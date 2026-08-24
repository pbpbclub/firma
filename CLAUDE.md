# Firma — внутренний интерфейс ИП Некрасов

Веб-приложение firma.yuranek.com — замена громоздкого MES.
Рабочий инструмент Юры Некрасова (PBPB Mebel Club, производство мебели, Воронеж/Тбилиси).

---

## Стек

**Backend:** FastAPI + SQLite, Python 3.12, uvicorn
- Сервис: `sudo systemctl restart firma` (порт 8001, только localhost)
- Исходники разработки: `/home/claude-runner/firma/backend/`
- Деплой: `/opt/firma/backend/`

**Frontend:** React + TypeScript + Vite + lucide-react + @tanstack/react-query
- Исходники разработки: `/home/claude-runner/firma/frontend/`
- Деплой: `/opt/firma/frontend/dist/`
- Dev-сервер: `cd /home/claude-runner/firma/frontend && npm run dev`

**Nginx + Cloudflare Flexible SSL** — раздаёт статику + proxy /api/ → 8001

---

## Базы данных

```
/opt/ai-os/data/production.db      — заказы, клиенты, сметы, платежи, расходы, подрядчики
/opt/ai-os/data/materials.db       — номенклатура + живые прайсы (ВРЭП, Металлинвест), read-only
/opt/fin-agent/data/finance.db     — транзакции банков (Т-Банк + Сбер), read-only
/opt/fin-agent/data/zenmoney.db    — личные финансы Юры (ZenMoney, синк раз в час), read-only
/opt/fin-agent/data/analytics.db   — вики подрядчиков фин-агента (схемы оплаты, история)
/opt/firma/data/auth.db            — пользователи firma (JWT); в backend/ — мёртвая копия от 19.05
```

Пользователь: yuranek@pbpb.club, роль admin.

**Чужие базы — только чтение** (исключение: pay-поля подрядчиков в analytics пишутся
best-effort, см. Задачу 18). Пишет в них фин-агент; веб читает короткими транзакциями
с `close()` в `finally`.

⚠️ **WAL и права — грабли, на которые легко наступить.**
`production.db` и `analytics.db` работают в `journal_mode=wal`. Сайдкары `*-wal` / `*-shm`
создаёт тот процесс, который открыл базу — у нас это сервис под **root**, и ACL для
`claude-runner` на них не наследуется. Пока сервис держит базу, из сессии агента она
не открывается вовсе: «unable to open database file», хотя приложение работает.
- Для чтения вики есть `db.get_analytics_ro()` — фолбэк на `immutable=1`, читает файл
  мимо WAL (свежие незачекпойнченные записи может не увидеть — для справочника ок).
- **Проверять изменения нужно через HTTP API с JWT**, а не прямыми запросами к БД.

### zenmoney.db — личные финансы (ZenMoney)
API endpoints (защищены JWT, роутер `routers/zenmoney.py`):
```
GET /api/zenmoney/accounts                   — счета и балансы
GET /api/zenmoney/transactions?month=YYYY-MM — транзакции
GET /api/zenmoney/report?month=YYYY-MM       — расходы/доходы по категориям
GET /api/zenmoney/cashflow?months=6          — ДДС по месяцам (для графика)
```
Логика транзакций:
- `income > 0, outcome = 0` → поступление
- `outcome > 0, income = 0` → расход
- `income > 0, outcome > 0` → перевод между счетами
- `tags` — JSON массив строк: `["Shopping", "Food"]`

### production.db (ключевые таблицы)
```sql
orders(id, number, title, status, priority, deadline, price_plan, cost_plan, customer_id, brand, archived)
customers(id, name, phone, email, inn, full_name, status, source, ...)
payments(id, order_id, amount, paid_at, note, bank_tx_id, source)

-- Смета: sets → items → lines
estimate_sets(id, order_id, title, status, payment_type, bank_pct, notes)
estimate_items(id, set_id, title, quantity, markup, cost_total, sale_price, bank_pct, catalog_item_id, brand)
estimate_lines(id, item_id, type, title, qty, unit, unit_price, line_total,
               material_code, price_supplier, price_date,   -- привязка к прайсам materials.db
               master_id, contractor_name, work_type_id)

-- Факт: фактические траты по заказу
expenses(id, order_id, title, amount, category, supplier, expense_date,
         source,          -- manual | bank | zenmoney
         master_id,       -- подрядчик (точная связь; supplier — только текст)
         creditor_id,     -- покрытое обязательство (дедуп факта)
         finance_tx_id, zenmoney_tx_id,   -- разнесённая транзакция
         group_id)        -- одна поездка, разнесённая на несколько заказов

creditors(id, name, total, paid, status, order_id, description, due_date,
          estimate_item_id, estimate_line_id, finance_tx_id, zenmoney_tx_id,
          kind, period, fixed_id)         -- kind='fixed' — постоянные обязательства
masters(id, name, role, phone, telegram, specialization, status, notes, mes_id)
catalog_items / catalog_item_lines        — рецептуры изделий
work_types / master_work_types            — виды работ и кто их делает
```
Статусы заказа: `draft` / `estimate` / `project` / `in_production` / `awaiting_payment` /
`completed` / `cancelled`. `awaiting_payment` («Ждёт оплаты») — счёт выставлен, заказчик
тянет с оплатой, работа не начата; ставится ТОЛЬКО вручную. В дебиторку не входит —
это «потенциальная выручка» (блок potential в /finance/debtors).
Статусы сметы: `draft` / `approved` / `superseded` (одна активная на заказ; approved заморожена)

