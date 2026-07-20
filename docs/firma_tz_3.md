# ТЗ на доработку Firma — часть 3: фактические траты, разноска, подрядчики

Составлено 20.07.2026 (YOS, согласовано с Юрой). Части 1–2 — `/opt/ai-os/docs/firma_tz.md`
(деньги: резервы, факт, алерты) и `/opt/ai-os/docs/firma_tz_2.md` (смета и pipeline).
Исполнитель — агент Claude Runner в этом репо (`/home/claude-runner/firma`).

**Цель этапа:** Юра заполняет прошлые фактические траты по заказам через веб —
вручную из карточки заказа и разноской банковских/ZenMoney-списаний — и Firma
запускается как рабочий инструмент с честной маржой по факту.

---

## Что уже сделано (НЕ дублировать)

Проверено по коду 20.07.2026:

- **Сметы** — `EstimateEditor.tsx` + `routers/estimates.py`: sets → items → lines,
  версии (`new-version`), материалы с живыми прайсами из materials.db, PDF-счёт,
  генерация обязательств (`create-obligations`), из/в каталог.
- **Калькулятор** — `components/ui/Calc.tsx` + `priceMath.ts`, порог наценки 1.8.
- **Заказчики** — `Customers.tsx` + `routers/customers.py`: полный CRUD + lookup-inn.
- **План/факт** — `orders.py::_plan_fact` (строка ~218) + экраны OrdersV2/OrderDetail.
- **Обязательства** — `Debtors.tsx`: creditors POST/PATCH (поле `paid`), `LinkTxModal`
  привязка к транзакциям банка/ZenMoney, `finance/transactions/suggest`.
- **API мастеров** — `routers/masters.py`: полный CRUD; вкладка «Исполнители» внутри
  `Customers.tsx` (компонент `MasterDetail`, ~строка 449) с pay-полями из вики
  analytics.db (PATCH уже пишет туда best-effort).
- Дубль смет ORD-023 наполовину устранён: смета от 08:01 уже `superseded`
  (id `6f94b93d-2e59-4029-895d-a5fbcf1cc432`), активная от 11:32 — `draft`
  (id `5472bbcc-c6b8-4d15-a779-8787ae590a4f`).

## Что НЕ делать (жёсткие ограничения)

1. **Не трогать механику банковских 13%** (`payment_type=bank`, `bank_pct`) и
   сходимость сметы со счётом до рубля — работает, ломать нельзя (ТЗ-2, задача 7).
2. **Не писать в `analytics.db.contractor_events` из веба** — историю событий ведёт
   только фин-агент (`/opt/fin-agent/tools/contractors.py`). Веб читает.
3. **Не мигрировать pay-поля в production.masters** — схемы оплаты остаются
   в analytics.db, читаем JOIN-ом (см. Задачу 18).
4. **Не менять существующие суммы план-факта задним числом**: после Задачи 16 регресс
   по ORD-023 и ORD-020 обязателен — цифры не должны измениться, пока нет связей.
5. Дизайн-система из CLAUDE.md строгая: inline styles, без border-radius, палитра,
   JetBrains Mono для чисел, `docs/code_rules.md` (в т.ч. запрет N+1 в списках).

---

## Задача 16 (главная). Внесение фактических трат через веб

**Проблема.** Таблицу `production.db.expenses` веб только читает
(`orders.py::_plan_fact`: факт = `SUM(expenses)` + `SUM(creditors.paid)` в «Прочее»).
Внести расход можно только через CLI фин-агента. Итог: 3 записи expenses на 23 заказа,
маржа считается «по мечте» (ТЗ-1, задача 2).

### 16.1. Миграция схемы

В `backend/db.py` — `ensure_expenses_schema()` по паттерну
`ensure_creditor_tx_link_schema`, вызов из `main.py`:

```sql
ALTER TABLE expenses ADD COLUMN source TEXT DEFAULT 'manual';  -- manual|bank|zenmoney
ALTER TABLE expenses ADD COLUMN creditor_id TEXT;      -- покрытое обязательство
ALTER TABLE expenses ADD COLUMN finance_tx_id TEXT;    -- транзакция банка
ALTER TABLE expenses ADD COLUMN zenmoney_tx_id TEXT;   -- транзакция ZenMoney
ALTER TABLE expenses ADD COLUMN group_id TEXT;         -- группа разнесённого расхода
```

### 16.2. Дедуп факта — ключевое решение

Один платёж не должен считаться фактом дважды (как expense И как оплаченное
обязательство). Правило в `_plan_fact`: `creditors.paid` попадает в факт, только если
обязательство НЕ покрыто расходом:

