"""Волна 2 внедрения из разбора ЛЕСКОВО: прослеживаемость.

A1 — audit_log пишется write-ручками в одной транзакции с изменением;
A4 — след привязки платежа/расхода (match_status/matched_by);
A3-лайт — group_id разноски + откат целиком + «братские» платежи;
A2 — rate_history: смена ставки оставляет след (раньше UPDATE затирал);
A10 — costing_version: сметы до движка 22.07.2026 = legacy;
Б2-лайт — orders.brand_id из текстового brand.
"""
import json
import sqlite3
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent / "backend"
MAIN = BACKEND / "main.py"


def _startup_migrations() -> list[str]:
    import re
    body = MAIN.read_text().split("def startup():", 1)[1]
    return [n for n in re.findall(r"^\s{4}(\w+)\(\)", body, re.M) if n != "init_admin"]


@pytest.fixture
def prod_db(tmp_path, monkeypatch, schema_sql):
    """Клон боевой схемы + startup-миграции (см. test_leskovo_wave1)."""
    import db
    prod, fin = tmp_path / "production.db", tmp_path / "finance.db"
    c = sqlite3.connect(prod)
    for stmt in schema_sql:
        try:
            c.execute(stmt)
        except sqlite3.OperationalError:
            pass
    c.commit()
    c.close()
    # finance.db с транзакцией банка — для from-tx
    f = sqlite3.connect(fin)
    f.execute("""CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY, bank TEXT, account TEXT, date TEXT,
        amount REAL, direction TEXT, counterparty TEXT, purpose TEXT, doc_num TEXT)""")
    f.execute("""INSERT INTO transactions (id, bank, date, amount, direction, counterparty, purpose)
                 VALUES (7001, 'tbank', '2026-08-01', 300000, 'in', 'ООО Тест', 'Оплата по счёту')""")
    f.commit()
    f.close()
    monkeypatch.setattr(db, "PRODUCTION_DB", prod)
    monkeypatch.setattr(db, "FINANCE_DB", fin)
    for name in _startup_migrations():
        getattr(db, name)()
    return prod


def _seed_order(conn, oid="o-1", number="ORD-901", title="Тест"):
    conn.execute("INSERT INTO orders (id, number, title) VALUES (?, ?, ?)", (oid, number, title))


class TestAuditLog:
    def test_смена_статуса_пишет_журнал(self, prod_db):
        import db
        from routers.orders import StatusUpdate, update_status
        conn = db.get_production()
        try:
            _seed_order(conn)
            conn.commit()
        finally:
            conn.close()
        update_status("o-1", StatusUpdate(status="in_production"))
        conn = db.get_production()
        try:
            row = conn.execute(
                "SELECT * FROM audit_log WHERE entity_type='order' AND entity_id='o-1'").fetchone()
        finally:
            conn.close()
        assert row["action"] == "status"
        assert "→" in row["summary"] and "Черновик" in row["summary"]
        assert row["actor"] == "system"   # без JWT-запроса актор дефолтный

    def test_платёж_и_удаление_с_полным_снимком(self, prod_db):
        import db
        from routers.orders import PaymentCreate, add_payment, delete_payment
        conn = db.get_production()
        try:
            _seed_order(conn)
            conn.commit()
        finally:
            conn.close()
        p = add_payment("o-1", PaymentCreate(amount=50_000, paid_at="2026-08-01"))
        delete_payment("o-1", p["id"])
        conn = db.get_production()
        try:
            rows = conn.execute(
                "SELECT * FROM audit_log WHERE entity_type='payment' ORDER BY created_at").fetchall()
        finally:
            conn.close()
        actions = [r["action"] for r in rows]
        assert actions == ["create", "delete"]
        snapshot = json.loads(rows[1]["changes"])   # снимок строки ДО удаления
        assert snapshot["amount"] == 50_000
        assert snapshot["matched_by"] == "order-card"   # A4: ручной платёж из карточки