**Категории расхода — строго 4:** `material` / `work` / `delivery` / `other` — с 04.08.2026
под **CHECK в базе** (волна ЛЕСКОВО-3): INSERT с иным значением получит IntegrityError.
Под CHECK также `orders.status` (7 статусов) и `creditors.status` (open/partial/closed/
cancelled); у creditors появились настоящие FK (сметные ссылки ON DELETE SET NULL).
`orders.py::_bucket` осталась тотальной для legacy из старых бэкапов.

**Накладные расходы (A8, решение Юры 04.08.2026):** факт месяца = `expenses.order_id IS
NULL AND purpose='overhead'` + оплаченные `creditors.kind='fixed'` периода (с дедупом
инварианта). Делятся между заказами `in_production` пропорционально их фактической
себестоимости (`orders.py::_overhead_allocation`); второй уровень маржи
`net_with_overhead` виден в карточке заказа в производстве и на дашборде
(`GET /api/orders/overhead-summary`). Сметы и план-факт этим не обрастают.

**`mes_id` (в 9 таблицах) — архивный идентификатор импорта из снятого MES, НЕ
ИСПОЛЬЗОВАТЬ** (решение Юры 04.08.2026, Б6 спеки ЛЕСКОВО): не заполнять, не искать
по нему, в связях не участвует. Не путать с `analytics.contractors.mes_master_id` —
тот хранит живой `masters.id`. Колонки не сносим: people.py/contractors.py фин-агента
читают их как фолбэк.

**`updated_at`** у денежных таблиц (payments, expenses, creditors, estimate_items,
estimate_lines, customers, masters) проставляют **триггеры** `trg_*_updated_at` —
руками в UPDATE его писать не нужно; NULL = «не правили с момента миграции 04.08.2026».

### 🔒 Инвариант: одна оплата = один факт

Факт по заказу = `expenses` + `creditors.paid`. Один и тот же платёж легко попадает в оба
источника (внесли расход И отметили обязательство оплаченным) — тогда факт задваивается,
а маржа занижается вдвое. Поэтому в `orders.py::_plan_fact` обязательство идёт в факт
**только если оно не покрыто расходом**:

```sql
SELECT COALESCE(SUM(c.paid),0) FROM creditors c
WHERE c.order_id = ?
  AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.order_id = c.order_id AND (
        e.creditor_id = c.id
     OR (e.finance_tx_id  IS NOT NULL AND e.finance_tx_id  = c.finance_tx_id)
     OR (e.zenmoney_tx_id IS NOT NULL AND e.zenmoney_tx_id = c.zenmoney_tx_id)))
```

При создании расхода `creditor_id` проставляется автоматически, если у заказа есть
обязательство с тем же tx_id. **Ломать это правило нельзя** — оно и есть защита от
двойного счёта. Полностью ручной двойной счёт (расход без привязки, дублирующий
оплаченное обязательство) не исключён — от него защищает подсказка в форме расхода.

Обратная сторона инварианта: **один перевод законно кормит несколько заказов** (45 500
Годнику 12.05.2026 = 40 000 ТО систем + 5 500 рассылка). Поэтому дедуп в
`orders.py::_transit_facts` ключуется парой **(tx_id, order_id)**, а не одним tx_id —
глобальный ключ глотал вторую часть и занижал факт заказа. Ошибку разноски (сумма
частей больше самой транзакции) ловит `costing.py::_tx_overspread` → вкладка
«Готовность», блок `tx_overspread`.

