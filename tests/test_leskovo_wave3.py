"""Волна 3 внедрения из разбора ЛЕСКОВО: экономика и схема.

A8 — уровни маржи (решение Юры): накладные месяца-факт делятся между заказами
в производстве пропорционально фактической себестоимости; второй уровень
net_with_overhead появляется только у in_production, сметы не трогаются.
Б1+Б8 — пересоздание creditors/expenses/orders с настоящими FK и CHECK
(механика _rebuild_table_with_ddl: явный DDL, перенос по именам, индексы и
триггеры выживают).
"""
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
    sqlite3.connect(fin).close()
    monkeypatch.setattr(db, "PRODUCTION_DB", prod)
    monkeypatch.setattr(db, "FINANCE_DB", fin)
    for name in _startup_migrations():
        getattr(db, name)()
    return prod


def _seed_order(conn, oid, number, title, status="in_production"):
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES (?, ?, ?, ?)",
                 (oid, number, title, status))


class TestOverheadMonth:
    def test_общехоз_плюс_непокрытая_аренда(self, prod_db):
        import db
        from routers.orders import _overhead_month
        conn = db.get_production()
        try:
            conn.execute(
                """INSERT INTO expenses (id, title, amount, expense_date, purpose)
                   VALUES ('e-1', 'Расходники', 2000, '2026-08-02', 'overhead')""")
            conn.execute(
                """INSERT INTO creditors (id, name, total, paid, kind, period, status)
                   VALUES ('c-1', 'Аренда', 4000, 4000, 'fixed', '2026-08', 'closed')""")
            got = _overhead_month(conn, "2026-08")
        finally:
            conn.close()
        assert got == {"period": "2026-08", "total": 6000, "expenses": 2000, "fixed": 4000}

    def test_аренда_покрытая_расходом_не_задваивается(self, prod_db):
        import db
        from routers.orders import _overhead_month
        conn = db.get_production()
        try:
            conn.execute(
                """INSERT INTO creditors (id, name, total, paid, kind, period, status)
                   VALUES ('c-1', 'Аренда', 4000, 4000, 'fixed', '2026-08', 'closed')""")
            conn.execute(
                """INSERT INTO expenses (id, title, amount, expense_date, purpose, creditor_id)
                   VALUES ('e-1', 'Аренда авг', 4000, '2026-08-03', 'overhead', 'c-1')""")
            got = _overhead_month(conn, "2026-08")
        finally:
            conn.close()
        assert got["total"] == 4000   # инвариант: одна оплата = один факт


class TestOverheadAllocation:
    def test_деление_по_себестоимости(self, prod_db, monkeypatch):
        import db
        from routers import orders as O
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", "ORD-901", "Большой")
            _seed_order(conn, "o-2", "ORD-902", "Маленький")
            _seed_order(conn, "o-3", "ORD-903", "Черновик", status="draft")
            conn.execute("INSERT INTO expenses (id, order_id, title, amount) VALUES ('e-1','o-1','Металл',30000)")
            conn.execute("INSERT INTO expenses (id, order_id, title, amount) VALUES ('e-2','o-2','Металл',10000)")
            conn.execute(
                """INSERT INTO expenses (id, title, amount, expense_date, purpose)
                   VALUES ('e-ov', 'Аренда', 4000, date('now'), 'overhead')""")
            alloc = O._overhead_allocation(conn)
        finally:
            conn.close()
        assert set(alloc["orders"]) == {"o-1", "o-2"}   # черновик не участвует
        assert alloc["orders"]["o-1"]["amount"] == 3000
        assert alloc["orders"]["o-2"]["amount"] == 1000
        assert abs(sum(x["share"] for x in alloc["orders"].values()) - 1) < 0.001

    def test_без_фактов_поровну(self, prod_db):
        import db
        from routers import orders as O
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", "ORD-901", "А")
            _seed_order(conn, "o-2", "ORD-902", "Б")
            conn.execute(
                """INSERT INTO expenses (id, title, amount, expense_date, purpose)
                   VALUES ('e-ov', 'Аренда', 5000, date('now'), 'overhead')""")
            alloc = O._overhead_allocation(conn)
        finally:
            conn.close()
        assert alloc["orders"]["o-1"]["amount"] == 2500
        assert alloc["orders"]["o-2"]["amount"] == 2500

    def test_второй_уровень_маржи_в_карточке(self, prod_db):
        import db
        from routers.orders import get_order
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", "ORD-901", "В работе")
            conn.execute("UPDATE orders SET price_plan = 100000, cost_plan = 40000 WHERE id='o-1'")
            conn.execute("INSERT INTO expenses (id, order_id, title, amount) VALUES ('e-1','o-1','Металл',20000)")
            conn.execute(
                """INSERT INTO expenses (id, title, amount, expense_date, purpose)
                   VALUES ('e-ov', 'Аренда', 4000, date('now'), 'overhead')""")
            conn.commit()
        finally:
            conn.close()
        d = get_order("o-1")
        assert d["overhead"]["amount"] == 4000          # единственный заказ в работе
        assert d["net_with_overhead"] == round(d["net_profit"] - 4000, 2)
        # сметы/план-факт не обросли: блок plan_fact без изменений структуры
        assert "overhead" not in (d["plan_fact"] or {})


