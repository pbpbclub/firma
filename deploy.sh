#!/bin/bash
# Деплой Фирмы: тесты → сборка → выкладка → рестарт → smoke.
#
# Скрипт обязан целиком отрабатывать под claude-runner, без ввода пароля.
# Поэтому каждый вызов sudo — с `-n` (не спрашивать, а падать) и ТОЧНЫМ путём
# из /etc/sudoers.d/claude-runner:
#     /bin/cp, /bin/rm — любые аргументы
#     /bin/systemctl restart firma, /bin/systemctl status firma — ровно эти,
#     без лишних флагов: `status firma --no-pager` уже НЕ подходит под правило.
# `sudo mkdir`, `sudo chown` и `sudo cp` (без /bin/) требуют пароля, которого у
# инженера нет — 29.07.2026 из-за них скрипт приходилось прогонять руками.
# mkdir не нужен: каталоги существуют, а их отсутствие — повод остановиться, а не
# чинить на ходу. chown не нужен: `sudo /bin/cp` копирует от root, файлы и так root.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

for d in /opt/firma/frontend /opt/firma/backend; do
  [ -d "$d" ] || { echo "Нет каталога $d — деплой остановлен (создать может только root)." >&2; exit 1; }
done

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
# rm обязателен: без него старые бандлы остаются рядом с новыми.
sudo -n /bin/rm -rf /opt/firma/frontend/dist
sudo -n /bin/cp -r dist /opt/firma/frontend/

# Исходники в /opt/firma держим для разбора инцидентов — приложение работает
# из dist и backend/, эти копии только для чтения глазами.
#
# `cp -r backend/.` копировал и точечные файлы, в том числе локальный backend/.env
# (он в .gitignore и в репозитории лежит старый, без FIRMA_SECRET_KEY). 29.07.2026
# так был затёрт боевой .env и Фирма ушла в рестарт-луп: auth.py падает без секрета.
# Поэтому копируем поимённо всё, кроме .env* — секреты живут только в /opt/firma.
echo "=== Sync backend source ==="
find "$ROOT/backend" -mindepth 1 -maxdepth 1 ! -name '.env*' -print0 \
  | xargs -0 -r -I{} sudo -n /bin/cp -r {} /opt/firma/backend/

echo "=== Sync frontend source ==="
sudo -n /bin/cp -r "$ROOT/frontend/src/." /opt/firma/frontend/src/

# Предохранитель перед рестартом: боевой .env должен быть цел. Проверять ПОСЛЕ
# рестарта поздно — 29.07.2026 затёртый секрет увёл сервис в рестарт-луп, и Фирма
# лежала до ручного восстановления. Здесь падаем, не трогая работающий сервис.
echo "=== Проверка боевого .env ==="
for key in FIRMA_SECRET_KEY TELEGRAM_BOT_TOKEN OWNER_CHAT_ID DADATA_TOKEN; do
  grep -q "^${key}=." /opt/firma/backend/.env || {
    echo "В /opt/firma/backend/.env нет ${key} — рестарт отменён, Фирма продолжает работать." >&2
    exit 1
  }
done
echo "  ok  4 ключа на месте"

echo "=== Restart backend service ==="
sudo -n /bin/systemctl restart firma

echo "=== Smoke ==="
# systemctl status покажет только «процесс жив». Падение миграции или роутера
# выглядит как живой сервис с пятисотками — видно лишь запросом.
#
# Ждём готовности, а не спим вслепую: старт с миграциями занимает то две секунды,
# то четыре, и фиксированный `sleep 3` дал ложный «Connection refused» на живом
# сервисе (04.09.2026) — провал приёмки, которого не было. Опрашиваем порт до 40 с:
# http_code=000 значит «соединение не принято», любой ответ — сервер слушает.
#
# Таймауты на попытку обязательны: если сокет принят, а старт завис (миграция,
# блокировка SQLite), curl без них ждёт бесконечно — одна итерация съедает весь
# цикл, и обещанные «до 40 с» не соблюдаются вовсе, деплой встаёт молча.
for i in $(seq 1 40); do
  code=$(curl -s --connect-timeout 2 --max-time 5 \
              -o /dev/null -w '%{http_code}' "http://127.0.0.1:8001/docs" || true)
  [ "$code" != "000" ] && break
  if [ "$i" = "40" ]; then
    # Алерт тем же каналом, что и провал smoke ниже: сервис, вообще не ответивший
    # после рестарта, — самый тяжёлый отказ, и он не должен быть виден только
    # тому, кто смотрит в терминал.
    echo "!!! Фирма не отвечает через 40 с после рестарта — smoke не запускался." >&2
    python3 /opt/ai-os/tools/agent_msg.py send --to yos --type alert \
      --text "[инженер Фирмы] после рестарта Фирма не отвечает 40 с — smoke не запускался, сервис может лежать. Смотри вывод deploy.sh." || true
    exit 1
  fi
  sleep 1
done
if ! python3 "$ROOT/scripts/smoke.py"; then
  echo "!!! Smoke провален — Фирма поднялась, но работает не вся."
  python3 /opt/ai-os/tools/agent_msg.py send --to yos --type alert \
    --text "[инженер Фирмы] деплой прошёл, но smoke провален — часть API или миграций не работает. Смотри вывод deploy.sh." || true
  exit 1
fi

echo "=== Deployment complete ==="
# Пайп важен: без него systemctl зовёт пейджер и скрипт зависает. --no-pager
# добавить нельзя — правило sudoers задано без аргументов и лишний флаг его ломает.
sudo -n /bin/systemctl status firma | sed -n '1,5p' || true
