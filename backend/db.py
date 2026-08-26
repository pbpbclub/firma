import sqlite3
from pathlib import Path

PRODUCTION_DB = Path("/opt/ai-os/data/production.db")
FINANCE_DB = Path("/opt/fin-agent/data/finance.db")
ANALYTICS_DB = Path("/opt/fin-agent/data/analytics.db")
ZENMONEY_DB = Path("/opt/fin-agent/data/zenmoney.db")
MATERIALS_DB = Path("/opt/ai-os/data/materials.db")

# Канонический состав catalog_item_lines: сюда сходятся оба пути создания таблицы —
# миграции (ensure_catalog_material_fk / ensure_catalog_lines_costing_schema) и ленивый
# CREATE в routers/catalog.py::_ensure_tables. Пересоздание таблицы копирует только
# эти колонки, поэтому список должен оставаться полным.
CATALOG_LINE_COLUMNS = (
    "id", "item_id", "type", "title", "qty", "unit", "unit_price", "line_total",
    "material_id", "sort_order", "material_code", "work_type_id", "master_id",
)


def get_production():
    conn = sqlite3.connect(PRODUCTION_DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _backup_production(tag: str):
    """Копия production.db перед разовой миграцией.

    Через sqlite3-backup API, а не копированием файла: база в WAL, и `cp` унёс бы
    снимок без незачекпойнченного хвоста. Падать из-за бэкапа нельзя — миграции
    ниже аддитивные, поэтому неудачу только печатаем."""
    from datetime import datetime
    dest_dir = Path("/opt/ai-os/data/backups")
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"production-{tag}-{datetime.now():%Y%m%d_%H%M%S}.db"
        src = get_production()
        try:
            out = sqlite3.connect(dest)
            try:
                src.backup(out)
            finally:
                out.close()
        finally:
            src.close()
        print(f"[migration] бэкап production.db → {dest}")
        return dest
    except Exception as e:
        print(f"[migration] бэкап production.db не сделан ({tag}): {e}")
        return None


def get_finance():
    conn = sqlite3.connect(FINANCE_DB)
    conn.row_factory = sqlite3.Row
    return conn


def get_analytics():
    """Вики фин-агента. Может быть недоступна на запись — см. get_analytics_ro().

    Базу держит фин-агент; веб пишет в неё только best-effort (pay-поля мастеров).
    Все вызовы обязаны быть в try/except: падать из-за чужой БД нельзя."""
    conn = sqlite3.connect(ANALYTICS_DB)
    conn.row_factory = sqlite3.Row
    return conn


def get_analytics_ro():
    """Чтение вики, устойчивое к WAL.

    analytics.db переведена фин-агентом в journal_mode=wal, а сайдкары
    analytics.db-wal/-shm принадлежат root без ACL для нашего пользователя.
    SQLite открывает их даже при mode=ro, поэтому обычный connect падает
    с «unable to open database file». immutable=1 читает файл напрямую,
    минуя WAL: для справочника подрядчиков этого достаточно, но свежие
    незачекпойнченные записи фин-агента могут быть не видны."""
    conn = None
    try:
        conn = sqlite3.connect(f"file:{ANALYTICS_DB}?mode=ro", uri=True)
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1")
    except sqlite3.OperationalError:
        if conn is not None:
            try:
                conn.close()  # иначе первый хэндл течёт на каждом заблокированном WAL
            except Exception:
                pass
        conn = sqlite3.connect(f"file:{ANALYTICS_DB}?immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def get_zenmoney():
    conn = sqlite3.connect(ZENMONEY_DB)
    conn.row_factory = sqlite3.Row
    return conn


def get_materials():
    """Единая номенклатура + живые прайсы поставщиков (materials.db, read-only)."""
    conn = sqlite3.connect(f"file:{MATERIALS_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_customer_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(customers)").fetchall()}
        if not existing:
            return          # таблицы нет (чистая база) — ALTER'ить нечего
        # master_id — тот же человек в картотеке подрядчиков (клиент бывает и мастером).
        for column in ("wiki_ref", "finagent_ref", "source", "status", "telegram", "instagram",
                       "whatsapp", "master_id"):
            if column not in existing:
                conn.execute(f"ALTER TABLE customers ADD COLUMN {column} TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_orders_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()}
        if not existing:
            return
        if "brand" not in existing:
            conn.execute("ALTER TABLE orders ADD COLUMN brand TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_order_reserve_schema():
    """Резерв предоплаты под материалы (ТЗ-1 задача 1).

    reserved_amount — сколько отложено под закупку, тратить нельзя.
    reserve_released_at — когда закупка проведена и резерв снят.
    Активный резерв (вычитается из «свободных денег») = reserved_amount > 0
    AND reserve_released_at IS NULL."""
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()}
        if not existing:
            return
        for col in ("reserved_amount REAL DEFAULT 0", "reserve_released_at TEXT"):
            name = col.split()[0]
            if name not in existing:
                conn.execute(f"ALTER TABLE orders ADD COLUMN {col}")
        conn.commit()
    finally:
        conn.close()


def ensure_catalog_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(catalog_items)").fetchall()}
        if existing and "brand" not in existing:
            conn.execute("ALTER TABLE catalog_items ADD COLUMN brand TEXT")
            conn.commit()
    finally:
        conn.close()


def ensure_estimate_items_schema():
    conn = get_production()
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if "estimate_items" not in tables:
            return
        existing = {r[1] for r in conn.execute("PRAGMA table_info(estimate_items)").fetchall()}
        for col in ("brand", "catalog_item_id"):
            if col not in existing:
                conn.execute(f"ALTER TABLE estimate_items ADD COLUMN {col} TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_order_settlement_schema():
    """«Расчёты с клиентом закрыты» (решение Юры 26.08.2026). Завершённый заказ с
    непривязанными платежами висел бы в «Нам должны» вечно; единственный обходной
    путь — discount — режет выручку и маржу во всех отчётах. settled_at — долг
    клиента не считается, цена/платежи/маржа не меняются; settled_note — почему
    (не привязали, взаимозачёт, безнадёжно)."""
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()}
        if existing:
            if "settled_at" not in existing:
                conn.execute("ALTER TABLE orders ADD COLUMN settled_at TEXT")
            if "settled_note" not in existing:
                conn.execute("ALTER TABLE orders ADD COLUMN settled_note TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_order_discount_schema():
    """Скидка — договорённость в конце сделки (Спираль: «22 500 он не будет
    доплачивать»). Живёт на заказе, смету-документ не перекраивает:
    к оплате = живая цена сметы − discount."""
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()}
        if existing:
            if "discount" not in existing:
                conn.execute("ALTER TABLE orders ADD COLUMN discount REAL DEFAULT 0")
            if "discount_note" not in existing:
                conn.execute("ALTER TABLE orders ADD COLUMN discount_note TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_payment_zenmoney_schema():
    """Платёж на личную карту связывается с транзакцией ZenMoney, как банковский
    с finance (bank_tx_id): происхождение видно, дедуп с zm_links работает,
    и УСН считается только с банковской части смешанной оплаты."""
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(payments)").fetchall()}
        if existing and "zenmoney_tx_id" not in existing:
            conn.execute("ALTER TABLE payments ADD COLUMN zenmoney_tx_id TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_payment_channel_schema():
    """Канал платежа — прошли ли деньги через расчётный счёт.

    До 30.07.2026 признаком безнала был `bank_tx_id`, и это врало: у платежей,
    внесённых руками и фин-агентом, он пуст, а деньги при этом шли на р/с
    (4 оплаты счетов от ООО через Т-Банк, 383 000 ₽ — по эвристике «нет id = нал»).
    Обратный случай тоже: ORD-023 с активной сметой cash не начислял УСН вовсе
    на реально прошедшие 184 000 ₽. По одному tx_id канал не восстановить —
    нужно отдельное поле.

    channel: 'bank' (р/с, база УСН) | 'cash' (нал) | 'personal' (личная карта).
    NULL = не указан; в расчёте налога NULL трактуется КОНСЕРВАТИВНО как 'bank':
    недоначисленный УСН — налоговый риск, лишний резерв в фонде — просто деньги
    на счету. Бэкофилл только детерминированный (по source/tx_id); угадывать
    канал по тексту назначения нельзя — это ставит Юра или фин-агент.
    """
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(payments)").fetchall()}
        if existing and "channel" not in existing:
            conn.execute("ALTER TABLE payments ADD COLUMN channel TEXT")
            conn.execute(
                """UPDATE payments SET channel = 'bank'
                   WHERE bank_tx_id IS NOT NULL AND bank_tx_id <> ''
                      OR source IN ('bank', 'sber', 'bank-in', 'fin-agent')""")
            conn.execute(
                """UPDATE payments SET channel = 'personal'
                   WHERE channel IS NULL
                     AND (source = 'personal'
                          OR (zenmoney_tx_id IS NOT NULL AND zenmoney_tx_id <> ''))""")
        conn.commit()
    finally:
        conn.close()


def ensure_estimate_primary_schema():
    """Основная смета заказа — выбор Юры, а не дата.

    Раньше активной считалась последняя по created_at, и у «Mirra летка» карточка
    показывала смету на 10 000 вместо 326 490. Флаг перебивает дату; альтернативные
    сметы при этом остаются живыми черновиками (заказчик ещё выбирает), в отличие
    от keep-actual, который отправляет их в superseded."""
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(estimate_sets)").fetchall()}
        if existing and "is_primary" not in existing:
            conn.execute("ALTER TABLE estimate_sets ADD COLUMN is_primary INTEGER DEFAULT 0")
        conn.commit()
    finally:
        conn.close()


def ensure_estimate_bank_pct_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(estimate_items)").fetchall()}
        if existing and "bank_pct" not in existing:
            conn.execute("ALTER TABLE estimate_items ADD COLUMN bank_pct REAL DEFAULT 13")
            conn.commit()
    finally:
        conn.close()


def ensure_catalog_material_fk():
    conn = get_production()
    try:
        schema_row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name='catalog_item_lines'"
        ).fetchone()
        if not schema_row:
            return
        if "REFERENCES materials" in (schema_row[0] or ""):
            return
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='materials'"
        ).fetchone():
            # Номенклатуру в production.db заводит production-агент. Пока её нет,
            # вешать FK нельзя: с PRAGMA foreign_keys=ON (см. get_production) ссылка
            # на отсутствующую таблицу роняет любой INSERT в catalog_item_lines.
            return
        # Перенос идёт ПОИМЕНОВАННО, а не `SELECT *`: позиционная копия верна только
        # для ровно той старой схемы, из которой миграция родилась. Таблица, созданная
        # роутером каталога на чистой базе, шире (material_code/work_type_id/master_id)
        # и в другом порядке — `SELECT *` там падает «10 columns but 13 values».
        existing = [r[1] for r in conn.execute("PRAGMA table_info(catalog_item_lines)").fetchall()]
        carried = [c for c in existing if c in CATALOG_LINE_COLUMNS]
        cols = ", ".join(carried)
        conn.executescript(f"""
            PRAGMA foreign_keys=OFF;
            CREATE TABLE catalog_item_lines_new (
                id            TEXT PRIMARY KEY,
                item_id       TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
                type          TEXT NOT NULL,
                title         TEXT NOT NULL,
                qty           REAL DEFAULT 1,
                unit          TEXT DEFAULT 'шт',
                unit_price    REAL DEFAULT 0,
                line_total    REAL DEFAULT 0,
                material_id   TEXT REFERENCES materials(id),
                sort_order    INTEGER DEFAULT 0,
                material_code TEXT,
                work_type_id  TEXT,
                master_id     TEXT
            );
            INSERT INTO catalog_item_lines_new ({cols}) SELECT {cols} FROM catalog_item_lines;
            DROP TABLE catalog_item_lines;
            ALTER TABLE catalog_item_lines_new RENAME TO catalog_item_lines;
            PRAGMA foreign_keys=ON;
        """)
        conn.commit()
    finally:
        conn.close()


def ensure_creditor_tx_link_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(creditors)").fetchall()}
        if not existing:
            return
        for col in ("finance_tx_id", "zenmoney_tx_id"):
            if col not in existing:
                conn.execute(f"ALTER TABLE creditors ADD COLUMN {col} TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_expenses_schema():
    """Фактические траты из веба: источник, привязки к обязательству/транзакции, группа разноски.

    master_id — точная связь с подрядчиком: supplier остаётся текстом («Ант Сервис
    (Денис Мельничук)»), и по нему агрегировать нельзя — он не совпадает с именем мастера."""
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(expenses)").fetchall()}
        if not existing:
            return
        cols = {
            "source": "TEXT DEFAULT 'manual'",   # manual|bank|zenmoney
            "creditor_id": "TEXT",               # покрытое обязательство (дедуп факта)
            "finance_tx_id": "TEXT",             # транзакция банка
            "zenmoney_tx_id": "TEXT",            # транзакция ZenMoney
            "group_id": "TEXT",                  # группа разнесённого расхода (одна поездка)
            "master_id": "TEXT",                 # подрядчик из production.masters
            # Наличный контур (ТЗ cash_expenses 24.07.2026): NULL = безнал/банк,
            # 'cash_fund' = из кассы наличных, 'accountable' = оплатило подотчётное лицо.
            "payment_source": "TEXT",
            "accountable_person_id": "TEXT",     # masters.id подотчётного лица
        }
        for col, decl in cols.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE expenses ADD COLUMN {col} {decl}")
        conn.commit()
    finally:
        conn.close()


def ensure_cash_schema():
    """Наличный контур (ТЗ cash_expenses, 24.07.2026).

    Касса — фонд kind='cash': физические наличные ВНЕ банка, из «свободных денег»
    банка НЕ вычитается (в отличие от фондов-резервов). fund_transactions.expense_id
    связывает списание кассы с расходом (наличная оплата поставщику = expense +
    fund-out одной операцией; удаление расхода подчищает движение кассы).
    accountable_ops — выдачи/возвраты под отчёт: выдача подотчётному лицу — НЕ
    расход по заказу (расход возникает при оплате поставщику), баланс лица =
    выдачи − возвраты − его оплаты (expenses.payment_source='accountable')."""
    conn = get_production()
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        # funds.kind: 'reserve' (резерв поверх банка) | 'cash' (физическая касса)
        if "funds" in tables:
            existing = {r[1] for r in conn.execute("PRAGMA table_info(funds)").fetchall()}
            if "kind" not in existing:
                conn.execute("ALTER TABLE funds ADD COLUMN kind TEXT DEFAULT 'reserve'")
            cash = conn.execute("SELECT id FROM funds WHERE kind = 'cash'").fetchone()
            if not cash:
                import uuid as _uuid
                conn.execute(
                    "INSERT INTO funds (id, name, description, color, kind) VALUES (?, ?, ?, ?, 'cash')",
                    (str(_uuid.uuid4()), "Касса (наличные)", "Физические наличные — вне банковских счетов", "#6B6355"),
                )
        if "fund_transactions" in tables:
            existing = {r[1] for r in conn.execute("PRAGMA table_info(fund_transactions)").fetchall()}
            if "expense_id" not in existing:
                conn.execute("ALTER TABLE fund_transactions ADD COLUMN expense_id TEXT")
        # Подотчётные лица — флаг на мастере (Эдуард Малафеев — первый).
        existing = {r[1] for r in conn.execute("PRAGMA table_info(masters)").fetchall()}
        if existing and "is_accountable" not in existing:
            conn.execute("ALTER TABLE masters ADD COLUMN is_accountable INTEGER DEFAULT 0")
            conn.execute("UPDATE masters SET is_accountable = 1 WHERE name = 'Эдуард Малафеев'")
        # Реквизиты контрагента-организации: поставщик — та же картотека, роль различает
        # (masters.role = Мастер | Подрядчик | Поставщик). price_supplier — код прайса
        # materials.db ('vrep'/'metplus') для метки свежести цен.
        if existing:
            for col in ("inn", "full_name", "contact", "website", "price_supplier"):
                if col not in existing:
                    conn.execute(f"ALTER TABLE masters ADD COLUMN {col} TEXT")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS accountable_ops (
                id             TEXT PRIMARY KEY,
                master_id      TEXT NOT NULL,
                kind           TEXT NOT NULL,          -- issue (выдача) | return (возврат)
                amount         REAL NOT NULL,
                date           TEXT DEFAULT (date('now')),
                finance_tx_id  TEXT,                   -- перевод из банка (выдача из Разноски)
                zenmoney_tx_id TEXT,
                note           TEXT,
                created_at     TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.commit()
    finally:
        conn.close()


def ensure_creditor_estimate_item_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(creditors)").fetchall()}
        if existing and "estimate_item_id" not in existing:
            conn.execute("ALTER TABLE creditors ADD COLUMN estimate_item_id TEXT")
            conn.commit()
    finally:
        conn.close()


def ensure_payee_rules_category_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(payee_rules)").fetchall()}
        if existing and "category" not in existing:
            conn.execute("ALTER TABLE payee_rules ADD COLUMN category TEXT")
            conn.commit()
    finally:
        conn.close()


def ensure_order_tx_link_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()}
        if existing and "finance_tx_id" not in existing:
            conn.execute("ALTER TABLE orders ADD COLUMN finance_tx_id TEXT")
            conn.commit()
    finally:
        conn.close()


def ensure_receivable_tx_link_schema():
    conn = get_finance()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(receivables)").fetchall()}
        if existing and "finance_tx_id" not in existing:
            conn.execute("ALTER TABLE receivables ADD COLUMN finance_tx_id TEXT")
            conn.commit()
    finally:
        conn.close()


def ensure_estimate_lines_contractor_schema():
    conn = get_production()
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if "estimate_lines" not in tables:
            return
        existing = {r[1] for r in conn.execute("PRAGMA table_info(estimate_lines)").fetchall()}
        for col in ("master_id TEXT", "contractor_name TEXT"):
            name = col.split()[0]
            if name not in existing:
                conn.execute(f"ALTER TABLE estimate_lines ADD COLUMN {col}")
        conn.commit()
    finally:
        conn.close()


def ensure_estimate_lines_price_schema():
    """Заморозка цены материала в строке сметы: поставщик + дата прайса (material_id уже есть)."""
    conn = get_production()
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if "estimate_lines" not in tables:
            return
        existing = {r[1] for r in conn.execute("PRAGMA table_info(estimate_lines)").fetchall()}
        # material_code — код живой номенклатуры (materials.db); отдельно от legacy material_id (FK на production.db materials)
        for col in ("material_code TEXT", "price_supplier TEXT", "price_date TEXT"):
            name = col.split()[0]
            if name not in existing:
                conn.execute(f"ALTER TABLE estimate_lines ADD COLUMN {col}")
        conn.commit()
    finally:
        conn.close()


def ensure_creditors_plan_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(creditors)").fetchall()}
        if not existing:
            return
        for col in ("estimate_line_id TEXT", "amount_plan REAL"):
            name = col.split()[0]
            if name not in existing:
                conn.execute(f"ALTER TABLE creditors ADD COLUMN {col}")
        conn.commit()
    finally:
        conn.close()


def ensure_fixed_obligations_schema():
    """Постоянные обязательства: шаблоны + месячные экземпляры в creditors (kind='fixed')."""
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(creditors)").fetchall()}
        for col in ("kind TEXT", "period TEXT", "fixed_id TEXT"):
            name = col.split()[0]
            if existing and name not in existing:
                conn.execute(f"ALTER TABLE creditors ADD COLUMN {col}")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fixed_obligations (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                amount     REAL NOT NULL,
                pay_day    INTEGER,
                note       TEXT,
                active     INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


_SEED_WORK_TYPES = [
    "Сварка", "Гибка", "Трубогиб", "Лазерная резка",
    "Порошковая покраска", "Покраска",
    "Столярные работы", "ЛДСП / корпусная мебель", "Нержавейка",
    "Монтаж", "Электрика", "Стекло / зеркала",
    "Доставка", "Сборка металла",
]


def ensure_work_types_schema():
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS work_types (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL UNIQUE,
                sort_order  INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS master_work_types (
                master_id     TEXT NOT NULL,
                work_type_id  TEXT NOT NULL,
                PRIMARY KEY (master_id, work_type_id)
            )
        """)
        # estimate_lines.work_type_id
        existing = {r[1] for r in conn.execute("PRAGMA table_info(estimate_lines)").fetchall()}
        if existing and "work_type_id" not in existing:
            conn.execute("ALTER TABLE estimate_lines ADD COLUMN work_type_id TEXT")

        # Seed work types if table is empty
        import uuid as _uuid
        count = conn.execute("SELECT COUNT(*) FROM work_types").fetchone()[0]
        if count == 0:
            for i, name in enumerate(_SEED_WORK_TYPES):
                conn.execute(
                    "INSERT OR IGNORE INTO work_types (id, name, sort_order) VALUES (?, ?, ?)",
                    (str(_uuid.uuid4()), name, i)
                )
            conn.commit()
            # Auto-link masters to work types by specialization keyword match
            # (картотеку мастеров ведёт production-агент: на чистой базе её ещё нет)
            wt_rows = conn.execute("SELECT id, name FROM work_types").fetchall()
            has_masters = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='masters'").fetchone()
            masters = conn.execute(
                "SELECT id, specialization FROM masters WHERE specialization IS NOT NULL AND specialization != ''"
            ).fetchall() if has_masters else []
            for m in masters:
                spec = (m["specialization"] or "").lower()
                for wt in wt_rows:
                    # match on first significant word of work type name
                    key = wt["name"].split(" / ")[0].split()[0].lower()
                    if key and key in spec:
                        conn.execute(
                            "INSERT OR IGNORE INTO master_work_types (master_id, work_type_id) VALUES (?, ?)",
                            (m["id"], wt["id"])
                        )
        conn.commit()
    finally:
        conn.close()


_SEED_BRANDS = [
    {
        "name": "MeRA", "color": "#2E6DA4", "sort_order": 0,
        # Подпись бренда — канон Юры от 07.08.2026 (вики фин-агента, Глоссарий).
        # «изделия из металла на заказ» / «индивидуальное производство» не используем.
        "description": "Mera · проектное производство. Металлокаркас: сварка, гибка, порошковая покраска, нержавейка — по чертежам и сметам. Клиенты: рестораны, кафе, дизайнеры, компании.",
        "positioning": "Производство под ключ: сварка, гибка, порошковая покраска, нержавейка. Работа по чертежам и сметам.",
    },
    {
        "name": "pbpb", "color": "#7B4F9E", "sort_order": 1,
        "description": "PBPB Mebel Club — дизайнерский / ритейл-бренд авторской мебели. Продвижение через Instagram и сайт pbpb.club.",
        "positioning": "Готовые дизайнерские изделия и коллекции, прямые продажи частным клиентам, сильный визуальный бренд.",
    },
    {
        "name": "Транзит", "color": "#3D8C6B", "sort_order": 2,
        "description": "Транзитные / посреднические заказы: перепродажа, логистика, агентские сделки.",
        "positioning": "Сделки, проходящие через ИП как посредника без собственного производства.",
    },
]


def ensure_brands_schema():
    import uuid as _uuid
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS brands (
                id          TEXT PRIMARY KEY,
                name        TEXT UNIQUE NOT NULL,
                color       TEXT,
                full_name   TEXT,
                inn         TEXT,
                account     TEXT,
                description TEXT,
                positioning TEXT,
                notes       TEXT,
                sort_order  INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (datetime('now'))
            )
        """)
        count = conn.execute("SELECT COUNT(*) FROM brands").fetchone()[0]
        if count == 0:
            for b in _SEED_BRANDS:
                conn.execute(
                    """INSERT OR IGNORE INTO brands (id, name, color, description, positioning, sort_order)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (str(_uuid.uuid4()), b["name"], b["color"], b["description"], b["positioning"], b["sort_order"])
                )
        conn.commit()
    finally:
        conn.close()


def normalize_catalog_brands():
    """Канонизация регистра бренда позиций каталога к brands.name.

    В данных встречались варианты по регистру ('PBPB' vs канонический 'pbpb'):
    Catalog.tsx группирует по сырому тексту → один бренд задваивался в фильтре и
    красился не тем цветом. Приводим любой регистрозависимый вариант к точному
    имени из таблицы brands. Идемпотентно (после прогона совпадающие исключены);
    страхует и будущие BOM-импорты. Требует, чтобы brands уже был засеян
    (вызывать ПОСЛЕ ensure_brands_schema)."""
    conn = get_production()
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if "catalog_items" not in tables or "brands" not in tables:
            return
        conn.execute("""
            UPDATE catalog_items
               SET brand = (SELECT b.name FROM brands b WHERE lower(b.name) = lower(catalog_items.brand))
             WHERE brand IS NOT NULL
               AND brand NOT IN (SELECT name FROM brands)
               AND EXISTS (SELECT 1 FROM brands b WHERE lower(b.name) = lower(catalog_items.brand))
        """)
        conn.commit()
    finally:
        conn.close()


def ensure_suppliers_schema():
    """Поставщики материалов — категория вики. Опциональный price_supplier хранит код
    прайса materials.db ('vrep'/'metplus'), чтобы показывать метку ВРЭП/Металлинвест."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS suppliers (
                id             TEXT PRIMARY KEY,
                name           TEXT UNIQUE NOT NULL,
                full_name      TEXT,
                inn            TEXT,
                category       TEXT,
                phone          TEXT,
                email          TEXT,
                contact        TEXT,
                telegram       TEXT,
                website        TEXT,
                price_supplier TEXT,
                notes          TEXT,
                status         TEXT,
                sort_order     INTEGER DEFAULT 0,
                created_at     TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.commit()
    finally:
        conn.close()


def ensure_business_units_schema():
    import uuid as _uuid
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS business_units (
                id          TEXT PRIMARY KEY,
                name        TEXT UNIQUE NOT NULL,
                kind        TEXT,
                inn         TEXT,
                full_name   TEXT,
                notes       TEXT,
                sort_order  INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id               TEXT PRIMARY KEY,
                business_unit_id TEXT,
                name             TEXT,
                number           TEXT,
                bank             TEXT,
                source           TEXT DEFAULT 'manual',
                manual_balance   REAL,
                sort_order       INTEGER DEFAULT 0,
                created_at       TEXT DEFAULT (datetime('now'))
            )
        """)
        if conn.execute("SELECT COUNT(*) FROM business_units").fetchone()[0] == 0:
            ip_id = str(_uuid.uuid4())
            fl_id = str(_uuid.uuid4())
            conn.execute(
                """INSERT INTO business_units (id, name, kind, full_name, inn, notes, sort_order)
                   VALUES (?, 'ИП Некрасов', 'ИП', 'ИП НЕКРАСОВ ЮРИЙ ВЛАДИМИРОВИЧ', '366409706709',
                           'ОГРНИП 320366800068510 · 394018, Воронеж, ул. Пушкинская, 18-37 · +7 920 405-14-88', 0)""",
                (ip_id,)
            )
            conn.execute("INSERT INTO business_units (id, name, kind, sort_order) VALUES (?, 'Физлицо Некрасов', 'Физлицо', 1)", (fl_id,))
            seed_accounts = [
                (ip_id, "Т-Банк р/с", "40802810400004306154", "tbank", "bank", 0),
                (ip_id, "Сбербанк р/с", "40802810113000047460", "sber", "bank", 1),
                (fl_id, "Личные карты", None, None, "zenmoney", 0),
            ]
            for bu, name, number, bank, source, so in seed_accounts:
                conn.execute(
                    "INSERT INTO accounts (id, business_unit_id, name, number, bank, source, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (str(_uuid.uuid4()), bu, name, number, bank, source, so)
                )
        # Idempotent: fill ИП Некрасов requisites if missing (existing installs)
        conn.execute(
            """UPDATE business_units
               SET full_name='ИП НЕКРАСОВ ЮРИЙ ВЛАДИМИРОВИЧ', inn='366409706709',
                   notes='ОГРНИП 320366800068510 · 394018, Воронеж, ул. Пушкинская, 18-37 · +7 920 405-14-88'
               WHERE name='ИП Некрасов' AND (inn IS NULL OR inn='')"""
        )
        conn.commit()
    finally:
        conn.close()


def ensure_payee_rules_schema():
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS payee_rules (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern     TEXT NOT NULL,
                match_type  TEXT NOT NULL DEFAULT 'exact',
                display_name TEXT,
                entity_type TEXT,
                entity_id   TEXT,
                entity_name TEXT,
                created_at  TEXT DEFAULT (datetime('now')),
                updated_at  TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.commit()
    finally:
        conn.close()


def ensure_work_rates_schema():
    """Справочник ставок работ: вид работ × исполнитель → цена.

    master_id IS NULL — дефолтная ставка вида работ. Схемы (те же, что в вики
    подрядчиков analytics.contractors): fixed ₽/изделие, per_unit ₽/ед, hourly ₽/ч,
    percent — % от клиентской цены позиции (в строку кладётся вычисленное).
    source: manual | wiki (bootstrap из analytics) | learned (из ручного ввода
    в смете) | history (из creditors)."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS work_rates (
                id           TEXT PRIMARY KEY,
                work_type_id TEXT NOT NULL,
                master_id    TEXT,
                scheme       TEXT NOT NULL DEFAULT 'per_unit',
                rate         REAL NOT NULL,
                unit         TEXT,
                note         TEXT,
                source       TEXT DEFAULT 'manual',
                created_at   TEXT DEFAULT (datetime('now')),
                updated_at   TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS ux_work_rates
            ON work_rates(work_type_id, IFNULL(master_id, ''))
        """)
        # variable=1 — «переменная» ставка-ориентир (себестоимость каждый раз разная):
        # cost-fill её НЕ подставляет молча, cost-check просит подтвердить цену
        # в каждой смете (prefill ориентиром). Решение Юры 23.07.2026.
        existing = {r[1] for r in conn.execute("PRAGMA table_info(work_rates)").fetchall()}
        if existing and "variable" not in existing:
            conn.execute("ALTER TABLE work_rates ADD COLUMN variable INTEGER DEFAULT 0")
        conn.commit()
    finally:
        conn.close()


def ensure_work_rate_tiers_schema():
    """Ступени ставки по объёму партии (ТЗ Юры 12.08.2026).

    Подрядчик по гибке берёт 450 ₽ за гиб на разовом изделии и 325 ₽ от 10 штук —
    одна цифра в work_rates занижала работу в полтора раза. Ступень выбирается
    строкой с наибольшим min_qty <= объёму партии; подходящей нет — базовая
    work_rates.rate, как раньше. Ставки без ступеней не меняются вовсе."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS work_rate_tiers (
                id           TEXT PRIMARY KEY,
                work_rate_id TEXT NOT NULL REFERENCES work_rates(id) ON DELETE CASCADE,
                min_qty      INTEGER NOT NULL,
                rate         REAL NOT NULL,
                note         TEXT,
                created_at   TEXT DEFAULT (datetime('now')),
                updated_at   TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS ux_work_rate_tiers
            ON work_rate_tiers(work_rate_id, min_qty)
        """)
        conn.commit()
    finally:
        conn.close()


def ensure_price_book_schema():
    """Выученные цены материалов ВНЕ прайсов materials.db (фанера, ткань, крепёж...).

    materials.db покрывает только металл; всё остальное система спрашивает у Юры
    один раз и запоминает здесь. pattern — нормализованное название (casefold,
    схлопнутые пробелы), как payee_rules."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS price_book (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern      TEXT NOT NULL,
                match_type   TEXT NOT NULL DEFAULT 'exact',
                title        TEXT,
                unit         TEXT,
                price        REAL NOT NULL,
                source       TEXT DEFAULT 'manual',
                note         TEXT,
                times_used   INTEGER DEFAULT 0,
                last_used_at TEXT,
                created_at   TEXT DEFAULT (datetime('now')),
                updated_at   TEXT DEFAULT (datetime('now')),
                UNIQUE(pattern, match_type)
            )
        """)
        conn.commit()
    finally:
        conn.close()


def ensure_costing_rules_schema():
    """Правила сопоставления для себестоимости (клон идеи payee_rules):
    kind='material' → target_id = код номенклатуры materials.db,
    kind='catalog'  → target_id = catalog_items.id (позиция сметы → рецептура),
    kind='work'     → target_id = work_types.id."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS costing_rules (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern    TEXT NOT NULL,
                match_type TEXT NOT NULL DEFAULT 'exact',
                kind       TEXT NOT NULL,
                target_id  TEXT NOT NULL,
                source     TEXT DEFAULT 'learned',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(pattern, kind)
            )
        """)
        conn.commit()
    finally:
        conn.close()


def ensure_catalog_lines_costing_schema():
    """Привязка строк рецептур каталога к номенклатуре и видам работ —
    чтобы разворот в смету (from-catalog / cost-fill) тянул живые цены,
    а to-catalog не терял связи."""
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(catalog_item_lines)").fetchall()}
        if not existing:
            # Таблицы ещё нет: PRAGMA по несуществующей молчит вместо ошибки, и без
            # этой проверки ALTER падает `no such table` прямо в startup. Таблицу
            # создаст роутер каталога — уже со всеми колонками (catalog.py::_ensure_tables).
            return
        cols = {
            "material_code": "TEXT",   # код номенклатуры materials.db
            "work_type_id": "TEXT",    # вид работ (labor/service)
            "master_id": "TEXT",       # плановый исполнитель
        }
        for col, decl in cols.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE catalog_item_lines ADD COLUMN {col} {decl}")
        conn.commit()
    finally:
        conn.close()


def ensure_general_expenses_schema():
    """Траты без заказа: запас, собственные образцы, общехозяйственное
    (ТЗ stock_and_samples, 01.08.2026).

    До этого `expenses.order_id` был NOT NULL, и трату «про запас» (нарезали логотипы
    впрок) записать было некуда: повесить на заказ — завысить его себестоимость,
    не записать — потерять деньги из учёта. Поэтому колонка становится NULLABLE,
    а назначение траты хранит `purpose`:
      stock    — материал/заготовка впрок, потом списывается в заказ датой ИСПОЛЬЗОВАНИЯ;
      sample   — собственный/тестовый экземпляр, выручки не будет никогда;
      overhead — общехозяйственное.
    `purpose` заполнен ТОЛЬКО у строк с order_id IS NULL — по этой паре и отличается
    «общий контур» от расхода заказа. `stock_parent_id` — ссылка списанной в заказ
    части на исходную запасовую строку (остаток запаса = amount родителя).

    NOT NULL в SQLite снимается только пересборкой таблицы — делаем её один раз
    и идемпотентно (проверка флага notnull в PRAGMA table_info)."""
    conn = get_production()
    try:
        info = conn.execute("PRAGMA table_info(expenses)").fetchall()
        if not info:
            return
        existing = {r[1] for r in info}
        for col in ("purpose", "stock_parent_id"):
            if col not in existing:
                conn.execute(f"ALTER TABLE expenses ADD COLUMN {col} TEXT")
                existing.add(col)
        order_col = next((r for r in info if r[1] == "order_id"), None)
        if order_col and order_col[3]:   # notnull == 1 → пересобрать
            cols = [r[1] for r in conn.execute("PRAGMA table_info(expenses)").fetchall()]
            decls = []
            for r in conn.execute("PRAGMA table_info(expenses)").fetchall():
                name, typ, notnull, dflt, pk = r[1], r[2] or "TEXT", r[3], r[4], r[5]
                d = f"{name} {typ}"
                if pk:
                    d += " PRIMARY KEY"
                elif notnull and name != "order_id":
                    d += " NOT NULL"
                if dflt is not None:
                    # PRAGMA отдаёт выражение без скобок ("datetime('now')"), а SQLite
                    # принимает выражение в DEFAULT только в скобках. Литералы — как есть.
                    lit = dflt.startswith(("'", '"')) or dflt.upper() in ("NULL", "TRUE", "FALSE")
                    try:
                        float(dflt)
                        lit = True
                    except ValueError:
                        pass
                    d += f" DEFAULT {dflt}" if lit else f" DEFAULT ({dflt})"
                decls.append(d)
            # DROP TABLE уносит ВСЁ, чего нет в PRAGMA table_info: индексы, триггеры,
            # UNIQUE-ограничения и остальные внешние ключи. Собираем их заранее и
            # восстанавливаем после переименования, иначе схема тихо деградирует.
            fks = {}
            for f in conn.execute("PRAGMA foreign_key_list(expenses)").fetchall():
                # (id, seq, table, from, to, on_update, on_delete, match)
                e = fks.setdefault(f[0], {"table": f[2], "from": [], "to": [],
                                          "on_update": f[5], "on_delete": f[6]})
                e["from"].append(f[3])
                if f[4] is not None:
                    e["to"].append(f[4])
            for e in fks.values():
                d = f"FOREIGN KEY ({', '.join(e['from'])}) REFERENCES {e['table']}"
                if e["to"]:
                    d += f" ({', '.join(e['to'])})"
                for act, kw in ((e["on_update"], "ON UPDATE"), (e["on_delete"], "ON DELETE")):
                    if act and act.upper() != "NO ACTION":
                        d += f" {kw} {act}"
                decls.append(d)
            if not any(e["from"] == ["order_id"] for e in fks.values()):
                decls.append("FOREIGN KEY (order_id) REFERENCES orders(id)")
            # Индексы и триггеры — их текст есть в sqlite_master как есть.
            restore = [r[0] for r in conn.execute(
                "SELECT sql FROM sqlite_master WHERE tbl_name = 'expenses' "
                "AND type IN ('index', 'trigger') AND sql IS NOT NULL").fetchall()]
            # UNIQUE, объявленный в CREATE TABLE, даёт авто-индекс без sql (origin='u') —
            # пересоздаём его явным CREATE UNIQUE INDEX по тем же колонкам.
            # (CHECK-ограничения SQLite через PRAGMA не отдаёт вовсе — их не восстановить.)
            for il in conn.execute("PRAGMA index_list(expenses)").fetchall():
                iname, uniq, origin = il[1], il[2], il[3]
                if origin != "u" or not uniq:
                    continue
                icols = [ii[2] for ii in conn.execute(f'PRAGMA index_info("{iname}")').fetchall()]
                if icols:
                    restore.append(
                        f'CREATE UNIQUE INDEX IF NOT EXISTS "uq_expenses_{"_".join(icols)}" '
                        f'ON expenses ({", ".join(icols)})')
            # PRAGMA foreign_keys переключается только вне транзакции, поэтому сначала
            # закрываем неявную (ALTER-ы выше), а INSERT→DROP→RENAME уходят одной
            # неявной транзакцией и коммитятся вместе: полупересобранной таблицы не будет.
            conn.commit()
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.execute("CREATE TABLE expenses_new (\n  " + ",\n  ".join(decls) + "\n)")
            names = ", ".join(cols)
            conn.execute(f"INSERT INTO expenses_new ({names}) SELECT {names} FROM expenses")
            conn.execute("DROP TABLE expenses")
            conn.execute("ALTER TABLE expenses_new RENAME TO expenses")
            for sql in restore:
                conn.execute(sql)
            conn.commit()
            conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_expenses_purpose ON expenses(purpose)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_expenses_stock_parent ON expenses(stock_parent_id)")
        conn.commit()
    finally:
        conn.close()


def ensure_order_extras_schema():
    """Допработы по заказу — работы сверх утверждённой сметы (ТЗ extra_works, 01.08.2026).

    Доп — НЕ новая версия сметы: та переписывает исходную договорённость и путает
    историю согласований. Это дополнение к ней: заводится в любой момент, в том числе
    по заказу в статусе completed (сдали → заказчик попросил доделать), статус заказа
    при этом не меняется, утверждённая смета остаётся нетронутой.

    price — сколько взяли с заказчика, cost — плановая себестоимость допа.
    Цена заказа = price_plan + Σ extras.price (см. orders.py::_margin), поэтому оплата
    допа перестаёт выглядеть переплатой, а его расходы не портят маржу основного заказа.
    payments.extra_id / expenses.extra_id — необязательная привязка «это по допу №N»."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS order_extras (
                id         TEXT PRIMARY KEY,
                order_id   TEXT NOT NULL,
                title      TEXT NOT NULL,
                price      REAL NOT NULL DEFAULT 0,
                cost       REAL NOT NULL DEFAULT 0,
                note       TEXT,
                created_by TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (order_id) REFERENCES orders(id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_order_extras_order ON order_extras(order_id)")
        for table in ("payments", "expenses"):
            info = conn.execute(f"PRAGMA table_info({table})").fetchall()
            if not info:
                # Таблицы ещё нет (чистая БД, порядок ensure_*): миграция обязана быть
                # no-op целиком — CREATE INDEX по несуществующей таблице уронил бы старт.
                continue
            if "extra_id" not in {r[1] for r in info}:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN extra_id TEXT")
            conn.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{table}_extra ON {table}(extra_id)")
        conn.commit()
    finally:
        conn.close()


def ensure_inbox_dismissed_schema():
    """Скрытые из инбокса транзакции (переводы между своими счетами, возвраты).

    finance.db веб только читает, флаг хранить негде — поэтому таблица здесь.
    source: 'bank-in' — инбокс поступлений (routers/payments.py); списания
    скрытия не используют (у них «разнесено» выводится из expenses/creditors)."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inbox_dismissed (
                tx_id      TEXT NOT NULL,
                source     TEXT NOT NULL,
                reason     TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (tx_id, source)
            )
        """)
        conn.commit()
    finally:
        conn.close()


# ─── Волна ЛЕСКОВО-1 (спека docs/superpowers/specs/2026-08-04-leskovo-adoption-design.md) ───

def ensure_unique_business_keys():
    """Б4: уникальные индексы на бизнес-ключи. Частичные (WHERE …) — NULL и пустая
    строка дублем не считаются: заказ без номера и клиент без ИНН легальны.

    На payments.bank_tx_id индекса НЕТ намеренно: одна банковская транзакция
    легально разносится на несколько платежей (from-tx, Суздаль/Спираль).

    Дубли в данных (например, база из старого бэкапа) не должны ронять startup:
    индекс тогда просто не создастся, сервис поднимется — лечится руками."""
    conn = get_production()
    try:
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        wanted = [
            ("orders", ("number",), "ux_orders_number",
             "CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_number ON orders(number) "
             "WHERE number IS NOT NULL"),
            ("estimate_sets", ("order_id", "number"), "ux_estimate_sets_order_number",
             "CREATE UNIQUE INDEX IF NOT EXISTS ux_estimate_sets_order_number "
             "ON estimate_sets(order_id, number) WHERE number IS NOT NULL"),
            ("materials", ("sku",), "ux_materials_sku",
             "CREATE UNIQUE INDEX IF NOT EXISTS ux_materials_sku ON materials(sku) "
             "WHERE sku IS NOT NULL AND sku != ''"),
            ("customers", ("inn",), "ux_customers_inn",
             "CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_inn ON customers(inn) "
             "WHERE inn IS NOT NULL AND inn != ''"),
        ]
        for table, cols, name, ddl in wanted:
            if table not in tables:
                continue
            existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if not all(c in existing for c in cols):
                continue   # узкая таблица из старого бэкапа — колонку доедет её миграция
            try:
                conn.execute(ddl)
            except sqlite3.IntegrityError:
                print(f"[db] Б4: индекс {name} не создан — в {table} есть дубли, разберите руками")
        conn.commit()
    finally:
        conn.close()


# Денежные таблицы, у которых правка строки должна быть видна (Б7).
_UPDATED_AT_TABLES = (
    "payments", "expenses", "creditors", "estimate_items",
    "estimate_lines", "customers", "masters",
)


def ensure_updated_at_schema():
    """Б7: updated_at через триггеры AFTER UPDATE — а не проставление в ручках.

    Триггер ловит ЛЮБУЮ запись, включая прямые INSERT/UPDATE агентов в базу мимо
    веба, — ради этого и выбран. ALTER ADD COLUMN без DEFAULT: SQLite не умеет
    неконстантный default в ADD COLUMN, поэтому у старых строк NULL = «не правили
    с момента миграции». Рекурсии нет: recursive_triggers в SQLite по умолчанию
    выключен. Пересборка таблиц (ensure_general_expenses_schema) триггеры
    восстанавливает из sqlite_master."""
    conn = get_production()
    try:
        for table in _UPDATED_AT_TABLES:
            info = conn.execute(f"PRAGMA table_info({table})").fetchall()
            if not info:
                continue
            if "updated_at" not in {r[1] for r in info}:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN updated_at TEXT")
            conn.execute(f"""
                CREATE TRIGGER IF NOT EXISTS trg_{table}_updated_at
                AFTER UPDATE ON {table}
                BEGIN
                    UPDATE {table} SET updated_at = datetime('now') WHERE id = NEW.id;
                END
            """)
        conn.commit()
    finally:
        conn.close()


def ensure_audit_log_schema():
    """A1: журнал изменений внутри production.db — пишет бэкенд на write-ручках
    (backend/audit.py). Журнал агентов (tools/audit.py, отдельная база) остаётся:
    он про их действия, этот — про правки через веб. changes — полный снимок
    строки ДО изменения (не diff: проще код, надёжнее восстановление)."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id          TEXT PRIMARY KEY,
                actor       TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id   TEXT,
                action      TEXT NOT NULL,
                summary     TEXT NOT NULL,
                changes     TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id, created_at)")
        conn.commit()
    finally:
        conn.close()


def ensure_match_trace_schema():
    """A4 + A3-лайт: след привязки платежа/расхода и группа разноски.

    match_status: 'manual' — привязал человек (все текущие пути), 'auto' —
    зарезервировано автопривязке фин-агента, 'confirmed' — авто, подтверждённое
    человеком. matched_by: 'inbox' (разноска из инбокса), 'order-card' (руками в
    карточке), 'rule:<id>' / 'suggest' — автопривязка. match_score 0..1 — если
    алгоритм её считает. У старых строк NULL — бэкфилл не выдумываем.

    payments.group_id — одна разноска from-tx на несколько заказов (у expenses
    поле уже есть): откат разноски целиком, показ «братских» платежей."""
    conn = get_production()
    try:
        for table in ("payments", "expenses"):
            info = conn.execute(f"PRAGMA table_info({table})").fetchall()
            if not info:
                continue
            existing = {r[1] for r in info}
            for col in ("match_status TEXT", "matched_by TEXT", "match_score REAL"):
                name = col.split()[0]
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col}")
            if table == "payments" and "group_id" not in existing:
                conn.execute("ALTER TABLE payments ADD COLUMN group_id TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_accountable_fund_link_schema():
    """Связь операции подотчёта с её движением кассы (24.08.2026).

    accountable.add_op пишет зеркальное движение в fund_transactions (выдал из кассы —
    минус кассе), но без всякой ссылки на операцию. Поэтому DELETE /accountable/ops/{id}
    убирал операцию и оставлял движение: баланс «на руках» пересчитывался, а остаток
    кассы — нет. Кнопку удаления в UI из-за этого выводить было нельзя.

    Тот же приём, что у расходов: fund_transactions.expense_id связывает движение с
    расходом (orders._sync_cash_fund). Здесь — accountable_op_id.

    NULL у старых движений: их операции удалить можно, но движение останется —
    delete_op честно скажет об этом флагом fund_unlinked."""
    conn = get_production()
    try:
        info = conn.execute("PRAGMA table_info(fund_transactions)").fetchall()
        if info and "accountable_op_id" not in {r[1] for r in info}:
            conn.execute("ALTER TABLE fund_transactions ADD COLUMN accountable_op_id TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_supersede_trace_schema():
    """След «кто погасил эту смету» — под честное рассогласование (24.08.2026).

    _approve_set помечает прочие сметы заказа superseded. Кнопка «Снять согласование»
    до этого только меняла статус: прочие сметы так и оставались superseded, is_primary
    оставался на рассогласованной, план заказа — пересчитанным. Чтобы откатить ровно то,
    что сделало ЭТО утверждение, нужно знать, какие сметы погасило именно оно: без следа
    откат не отличит их от погашенных прошлыми утверждениями и поднял бы лишние.

    NULL у старых строк — «неизвестно кем»: такие сметы unapprove не трогает."""
    conn = get_production()
    try:
        info = conn.execute("PRAGMA table_info(estimate_sets)").fetchall()
        if info and "superseded_by" not in {r[1] for r in info}:
            conn.execute("ALTER TABLE estimate_sets ADD COLUMN superseded_by TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_expense_settlement_schema():
    """A1 (ТЗ финагента 24.08.2026): у расхода по заказу два разных факта —
    «работа принята» (себестоимость заказа) и «деньги ушли мастеру» (движение по
    лицевому счёту). До этой колонки лицевой счёт считал выплатой ЛЮБОЙ расход,
    сопоставленный с мастером: разноска ORD-024 (16 000 + 8 000 Кебре) перевернула
    сальдо с «мы должны 1 800» на «должен отработать 22 200», хотя денег в тот день
    не переводили — работы были закрыты авансом и зачётом.

    settled_by — «чем закрыт этот расход»:
      cash (и NULL у старых строк) — деньги ушли ЭТИМ расходом  → ledger: payment
      offset       — взаимозачёт                                → ledger: offset
      advance      — закрыто ранее выданным авансом             → ledger: ничего
      third_party  — закрыто ранее сделанной оплатой за него    → ledger: ничего
      none         — работа принята, ещё должны                 → ledger: ничего

    Правило одной строкой: движение по лицевому счёту рождают только cash и offset;
    остальные значат «минус уже проведён в другом месте, здесь только себестоимость».

    На _plan_fact и obligations.coverage НЕ влияет: себестоимость растёт всегда,
    работа принята независимо от того, чем закрыта. Это и есть развод двух фактов.

    NULL у всех существующих строк ⇒ читается как cash ⇒ ни одно текущее сальдо и
    ни один текущий факт миграцией не меняются. Бэкфилла нет.

    Не путать с payment_source (откуда деньги: касса/подотчёт/безнал — осмысленно
    только при cash) и с purpose contractor_pay/contractor_third_party (те живут на
    расходах ВНЕ заказов, это сама выдача аванса / оплата за мастера)."""
    conn = get_production()
    try:
        info = conn.execute("PRAGMA table_info(expenses)").fetchall()
        if info and "settled_by" not in {r[1] for r in info}:
            # SQLite разрешает CHECK у ADD COLUMN — полная пересборка таблицы
            # (_rebuild_table_with_ddl) здесь не нужна.
            conn.execute(
                "ALTER TABLE expenses ADD COLUMN settled_by TEXT CHECK (settled_by IS NULL "
                "OR settled_by IN ('cash','advance','offset','third_party','none'))")
        conn.commit()
    finally:
        conn.close()


def ensure_rate_history_schema():
    """A2 (лёгкая версия): история ставок и наценок одной таблицей.

    kind: work_rate | price_book | catalog_markup. Пишется в точках изменения
    (rates.py upsert'ы, catalog.py markup) — до этого UPDATE затирал старое
    значение безвозвратно. Пересчёт «на дату» не строим: по ТЗ хватает факта
    «ставка менялась тогда-то», effective_from понадобится при сотнях заказов."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rate_history (
                id         TEXT PRIMARY KEY,
                kind       TEXT NOT NULL,
                target_id  TEXT NOT NULL,
                old_value  REAL,
                new_value  REAL NOT NULL,
                scheme     TEXT,
                changed_by TEXT,
                comment    TEXT,
                changed_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rate_history_target ON rate_history(kind, target_id, changed_at)")
        conn.commit()
    finally:
        conn.close()


def ensure_costing_version_schema():
    """A10: граница контуров себестоимости. Сметы до costing-движка (22.07.2026)
    считались по ценам, которых больше нет, — их маржу нельзя смешивать с новой.
    Бэкфилл по дате создания сета относительно запуска движка; дальше
    cost-fill/новые сеты помечаются catalog_v1 в коде."""
    conn = get_production()
    try:
        info = conn.execute("PRAGMA table_info(estimate_sets)").fetchall()
        if not info:
            return
        if "costing_version" not in {r[1] for r in info}:
            conn.execute("ALTER TABLE estimate_sets ADD COLUMN costing_version TEXT")
            conn.execute("""
                UPDATE estimate_sets SET costing_version =
                    CASE WHEN COALESCE(created_at, '') < '2026-07-22' THEN 'legacy'
                         ELSE 'catalog_v1' END
                WHERE costing_version IS NULL
            """)
        conn.commit()
    finally:
        conn.close()


def ensure_order_brand_id_schema():
    """Б2-лайт: бренд как связь, а не строка. brand_id с FK (ADD COLUMN с
    REFERENCES легален при NULL default), бэкфилл по совпадению с brands.name;
    текстовый brand остаётся на переходный период — UI шлёт его, бэкенд резолвит
    (orders.py). Пустой бренд (11 заказов) не выдумываем — разметит Юра."""
    conn = get_production()
    try:
        info = conn.execute("PRAGMA table_info(orders)").fetchall()
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if not info or "brands" not in tables:
            return
        if "brand_id" not in {r[1] for r in info}:
            conn.execute("ALTER TABLE orders ADD COLUMN brand_id TEXT REFERENCES brands(id)")
            conn.execute("""
                UPDATE orders SET brand_id =
                    (SELECT b.id FROM brands b WHERE b.name = orders.brand COLLATE NOCASE)
                WHERE brand IS NOT NULL AND brand != ''
            """)
        conn.commit()
    finally:
        conn.close()


_DECL_KEYWORDS = ("FOREIGN", "CHECK", "PRIMARY", "UNIQUE", "CONSTRAINT")


def _decls_from_table(conn, table: str, extra: dict | None = None,
                      not_null: tuple = (), defaults: dict | None = None) -> list[str]:
    """Декларации колонок из ФАКТИЧЕСКОЙ схемы таблицы (PRAGMA table_info).

    Зашитым в миграции остаётся только то, что она добавляет (FK/CHECK/UNIQUE/
    NOT NULL) — в production.db пишет не один агент, и колонка, добавленная
    кем-то другим, обязана пережить пересборку вместе с данными: зашитый список
    колонок молча удалил бы её (code_rules 04.08).

    extra — хвост декларации по имени колонки (REFERENCES/CHECK/UNIQUE);
    not_null/defaults — ограничения, которых в текущей схеме ещё нет."""
    extra, defaults = extra or {}, defaults or {}
    decls = []
    for c in conn.execute(f"PRAGMA table_info({table})").fetchall():
        name, ctype, notnull, dflt = c[1], c[2] or "TEXT", c[3], c[4]
        if name == "id":
            d = "id TEXT PRIMARY KEY"
        else:
            d = f"{name} {ctype}"
            if notnull or name in not_null:
                d += " NOT NULL"
            dv = dflt if dflt is not None else defaults.get(name)
            if dv is not None:
                # выражение-default (datetime('now')) обязано быть в скобках
                d += f" DEFAULT ({dv})" if "(" in str(dv) else f" DEFAULT {dv}"
        if name in extra:
            d += " " + extra[name]
        decls.append(d)
    return decls


def _decl_check(decl: str) -> str | None:
    """Выражение из CHECK(...) декларации колонки — по балансу скобок."""
    i = decl.upper().find("CHECK")
    if i < 0:
        return None
    j = decl.find("(", i)
    if j < 0:
        return None
    depth = 0
    for k in range(j, len(decl)):
        if decl[k] == "(":
            depth += 1
        elif decl[k] == ")":
            depth -= 1
            if depth == 0:
                return decl[j + 1:k]
    return None


def _rebuild_violations(conn, table: str, decls: list[str], common: list[str]) -> list[str]:
    """Данные, которые не переживут новые NOT NULL / CHECK / UNIQUE.

    Проверяем SELECT-ом по старой таблице ДО пересборки: `INSERT … SELECT` падает
    на первой же легаси-строке, а это стартовая миграция — вместе с ней падает
    весь сервис (code_rules 04.08). Легаси приводит к канону сама миграция;
    остаток — повод отказаться от пересборки и сказать об этом вслух."""
    problems = []
    for d in decls:
        col = d.strip().split()[0].strip('"')
        if col.upper() in _DECL_KEYWORDS:
            continue
        rest = d.strip()[len(col):]
        up = rest.upper()
        if col not in common:
            # новой NOT NULL-колонке INSERT … SELECT значения не даст
            if "NOT NULL" in up and "DEFAULT" not in up:
                problems.append(f"{col}: NOT NULL без DEFAULT, а колонки в таблице нет")
            continue
        if "NOT NULL" in up:
            n = conn.execute(f'SELECT COUNT(*) FROM {table} WHERE "{col}" IS NULL').fetchone()[0]
            if n:
                problems.append(f"{col}: NULL в {n} строк(ах) при NOT NULL")
        chk = _decl_check(rest)
        if chk:
            n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE NOT ({chk})").fetchone()[0]
            if n:
                problems.append(f"{col}: {n} строк(и) вне CHECK ({chk})")
        if "UNIQUE" in up or "PRIMARY KEY" in up:
            n = conn.execute(
                f'SELECT COUNT(*) FROM (SELECT "{col}" FROM {table} WHERE "{col}" IS NOT NULL '
                f'GROUP BY "{col}" HAVING COUNT(*) > 1)').fetchone()[0]
            if n:
                problems.append(f"{col}: {n} повторяющихся значений при UNIQUE/PK")
    return problems


def _rebuild_table_with_ddl(conn, table: str, decls: list[str]) -> bool:
    """Пересоздать таблицу с ЯВНЫМ DDL (Б1/Б8): единственный способ добавить FK
    и CHECK в SQLite. Реконструкция схемы из PRAGMA (ensure_general_expenses_schema)
    для этого не годится — CHECK-ограничения PRAGMA не отдаёт вовсе.

    Данные переносятся по именам колонок (пересечение старых и новых — узкая
    таблица из бэкапа доезжает); отброшенные колонки печатаются в лог. Индексы
    и триггеры восстанавливаются из sqlite_master. foreign_keys переключается
    вне транзакции; INSERT→DROP→RENAME коммитятся вместе — полупересобранной
    таблицы не бывает.

    Миграция стартовая, поэтому она НЕ имеет права уронить сервис: несовместимые
    данные и любой сбой пересборки = отказ с алертом и прежняя схема, а не
    исключение в startup(). CREATE идёт после DROP TABLE IF EXISTS {table}_new:
    он выполняется в автокоммите, и хвост прошлого сбоя иначе делает старт
    невозможным навсегда. Возвращает True, если таблица пересобрана."""
    old_cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    new_cols = []
    for d in decls:
        first = d.strip().split()[0].strip('"')
        if first.upper() not in _DECL_KEYWORDS:
            new_cols.append(first)
    common = [c for c in old_cols if c in new_cols]
    dropped = [c for c in old_cols if c not in new_cols]
    if dropped:
        print(f"[db] ВНИМАНИЕ: пересборка {table} отбрасывает колонки {dropped} с данными")
    problems = _rebuild_violations(conn, table, decls, common)
    if problems:
        print(f"[db] ОТКАЗ от пересборки {table}: данные не отвечают новым ограничениям — "
              + "; ".join(problems))
        return False
    restore = [r[0] for r in conn.execute(
        "SELECT sql FROM sqlite_master WHERE tbl_name = ? "
        "AND type IN ('index', 'trigger') AND sql IS NOT NULL", (table,)).fetchall()]
    for il in conn.execute(f"PRAGMA index_list({table})").fetchall():
        iname, uniq, origin = il[1], il[2], il[3]
        if origin != "u" or not uniq:
            continue
        icols = [ii[2] for ii in conn.execute(f'PRAGMA index_info("{iname}")').fetchall()]
        if icols and all(c in new_cols for c in icols):
            restore.append(
                f'CREATE UNIQUE INDEX IF NOT EXISTS "uq_{table}_{"_".join(icols)}" '
                f'ON {table} ({", ".join(icols)})')
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute(f"DROP TABLE IF EXISTS {table}_new")
        conn.execute(f"CREATE TABLE {table}_new (\n  " + ",\n  ".join(decls) + "\n)")
        names = ", ".join(common)
        conn.execute(f"INSERT INTO {table}_new ({names}) SELECT {names} FROM {table}")
        conn.execute(f"DROP TABLE {table}")
        conn.execute(f"ALTER TABLE {table}_new RENAME TO {table}")
        for sql in restore:
            conn.execute(sql)
        conn.commit()
    except Exception as e:
        # Откат вернёт INSERT→DROP→RENAME, но CREATE прошёл в автокоммите:
        # хвост {table}_new сносим руками, иначе следующий старт падает на нём.
        conn.rollback()
        conn.execute(f"DROP TABLE IF EXISTS {table}_new")
        conn.commit()
        conn.execute("PRAGMA foreign_keys = ON")
        print(f"[db] ОШИБКА пересборки {table}: {e} — схема осталась прежней")
        return False
    conn.execute("PRAGMA foreign_keys = ON")
    bad = conn.execute("PRAGMA foreign_key_check").fetchall()
    if bad:
        # Пересборка не должна оставлять битые ссылки: это сигнал разбираться, не глотать.
        print(f"[db] ВНИМАНИЕ: foreign_key_check после пересборки {table}: {bad[:5]}")
    return True


def ensure_creditors_constraints_schema():
    """Б1+Б8 (волна ЛЕСКОВО-3): creditors — главная денежная таблица совсем без FK
    (4 ссылки на честном слове). Пересоздание с настоящими связями + CHECK статуса.

    ON DELETE SET NULL у смет-ссылок сохраняет текущее поведение (delete_line/
    delete_item удаляют строки, не спрашивая обязательства); заказ delete_order
    отвязывает сам. Статусы по факту кода: open (дефолт) / closed
    (expenses.from-tx при полном гашении) + partial/cancelled на вырост.

    Легаси приводится к канону ДО пересборки и только там, где значение
    равнозначно тому, как его уже читает код: пустой статус = open (дефолт),
    NULL в суммах = 0 (все читатели берут их через COALESCE). Остаток —
    отказ от пересборки с алертом, см. _rebuild_table_with_ddl."""
    conn = get_production()
    try:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='creditors'").fetchone()
        if not row or ("REFERENCES orders" in row[0] and "CHECK" in row[0]):
            return
        conn.execute("UPDATE creditors SET status = 'open' "
                     "WHERE status IS NULL OR TRIM(status) = ''")
        conn.execute("UPDATE creditors SET total = 0 WHERE total IS NULL")
        conn.execute("UPDATE creditors SET paid = 0 WHERE paid IS NULL")
        conn.commit()
        decls = _decls_from_table(
            conn, "creditors",
            not_null=("name", "total", "paid", "status", "created_at"),
            defaults={"total": "0", "paid": "0", "status": "'open'",
                      "created_at": "(datetime('now'))"},
            extra={
                "order_id": "REFERENCES orders(id)",
                "status": "CHECK (status IN ('open','partial','closed','cancelled'))",
                "estimate_item_id": "REFERENCES estimate_items(id) ON DELETE SET NULL",
                "estimate_line_id": "REFERENCES estimate_lines(id) ON DELETE SET NULL",
                "fixed_id": "REFERENCES fixed_obligations(id) ON DELETE SET NULL",
            })
        _rebuild_table_with_ddl(conn, "creditors", decls)
        conn.commit()
    finally:
        conn.close()


def ensure_expense_category_check_schema():
    """Б8: категории расхода — строго 4 (CHECK). Легаси в данных (labor→work,
    test→other) приводится к канону ДО пересборки — ровно так их и сводит
    orders.py::_bucket, цифры план-факта не меняются."""
    conn = get_production()
    try:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='expenses'").fetchone()
        if not row or "CHECK" in row[0]:
            return
        conn.execute("UPDATE expenses SET category='work' WHERE category='labor'")
        conn.execute("UPDATE expenses SET category='other' WHERE category='test'")
        # Пустая строка — то же «нет категории», что и NULL (_bucket сводит обе
        # в «Прочее»), но CHECK её не пропустит и уронит стартовую миграцию.
        conn.execute("UPDATE expenses SET category = NULL WHERE TRIM(category) = ''")
        conn.commit()
        # FK колонками, а не FOREIGN KEY-строками: колонки, которой в схеме нет,
        # такая декларация просто не получит, а табличная уронила бы CREATE.
        decls = _decls_from_table(conn, "expenses", extra={
            "category": "CHECK (category IS NULL OR "
                        "category IN ('material','work','delivery','other'))",
            "order_id": "REFERENCES orders(id)",
            "creditor_id": "REFERENCES creditors(id) ON DELETE SET NULL",
            "master_id": "REFERENCES masters(id) ON DELETE SET NULL",
            "extra_id": "REFERENCES order_extras(id) ON DELETE SET NULL",
        })
        _rebuild_table_with_ddl(conn, "expenses", decls)
        conn.commit()
    finally:
        conn.close()


def ensure_order_status_check_schema():
    """Б8: статусы заказа под CHECK — база больше не примет опечатку скрипта.
    Пересоздание родителя: дети (payments/expenses/estimate_sets/...) ссылаются
    по имени, foreign_keys на время пересборки выключен, RENAME возвращает имя."""
    conn = get_production()
    try:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").fetchone()
        if not row or "CHECK" in row[0]:
            return
        decls = _decls_from_table(conn, "orders", extra={
            "number": "UNIQUE",
            "status": "CHECK (status IS NULL OR status IN ('draft','estimate','project',"
                      "'in_production','awaiting_payment','completed','cancelled'))",
            "customer_id": "REFERENCES customers(id)",
            "brand_id": "REFERENCES brands(id)",
        })
        _rebuild_table_with_ddl(conn, "orders", decls)
        conn.commit()
    finally:
        conn.close()


def ensure_creditors_close_schema():
    """След закрытия обязательства: когда и почему (ТЗ обязательств 04.08.2026).

    closed_reason: order_completed — закрыто завершением заказа (только эти
    переоткрываются при возврате заказа в работу), manual — руками, paid_in_full —
    погашено полностью. Вызывать ПОСЛЕ ensure_creditors_constraints_schema:
    пересборка таблицы собирает колонки из PRAGMA, порядок важен."""
    conn = get_production()
    try:
        info = conn.execute("PRAGMA table_info(creditors)").fetchall()
        if not info:
            return
        existing = {r[1] for r in info}
        for col in ("closed_at TEXT", "closed_reason TEXT"):
            if col.split()[0] not in existing:
                conn.execute(f"ALTER TABLE creditors ADD COLUMN {col}")
        conn.commit()
    finally:
        conn.close()


def ensure_paid_obligations_closed():
    """Полностью оплаченное обязательство не может висеть открытым: оно
    показывалось в «Мы должны» с нулевым остатком и в долге подрядчика
    (живой случай — «Миша Юрьев» 6 400/6 400).

    Порог 0.01, а не строгое равенство: деньги в REAL (правило Б3).

    Каждая закрытая строка пишется в audit_log (actor='system', база общая —
    без следа непонятно, кто и когда закрыл обязательство). Снимок «до» берём
    перед UPDATE: по нему строку можно вернуть."""
    from audit import audit
    conn = get_production()
    try:
        info = conn.execute("PRAGMA table_info(creditors)").fetchall()
        if not info or "closed_reason" not in {r[1] for r in info}:
            return
        where = ("""WHERE status = 'open' AND COALESCE(total,0) > 0
                      AND COALESCE(paid,0) >= COALESCE(total,0) - 0.01""")
        before = [dict(r) for r in conn.execute(f"SELECT * FROM creditors {where}").fetchall()]
        if not before:
            return
        conn.execute(f"""
            UPDATE creditors
               SET status = 'closed',
                   closed_at = COALESCE(closed_at, datetime('now')),
                   closed_reason = COALESCE(closed_reason, 'paid_in_full')
             {where}
        """)
        for row in before:
            audit(conn, "creditor", row["id"], "status",
                  f"Закрыто миграцией как полностью оплаченное: «{row['name']}» "
                  f"план {(row['total'] or 0):g} ₽, оплачено {(row['paid'] or 0):g} ₽",
                  before_row=row)
        conn.commit()
    finally:
        conn.close()


def ensure_line_rate_snapshot_schema():
    """A9: строка работ хранит свои входные данные — применённую ставку, её схему
    и дату применения. Симметрия с price_supplier/price_date у материалов: смета
    read-only навсегда, строка обязана быть самодостаточной. Заполняют точки, где
    ставка справочника реально применяется (from-catalog, cost-fill); ручной ввод
    цены снимка не пишет — там входные данные и есть сама цена."""
    conn = get_production()
    try:
        for table in ("estimate_lines", "catalog_item_lines"):
            info = conn.execute(f"PRAGMA table_info({table})").fetchall()
            if not info:
                continue
            existing = {r[1] for r in info}
            for col in ("applied_rate REAL", "rate_scheme TEXT", "rate_date TEXT"):
                name = col.split()[0]
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col}")
        conn.commit()
    finally:
        conn.close()


def ensure_master_ledger_schema():
    """Лицевой счёт подрядчика — регистр взаиморасчётов (ТЗ фин-агента 05.08.2026).

    Расчёты с мастером не сводятся к «расходу по заказу»: Кебра просит оплатить
    ткань для ЧУЖОГО заказа (деньги наши, себестоимость не наша), один перевод
    уходит авансом сразу на два заказа, а «сколько мы должны мастеру на сегодня»
    не считается вовсе — начисления живут в creditors, выплаты в expenses.

    Регистр СОБИРАЕТСЯ, а не дублируется (routers/ledger.py::_entries):
      начислено (+) — creditors по имени мастера (total);
      выплачено (−) — expenses.master_id + creditors.paid, не покрытые расходом
                      (тот же дедуп, что в masters._paid_total и orders._plan_fact);
      за него третьим лицам (−) — expenses.purpose='contractor_third_party';
      аванс без заказа (−)      — expenses.purpose='contractor_pay'.
    Обе новые purpose живут при order_id IS NULL, поэтому в себестоимость заказов
    и в накладные (A8 фильтрует purpose='overhead') не попадают по построению.

    Эта таблица — только для того, чему нет места среди денег и обязательств:
    зачёт встречных требований, ручное начисление, корректировка сальдо.
    Дублировать ею expenses/creditors нельзя — задвоит оборот."""
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS master_ledger (
                id             TEXT PRIMARY KEY,
                master_id      TEXT NOT NULL,
                kind           TEXT NOT NULL,
                amount         REAL NOT NULL,
                happened_at    TEXT NOT NULL,
                order_id       TEXT,
                note           TEXT,
                creditor_id    TEXT,
                expense_id     TEXT,
                finance_tx_id  TEXT,
                zenmoney_tx_id TEXT,
                source         TEXT DEFAULT 'manual',
                created_by     TEXT,
                created_at     TEXT DEFAULT (datetime('now')),
                updated_at     TEXT DEFAULT (datetime('now')),
                CHECK (kind IN ('accrual', 'payment', 'third_party', 'offset', 'adjust')),
                FOREIGN KEY (master_id) REFERENCES masters(id),
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
                FOREIGN KEY (creditor_id) REFERENCES creditors(id) ON DELETE SET NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_master_ledger_master ON master_ledger(master_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_master_ledger_date ON master_ledger(happened_at)")
        conn.execute("""
            CREATE TRIGGER IF NOT EXISTS trg_master_ledger_updated_at
            AFTER UPDATE ON master_ledger
            BEGIN
                UPDATE master_ledger SET updated_at = datetime('now') WHERE id = NEW.id;
            END
        """)
        # Выплаты ищутся по мастеру — без индекса это скан expenses на каждую карточку.
        if conn.execute("PRAGMA table_info(expenses)").fetchall():
            conn.execute("CREATE INDEX IF NOT EXISTS idx_expenses_master ON expenses(master_id)")
        conn.commit()
    finally:
        conn.close()


MEDIA_ROOT = Path("/opt/firma/data/media")
MEDIA_KINDS = ("studio", "photo", "viz", "render", "draft", "ref")


def ensure_media_schema():
    """Медиатека изделий — картинки в КП, чертежи в спецификацию (спека Юры 07.08.2026).

    Роли файла: studio/photo/viz/render идут наружу (КП, в этом порядке),
    draft/ref — только внутрь (спецификация мастеру, рефы). В роли файлов сколько
    угодно, главный один — `is_primary`, его и берёт документ.

    Привязка РОВНО ОДНА (CHECK): `catalog_item_id` — базовая картинка карточки
    каталога, `estimate_item_id` — переопределение для конкретного заказа. Выбор
    для документа: сначала файлы позиции сметы, нет — файлы карточки каталога
    (routers/media.py::pick). `order_id` — не привязка, а ярлык для выборки
    «все картинки заказа», проставляется от позиции сметы.

    Блобы в SQLite не кладём: в базе путь и метаданные, файлы на диске под
    MEDIA_ROOT — иначе production.db станет не скопировать."""
    conn = get_production()
    try:
        fresh = not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='media'"
        ).fetchone()
        if fresh:
            _backup_production("before-media")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS media (
                id               TEXT PRIMARY KEY,
                kind             TEXT NOT NULL,
                path             TEXT NOT NULL,
                thumb_path       TEXT,
                mime             TEXT,
                width            INTEGER,
                height           INTEGER,
                bytes            INTEGER,
                title            TEXT,
                catalog_item_id  TEXT REFERENCES catalog_items(id) ON DELETE CASCADE,
                estimate_item_id TEXT REFERENCES estimate_items(id) ON DELETE CASCADE,
                order_id         TEXT REFERENCES orders(id) ON DELETE SET NULL,
                is_primary       INTEGER NOT NULL DEFAULT 0,
                ral              TEXT,
                source           TEXT,
                note             TEXT,
                created_at       TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at       TEXT,
                CHECK (kind IN ('studio','photo','viz','render','draft','ref')),
                CHECK (is_primary IN (0, 1)),
                CHECK ((catalog_item_id IS NOT NULL) + (estimate_item_id IS NOT NULL) = 1)
            )
        """)
        # Главный в роли — ровно один на привязку. Частичный уникальный индекс:
        # ошибку ловит база, а не только обработчик.
        conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_media_primary_catalog
                        ON media(catalog_item_id, kind)
                        WHERE is_primary = 1 AND catalog_item_id IS NOT NULL""")
        conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_media_primary_estimate
                        ON media(estimate_item_id, kind)
                        WHERE is_primary = 1 AND estimate_item_id IS NOT NULL""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_media_catalog ON media(catalog_item_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_media_estimate ON media(estimate_item_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_media_order ON media(order_id)")
        conn.execute("""
            CREATE TRIGGER IF NOT EXISTS trg_media_updated_at
            AFTER UPDATE ON media
            BEGIN
                UPDATE media SET updated_at = datetime('now') WHERE id = NEW.id;
            END
        """)
        conn.commit()
    finally:
        conn.close()
    # Каталог файлов заводим здесь, но падать из-за него нельзя: миграции гоняются
    # и из тестов под claude-runner, где /opt/firma/data не наш. Приём файла
    # создаёт папку месяца сам (routers/media.py::_store).
    try:
        MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(f"[migration] каталог медиатеки {MEDIA_ROOT} не создан: {e}")
