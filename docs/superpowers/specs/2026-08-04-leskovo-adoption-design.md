# Внедрение решений из разбора ЛЕСКОВО — фазированный план

## Контекст

ТЗ `firma_tz_from_leskovo.md` (04.08.2026): разбор чужой ERP (PostgreSQL, 43 таблицы,
95 FK) против нашей production.db. 10 пунктов «забрать» (А1–А10), 8 пунктов гигиены
(Б1–Б8). Задача Юры: качественные изменения, которые не ломают уже сделанное —
инварианты дедупа факта, costing-движок, транзит, 100 зелёных тестов, smoke.

**Сверка ТЗ с живым кодом (документ писался по снимку базы и кое-где отстал):**
- Б1: `PRAGMA foreign_keys=ON` **уже включён** (db.py:23); 12/32 таблиц с настоящими
  FK. Главная дыра — `creditors` (0 FK из 4 ссылок: order_id, estimate_item_id,
  estimate_line_id, fixed_id).
- Б4: дублей по бизнес-ключам нет (проверено live) — индексы можно вешать сразу.
- A4: `match_source` уже вычисляется в from-tx (payments.py:42, expenses.py:42),
  но после записи выбрасывается.
- Механизм пересборки таблиц в db.py **теряет CHECK** (признание в db.py:972) —
  Б8 делается только после его доработки.
- A9: аналог для материалов уже есть (`price_supplier`/`price_date`) — работам
  нужна симметрия.

**Решения Юры (04.08, два раунда вопросов):**
A6 почта — отложить · A8 — «несколько уровней маржи»: без накладных (как сейчас)
и с накладными у заказов в производстве + на дашборде, сметы не перегружать, база
распределения — по себестоимости · Б5 stages/events — оставить заделом · Б6 mes_id —
архивным · A3 — таблицу аллокаций НЕ строить, усилить текущую механику · Б3 —
дисциплина округления, не INTEGER · Волна 3 в этом заходе: A8 + Б1/Б8 (creditors).

---

## Волна 1 — гигиена, ничего не ломает (день)

Каждый пункт: ensure-миграция в `backend/db.py` (идемпотентно) + вызов в
`main.py::startup` + колонки в `scripts/smoke.py::REQUIRED_COLUMNS` + тест.

1. **Б4 — уникальные индексы** (`CREATE UNIQUE INDEX IF NOT EXISTS`):
   `orders(number)`; `estimate_sets(order_id, number) WHERE number IS NOT NULL`;
   `materials(sku) WHERE sku IS NOT NULL`; `customers(inn) WHERE inn IS NOT NULL
   AND inn != ''`. На `payments.bank_tx_id` НЕ вешаем — одна транзакция легально
   даёт N платежей (разноска from-tx).
2. **Б7 — `updated_at`** в `payments, expenses, creditors, estimate_items,
   estimate_lines, customers, masters` — через **триггеры AFTER UPDATE** (ловят и
   прямые записи агентов в базу, не только веб; recursive_triggers в SQLite выключен,
   рекурсии нет; пересборка таблиц в db.py триггеры уже восстанавливает).
3. **Б3 — дисциплина денег**: `money(x) = round(x, 2)` в `backend/money.py`,
   применять при записи сумм в write-ручках; правило + запрет сравнения сумм на
   строгое равенство — в `docs/code_rules.md` (hookify YOS подхватит).
4. **A9 — снимок ставки в строке работ**: `estimate_lines` и `catalog_item_lines`
   + `applied_rate REAL, rate_scheme TEXT, rate_date TEXT`. Заполняют: cost-fill
   (`routers/costing.py`) и ручной ввод цены работы (`routers/estimates.py`, рядом
   с learned-записью). Симметрия с price_supplier/price_date для материалов.
5. **Б6 — mes_id архивный**: строка в CLAUDE.md («архивный идентификатор импорта
   из MES, не использовать»). Код не трогаем — people.py/contractors.py фин-агента
   его ещё читают как фолбэк.

## Волна 2 — прослеживаемость (неделя)

6. **A1 — журнал изменений**: таблица `audit_log` по DDL из ТЗ (actor, entity_type,
   entity_id, action, summary, changes, created_at + индекс). Одна обёртка
   `audit(conn, actor, entity_type, entity_id, action, summary, before_row)` в новом
   `backend/audit.py`; `changes` = **полный снимок строки до изменения** (вариант
   «на критику» из ТЗ — проще и надёжнее diff). actor = email из JWT. Вызовы — в
   write-ручки денежных сущностей: orders (status/PATCH/delete), estimates
   (approve/item/line/set), payments, expenses, creditors, rates. Справочники
   добираем по мере касания, не все 40 эндпоинтов разом.
7. **A4 — след привязки платежа**: `payments` и `expenses` + `match_status`
   (auto/manual/confirmed), `matched_by` (rule:<id>/suggest/manual), `match_score`.
   Заполнять в from-tx (готовый `match_source` сейчас выбрасывается) и в ручном
   создании. Бэкфилл не выдумываем — у старых строк NULL.
8. **A3-лайт — усиление разноски** (решение Юры вместо таблицы аллокаций):
   `payments.group_id` (как у expenses) — откат разноски целиком; в карточке заказа
   у платежа с bank_tx_id показывать «братские» платежи той же транзакции на другие
   заказы. Инвариант «одна оплата = один факт» не трогается.