```sql
SELECT COALESCE(SUM(paid),0) FROM creditors c
WHERE c.order_id = ?
  AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.order_id = c.order_id AND (
        e.creditor_id = c.id
     OR (e.finance_tx_id IS NOT NULL AND e.finance_tx_id = c.finance_tx_id)
     OR (e.zenmoney_tx_id IS NOT NULL AND e.zenmoney_tx_id = c.zenmoney_tx_id)))
```

Плюс guard при создании: если у нового expense указан tx_id, совпадающий с
creditors.finance_tx_id / zenmoney_tx_id того же заказа — автоматически проставить
`creditor_id` (одна оплата = один факт, но в правильной категории вместо «Прочего»).

### 16.3. Эндпоинты (в `routers/orders.py`, паттерн payments)

```
GET    /api/orders/{order_id}/expenses              → {items, total, by_category}
POST   /api/orders/{order_id}/expenses              (ExpenseIn) → 201
PUT    /api/orders/{order_id}/expenses/{expense_id}
DELETE /api/orders/{order_id}/expenses/{expense_id}?with_group=true
```

```python
class ExpenseIn(BaseModel):
    title: str
    amount: float
    category: str = "other"          # material|work|delivery|other
    supplier: Optional[str] = None
    expense_date: Optional[str] = None   # YYYY-MM-DD, default today
    finance_tx_id: Optional[str] = None
    zenmoney_tx_id: Optional[str] = None
    creditor_id: Optional[str] = None
```

Legacy-категории в данных (`labor`, `test`) уже сводятся функцией `_bucket` — не чинить.

### 16.4. UI: блок «РАСХОДЫ (ФАКТ)» в OrderDetail.tsx

- Секция между ФИНАНСЫ и ПЛАТЕЖИ, стиль секции ПЛАТЕЖИ: label CAPS 10–11px #A89070,
  суммы MONO, строки с border-bottom #F2EFE9.
- Строка: дата, название, категория, поставщик, сумма, иконка-связь если есть tx,
  Trash (ConfirmModal).
- Форма (новый `components/ExpenseModal.tsx`): категория (4 корзины), поставщик
  (datalist из mastersApi.list()), сумма, дата; если у заказа есть обязательства
  с тем же поставщиком — подсказка «это оплата обязательства N?» (чекбокс →
  creditor_id).
- Чекбокс «разнести на несколько заказов» — см. Задачу 17.2.
- Инвалидация react-query: `order-detail`, `orders-v2`, `orders-plan-fact-summary`.
- Новый `expensesApi` в `api.ts` по образцу существующих обёрток.

**Критерий готовности:** открыл ORD-020 → добавил «Сварка (Малафеев) 17 000 ₽,
категория work» → факт и маржа в план-факте пересчитались сразу. Обязательство,
оплаченное через Debtors и затем привязанное как expense, в факте один раз.

---

## Задача 17. Разноска прошлых трат из банка и ZenMoney

**Проблема.** Прошлые траты уже лежат в выписках (`finance.db.transactions`,
`zenmoney.db`), но по заказам не разнесены. Вносить руками по памяти — потеря данных.

### 17.1. Экран «Разноска» (inbox списаний)

Новый роутер `backend/routers/expenses.py` (prefix `/api/expenses`), подключить
в `main.py`. Новая страница `frontend/src/pages/ExpensesInbox.tsx`, роут `/expenses`
в `App.tsx`, пункт «Разноска» в `Layout.tsx`.

```
GET /api/expenses/inbox?source=bank|zen&date_from&date_to&search&amount_min&amount_max&limit=100
```

- source=bank: `finance.transactions` WHERE direction='out'.
- source=zen: zenmoney, `outcome>0 AND income=0 AND deleted=0`.
- **Исключения (уже разнесённое не показывать)** — id транзакции встречается в:
  `expenses.finance_tx_id`, `expenses.zenmoney_tx_id`, `creditors.finance_tx_id`,
  `creditors.zenmoney_tx_id`, `zenmoney.zm_links`.
- Каждой строке — `payee_hint` (поставщик + категория) из `payee_rules`
  (паттерн — `routers/zenmoney.py::_resolve_payee`).

```
POST /api/expenses/from-tx
  {source, tx_id, title?, category, supplier?, expense_date?,
   allocations: [{order_id, amount}]}                       → 201
```

- Создаёт 1..N строк expenses (`source=bank|zenmoney`, tx-поля заполнены,
  `group_id` при N>1). supplier/дата — из транзакции, если не переданы.
