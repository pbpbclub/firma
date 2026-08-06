"""Завершение заказа закрывает расчёты с подрядчиками (решение Юры 04.08.2026).

План сметы и факт расходятся законно: по ORD-020 «Спираль» в обязательствах
висело 116 200 ₽ плана при 54 013 ₽ проведённых расходов. Молча списывать
разницу нельзя — 409 со списком, решение построчно.
"""
import sqlite3
from pathlib import Path

import pytest
from fastapi import HTTPException

BACKEND = Path(__file__).resolve().parent.parent / "backend"


@pytest.fixture
def db(migrated):
    """Схема с миграциями: тестам нужны closed_at/closed_reason (conftest::migrated)."""
    conn = migrated
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES ('o-1','ORD-901','Спираль','in_production')")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-1','Эдуард Малафеев')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status) VALUES ('s-1','o-1','approved')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-1','s-1','Изделие')")
    return conn


def _cred(conn, cid, name, total, *, paid=0, line_id=None, kind=None, status="open"):
    conn.execute(
        """INSERT INTO creditors (id, name, total, paid, order_id, status, estimate_line_id,
                                  estimate_item_id, kind, created_at)
           VALUES (?,?,?,?,'o-1',?,?,'i-1',?,datetime('now'))""",
        (cid, name, total, paid, status, line_id, kind))


class TestCloseForOrder:
    def test_остаток_требует_подтверждения(self, db):
        from obligations import close_for_order
        _cred(db, "c-1", "Работа: Сварка", 30_000)
        res = close_for_order(db, "o-1")
        assert res["needs_confirm"] is True
        assert res["unpaid_total"] == 30_000
        assert db.execute("SELECT status FROM creditors WHERE id='c-1'").fetchone()[0] == "open"

    def test_полностью_покрытое_закрывается_без_вопросов(self, db):
        from obligations import close_for_order
        _cred(db, "c-1", "Материал: Зеркало", 10_000)
        db.execute("""INSERT INTO expenses (id, order_id, title, amount, category, creditor_id, expense_date)
                      VALUES ('e-1','o-1','Зеркало',10000,'material','c-1','2026-08-01')""")
        res = close_for_order(db, "o-1")
        assert res.get("needs_confirm") is None
        assert res["closed"] == 1 and res["written_off"] == 0
        assert db.execute("SELECT status FROM creditors WHERE id='c-1'").fetchone()[0] == "closed"

    def test_force_закрывает_и_списывает(self, db):
        from obligations import close_for_order
        _cred(db, "c-1", "Работа: Сварка", 30_000)
        res = close_for_order(db, "o-1", force=True)
        assert res["closed"] == 1 and res["written_off"] == 30_000
        row = db.execute("SELECT status, closed_reason, closed_at FROM creditors WHERE id='c-1'").fetchone()
        assert (row[0], row[1]) == ("closed", "order_completed") and row[2]

    def test_only_ids_закрывает_выбранное(self, db):
        from obligations import close_for_order
        _cred(db, "c-1", "Работа: Сварка", 30_000)
        _cred(db, "c-2", "Материал: Металл", 18_000)
        close_for_order(db, "o-1", force=True, only_ids=["c-2"])
        got = dict(db.execute("SELECT id, status FROM creditors").fetchall())
        assert got == {"c-1": "open", "c-2": "closed"}

    def test_постоянные_обязательства_не_закрываются(self, db):
        from obligations import close_for_order
        _cred(db, "c-1", "Аренда мастерской", 4_000, kind="fixed")
        close_for_order(db, "o-1", force=True)
        assert db.execute("SELECT status FROM creditors WHERE id='c-1'").fetchone()[0] == "open"

    def test_возврат_в_работу_переоткрывает_только_своё(self, db):
        from obligations import close_for_order, reopen_for_order
        _cred(db, "c-1", "Работа: Сварка", 30_000)
        _cred(db, "c-2", "Материал: Металл", 18_000, status="closed")
        db.execute("UPDATE creditors SET closed_reason='manual' WHERE id='c-2'")
        close_for_order(db, "o-1", force=True)
        res = reopen_for_order(db, "o-1")
        assert res["reopened"] == 1
        got = dict(db.execute("SELECT id, status FROM creditors").fetchall())
        assert got == {"c-1": "open", "c-2": "closed"}   # закрытое вручную не трогаем