9. **A2 — история ставок (лёгкая версия)**: одна таблица `rate_history(kind
   work_rate|price_book|catalog_markup, target_id, old_value, new_value, scheme,
   changed_by, comment, changed_at)`. Пишется в `rates.py` upsert'ах (сейчас UPDATE
   затирает старое безвозвратно — rates.py:78-95) и при смене `catalog_items.markup_pct`.
   Пересчёт «на дату» не строим — по ТЗ хватает факта (польза effective_from
   появится при сотнях заказов).
10. **A10 — версия контура себестоимости**: `estimate_sets.costing_version`:
    бэкфилл всем существующим `legacy`, при cost-fill/approve через движок —
    `catalog_v1`; бейдж в редакторе сметы. Отчёты по марже перестают смешивать эпохи.
11. **Б2-лайт — бренд как связь**: `orders.brand_id REFERENCES brands(id)`
    (ALTER ADD COLUMN с FK допустим при NULL default), бэкфилл по `brands.name`,
    при записи текстового brand бэкенд резолвит name→id, текст остаётся на переход.
    11 заказов без бренда — Юра разметит через UI, я не угадываю.
    `business_unit_id` в payments/expenses НЕ вводим: разрез по юрлицу уже даёт
    `payments.channel` (bank=ИП / personal=физлицо) + `accounts.business_unit_id`.

## Волна 3 — экономика и схема (по решению Юры: A8 и Б1/Б8 в этом заходе)

12. **A8 — уровни маржи (формулировка Юры)**:
    - Источник накладных-факта: `expenses.order_id IS NULL AND purpose='overhead'`
      + оплаченные `creditors.kind='fixed'` (аренда). Отдельную таблицу периодов
      не заводим — период = месяц, сумма = факт месяца.
    - Распределение на лету: накладные месяца делятся между заказами
      `in_production` **пропорционально их фактической себестоимости** (решение
      Юры; база — одна константа, поменять легко).
    - Показ: в `_margin` второй уровень `net_with_overhead`; карточка заказа в
      производстве — строка «Маржа с накладными»; Dashboard — блок «Накладные
      месяца» и их влияние на общую экономику. Сметы и план-факт не трогаем.
    - Snapshot-таблица `overhead_allocations` (доля навсегда) — вторым шагом,
      когда появится «закрытие месяца»; сейчас YAGNI.
13. **Б1+Б8 — пересоздание creditors с FK и CHECK**: сначала доработать пересборку
    в db.py (явные DDL вместо реконструкции из PRAGMA — иначе CHECK теряются),
    затем пересоздать `creditors` (4 FK) + `CHECK(status IN ('open','partial',
    'paid','cancelled'))`; заодно CHECK на `orders.status` (7 статусов) и
    `expenses.category` (4 категории) — по одной таблице за заход, под транзакцией,
    с бэкапом файла базы (`--exclude` не нужен, база без секретов) перед каждой.
    Перед CHECK — сверка фактических значений в базе (legacy `labor`/`test` в
    expenses.category привести к канону заранее).
14. **A5/A7 — территория фин-агента**: dedup_hash импортов в finance.db и идея
    tx_links — его базы и пайплайны. Мы: отправляем ему разбор и решения Юры
    (`agent_msg.py send --to fin --mode smart`), активную работу в этом заходе
    не ведём (Юра не включил в квартал).

## Сознательно не делаем (зафиксировано)

- A6 почтовый буфер — решение Юры: отложить.
- Б5 запуск stages/events — задел, не сносим и не запускаем.
- A3 payment_allocations как таблица — риск двойного учёта; лайт-вариант в п.8.
- Копейки в INTEGER, PostgreSQL, мульти-тенант, роли — раздел В ТЗ, не берём.

## Сквозные правила исполнения (каждая волна)

- Тесты сначала (красный → зелёный); `python3 -m pytest tests/ -q` — все зелёные.
- Схема только через `ensure_*` + `main.py:startup` + `smoke.py::REQUIRED_COLUMNS`.
- Изменение схемы/денежных формул → сообщение фин-агенту `--mode smart` ДО деплоя
  (Б4-индексы и Б8-CHECK бьют по его прямым INSERT'ам — прислать ему список).
- Деплой: build → `sudo -n /bin/cp` → `systemctl restart firma` → `scripts/smoke.py`
  → живая проверка через HTTP API с JWT (не прямые запросы к базе — WAL/права).
- После утверждения плана: спека в `docs/superpowers/specs/2026-08-04-leskovo-adoption-design.md`
  + коммит (процесс brainstorming); каждая волна завершается коммитом и отчётом Юре.

## Проверка

- В1: pytest+smoke; дубль `orders.number` через API → внятная ошибка; UPDATE
  платежа → `updated_at` проставился триггером; строка работы после cost-fill
  несёт applied_rate/rate_scheme/rate_date.
- В2: правка цены в смете → запись в `audit_log` с actor и снимком «до»; from-tx →
  `match_status='auto', matched_by='rule:N'`; смена ставки → строка в `rate_history`;
  разноска на 2 заказа → общий `group_id` и взаимные «братские» ссылки в карточках.
- В3: заказ в производстве показывает обе маржи; сумма долей накладных месяца =
  100%; `PRAGMA foreign_key_check` чист после пересоздания creditors; регресс цифр
  Горбачёв/Спираль/Суздаль/Маяк по 4 поверхностям (карточка, таблица заказов,
  дашборд, дебиторка) — без изменений.