- Валидация: Σ allocations = сумме транзакции (допуск копейки).
- Авто-`creditor_id` при совпадении tx (см. 16.2). 409, если tx уже разнесена.

```
DELETE /api/expenses/groups/{group_id}    — откат всей разноски одной поездки/платежа
```

UI: табы «ДДС (банк)» / «Личные» (стиль табов LinkTxModal из Debtors.tsx),
DataTable + TableFilters (период, сумма, контрагент). Клик по строке → раскрытие:
подсказки заказов через существующий `GET /api/orders/suggest?counterparty&amount`
(скоринг уже реализован, orders.py:~114) + форма с предзаполненной категорией из
payee_hint. После разноски строка исчезает из списка.

### 17.2. Транспорт между цехами (задача 14 из ТЗ-2)

Одна поездка = один расход, разнесённый на несколько заказов:

- В форме расхода (и в разноске) — выбор нескольких заказов, кнопка «Поровну»
  (деление на фронте) или суммы вручную.
- Все строки одной поездки получают общий `group_id`; удаление с `?with_group=true`
  или `DELETE /groups/{gid}` убирает все строки группы.

**Критерий готовности:** открыл «Разноску», увидел списание Ант Сервису из банка,
в два клика привязал к ORD-023 как material — расход появился в план-факте заказа,
транзакция из списка исчезла. Поездка 3 000 ₽ разнесена на ORD-023 + ORD-020
по 1 500 ₽.

---

## Задача 18. Страница «Подрядчики» — объединённая картотека

**Проблема.** API masters полный, но страницы-справочника нет: мастера создаются
«на лету» в смете, вкладка «Исполнители» спрятана внутри Клиентов. Схемы оплаты
и история — в вики фин-агента (analytics.db), в вебе видны частично.

**Решение по архитектуре: JOIN на чтение, без миграции полей.**
`production.masters` — картотека (имя, роль, контакты, специализация);
`analytics.contractors` (pay_scheme fixed/percent/per_unit/mixed, pay_rate,
prepay_pct, статус) и `contractor_events` — читаются по `mes_master_id`
(fallback — по имени). PATCH pay-полей best-effort в analytics уже реализован
в masters.py — переиспользовать.

### Backend (`routers/masters.py`)

- `list_masters`: агрегаты **пакетно, без N+1** (code_rules): contractors целиком
  в dict; `creditors` GROUP BY name; `expenses` GROUP BY supplier;
  `contractor_events` (type=payment) GROUP BY contractor_id.
  В строке: `pay_label`, `pay_scheme`, `wiki_status`, `paid_total`, `debt`.
- `get_master`: + `events` (последние 50), + expenses по supplier с номерами заказов
  (JOIN orders), + `paid_total`.
- `create_master`: best-effort INSERT в analytics.contractors с `mes_master_id`.
- Контрагенты analytics без пары в masters — отдать отдельным списком
  (`wiki_only: [...]`), в UI показать read-only секцией «Только в вики фин-агента».
  Не мигрировать автоматически.
- «Всего выплачено» = creditors.paid + expenses (production). `contractor_events`
  показывать отдельной секцией «История» и **не суммировать** с expenses —
  одна выплата бывает и там, и там (дубль).

### Frontend

- Новая `pages/Contractors.tsx`, роут `/contractors`, пункт «Подрядчики» в сайдбаре.
- Вынести `MasterDetail` + `MASTER_FIELDS` из `Customers.tsx` в
  `components/ContractorDetail.tsx`; из Клиентов вкладку «Исполнители» убрать
  (один вход), вернуть странице заголовок «Клиенты».
- Паттерн UI — как Customers: список слева (Имя / Роль / Специализация /
  Схема оплаты / Выплачено / Долг / Статус) + панель детали ~50% справа.
  В карточке: контакты, pay-поля (редактируемые), секции «ИСТОРИЯ» (events)
  и «РАСХОДЫ ПО ЗАКАЗАМ» (expenses по supplier).

**Критерий готовности:** в сайдбаре пункт «Подрядчики»; открыл Малафеева — вижу
ставку, все выплаты по заказам и историю из вики. Создание подрядчика из смет
работает как раньше.

---

## Задача 19. Разовые операции с данными

1. **ORD-023, смета 11:32** (`5472bbcc-c6b8-4d15-a779-8787ae590a4f`, статус draft):
   счёт 065-Н/26 по ней выставлен → предложить Юре перевести в `approved`
   (`PUT /api/estimates/sets/{id}`). **Спросить Юру перед выполнением** — approved
   замораживает смету. Superseded-версию от 08:01 оставить как историю.