class TestStatusFlow:
    def _order_row(self, db):
        return db.execute("SELECT * FROM orders WHERE id='o-1'").fetchone()

    def test_завершение_без_подтверждения_даёт_409_и_не_меняет_статус(self, db):
        from routers.orders import _apply_status
        _cred(db, "c-1", "Работа: Сварка", 30_000)
        with pytest.raises(HTTPException) as e:
            _apply_status(db, self._order_row(db), "completed")
        assert e.value.status_code == 409
        assert e.value.detail["code"] == "obligations_unpaid"
        assert db.execute("SELECT status FROM orders WHERE id='o-1'").fetchone()[0] == "in_production"

    def test_подтверждённое_завершение_закрывает_и_пишет_журнал(self, db):
        from routers.orders import _apply_status
        _cred(db, "c-1", "Работа: Сварка", 30_000)
        res = _apply_status(db, self._order_row(db), "completed", close_obligations=True)
        assert res["closed_obligations"] == 1
        assert db.execute("SELECT status FROM orders WHERE id='o-1'").fetchone()[0] == "completed"
        kinds = [r[0] for r in db.execute(
            "SELECT action FROM audit_log WHERE entity_type='creditor'").fetchall()]
        assert kinds == ["close"]
        # снимок «до» — единственный путь восстановления
        import json
        snap = json.loads(db.execute(
            "SELECT changes FROM audit_log WHERE entity_type='creditor'").fetchone()[0])
        assert snap["status"] == "open" and snap["total"] == 30_000

    def test_смена_статуса_на_другой_обязательств_не_трогает(self, db):
        from routers.orders import _apply_status
        _cred(db, "c-1", "Работа: Сварка", 30_000)
        _apply_status(db, self._order_row(db), "awaiting_payment")
        assert db.execute("SELECT status FROM creditors WHERE id='c-1'").fetchone()[0] == "open"


class TestPlanFactRegress:
    """Инвариант «одна оплата = один факт»: факт заказа не зависит ни от статуса
    обязательства, ни от покрытия — иначе себестоимость поехала бы."""

    def test_факт_не_меняется_от_закрытия_обязательств(self, db):
        from routers.orders import _plan_fact
        from obligations import close_for_order
        _cred(db, "c-1", "Работа: Сварка", 30_000, paid=17_000)
        before = _plan_fact(db, "o-1", 30_000, 0, 0)
        close_for_order(db, "o-1", force=True)
        after = _plan_fact(db, "o-1", 30_000, 0, 0)
        assert before["cost_fact"] == after["cost_fact"] == 17_000

    def test_покрытие_не_меняет_факт(self, db):
        from routers.orders import _plan_fact
        from obligations import coverage
        _cred(db, "c-1", "Работа: Сварка", 30_000, paid=17_000)
        before = _plan_fact(db, "o-1", 30_000, 0, 0)["cost_fact"]
        coverage(db)
        assert _plan_fact(db, "o-1", 30_000, 0, 0)["cost_fact"] == before


class TestLedgerAgreement:
    """Карточка подрядчика и экран «Мы должны» обязаны показывать одно число:
    до этого лицевой счёт начислял полный план сметы и спорил с остатком."""

    def test_сальдо_совпадает_с_остатком_на_экране(self, db):
        from obligations import coverage, effective_debt
        from routers.ledger import _entries, _totals
        db.execute("""INSERT INTO estimate_lines (id, item_id, type, title, master_id)
                      VALUES ('l-1','i-1','labor','Сварка','m-1')""")
        _cred(db, "c-1", "Работа: Сварка", 30_000, line_id="l-1")
        db.execute("""INSERT INTO expenses (id, order_id, title, amount, category, master_id, expense_date)
                      VALUES ('e-1','o-1','Аванс',17000,'work','m-1','2026-08-01')""")
        master = dict(db.execute("SELECT * FROM masters WHERE id='m-1'").fetchone())
        balance = _totals(_entries(db, master))["balance"]
        cred = db.execute("SELECT * FROM creditors WHERE id='c-1'").fetchone()
        screen_debt = effective_debt(cred, coverage(db).get("c-1", {}))
        assert balance == screen_debt == 13_000

    def test_закрытое_со_списанием_даёт_ноль_а_не_фантом(self, db):
        from obligations import close_for_order
        from routers.ledger import _entries, _totals
        db.execute("""INSERT INTO estimate_lines (id, item_id, type, title, master_id)
                      VALUES ('l-1','i-1','labor','Сварка','m-1')""")
        _cred(db, "c-1", "Работа: Сварка", 30_000, line_id="l-1")
        db.execute("""INSERT INTO expenses (id, order_id, title, amount, category, master_id, expense_date)
                      VALUES ('e-1','o-1','Аванс',17000,'work','m-1','2026-08-01')""")
        close_for_order(db, "o-1", force=True)     # 13 000 списаны
        master = dict(db.execute("SELECT * FROM masters WHERE id='m-1'").fetchone())
        assert _totals(_entries(db, master))["balance"] == 0

    def test_постоянное_обязательство_не_попадает_в_сальдо(self, db):
        from routers.ledger import _entries, _totals
        db.execute("INSERT INTO masters (id, name) VALUES ('m-9','Аренда мастерской')")
        db.execute("""INSERT INTO creditors (id, name, total, paid, status, kind, period, created_at)
                      VALUES ('c-f','Аренда мастерской',4000,0,'open','fixed','2026-08',datetime('now'))""")
        master = dict(db.execute("SELECT * FROM masters WHERE id='m-9'").fetchone())
        assert _totals(_entries(db, master))["balance"] == 0