class TestFromTxGroup:
    def _run_allocation(self):
        from routers.payments import PayFromTxIn, payments_from_tx
        body = PayFromTxIn(tx_id="7001", allocations=[
            {"order_id": "o-1", "amount": 100000},
            {"order_id": "o-2", "amount": 200000},
        ])
        return payments_from_tx(body)

    def test_разноска_даёт_общий_group_id_и_inbox(self, prod_db):
        import db
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", "ORD-901", "Первый")
            _seed_order(conn, "o-2", "ORD-902", "Второй")
            conn.commit()
        finally:
            conn.close()
        self._run_allocation()
        conn = db.get_production()
        try:
            rows = conn.execute("SELECT * FROM payments ORDER BY amount").fetchall()
        finally:
            conn.close()
        assert len(rows) == 2
        assert rows[0]["group_id"] and rows[0]["group_id"] == rows[1]["group_id"]
        assert {r["matched_by"] for r in rows} == {"inbox"}
        assert {r["match_status"] for r in rows} == {"manual"}

    def test_откат_группы_целиком(self, prod_db):
        import db
        from routers.payments import delete_payment_group
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", "ORD-901", "Первый")
            _seed_order(conn, "o-2", "ORD-902", "Второй")
            conn.commit()
        finally:
            conn.close()
        self._run_allocation()
        conn = db.get_production()
        try:
            gid = conn.execute("SELECT group_id FROM payments LIMIT 1").fetchone()[0]
        finally:
            conn.close()
        res = delete_payment_group(gid)
        assert res["deleted"] == 2
        conn = db.get_production()
        try:
            assert conn.execute("SELECT COUNT(*) FROM payments").fetchone()[0] == 0
        finally:
            conn.close()

    def test_братские_платежи_видны_в_карточке(self, prod_db):
        import db
        from routers.orders import get_order
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", "ORD-901", "Первый")
            _seed_order(conn, "o-2", "ORD-902", "Второй")
            conn.commit()
        finally:
            conn.close()
        self._run_allocation()
        detail = get_order("o-1")
        sib = detail["payments"][0].get("siblings")
        assert sib and sib[0]["title"] == "Второй" and sib[0]["amount"] == 200000


class TestRateHistory:
    def test_смена_ставки_оставляет_след(self, prod_db):
        import db
        from routers.rates import upsert_work_rate
        conn = db.get_production()
        try:
            conn.execute("INSERT INTO work_types (id, name) VALUES ('wt-9', 'Гибка теста')")
            upsert_work_rate(conn, "wt-9", None, "per_unit", 1500, "шт", None, "manual")
            upsert_work_rate(conn, "wt-9", None, "per_unit", 1800, "шт", None, "manual")
            conn.commit()
            rows = conn.execute(
                "SELECT * FROM rate_history WHERE kind='work_rate'").fetchall()
        finally:
            conn.close()
        assert len(rows) == 1
        assert (rows[0]["old_value"], rows[0]["new_value"]) == (1500, 1800)

    def test_та_же_ставка_не_шумит(self, prod_db):
        import db
        from routers.rates import upsert_work_rate
        conn = db.get_production()
        try:
            conn.execute("INSERT INTO work_types (id, name) VALUES ('wt-9', 'Гибка теста')")
            upsert_work_rate(conn, "wt-9", None, "per_unit", 1500, "шт", None, "manual")
            upsert_work_rate(conn, "wt-9", None, "per_unit", 1500, "шт", None, "manual")
            conn.commit()
            n = conn.execute("SELECT COUNT(*) FROM rate_history").fetchone()[0]
        finally:
            conn.close()
        assert n == 0


class TestCostingVersion:
    def test_бэкфилл_по_дате_запуска_движка(self, prod_db):
        import db
        conn = db.get_production()
        try:
            conn.execute("ALTER TABLE estimate_sets DROP COLUMN costing_version")
            _seed_order(conn)
            conn.execute(
                "INSERT INTO estimate_sets (id, order_id, created_at) VALUES ('s-old','o-1','2026-07-01T10:00:00')")
            conn.execute(
                "INSERT INTO estimate_sets (id, order_id, created_at) VALUES ('s-new','o-1','2026-08-01T10:00:00')")
            conn.commit()
        finally:
            conn.close()
        db.ensure_costing_version_schema()
        conn = db.get_production()
        try:
            got = dict(conn.execute(
                "SELECT id, costing_version FROM estimate_sets").fetchall())
        finally:
            conn.close()
        assert got == {"s-old": "legacy", "s-new": "catalog_v1"}


class TestBrandId:
    def test_бэкфилл_и_резолв_при_правке(self, prod_db):
        import db
        from routers.orders import update_order
        import asyncio
        conn = db.get_production()
        try:
            conn.execute("ALTER TABLE orders DROP COLUMN brand_id")
            conn.execute("INSERT INTO orders (id, number, title, brand) VALUES ('o-1','ORD-901','Т','MeRA')")
            conn.commit()
        finally:
            conn.close()
        db.ensure_order_brand_id_schema()
        conn = db.get_production()
        try:
            bid = conn.execute("SELECT brand_id FROM orders WHERE id='o-1'").fetchone()[0]
            mera = conn.execute("SELECT id FROM brands WHERE name='MeRA'").fetchone()[0]
        finally:
            conn.close()
        assert bid == mera
        # правка бренда через PATCH резолвит связь заново
        asyncio.get_event_loop().run_until_complete(update_order("o-1", {"brand": "pbpb"}))
        conn = db.get_production()
        try:
            row = conn.execute("SELECT brand, brand_id FROM orders WHERE id='o-1'").fetchone()
            pbpb = conn.execute("SELECT id FROM brands WHERE name='pbpb'").fetchone()[0]
        finally:
            conn.close()
        assert (row["brand"], row["brand_id"]) == ("pbpb", pbpb)
