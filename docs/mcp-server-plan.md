# MCP-сервер Фирмы — план (05.10.2026, ждёт согласия Юры)

ТЗ: агенты (fin, yos, vendor) ходят в Фирму через MCP вместо своих обёрток REST.
Сейчас: `fin-agent/tools/firma.py` (1464 строки, ходит в API) и
`ai-os/tools/production.py` (2017 строк, ~98 прямых обращений к SQLite и 4 — к API:
заказы, платежи, расходы, обновление заказа пишутся мимо правил API).

## Принцип
MCP — тонкий слой над HTTP API на 127.0.0.1:8001, своей логики и SQL нет.
Каждый инструмент = один вызов ручки; все правила (канал платежа, settled_by,
`_check_sellable` на approve, инвариант «одна оплата = один факт», 409 с
подтверждением) остаются в API. 409/400 отдаются агенту как есть, `confirm`/`force`
агент передаёт явно вторым вызовом.

## Транспорт и доступ
- stdio, процесс `backend/mcp_server.py` (пакет `mcp`, ставится pip). Каждый агент
  запускает его у себя в `.mcp.json`; сеть не открывается вовсе.
- Авторизация — сервисный токен (`service_token.py issue`), env `FIRMA_TOKEN`; права =
  права учётки `sub`. По токену на агента — отзыв точечный.
- Режим `FIRMA_MCP_WRITE=0` — только чтение (для vendor и проб).

## Инструменты (≈25)
Чтение: orders_list, order_get (карточка + plan_fact), order_timeline, debtors,
creditors (debt/plan), ledger_balances, ledger_master, estimate_sets, estimate_get,
cost_check, customers_find, masters_find, plan_fact_summary, alloc_map,
general_expenses, machine_usage_summary.
Запись: payment_add / payment_from_tx, expense_add / expense_from_tx (settled_by,
purpose), estimate_create_full, estimate_approve / unapprove (только API-гейт),
order_status (409 obligations_unpaid → confirm), order_update, ledger_offset /
contractor_pay, creditor_close (preview → apply), cost_fill.

## Переезд агентов
1. MCP + тесты на тестовом токене, чтение — неделя параллельно с обёртками.
2. fin: команды firma.py → вызовы MCP (обёртка остаётся алиасом на неделю, затем
   удаляется).
3. YOS: production.py — сначала запись (order-create, payment-add, expense-add,
   order-update, estimate-create) на MCP: убирает прямые записи в production.db;
   затем чтение. CLI-обёртки, которые читают другие скрипты, — делегатами к MCP.
4. vendor — сразу на MCP, только чтение.

## Оценка
MCP-сервер с ~25 инструментами и тестами — 1 сессия; перевод fin — 1 сессия
(его агент); перевод YOS — 1–2 сессии (больше всего прямого SQL).