**Транзитная смета обязательств не рождает** (05.08.2026): `_gen_obligations` при
`payment_type='transit'` возвращает `{created: 0, reason: "transit"}` — и на approve,
и на ручном `create-obligations`. Себестоимость транзита = выплата контрагенту и
ведётся расходами/`zm_links`, а позиции там — месяцы обслуживания, не работы
подрядчиков. Оплаченное обязательство становилось вторым источником в
`_transit_facts`, и инвариант его не гасил: расходы заведены агрегированно, а
обязательства помесячно — ни tx_id, ни сумма не совпадают (ORD-036: 430 200 вместо
230 200, чистая −181 335).

### 🤝 Расход ≠ выплата мастеру: `settled_by` (24.08.2026)

Строка `expenses` значит два разных факта сразу: **работа принята** (себестоимость
заказа) и **деньги ушли мастеру** (движение по лицевому счёту). Раньше лицевой счёт
считал выплатой любой расход, сопоставленный с мастером, — разноска ORD-024
(16 000 + 8 000 Кебре) перевернула сальдо с «мы должны 1 800» на «должен отработать
22 200», хотя в тот день никто ничего не переводил.

`expenses.settled_by` — «чем закрыт расход». Движение по лицевому счёту рождают
**только `cash` и `offset`**; остальные значат «минус уже проведён в другом месте»
(`ledger.SETTLED_KIND` — единственная точка, где значение превращается в оборот):

| значение | смысл | лицевой счёт |
|---|---|---|
| `cash`, NULL (legacy) | деньги ушли этим расходом | `payment` (−) |
| `offset` | взаимозачёт | `offset` (−) |
| `advance` | закрыто ранее выданным авансом | `accepted` (0) |
| `third_party` | закрыто оплатой за него третьему лицу | `accepted` (0) |
| `none` | работа принята, ещё должны | `accepted` (0) |

`accepted` — справочный вид со знаком 0: в сальдо не входит, показывает «за что мы
ещё должны». `MANUAL_KINDS` (POST /entries) его не принимает — под CHECK его нет.

🔒 **На `_plan_fact` и `obligations.coverage` `settled_by` не влияет.** Себестоимость
растёт всегда: работа принята независимо от того, чем закрыта. Обязательство гасит
покрытие L1 (`expenses.creditor_id`), которое и так работало, — поэтому «зачёт
закрывает обязательство» не потребовало новых источников факта и не тронуло инвариант
«одна оплата = один факт». В разноске банковской транзакции (`expenses.py::Allocation`)
поля нет намеренно: там деньги по определению ушли.

**Сальдо строится только на `master_id`.** Фолбэк «`supplier` = имя мастера» снят из
`ledger._entries`/`_entries_bulk` (supplier — свободный текст, совпадение случайно);
13 исторических расходов на 185 270 ₽ получили явный `master_id` бэкфиллом 24.08.2026.
По имени можно только подсказывать в интерфейсе.

**Два входа — одна таблица.** Форма расхода («ЧЕМ ЗАКРЫТО») и карточка подрядчика
(«Выдать аванс» / «Оплатить за него» / «Провести зачёт», `POST /api/ledger/offset`,
`contractor-pay` с `order_id`) пишут ОДИН И ТОТ ЖЕ расход по заказу через
`ledger._settle_on_order`. Ручная строка `master_ledger` осталась только для зачёта
вне заказов: она двигает сальдо, но не себестоимость.

### 📊 План без разбивки не раскладывается по категориям (24.08.2026)

Позиция сметы без строк состава даёт `plan_unbroken`, а в `plan_by` не попадает.
Раньше её `cost_total` падал в «Прочее», а факт по ней разносился настоящей категорией —
у ORD-024 разбивка показывала «Работы: план 0 / факт 16 000» и «Прочее: план 16 000 /
факт 0», два зеркальных перекоса, читавшихся как ошибка разноски. Итог плана прежний:
`plan_total = plan_detail_sum + plan_unbroken`. Сумма ПЛАНА категорий =
`cost_plan_estimate − plan_unbroken`. UI (`PlanFactDuel`, «Сводка П/Ф») показывает
неразобранный план отдельной строкой и не красит красным категории без плана.
Приписку вешать на `plan_unbroken > 0`, а не на `detailed` — `detailed` бывает true
при частично разобранной смете.

**`GET /api/orders` отдаёт `cost_fact`/`cost_delta`/`cost_coverage`** (колонки СЕБ. ПЛАН /
СЕБ. ФАКТ в списке). Факт берётся предрасчётом `_fact_costs` пачкой + `_transit_facts`
для транзита; `_order_delta` переведён на него же — раньше он звал `_plan_fact` на
каждый completed/in_production заказ (сотни запросов при limit=200).

### 📋 Обязательства: план ≠ долг (04.08.2026)

