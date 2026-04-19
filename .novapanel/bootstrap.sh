#!/usr/bin/env bash
set -e
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
BOOTSTRAP_VERSION="2"
BOOTSTRAP_STAMP=".novapanel/.bootstrap-version"
echo "[NovaPanel] Setup..."
mkdir -p .novapanel server
[ -d .cubepanel ] || mkdir -p .cubepanel
[ -f .novapanel/bootstrap.sh ] && cp .novapanel/bootstrap.sh .cubepanel/bootstrap.sh || true
[ -f .novapanel/agent.js ] && cp .novapanel/agent.js .cubepanel/agent.js || true
[ ! -f server/eula.txt ] && echo "eula=true" > server/eula.txt
if [ -f "$BOOTSTRAP_STAMP" ] && [ "$(cat "$BOOTSTRAP_STAMP" 2>/dev/null)" = "$BOOTSTRAP_VERSION" ]; then
  echo "[NovaPanel] Bootstrap já concluído."
  exit 0
fi
if [ ! -f package.json ]; then
  printf '{
  "name": "novapanel-server",
  "private": true,
  "dependencies": { "@supabase/supabase-js": "^2.45.0", "unzipper": "^0.10.14" }
}
' > package.json
fi
echo "[NovaPanel] npm install (root)..."
npm install --silent --no-audit --no-fund 2>&1 | tail -10 || true
if [ ! -f playit ]; then
  echo "[NovaPanel] A descarregar playit.gg..."
  curl -sSL -o playit "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64" || echo "[NovaPanel] falhou playit (não-fatal)"
  chmod +x playit 2>/dev/null || true
fi
echo "$BOOTSTRAP_VERSION" > "$BOOTSTRAP_STAMP"
echo "[NovaPanel] Pronto. Para arrancar manualmente: node agent.js"
