import sqlite3
from pathlib import Path

PRODUCTION_DB = Path("/opt/ai-os/data/production.db")
FINANCE_DB = Path("/opt/fin-agent/data/finance.db")
ANALYTICS_DB = Path("/opt/fin-agent/data/analytics.db")
ZENMONEY_DB = Path("/opt/fin-agent/data/zenmoney.db")
MATERIALS_DB = Path("/opt/ai-os/data/materials.db")


def get_production():
    conn = sqlite3.connect(PRODUCTION_DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


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
        for column in ("wiki_ref", "finagent_ref", "source", "status", "telegram", "instagram", "whatsapp"):
            if column not in existing:
                conn.execute(f"ALTER TABLE customers ADD COLUMN {column} TEXT")
        conn.commit()
    finally:
        conn.close()


def ensure_orders_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()}
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


def ensure_estimate_bank_pct_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(estimate_items)").fetchall()}
        if "bank_pct" not in existing:
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
        conn.executescript("""
            PRAGMA foreign_keys=OFF;
            CREATE TABLE catalog_item_lines_new (
                id          TEXT PRIMARY KEY,
                item_id     TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
                type        TEXT NOT NULL,
                title       TEXT NOT NULL,
                qty         REAL DEFAULT 1,
                unit        TEXT DEFAULT 'шт',
                unit_price  REAL DEFAULT 0,
                line_total  REAL DEFAULT 0,
                material_id TEXT REFERENCES materials(id),
                sort_order  INTEGER DEFAULT 0
            );
            INSERT INTO catalog_item_lines_new SELECT * FROM catalog_item_lines;
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
        cols = {
            "source": "TEXT DEFAULT 'manual'",   # manual|bank|zenmoney
            "creditor_id": "TEXT",               # покрытое обязательство (дедуп факта)
            "finance_tx_id": "TEXT",             # транзакция банка
            "zenmoney_tx_id": "TEXT",            # транзакция ZenMoney
            "group_id": "TEXT",                  # группа разнесённого расхода (одна поездка)
            "master_id": "TEXT",                 # подрядчик из production.masters
        }
        for col, decl in cols.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE expenses ADD COLUMN {col} {decl}")
        conn.commit()
    finally:
        conn.close()


def ensure_creditor_estimate_item_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(creditors)").fetchall()}
        if "estimate_item_id" not in existing:
            conn.execute("ALTER TABLE creditors ADD COLUMN estimate_item_id TEXT")
            conn.commit()
    finally:
        conn.close()


def ensure_payee_rules_category_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(payee_rules)").fetchall()}
        if "category" not in existing:
            conn.execute("ALTER TABLE payee_rules ADD COLUMN category TEXT")
            conn.commit()
    finally:
        conn.close()


def ensure_order_tx_link_schema():
    conn = get_production()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()}
        if "finance_tx_id" not in existing:
            conn.execute("ALTER TABLE orders ADD COLUMN finance_tx_id TEXT")
            conn.commit()
    finally:
        conn.close()


def ensure_receivable_tx_link_schema():
    conn = get_finance()
    try:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(receivables)").fetchall()}
        if "finance_tx_id" not in existing:
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
            if name not in existing:
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
            wt_rows = conn.execute("SELECT id, name FROM work_types").fetchall()
            masters = conn.execute("SELECT id, specialization FROM masters WHERE specialization IS NOT NULL AND specialization != ''").fetchall()
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
        "description": "Производственный бренд: металлокаркасная мебель и изделия на заказ. B2B — рестораны, кафе, дизайнеры, корпоративные клиенты.",
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
