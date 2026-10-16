#!/bin/bash
set -e

echo "=== Ascent Setup ==="

# ── Node ────────────────────────────────────────────────────────────────────
# Ascent supports Node 20, 22 and 24 (.nvmrc picks 24). With nvm we use the .nvmrc
# version; otherwise any supported Node already on PATH.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && { \. "$NVM_DIR/nvm.sh" --no-use || true; }
node_supported() {
  command -v node &>/dev/null || return 1
  case "$(node -p 'process.versions.node.split(".")[0]')" in 20|22|24) return 0 ;; *) return 1 ;; esac
}
cd "$(dirname "$0")"

if command -v nvm &>/dev/null; then
  nvm install            # reads .nvmrc; a no-op if that version is already installed
elif ! node_supported; then
  command -v node &>/dev/null && echo "Found Node $(node --version), but Ascent needs Node 20, 22 or 24 — installing Node 24 with nvm alongside it."
  echo "Installing nvm and Node.js..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  \. "$NVM_DIR/nvm.sh" --no-use || true   # nvm.sh can return non-zero when sourced; not an error
  nvm install
fi
node_supported || { echo "Error: Node $(node --version 2>/dev/null) isn't supported — install Node 24 and run ./setup.sh again."; exit 1; }

echo "Node: $(node --version), npm: $(npm --version)"

# Backend deps
echo "Installing server dependencies..."
cd server
npm install

# Frontend deps
echo "Installing client dependencies..."
cd ../client
npm install

echo ""
echo "=== Setup complete! ==="
echo ""
echo "To run it (builds the client, serves everything on one port with pm2):"
echo "  ./start.sh"
echo "  Open: http://localhost:3001"
echo ""
echo "To DEVELOP with hot reload instead:"
echo "  Terminal 1: cd server && npm run dev"
echo "  Terminal 2: cd client && npm run dev"
echo "  Open: http://localhost:5173"