2. **zm_links** (zenmoney, сейчас 1 строка) — разноска фин-агента, не создающая
   expenses. Inbox их исключает (17.1). Разовый импорт zm_links → expenses —
   отдельно согласовать с Юрой, в этот этап не входит.

---

## Задача 20. Актуализация CLAUDE.md

`/home/claude-runner/firma/CLAUDE.md` сильно отстал от кода (описаны 7 роутеров из 18,
6 страниц из 15). Обновить: разделы «Базы данных» (+analytics.db, materials.db; схемы
expenses с новыми колонками, creditors, masters/contractors), «Структура бэкенда»
(все роутеры), «Структура фронтенда» (все страницы + Contractors, ExpensesInbox).
Зафиксировать **правило дедупа факта** (16.2) как инвариант. Разделы дизайн-системы,
деплоя и IG-логгера не трогать. После правки — задеплоить копию:
`sudo /bin/cp /home/claude-runner/firma/CLAUDE.md /opt/firma/CLAUDE.md`.

---

## Задача 21. Устойчивость к конкурентному доступу к SQLite

Добавлено 20.07 по итогам аудита совместного доступа (в базы пишут одновременно:
Firma-сервис, фин-агент, YOS, кроны, headless-агенты inbox).

1. Во всех коннекторах `backend/db.py` (`get_production` / `get_finance` /
   `get_analytics` / `get_zenmoney` / `get_materials`) добавить `timeout=15` в
   `sqlite3.connect(...)` — это busy_timeout 15с. Сейчас дефолтные 5с: чужой
   массовый импорт кладёт запрос с «database is locked» (инцидент-прецедент 13.07).
2. `startup()` в `main.py` гоняет все `ensure_*`-миграции (PRAGMA table_info +
   ALTER, а `ensure_catalog_material_fk` — DROP/CREATE TABLE) при каждом рестарте
   сервиса — это writer-lock по живой production.db. Обернуть: константа
   `SCHEMA_VERSION` + `PRAGMA user_version`; если `user_version == SCHEMA_VERSION` —
   пропустить все ensure_*, иначе прогнать и поднять `user_version`. Новая
   миграция = +1 к константе.
3. В CLAUDE.md репо дописать: `timeout=15` обязателен для новых соединений;
   dev-backend против боевых баз не запускать (vite dev проксирует `/api`
   на боевой :8001 — dev-uvicorn не нужен); массовые вставки — чанками ≤500 строк.

**Критерий готовности:** рестарт firma в момент чужой записи не падает и не
блокирует; повторный рестарт не гоняет миграции (видно по времени старта в journalctl).

---

## Порядок работ и деплой

Последовательность: **16 → 17 → 18 → 19 → 20 → 21** (задачу 21 можно сделать и раньше — она независима). Коммитить по задаче (осмысленные
сообщения, `git log` читает человек через месяц).

После каждого этапа:

```bash
cd /home/claude-runner/firma/frontend && npm run build
sudo /bin/rm -rf /opt/firma/frontend/dist && sudo /bin/cp -r dist /opt/firma/frontend/
sudo /bin/systemctl restart firma        # только если менялся backend
```

Проверки:
- curl новых эндпоинтов на `127.0.0.1:8001` (JWT — см. auth).
- **Регресс план-факта**: `GET /api/orders/{id}` для ORD-023 и ORD-020 до/после
  Задачи 16 — суммы не изменились (связей ещё нет).
- Скриншоты: `npm run dev` в фоне + `node screenshot.cjs <route> <png>`
  (ходит на :5173, JWT минтит сам) — карточка заказа с расходами, «Разноска»,
  «Подрядчики».

## Риски

- **analytics.db пишут двое** (веб best-effort + фин-агент): только короткие
  транзакции с close() в finally; events из веба не писать.
- **SQLite-блокировки**: finance.db/zenmoney.db веб только читает; production.db —
  короткие транзакции (существующий паттерн).
- **Ручной двойной счёт** полностью не исключается (расход без привязки, дублирующий
  оплаченное обязательство) — закрывается подсказкой в форме (16.4) и правилом
  в CLAUDE.md; принудительную привязку не вводить (мешает быстрому вводу).

## Контекст данных (на 20.07.2026)

orders 23, customers 19, masters 18 (+20 в вики analytics), estimate_lines 148,
payments 4, **expenses 3** — наполнение факта и есть цель этапа. Известные факты
для проверки: ORD-020 сварка Малафеев 17 000 ₽; ORD-023 резка Ант Сервис 19 472 ₽
(уже в expenses — не задваивать при разноске).