class TestRebuiltConstraints:
    def test_creditors_fk_и_check_работают(self, prod_db):
        import db
        conn = db.get_production()
        try:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO creditors (id, name, total, paid, order_id) VALUES ('c-x','Ф',1,0,'нет-такого')")
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO creditors (id, name, total, paid, status) VALUES ('c-y','Ф',1,0,'опечатка')")
        finally:
            conn.close()

    def test_удаление_строки_сметы_отвязывает_а_не_падает(self, prod_db):
        import db
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", "ORD-901", "Т", status="draft")
            conn.execute("INSERT INTO estimate_sets (id, order_id) VALUES ('s-1','o-1')")
            conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-1','s-1','П')")
            conn.execute(
                "INSERT INTO estimate_lines (id, item_id, title) VALUES ('l-1','i-1','Работа')")
            conn.execute(
                """INSERT INTO creditors (id, name, total, paid, order_id, estimate_line_id)
                   VALUES ('c-1','Гоча',5000,0,'o-1','l-1')""")
            conn.execute("DELETE FROM estimate_lines WHERE id = 'l-1'")   # ON DELETE SET NULL
            left = conn.execute(
                "SELECT estimate_line_id FROM creditors WHERE id='c-1'").fetchone()[0]
        finally:
            conn.close()
        assert left is None

    def test_expenses_категория_под_check(self, prod_db):
        import db
        conn = db.get_production()
        try:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO expenses (id, title, amount, category) VALUES ('e-x','Т',1,'labor')")
            conn.execute(
                "INSERT INTO expenses (id, title, amount, category) VALUES ('e-ok','Т',1,'work')")
        finally:
            conn.close()

    def test_legacy_категории_приведены_к_канону(self, prod_db):
        """Пересборка конвертирует labor→work, test→other ровно как _bucket."""
        import db
        conn = db.get_production()
        try:
            conn.execute("ALTER TABLE expenses RENAME TO expenses_backup")
            conn.execute("CREATE TABLE expenses AS SELECT * FROM expenses_backup WHERE 0")
            conn.execute(
                "INSERT INTO expenses (id, title, amount, category) VALUES ('e-1','Т',1,'labor')")
            conn.execute(
                "INSERT INTO expenses (id, title, amount, category) VALUES ('e-2','Т',1,'test')")
            conn.commit()
        finally:
            conn.close()
        db.ensure_expense_category_check_schema()
        conn = db.get_production()
        try:
            got = {r[0]: r[1] for r in conn.execute(
                "SELECT id, category FROM expenses").fetchall()}
        finally:
            conn.close()
        assert got == {"e-1": "work", "e-2": "other"}

    def test_orders_статус_под_check_и_триггер_жив(self, prod_db):
        import db
        conn = db.get_production()
        try:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO orders (id, number, title, status) VALUES ('o-x','ORD-9','Т','opechatka')")
            _seed_order(conn, "o-1", "ORD-901", "Т", status="draft")
            conn.execute("UPDATE orders SET title = 'Т2' WHERE id = 'o-1'")
            upd = conn.execute("SELECT updated_at FROM orders WHERE id='o-1'").fetchone()[0]
        finally:
            conn.close()
        assert upd is not None   # триггер Б7 пережил пересборку

    def test_данные_переживают_пересборку(self, prod_db):
        """Идемпотентность и сохранность: повторный прогон миграций с данными."""
        import db
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", "ORD-901", "Живой", status="completed")
            conn.execute(
                """INSERT INTO creditors (id, name, total, paid, order_id, status)
                   VALUES ('c-1','Гоча',5000,5000,'o-1','closed')""")
            conn.commit()
        finally:
            conn.close()
        for name in _startup_migrations():
            getattr(db, name)()
        conn = db.get_production()
        try:
            o = conn.execute("SELECT title, status FROM orders WHERE id='o-1'").fetchone()
            c = conn.execute("SELECT name, paid, status FROM creditors WHERE id='c-1'").fetchone()
        finally:
            conn.close()
        assert (o["title"], o["status"]) == ("Живой", "completed")
        assert (c["name"], c["paid"], c["status"]) == ("Гоча", 5000, "closed")
