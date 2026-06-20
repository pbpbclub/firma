import sqlite3
from pathlib import Path

PRODUCTION_DB = Path("/opt/ai-os/data/production.db")
FINANCE_DB = Path("/opt/fin-agent/data/finance.db")
ANALYTICS_DB = Path("/opt/fin-agent/data/analytics.db")
ZENMONEY_DB = Path("/opt/fin-agent/data/zenmoney.db")


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
    conn = sqlite3.connect(ANALYTICS_DB)
    conn.row_factory = sqlite3.Row
    return conn


def get_zenmoney():
    conn = sqlite3.connect(ZENMONEY_DB)
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