`_gen_obligations` при утверждении сметы создаёт `creditors` на каждую строку — это
**план закупок**, а не долг. В сальдо «Мы должны» идут только обязательства живых
заказов (`in_production`, `completed` до закрытия расчётов) и ручные без `order_id`;
остальные — вкладка «План по подрядчикам» (`get_creditors` отдаёт `scope=debt|plan`).
До этой правки план давал 550 158 ₽ из 812 112 ₽ «долга».

Остаток строки считает `backend/obligations.py::coverage` — деньги подрядчику уходят
расходами, а `creditors.paid` двигается только при разноске с тем же tx_id (отмечено
оплаченными 2%). Уровни покрытия: L1 `creditor_id` → L2 tx_id → L3 подрядчик в границах
заказа → L4 категория (**только подсказка `ambiguous`, из долга не вычитается**).
Признано = `max(paid, L1+L2) + L3` — max, а не сумма: `from-tx` поднимает `paid` И
создаёт расход с `creditor_id`, это один платёж.

🔒 **L3 никогда не попадает в `NOT EXISTS`-дедуп факта** (`_plan_fact` и пять его
собратьев). L1/L2 — «тот же платёж» по общему ключу; L3 — «похоже, тот же». Добавь L3
в факт — себестоимость просядет, маржа вырастет на пустом месте.

Перевод заказа в «Завершён» закрывает его обязательства (`_apply_status` →
`close_for_order`): без подтверждения — 409 со списком, Юра решает построчно.
Возврат в работу переоткрывает только `closed_reason='order_completed'`.

### ✅ Утверждение сметы: один гейт на все двери (24.08.2026)

Сделать смету актуальной можно двумя ручками — `POST /sets/{id}/approve` и
`PUT /sets/{id} {status:"approved"}` (обе доводят дело до `_approve_set`). Проверка
«в смете нет продажных цен — approve обнулит цену заказа» жила только в первой, и
редактор смет, ходивший через вторую, утверждал такую смету **молча одним кликом**.

Гейт вынесен в `estimates.py::_check_sellable(conn, set_id, force)` и стоит на обеих
дверях ДО смены статуса. **Новая дверь к approve — новый вызов `_check_sellable`.**
Обход возможен только явным `force=true` (у `SetUpdate` для этого есть поле `force`,
оно не колонка и обязано попадать под `fields.pop`).

**`POST /sets/{id}/unapprove` {confirm}** — честный откат. До него «Снять согласование»
меняло одну надпись: прочие сметы оставались `superseded`, `is_primary` — на этой,
план заказа — пересчитанным, обязательства — созданными.
- Что откатывает: статус → `draft`, снимает `is_primary`, поднимает сметы с
  `estimate_sets.superseded_by = этот сет` (миграция `ensure_supersede_trace_schema`;
  NULL у старых строк = «неизвестно кем», такие не трогаем), пересчитывает план заказа
  через `_resync_order_plan` — ту же функцию, что у переноса сметы.
- 🔒 **Обязательство, по которому прошли деньги, не удаляется никогда** (`paid > 0` или
  `obligations.coverage`): на нём держится факт себестоимости. Без `confirm` — 409 со
  списком `{restore_sets, obligations_delete, obligations_keep}`, форма ответа как у
  `orders._apply_status` → `obligations_unpaid`.

**Сводка П/Ф принимает `scope`**: `active` (дефолт) / `completed` / `all`; `cancelled` не
показывается никогда. У завершённого заказа прогноз бессмыслен — в строке есть `net_fact`
(`revenue − cost_fact − tax`, то же выражение, что в `_order_delta` для completed) и
`cash_collected_vs_cost`.

**`extra_id` у платежа** (`PaymentCreate`, `PayAllocation`) заполняется из интерфейса:
блок «Платежи клиента» в карточке заказа и строка разноски поступлений. До этого поле
принималось бэком, но не слалось фронтом — «оплачено» у допработы всегда было нулём.

### 💰 Себестоимость смет — costing-движок (22.07.2026)

Один резолвер «строка → источник цены» (`routers/costing.py`): рецептура каталога
(по `catalog_item_id`/правилу/имени, с живыми ценами) → материал по `material_code`
из прайсов → `price_book` → работа по `work_rates` → **missing** (вопрос с готовым `ask`).

```sql
work_rates(id, work_type_id, master_id NULL=дефолт, scheme, rate, unit, note, source)
-- scheme: fixed ₽/изделие | per_unit ₽/ед | hourly ₽/ч | percent (% от клиентской цены позиции)
work_rate_tiers(id, work_rate_id, min_qty, rate, note)  -- ступени по объёму партии
price_book(pattern, match_type, title, unit, price, source)   -- цены ВНЕ прайсов (фанера/ткань)
costing_rules(pattern, kind material|catalog|work, target_id) -- выученные сопоставления
-- catalog_item_lines дополнена material_code/work_type_id/master_id (привязки не теряются)
```

