#!/bin/bash
# Ascent — build and start persistently with pm2
set -e

# ── Node ────────────────────────────────────────────────────────────────────
# Ascent supports Node 20, 22 and 24 (.nvmrc picks 24). With nvm we use the .nvmrc
# version; otherwise any supported Node already on PATH.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && { \. "$NVM_DIR/nvm.sh" --no-use || true; }
node_supported() {
  command -v node &>/dev/null || return 1
  case "$(node -p 'process.versions.node.split(".")[0]')" in 20|22|24) return 0 ;; *) return 1 ;; esac
}
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
command -v nvm &>/dev/null && nvm use >/dev/null   # same Node setup.sh installed with
node_supported || { echo "Error: Node 20, 22 or 24 not found — run ./setup.sh first."; exit 1; }

echo "=== Building client ==="
cd "$ROOT/client"
rm -rf dist
npm run build --silent 2>&1 | grep -E "built in|error" || true
[ -f dist/index.html ] || { echo "Error: client build failed — run 'cd client && npm run build' to see why."; exit 1; }

echo "=== Starting server with pm2 ==="
cd "$ROOT"

# Install pm2 globally if needed
command -v pm2 &>/dev/null || npm install -g pm2 --silent

# Delete and re-add so a changed Node version or config always takes effect
pm2 delete ascent &>/dev/null || true
pm2 start ecosystem.config.js >/dev/null
pm2 save >/dev/null
sleep 2
pm2 jlist | node -e "
const a = JSON.parse(require('fs').readFileSync(0, 'utf8')).find(p => p.name === 'ascent');
if (!a || a.pm2_env.status !== 'online') { console.log('Error: Ascent did not start — run: pm2 logs ascent'); process.exit(1); }
"

echo ""
echo "=== Ascent is running ==="
echo ""
echo "To start it automatically after a reboot, run 'pm2 startup' once and follow its instructions."
echo ""
PORT=$(node -p "require('./ecosystem.config.js').apps[0].env.PORT")
echo "Access on this machine:  http://localhost:$PORT"

# Print network IPs
PORT=$PORT node -e "
const os = require('os');
const ifaces = os.networkInterfaces();
for (const iface of Object.values(ifaces)) {
  for (const addr of iface) {
    if (addr.family === 'IPv4' && !addr.internal) {
      console.log('Access on network:       http://' + addr.address + ':' + process.env.PORT + '');
      console.log('Split-screen (iPad):     http://' + addr.address + ':' + process.env.PORT + '/?users=1,2');
    }
  }
}
"
