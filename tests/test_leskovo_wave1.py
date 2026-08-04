"""Волна 1 внедрения из разбора ЛЕСКОВО (спека 2026-08-04-leskovo-adoption-design).

Б4 — уникальные индексы на бизнес-ключи; Б7 — updated_at триггерами (ловит и
прямые записи агентов в базу, не только веб); Б3 — money() как единственное
правило округления сумм; A9 — строка работ несёт снимок применённой ставки,
как строка материала несёт price_supplier/price_date.
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
    """Файл с клоном боевой схемы (данных нет) + все startup-миграции поверх.

    Клон, а не пустой файл: часть таблиц (orders, payments) создаёт роутер
    лениво, и на девственной базе миграции волны легально проходят вхолостую —
    а проверяем мы именно их работу на настоящей схеме."""
    import db
    prod, fin = tmp_path / "production.db", tmp_path / "finance.db"
    c = sqlite3.connect(prod)
    for stmt in schema_sql:
        try:
            c.execute(stmt)
        except sqlite3.OperationalError:
            pass   # индекс на таблицу из ATTACH-базы — в тестах не нужен
    c.commit()
    c.close()
    sqlite3.connect(fin).close()
    monkeypatch.setattr(db, "PRODUCTION_DB", prod)
    monkeypatch.setattr(db, "FINANCE_DB", fin)
    for name in _startup_migrations():
        getattr(db, name)()
    return prod


def _seed_order(conn, oid="o-1", number="ORD-901"):
    conn.execute("INSERT INTO orders (id, number, title) VALUES (?, ?, 'Тест')", (oid, number))


class TestUniqueBusinessKeys:
    def test_дубль_номера_заказа_невозможен(self, prod_db):
        import db
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", "ORD-901")
            with pytest.raises(sqlite3.IntegrityError):
                _seed_order(conn, "o-2", "ORD-901")
        finally:
            conn.close()

    def test_заказы_без_номера_не_конфликтуют(self, prod_db):
        import db
        conn = db.get_production()
        try:
            _seed_order(conn, "o-1", None)
            _seed_order(conn, "o-2", None)   # частичный индекс: NULL не считается дублем
            conn.commit()
        finally:
            conn.close()

    def test_дубль_номера_сметы_внутри_заказа(self, prod_db):
        import db
        conn = db.get_production()
        try:
            _seed_order(conn)
            conn.execute("INSERT INTO estimate_sets (id, order_id, number) VALUES ('s-1','o-1','067')")
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute("INSERT INTO estimate_sets (id, order_id, number) VALUES ('s-2','o-1','067')")
            # тот же номер у ДРУГОГО заказа — легально
            _seed_order(conn, "o-2", "ORD-902")
            conn.execute("INSERT INTO estimate_sets (id, order_id, number) VALUES ('s-3','o-2','067')")
        finally:
            conn.close()

    def test_пустой_инн_клиентов_не_дубль(self, prod_db):
        import db
        conn = db.get_production()
        try:
            conn.execute("INSERT INTO customers (id, name, inn) VALUES ('c-1','А','')")
            conn.execute("INSERT INTO customers (id, name, inn) VALUES ('c-2','Б','')")
            conn.execute("INSERT INTO customers (id, name, inn) VALUES ('c-3','В','366000000000')")
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute("INSERT INTO customers (id, name, inn) VALUES ('c-4','Г','366000000000')")
        finally:
            conn.close()

    def test_дубли_в_данных_не_роняют_startup(self, prod_db):
        """Индекс не создался из-за дублей → сервис обязан подняться, а не лечь.
        Проверка гоняет миграцию на базе, где дубль уже есть (индекс снят руками —
        сценарий восстановления из старого бэкапа). Берём customers.inn: у
        orders.number UNIQUE вшит в CREATE TABLE, там дубль невозможен в принципе."""
        import db
        conn = db.get_production()
        try:
            conn.execute("DROP INDEX IF EXISTS ux_customers_inn")
            conn.execute("INSERT INTO customers (id, name, inn) VALUES ('c-1','А','366000000001')")
            conn.execute("INSERT INTO customers (id, name, inn) VALUES ('c-2','Б','366000000001')")
            conn.commit()
        finally:
            conn.close()
        db.ensure_unique_business_keys()   # не должна бросить


class TestUpdatedAtTriggers:
    def test_update_платежа_проставляет_updated_at(self, prod_db):
        import db
        conn = db.get_production()
        try:
            _seed_order(conn)
            conn.execute(
                "INSERT INTO payments (id, order_id, amount) VALUES ('p-1', 'o-1', 100)")
            before = conn.execute("SELECT updated_at FROM payments WHERE id='p-1'").fetchone()[0]
            assert before is None   # INSERT триггер не трогает
            conn.execute("UPDATE payments SET amount = 200 WHERE id = 'p-1'")
            after = conn.execute("SELECT updated_at FROM payments WHERE id='p-1'").fetchone()[0]
            assert after is not None
        finally:
            conn.close()

    @pytest.mark.parametrize("table", [
        "payments", "expenses", "creditors", "estimate_items",
        "estimate_lines", "customers", "masters",
    ])
    def test_колонка_и_триггер_есть(self, prod_db, table):
        import db
        conn = db.get_production()
        try:
            cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
            assert "updated_at" in cols, f"{table}: нет updated_at"
            trg = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?",
                (f"trg_{table}_updated_at",)).fetchone()
            assert trg, f"{table}: нет триггера trg_{table}_updated_at"
        finally:
            conn.close()

    def test_миграция_идемпотентна(self, prod_db):
        import db
        db.ensure_updated_at_schema()
        db.ensure_updated_at_schema()


class TestMoney:
    def test_канон_округления(self):
        from money import money
        assert money(0.1 + 0.2) == 0.3
        assert money(224827.594999) == 224827.59
        assert money(None) == 0.0
        assert money(0) == 0.0


class TestRateSnapshot:
    """A9: строка работы, взятая из каталога по ставке, самодостаточна —
    какая ставка, по какой схеме и когда применена."""

    def _seed_catalog(self, conn):
        # имя вида работ уникально, а «Сварку» уже сидировала ensure_work_types_schema
        conn.execute("INSERT INTO work_types (id, name) VALUES ('wt-1', 'Сварка теста A9')")
        conn.execute("INSERT INTO masters (id, name) VALUES ('m-1', 'Гоча')")
        conn.execute(
            """INSERT INTO work_rates (id, work_type_id, master_id, scheme, rate, unit)
               VALUES ('wr-1', 'wt-1', 'm-1', 'per_unit', 1500, 'шт')""")
        conn.execute("INSERT INTO catalog_items (id, title, markup_pct) VALUES ('ci-1', 'Стол', 30)")
        conn.execute(
            """INSERT INTO catalog_item_lines (id, item_id, type, title, qty, unit, unit_price,
                                               work_type_id, master_id, sort_order)
               VALUES ('cl-1', 'ci-1', 'labor', 'Сварка теста A9', 2, 'шт', 0, 'wt-1', 'm-1', 0)""")

    def test_колонки_снимка_в_обеих_таблицах(self, prod_db):
        import db
        conn = db.get_production()
        try:
            for table in ("estimate_lines", "catalog_item_lines"):
                cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
                for c in ("applied_rate", "rate_scheme", "rate_date"):
                    assert c in cols, f"{table}: нет {c}"
        finally:
            conn.close()

    def test_from_catalog_пишет_снимок_ставки(self, prod_db):
        import db
        from routers.estimates import FromCatalog, from_catalog
        conn = db.get_production()
        try:
            _seed_order(conn)
            conn.execute("INSERT INTO estimate_sets (id, order_id, payment_type) VALUES ('s-1','o-1','cash')")
            self._seed_catalog(conn)
            conn.commit()
        finally:
            conn.close()
        from_catalog(FromCatalog(set_id="s-1", catalog_item_id="ci-1"))
        conn = db.get_production()
        try:
            row = conn.execute(
                "SELECT unit_price, applied_rate, rate_scheme, rate_date FROM estimate_lines"
                " WHERE title = 'Сварка теста A9'").fetchone()
        finally:
            conn.close()
        assert row["unit_price"] == 1500
        assert row["applied_rate"] == 1500
        assert row["rate_scheme"] == "per_unit"
        assert row["rate_date"]          # дата применения зафиксирована