- `GET /api/estimates/sets/{id}/cost-check` (dry-run) / `POST .../cost-fill` (apply,
  `{expand_items, refresh_materials}`); UI — `components/CostingBlock.tsx` в редакторе сметы.
- **Ступени ставки по объёму** (12.08.2026): `work_rate_tiers` — берётся строка с
  наибольшим `min_qty <= объёму партии`, подходящей нет → базовая `work_rates.rate`
  (ставки без ступеней работают как раньше). Объём партии считает
  `rates.py::batch_qty`: per_unit/hourly — qty строки × количество изделий позиции
  (8 гибов × 5 стульев = 40), fixed/percent — количество изделий. Единая точка
  чтения — `rates.py::effective_rate`, ставку в цену больше нигде напрямую не брать.
- Обучение: ручная цена работы в строке и approve сметы пишут learned-записи;
  **ручное (source=manual) не перетирается** — upsert'ы с overwrite=False.
- Bootstrap ставок: `POST /api/work-rates/bootstrap` (вики analytics + история creditors).
- BOM из Blender: `POST /api/catalog/import-bom`, контракт в `docs/bom-contract.md`.
- Финагент: `firma.py cost-check/cost-fill/rate-set/price-set/rates` (сценарий в его CLAUDE.md).

**Сметы извне — только через API, не в SQLite.** `POST /api/estimates/sets/full` (сет +
позиции одним запросом) — единственная точка входа для агентов; с 05.08.2026 на неё
переведён `production.py estimate-create`, прямая запись смет в базу оттуда убрана
(перенос сметы в другой заказ — `POST /api/estimates/sets/{id}/move {order_id, confirm}`
или `order_id` в PUT сета: едут обязательства по строкам, планы обоих заказов
пересчитываются, донор без смет НЕ удаляется — флаг `donor_empty` в ответе)
(своя копия формулы безнала уже разъезжалась с `money.py`). Цены за штуку —
`cost_unit` / `sale_unit` / `client_unit` (`client_unit` = «к оплате», безнал
разворачивается сервером через `cash_from_client`). **`markup` сервер в цену не
разворачивает**: `cost_total` — самостоятельное поле, и если вызывающий знает
себестоимость, её надо слать в том же запросе, а не дописывать вторым PUT.

### finance.db (ключевые таблицы)
```sql
transactions(id, bank, account, date, amount, direction, counterparty, purpose, doc_num)
-- direction: 'in' (поступление) / 'out' (списание), amount всегда положительный
-- id INTEGER (в отличие от UUID у ZenMoney) — при сравнении приводить к строке
receivables(id, client, invoice_num, amount, paid, finance_tx_id)
-- bank: 'tbank' (40802810400004306154) / 'sber' (40802810113000047460)
```

### analytics.db — вики подрядчиков (фин-агент)
```sql
contractors(id, name, type, specialization, status, pay_scheme, pay_rate, pay_note,
            prepay_pct, notes, mes_master_id)   -- mes_master_id = production masters.id (!)
contractor_events(id, contractor_id, event_type, order_number, amount, description, happened_at)
```
- `mes_master_id` хранит **`masters.id`**, а не `masters.mes_id` — на этом уже спотыкались.
- `contractor_events.event_type` (не `type`); `payment` там часто значит «к выплате»,
  а не «деньги ушли». **Не суммировать с expenses** — задвоит выплаты.
- Веб пишет туда только pay-поля (best-effort). **События из веба не писать** — историю
  ведёт фин-агент (`/opt/fin-agent/tools/contractors.py`).

---

## Структура бэкенда

```
backend/
  main.py        — FastAPI app, @app.on_event("startup") с миграциями, роутеры
  auth.py        — JWT (python-jose), bcrypt (passlib), 30-дневные токены
  db.py          — get_production() / get_finance() / get_zenmoney() / get_analytics()
                   get_analytics_ro() / get_materials() + все ensure_*_schema()
  routers/
    orders.py    — заказы, план-факт, лестница прибыли, CRUD расходов по заказу
    estimates.py — сметы: sets/items/lines, версии, счёт PDF, обязательства, каталог
    expenses.py  — разноска: inbox банк/ZenMoney, from-tx, откат группы
    payments.py  — инбокс ПОСТУПЛЕНИЙ банка → payments по заказам (from-tx, dismiss)
    costing.py   — себестоимость: cost-check/cost-fill (резолвер «заполнить или спросить»)
    rates.py     — справочники costing: work_rates, price_book, costing_rules, bootstrap
    finance.py   — баланс, ДДС, обязательства (creditors), дебиторка, фонды
    zenmoney.py  — личные финансы, _resolve_payee (правила сопоставления плательщиков)
    masters.py   — подрядчики: картотека + JOIN на вики analytics
    materials.py — номенклатура и живые прайсы поставщиков
    customers.py — клиенты, lookup по ИНН
    catalog.py   — каталог изделий и рецептуры
    taxes.py     — УСН 6%
    funds.py     — фонды (налоговый, зарплатный, ...)
    brands.py / business_units.py / work_types.py / payee_rules.py / admin.py / users.py / yos.py
```

