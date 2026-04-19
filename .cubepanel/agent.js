#!/usr/bin/env node
// NovaPanel Agent — Java/Bedrock/Eaglercraft + Geyser + Playit
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

const SUPABASE_URL = process.env.NOVAPANEL_SUPABASE_URL;
const AGENT_TOKEN = process.env.NOVAPANEL_AGENT_TOKEN;
const SERVER_KIND = process.env.NOVAPANEL_KIND || "java";  // java | bedrock | eaglercraft
const JAVA_BIN = process.env.NOVAPANEL_JAVA_BIN || "/usr/lib/jvm/msopenjdk-current/bin/java";
const SERVER_DIR = path.resolve(__dirname, "server");

// Strip ANSI escape codes (CSI sequences, OSC, single-char escapes), cursor moves,
// carriage returns and ALL non-printable control bytes. Playit uses lots of these
// for live-rendering its TUI which spam the console useless garbage.
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>PX^_]|\x1b\([B0]|\r/g;
const cleanLine = (s) => s.replace(ANSI_RE, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
// Drop noise: pure cursor/blank residue, or lines that don't have at least 3 letters/digits.
const isNoise = (s) => !s || s.length < 3 || !/[A-Za-z0-9]{3,}/.test(s);
const JAR_URL_FILE = path.join(__dirname, ".novapanel", "jar_url.txt");
const IMPORT_FILE = path.join(__dirname, ".novapanel", "import.json");

if (!SUPABASE_URL || !AGENT_TOKEN) {
  console.error("[NovaPanel] Missing NOVAPANEL_SUPABASE_URL or NOVAPANEL_AGENT_TOKEN");
  process.exit(1);
}

let mc = null;
const players = new Map();
let startedAt = null;
let lastTps = 20;
let lastCpu = 0;
const LOG_BUF = [];

function api(method, p, body, headers) {
  return new Promise((resolve) => {
    const url = new URL(SUPABASE_URL + p);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      method, hostname: url.hostname, path: url.pathname + url.search,
      headers: Object.assign({
        "X-Agent-Token": AGENT_TOKEN,
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      }, headers || {}),
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}
const post = (p, body) => api("POST", p, body);
const get = (p) => api("GET", p);

let publicAddress = null;
let bedrockPublicAddress = null;
let authUrl = null;
let cleaning = false;
let eaglercraftWebUrl = null;

async function reportMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const cpus = os.cpus().length || 1;
  const load = os.loadavg()[0];
  lastCpu = Math.min(100, Math.round((load / cpus) * 100));
  const uptime = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  await post("/functions/v1/agent-relay", {
    action: "metrics",
    data: {
      live_players: players.size,
      live_ram_used_mb: Math.round((total - free) / 1024 / 1024),
      live_ram_total_mb: Math.round(total / 1024 / 1024),
      live_cpu_percent: lastCpu,
      live_tps: lastTps,
      live_uptime_seconds: uptime,
      agent_status: cleaning ? "cleaning" : (mc ? "running" : "connected"),
      public_address: publicAddress,
      bedrock_public_address: bedrockPublicAddress,
      eaglercraft_web_url: eaglercraftWebUrl,
      auth_url: authUrl,
    },
  });
}

async function flushLogs() {
  if (!LOG_BUF.length) return;
  const lines = LOG_BUF.splice(0, Math.min(LOG_BUF.length, 50))
    .map(cleanLine).filter((l) => !isNoise(l));
  if (!lines.length) return;
  await post("/functions/v1/agent-relay", { action: "logs", data: { lines } });
}

async function announcePlayer(event, name, uuid) {
  await post("/functions/v1/agent-relay", { action: "player_event", data: { event, name, uuid } });
}

function parseLogLine(line) {
  // Java player join
  let m = line.match(/(?:^|: )([A-Za-z0-9_]{2,16})\[\/[\d\.:]+\] logged in/);
  if (m && !players.has(m[1])) { players.set(m[1], { joined_at: Date.now() }); announcePlayer("join", m[1]); }
  m = line.match(/(?:^|: )([A-Za-z0-9_]{2,16}) (?:lost connection|left the game)/);
  if (m && players.has(m[1])) { players.delete(m[1]); announcePlayer("leave", m[1]); }
  // Bedrock player connect
  m = line.match(/Player connected: ([A-Za-z0-9_ ]{2,32}), xuid:/);
  if (m && !players.has(m[1])) { players.set(m[1], { joined_at: Date.now() }); announcePlayer("join", m[1]); }
  m = line.match(/Player disconnected: ([A-Za-z0-9_ ]{2,32}), xuid:/);
  if (m && players.has(m[1])) { players.delete(m[1]); announcePlayer("leave", m[1]); }
  // TPS
  const tps = line.match(/TPS from last 1m[^\d]+([\d\.]+)/);
  if (tps) lastTps = Math.min(20, parseFloat(tps[1]));

  // Playit address — broad capture (xxx.gl.joinmc.link, xxx.playit.gg, xxx.tunnel.playit.gg)
  // Format from playit log: "Tunnel ready: xxxx.gl.joinmc.link:25565"
  const playit1 = line.match(/((?:[a-zA-Z0-9-]+\.)+(?:gl\.joinmc\.link|playit\.gg|tunnel\.playit\.gg|joinmc\.link)(?::\d+)?)/);
  if (playit1) {
    const addr = playit1[1];
    // Bedrock typically has port 19132
    if (addr.includes(":19132") || /bedrock/i.test(line)) bedrockPublicAddress = addr;
    else publicAddress = addr;
  }
  // Playit auth claim URL
  const claim = line.match(/(https?:\/\/(?:[a-z0-9-]+\.)?playit\.gg\/[A-Za-z0-9\/_\-?=&%.#]+)/);
  if (claim) authUrl = claim[1];
}

let playitProc = null;
function startPlayit() {
  if (playitProc) return;
  const playitBin = path.join(__dirname, "playit");
  if (!fs.existsSync(playitBin)) { LOG_BUF.push("[NovaPanel] playit não instalado — pula tunnel."); return; }
  LOG_BUF.push("[NovaPanel] A iniciar túnel playit.gg...");
  const env = Object.assign({}, process.env, { NO_COLOR: "1", TERM: "dumb", CI: "1" });
  playitProc = spawn(playitBin, [], { cwd: __dirname, shell: false, env });
  const handle = (d) => {
    const s = d.toString();
    for (const raw of s.split(/\r?\n/)) {
      const line = cleanLine(raw);
      if (isNoise(line)) continue;
      // Always parse (capture tunnel/auth URLs even from noisy frames)
      parseLogLine(line);
      // Only forward meaningful playit messages — skip its TUI re-renders.
      if (/(tunnel|claim|playit\.gg|joinmc|ready|error|fail|connected|disconnect|http)/i.test(line)) {
        LOG_BUF.push("[playit] " + line);
      }
    }
  };
  playitProc.stdout.on("data", handle);
  playitProc.stderr.on("data", handle);
  playitProc.on("exit", () => { playitProc = null; LOG_BUF.push("[NovaPanel] playit parou."); });
}

async function downloadFile(url, dest) {
  LOG_BUF.push("[NovaPanel] Download " + url);
  execSync("curl -fsSL -o " + JSON.stringify(dest) + " " + JSON.stringify(url), { stdio: "inherit" });
}

async function ensureJar() {
  if (SERVER_KIND === "bedrock" || SERVER_KIND === "eaglercraft") return true;
  const jarPath = path.join(SERVER_DIR, "server.jar");
  if (fs.existsSync(jarPath)) return true;
  if (!fs.existsSync(JAR_URL_FILE)) {
    LOG_BUF.push("[NovaPanel] server.jar não existe e jar_url.txt não foi configurado.");
    return false;
  }
  const url = fs.readFileSync(JAR_URL_FILE, "utf8").trim();
  try { await downloadFile(url, jarPath); LOG_BUF.push("[NovaPanel] server.jar OK."); return true; }
  catch (e) { LOG_BUF.push("[NovaPanel] Falha download: " + e.message); return false; }
}

async function ensureBedrock() {
  const bin = path.join(SERVER_DIR, "bedrock_server");
  if (fs.existsSync(bin)) return true;
  LOG_BUF.push("[NovaPanel] A descarregar Bedrock Dedicated Server...");
  try {
    // Latest BDS download (Mojang requires HTML scrape — usar URL conhecida)
    const url = "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server.zip";
    const zip = path.join(SERVER_DIR, "bds.zip");
    await downloadFile(url, zip);
    execSync("cd " + JSON.stringify(SERVER_DIR) + " && unzip -o bds.zip && rm bds.zip && chmod +x bedrock_server", { stdio: "inherit" });
    return true;
  } catch (e) {
    LOG_BUF.push("[NovaPanel] Falha BDS: " + e.message + " — descarrega manualmente bedrock_server para /server.");
    return false;
  }
}

async function ensureEaglercraft() {
  // BungeeCord + EaglercraftXBungee
  const bcJar = path.join(SERVER_DIR, "BungeeCord.jar");
  if (!fs.existsSync(bcJar)) {
    try { await downloadFile("https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar", bcJar); }
    catch (e) { LOG_BUF.push("[NovaPanel] Falha BungeeCord: " + e.message); return false; }
  }
  const pluginsDir = path.join(SERVER_DIR, "plugins");
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
  const eaglerJar = path.join(pluginsDir, "EaglercraftXBungee.jar");
  if (!fs.existsSync(eaglerJar)) {
    try { await downloadFile("https://github.com/lax1dude/eaglercraft-bungee/releases/latest/download/EaglercraftXBungee.jar", eaglerJar); }
    catch (e) { LOG_BUF.push("[NovaPanel] Falha EaglercraftXBungee: " + e.message); }
  }
  return true;
}

async function startServer() {
  if (mc) return;
  cleaning = true;
  LOG_BUF.push("[NovaPanel] A limpar ambiente (kill java + session.lock)...");
  try { execSync("pkill -f java || true", { stdio: "ignore" }); } catch {}
  try { execSync("pkill -f bedrock_server || true", { stdio: "ignore" }); } catch {}
  try {
    const lock = path.join(SERVER_DIR, "world", "session.lock");
    if (fs.existsSync(lock)) { fs.unlinkSync(lock); LOG_BUF.push("[NovaPanel] session.lock removido."); }
  } catch {}
  cleaning = false;

  if (SERVER_KIND === "bedrock") {
    if (!await ensureBedrock()) return;
    LOG_BUF.push("[NovaPanel] $ ./bedrock_server");
    startPlayit();
    try {
      const env = Object.assign({}, process.env, { LD_LIBRARY_PATH: "." });
      mc = spawn("./bedrock_server", [], { cwd: SERVER_DIR, shell: false, env });
    } catch (e) { LOG_BUF.push("[NovaPanel] Falha ao arrancar Bedrock: " + e.message); return; }
  } else if (SERVER_KIND === "eaglercraft") {
    if (!await ensureEaglercraft()) return;
    LOG_BUF.push("[NovaPanel] $ java -jar BungeeCord.jar (Eaglercraft proxy)");
    startPlayit();
    try {
      mc = spawn("java", ["-Xms512M", "-Xmx2G", "-jar", "BungeeCord.jar"], { cwd: SERVER_DIR, shell: false });
      eaglercraftWebUrl = "https://eaglercraft.com/mc/1.8.8-wasm/";
    } catch (e) { LOG_BUF.push("[NovaPanel] Falha Eaglercraft: " + e.message); return; }
  } else {
    if (!await ensureJar()) return;
    const raw = (process.env.NOVAPANEL_JAVA_CMD || "java -Xms2G -Xmx4G -jar server.jar nogui").trim();
    const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || ["java"];
    const argv = tokens.map((t) => t.replace(/^"|"$/g, ""));
    let bin = argv.shift() || "java";
    if (bin === "java" && fs.existsSync(JAVA_BIN)) bin = JAVA_BIN;
    LOG_BUF.push("[NovaPanel] $ " + bin + " " + argv.join(" "));
    startPlayit();
    try { mc = spawn(bin, argv, { cwd: SERVER_DIR, shell: false, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { LOG_BUF.push("[NovaPanel] Falha: " + e.message); return; }
  }

  startedAt = Date.now();
  players.clear();
  mc.on("error", (err) => { LOG_BUF.push("[NovaPanel] Erro: " + err.message); mc = null; startedAt = null; });
  const handle = (data) => {
    const s = data.toString();
    for (const raw of s.split(/\r?\n/)) {
      const line = cleanLine(raw);
      if (isNoise(line)) continue;
      LOG_BUF.push(line); parseLogLine(line);
    }
  };
  mc.stdout && mc.stdout.on("data", handle);
  mc.stderr && mc.stderr.on("data", (d) => { const s = cleanLine(d.toString()); if (!isNoise(s)) LOG_BUF.push("[STDERR] " + s); });
  mc.on("exit", (code) => {
    LOG_BUF.push("[NovaPanel] Server parou (code " + code + ").");
    mc = null; startedAt = null; players.clear();
    post("/functions/v1/agent-relay", { action: "players", data: { list: [] } });
  });
}

function stopServer() {
  if (!mc) return;
  try { mc.stdin.write("stop\n"); } catch {}
  setTimeout(() => { if (mc) try { mc.kill("SIGTERM"); } catch {} }, 8000);
}
function sendCmd(cmd) {
  if (!mc) { LOG_BUF.push("[NovaPanel] Servidor offline — comando ignorado: " + cmd); return; }
  try { mc.stdin.write(cmd + "\n"); } catch (e) { LOG_BUF.push("[NovaPanel] Erro: " + e.message); }
}

async function checkImport() {
  if (!fs.existsSync(IMPORT_FILE)) return;
  try {
    const { url } = JSON.parse(fs.readFileSync(IMPORT_FILE, "utf8"));
    fs.unlinkSync(IMPORT_FILE);
    LOG_BUF.push("[NovaPanel] A importar ZIP de " + url);
    const zipPath = path.join(__dirname, "import.zip");
    execSync("curl -sSL -o " + JSON.stringify(zipPath) + " " + JSON.stringify(url), { stdio: "inherit" });
    const unzipper = require("unzipper");
    await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: SERVER_DIR })).promise();
    fs.unlinkSync(zipPath);
    // Auto-detect MC version from server.properties or paper.yml
    try {
      const propsPath = path.join(SERVER_DIR, "server.properties");
      if (fs.existsSync(propsPath)) {
        const v = fs.readFileSync(propsPath, "utf8").match(/^minecraft-version=(\S+)/m);
        if (v) LOG_BUF.push("[NovaPanel] Detected MC version from properties: " + v[1]);
      }
    } catch {}
    LOG_BUF.push("[NovaPanel] Import concluído.");
  } catch (e) { LOG_BUF.push("[NovaPanel] Falha import: " + e.message); }
}

async function poll() {
  const j = await get("/functions/v1/agent-relay?action=poll");
  if (!j || !j.commands) return;
  for (const c of j.commands) {
    if (c.type === "start") startServer();
    else if (c.type === "stop") stopServer();
    else if (c.type === "restart") { stopServer(); setTimeout(startServer, 9000); }
    else if (c.type === "cmd") sendCmd(c.value);
  }
}

console.log("[NovaPanel] Agent started. Mode=" + SERVER_KIND);
post("/functions/v1/agent-relay", { action: "hello", data: { agent_status: "connected" } });
setInterval(reportMetrics, 5000);
setInterval(flushLogs, 1000);
setInterval(poll, 2000);
setInterval(checkImport, 5000);
