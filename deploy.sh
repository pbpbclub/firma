#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

echo "=== Build frontend ==="
cd frontend
npm run build

echo "=== Deploy frontend dist ==="
sudo rm -rf /opt/firma/frontend/dist
sudo mkdir -p /opt/firma/frontend
sudo cp -r dist /opt/firma/frontend/

# Optional: keep deployed source in /opt/firma for easier troubleshooting
echo "=== Sync backend source ==="
sudo mkdir -p /opt/firma/backend
sudo cp -r "$ROOT/backend/"* /opt/firma/backend/

# Optional: sync frontend source too, if needed
sudo mkdir -p /opt/firma/frontend/src
sudo cp -r "$ROOT/frontend/src/"* /opt/firma/frontend/src/

# Ensure permissions are consistent
sudo chown -R root:root /opt/firma/backend /opt/firma/frontend

echo "=== Restart backend service ==="
sudo systemctl restart firma

echo "=== Deployment complete ==="
sudo systemctl status firma --no-pager | sed -n '1,5p'