**Схему менять только миграцией.** Паттерн: `ensure_*_schema()` в `db.py`
(`PRAGMA table_info` → `ALTER TABLE ... ADD COLUMN` только недостающих, идемпотентно),
затем импорт в `main.py:7` и вызов в `startup()`. Порядок вызовов = порядок в функции.

**Ключевые места в orders.py:**
- `_margin()` — лестница прибыли: выручка − себестоимость = валовая, − УСН 6%
  (только при `payment_type=bank`) = чистая. Единый источник, не дублировать выражением.
- `_plan_fact()` — план/факт по категориям + дедуп факта (см. инвариант выше).
- `_active_set()` — активная смета: approved, иначе последняя не-superseded.

---

## Структура фронтенда

```
frontend/src/
  App.tsx              — роуты (порядок как в сайдбаре)
  api.ts               — axios + JWT bearer interceptor + 401→/login; обёртки по домену
  auth.ts              — getToken/getUser/logout
  components/
    Layout.tsx         — бежевая рама + белый контейнер + сворачиваемый сайдбар (массив nav)
    ui/                — общий слой: Modal, Calc, Selects, DataTable, IconButton,
                         EmptyState, Loading, MetricCard, Num (MONO), priceMath
    TableFilters.tsx   — ColumnFilter / AmountFilter / PeriodFilter (контролируемые, строковые)
    EditModal.tsx      — общая форма правки (FieldDef) — клиенты и подрядчики
    PayeeRulesSection.tsx — правила сопоставления плательщиков
    ContractorDetail.tsx  — карточка подрядчика: контакты, оплата, история, расходы
    ExpenseModal.tsx   — форма расхода (4 категории + подсказка «это оплата обязательства?»)
    NavigationGuard.tsx— защита от ухода с несохранёнными правками
  pages/
    Dashboard.tsx      — сводка: полосы 2px, круговые SVG-индикаторы
    OrdersV2.tsx       — заказы: split-panel + вкладка «Сводка П/Ф»
    OrderDetail.tsx    — карточка заказа: финансы, план-факт, РАСХОДЫ (ФАКТ), платежи
    EstimateEditor.tsx — редактор сметы: позиции, строки, версии, счёт
    ExpensesInbox.tsx  — «Разноска»: неразнесённые списания банка и ZenMoney
    Contractors.tsx    — «Подрядчики»: картотека + вики (deep-link /contractors/:id)
    Customers.tsx      — клиенты
    Finance.tsx        — ДДС: баланс счетов, месячный график, транзакции
    ZenMoney.tsx       — личные финансы
    Debtors.tsx        — обязательства и дебиторка
    Catalog.tsx / Taxes.tsx / Funds.tsx / Brands.tsx / Admin.tsx / Login.tsx
```

`Orders.tsx` — legacy, в роутах не используется (актуальный экран — `OrdersV2.tsx`).

---

## Дизайн-система (строго соблюдать)

Референс: минималистичный B2B UI (Hue & Machine стиль).

**Цвета:**
```
#E8E4DA  — beige (внешний фон, outer frame)
#FFFFFF  — white (основной контейнер)
#E8592A  — orange accent (выделение, активные элементы, selected rows)
#1A1A1A  — text primary
#A89070  — text secondary / labels
#6B6355  — text muted
#EDEBE6  — border / divider
#F2EFE9  — row divider (тонкий)
#FAF8F5  — row hover
#4A7C59  — green (позитив: оплачено, поступления)
#8B3A3A  — red (негатив: долг, списания)
```

**Layout:**
- Outer div: `background: #E8E4DA`, `height: 100vh`, `padding: 36px 56px`, `box-sizing: border-box`
- Inner white container: `flex: 1`, `background: #FFFFFF`, `box-shadow: 0 2px 24px rgba(0,0,0,0.06)`
- Sidebar: 60px collapsed (icon-only) / 200px expanded, hamburger toggle, ВНУТРИ белого контейнера

