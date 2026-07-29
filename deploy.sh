#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

# Деньги проверяем до сборки: тесты дешевле, чем откат задеплоенной формулы.
# Пропустить осознанно — SKIP_TESTS=1 ./deploy.sh (в норме не нужно).
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "=== Тесты денежной логики ==="
  python3 -m pytest tests/ -q
fi

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

echo "=== Smoke ==="
# systemctl status покажет только «процесс жив». Падение миграции или роутера
# выглядит как живой сервис с пятисотками — видно лишь запросом.
sleep 3
if ! python3 "$ROOT/scripts/smoke.py"; then
  echo "!!! Smoke провален — Фирма поднялась, но работает не вся."
  python3 /opt/ai-os/tools/agent_msg.py send --to yos --type alert \
    --text "[инженер Фирмы] деплой прошёл, но smoke провален — часть API или миграций не работает. Смотри вывод deploy.sh." || true
  exit 1
fi

echo "=== Deployment complete ==="
sudo systemctl status firma --no-pager | sed -n '1,5p'