**Правила вёрстки:**
- Все компоненты на **inline styles** (не Tailwind классы — они только в index.css базовых стилях)
- NO border-radius (все углы строго прямые)
- **shadcn/ui — опция, не обязанность (решение Юры 23.07.2026).** Свой стиль и своя библиотека
  `src/components/ui/` — главные. shadcn брать только когда элемент дорого писать руками:
  сложные диалоги, комбобоксы с поиском, календари, тосты. Ставится через
  `npx shadcn@latest add <name>` → ложится отдельно в `src/components/shadcn/` (алиас в
  `components.json`). Тема shadcn уже замаплена на ЭТУ дизайн-систему в `src/index.css`
  (primary = orange #E8592A, беж, `--radius: 0`, тёмной темы нет) — цвета руками не
  переопределять. Не нужен — не используй; сборке он не мешает.
- Таблицы: без карточек-обёрток, прямо на белой поверхности
- Заголовок страницы: `fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em"`
- Метки разделов: `fontSize: 11, color: "#A89070", letterSpacing: "0.06em"` — CAPS
- Thin progress bars: `height: 2px, background: #EDEBE6` + `div` внутри с цветом
- Circular indicators: SVG, r=26, strokeWidth=3.5, stroke-dasharray для прогресса

---

## MCP-инструменты для UI/UX (подключены 23.07.2026)

Какой инструмент когда:
- **shadcn MCP** — подбор и установка компонентов из реестра, когда решил взять готовый
  сложный элемент (см. «Правила вёрстки»: shadcn — опция).
- **Context7 MCP** — актуальная документация библиотек (React 19, Tailwind, TanStack Query,
  react-router 7). Незнакомый или сомнительный API → сначала Context7, не гадать по памяти.
- **Playwright MCP** — живой браузер. **Обязательный воркфлоу любой UI-задачи:**
  сделал → собрал и задеплоил → открыл страницу в Playwright → скриншот → сверил с
  дизайн-системой → поправил. Не сдавать UI-задачу, не посмотрев на результат глазами.
  Авторизация: JWT самоминтится из `auth.py` — как это делает `screenshot.cjs` (см. его код).
- **Magic MCP (21st.dev)** — генерация нестандартного UI-компонента по текстовому описанию,
  когда ни свой `ui/`, ни shadcn не подходят. Бета, у тарифа есть месячный лимит генераций —
  не жечь на мелочи, простое верстается руками.
- Figma MCP — не подключаем (решение Юры 23.07.2026), макетов в Figma нет.

---

## Деплой (критично — всегда так)

```bash
# Собрать фронтенд
cd /home/claude-runner/firma/frontend && npm run build

# Задеплоить (ОБЯЗАТЕЛЬНО rm -rf сначала — иначе старые bundle-файлы останутся)
sudo rm -rf /opt/firma/frontend/dist && cp -r dist /opt/firma/frontend/

# Перезапустить бэкенд (только если менял backend/)
sudo systemctl restart firma
```

---

## Расширение IG Outreach Logger (tools/ig-outreach-logger/)

Chrome-расширение (MV3) для фиксации рассылки дизайнерам в Instagram Direct.
**Сам сообщения не шлёт** — только логирует, кому уже написали.

**Цель / этапы:**
- Этап 1 (текущий, MVP): скрап списка переписок из DOM → запись в Google-таблицу
  через Apps Script Web App. Тест, что база формируется и данные вытаскиваются.
- Этап 2 (позже): тот же POST, но на backend pbpb.club вместо Sheets — меняется
  только URL приёмника в настройках расширения.

**Файлы:** `manifest.json`, `content.js` (скрап), `popup.html/js` (UI: фильтр →
Собрать → превью → Записать), `options.html/js` (URL таблицы + дефолты),
`apps-script.gs` (приёмник для Sheet, дедуп), `icons/` (оранжевый лого-звёздочка),
`README.md` (установка). Дизайн-план был в `~/.claude/plans/bright-wandering-wozniak.md`.

**Скрап Instagram — ключевые факты (выстрадано итерациями):**
- IG обфусцирует CSS-классы, строки инбокса — `div role="button"` БЕЗ href и БЕЗ
  @логина. Цепляться за классы/ссылки нельзя.
- Стратегия: ищем листовой элемент с текстом времени («2 ч.», «3 нед.», «8 июн.»),
  поднимаемся к строке (первая текстовая строка = имя), парсим имя/превью/время.
- **@логин из списка достать НЕЛЬЗЯ** (его нет в DOM). Ключ дедупа — отображаемое имя.
  Реальный @username — только заходя в каждый диалог (этап 2).
- **Парсинг времени:** НЕ использовать `\b` после кириллицы — в JS кириллица не `\w`,
  граница не срабатывает (был баг «дата = ?»). Использовать `(?![а-яёa-z])`.
- **Виртуализация:** в DOM только видимые строки → авто-скролл (галочка в popup):
  прокручиваем контейнер списка донизу, дособирая строки с дедупом.
- **Тестировать живой IG с сервера нельзя** (нет залогиненной сессии, headless блокён).
  Отладка — на машине Юры: в popup есть «⧉ Скопировать отладку для Клода» (копирует
  sample_html + распознанные поля в буфер), Юра присылает — по этому правим селекторы.

**Сборка и публикация архива (sudo с паролем НЕ нужен — см. ниже):**
```bash
cd /home/claude-runner/firma/tools
rm -f ig-outreach-logger.zip
python3 -c "import shutil;shutil.make_archive('ig-outreach-logger','zip','.','ig-outreach-logger')"
sudo /bin/cp ig-outreach-logger.zip /opt/firma/frontend/dist/ig-outreach-logger.zip
# скачивание (cache-bust ?v= меняй):  https://firma.yuranek.com/ig-outreach-logger.zip?v=N
```
- **Поднимать `version` в manifest.json при КАЖДОМ изменении** — Юра по номеру версии
  в `chrome://extensions` видит, что загрузилась свежая (главная проверка обновления).
- Файл в `dist/` сотрётся при деплое фронта (`rm -rf dist`) — это ок, ссылка разовая.

**Обновление у Юры:** `chrome://extensions` → Удалить старое → распаковать новый zip →
Загрузить распакованное → проверить номер версии → перезагрузить вкладку IG (Cmd+R,
обязательно — иначе content-script не встроится).

**Passwordless sudo в этой сессии** (NOPASSWD, точные пути обязательны):
`/bin/cp`, `/bin/rm`, `/bin/systemctl restart firma|fin-agent`,
`/bin/systemctl status firma|fin-agent`, `/bin/npm`, `pip/pip3`.
Прочий `sudo` (в т.ч. `sudo cp` без `/bin/`) требует пароль, которого нет.
`/opt/firma/frontend/dist` — root-owned, писать туда только через `sudo /bin/cp`.

---

## Операционка — общая память агентов (с 14.08.2026)

Общая лента координации всех агентов (Supabase yos-ops). Большинство задач Юры
начинается с тебя и уходит дальше в аналитику — **фиксируй передачи**, иначе
следующий агент не знает, откуда задача взялась. Ключи уже лежат в `~/.ops.env`;
нет прав на общую очередь — событие само ляжет в твой спул, YOS подметёт.

```bash
python3 /opt/ai-os/tools/ops.py subject order:ORD-034   # история решений — читать ПЕРЕД задачей
python3 /opt/ai-os/tools/ops.py log --kind handoff --actor firma \
    --subject order:ORD-034 --title "Схема смет расширена, дальше фин сверяет запросы"
python3 /opt/ai-os/tools/ops.py feed --days 7           # что происходило у всех
```

**Что писать** (`--actor firma` всегда): задача от Юры принята и уйдёт дальше →
`handoff`; изменение схемы/логики, влияющее на других → `fact`; вопрос, требующий
решения Юры → `question`. **Что не писать:** технику, деплой, рутинные правки —
для этого журнал. Денег и сумм в операционке нет — только ссылки на записи баз.

## Агенты на сервере (если нужны данные)

```bash
# Производство
python3 /opt/ai-os/tools/production.py stats
python3 /opt/ai-os/tools/production.py orders [--status X]
python3 /opt/ai-os/tools/production.py order ORD-002

# Финансы
python3 /opt/fin-agent/tools/dds.py cashflow
python3 /opt/fin-agent/tools/tbank.py balance
```

Полные CLAUDE.md агентов: `/opt/ai-os/CLAUDE.md`, `/opt/fin-agent/CLAUDE.md`

## Скиллы

Знание, нужное не в каждом запросе (порядок миграции схемы, разбор конкретного экрана,
чеклист релиза), выноси из этой шапки в скилл: `.claude/skills/<имя>/SKILL.md` в этом
каталоге. Шапка грузится целиком при каждом обращении, скилл — только когда подходит по
описанию.

**Описание — единственный механизм срабатывания**, тело скилла модель не видит, пока не
решит его вызвать. Формула из двух обязательных частей: «Использовать при …» (прямые задачи
словами Юры) и «Также когда …» (симптомы: «экран не открывается», «миграция не применилась»).
Подробности и обязательный набор `evals.json` — общий скилл **`skill-authoring`** в твоём
каталоге скиллов. Приёмка:
`python3 /opt/ai-os/tools/skill_evals.py gate --skill .claude/skills/<имя>`
