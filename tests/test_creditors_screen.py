"""Экран денег: обязательства — план, а не долг (ТЗ фин-агента 03.09.2026, п.1/п.4/п.10).

- незапущенные заказы по умолчанию не отдаются;
- строка с ручным начислением лицевого счёта — «признано», из «осталось потратить» уходит;
- закрытие показывает дельту сальдо подрядчика и умеет «признать долг».
"""
import pytest
from fastapi import HTTPException


@pytest.fixture
def db(migrated):
    conn = migrated
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES ('o-1','ORD-901','МАФ','in_production')")
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES ('o-2','ORD-902','Дизайн','draft')")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-1','Эдуард Малафеев')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status, title) VALUES ('s-1','o-1','approved','Смета МАФ')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-1','s-1','Изделие')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status, title) VALUES ('s-2','o-2','approved','Смета дизайна')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-2','s-2','Проект')")
    conn.commit()
    return conn


def _cred(conn, cid, total, *, oid="o-1", item="i-1", paid=0, name="Эдуард Малафеев", status="open"):
    conn.execute(
        """INSERT INTO creditors (id, name, total, paid, order_id, status, estimate_item_id, created_at)
           VALUES (?,?,?,?,?,?,?,datetime('now'))""", (cid, name, total, paid, oid, status, item))
    conn.commit()


def _led(conn, lid, amount, *, kind="accrual", creditor_id=None, oid="o-1"):
    conn.execute(
        """INSERT INTO master_ledger (id, master_id, kind, amount, happened_at, order_id, creditor_id, note)
           VALUES (?,'m-1',?,?,'2026-08-05',?,?,'сверка')""", (lid, kind, amount, oid, creditor_id))
    conn.commit()


class TestGetCreditors:
    def test_незапущенные_скрыты_по_умолчанию(self, db):
        from routers.finance import get_creditors
        _cred(db, "c-1", 30_000)
        _cred(db, "c-2", 82_500, oid="o-2", item="i-2", name="Власов дизайн")
        res = get_creditors()
        assert [r["id"] for r in res["items"]] == ["c-1"]
        assert res["plan_total"] == 0 and res["plan_count"] == 0
        res = get_creditors(include_unstarted=True)
        assert {r["id"] for r in res["items"]} == {"c-1", "c-2"}
        assert res["plan_total"] == 82_500

    def test_признанное_уходит_из_осталось_потратить(self, db):
        from routers.finance import get_creditors
        _cred(db, "c-1", 30_000)
        _cred(db, "c-2", 20_000)
        _led(db, "l-1", 25_000, creditor_id="c-2")
        res = get_creditors()
        by = {r["id"]: r for r in res["items"]}
        assert by["c-2"]["recognized"] is True and by["c-2"]["recognized_amount"] == 25_000
        assert by["c-1"]["recognized"] is False
        assert by["c-1"]["set_title"] == "Смета МАФ" and by["c-1"]["master_id"] == "m-1"
        assert res["plan_rest_total"] == 30_000 and res["plan_rest_count"] == 1
        assert res["total_debt"] == res["plan_rest_total"]

    def test_покрытое_фактом_не_в_осталось_потратить(self, db):
        from routers.finance import get_creditors
        _cred(db, "c-1", 30_000, paid=30_000)
        res = get_creditors()
        assert res["items"][0]["covered"] is True and res["plan_rest_count"] == 0

    def test_double_accrual_подсказка(self, db):
        from routers.finance import get_creditors
        _cred(db, "c-1", 30_000)
        _led(db, "l-1", 30_000)          # по заказу, без creditor_id
        res = get_creditors()
        assert [d["creditor_id"] for d in res["double_accrual"]] == ["c-1"]


class TestClosePreview:
    def test_manual_роняет_сальдо_recognized_держит(self, db):
        from obligations import ledger_impact
        _cred(db, "c-1", 30_000)
        d = ledger_impact(db, ["c-1"], "manual")
        assert d["by_master"] == [{"master_id": "m-1", "name": "Эдуард Малафеев",
                                   "balance_before": 30_000, "balance_after": 0, "delta": -30_000}]
        assert d["unbound"] == []
        d = ledger_impact(db, ["c-1"], "recognized")
        assert d["by_master"][0]["delta"] == 0
        # предпросмотр ничего не записал
        assert db.execute("SELECT status FROM creditors WHERE id='c-1'").fetchone()[0] == "open"

    def test_непривязанная_строка_в_unbound(self, db):
        from obligations import ledger_impact
        _cred(db, "c-1", 9_348, name="Услуга: Резерв 10%")
        d = ledger_impact(db, ["c-1"], "manual")
        assert d["by_master"] == [] and [u["id"] for u in d["unbound"]] == ["c-1"]

    def test_recognized_по_непривязанной_409(self, db):
        from routers.finance import close_creditors, CloseIdsIn
        _cred(db, "c-1", 9_348, name="Услуга: Резерв 10%")
        with pytest.raises(HTTPException) as e:
            close_creditors(CloseIdsIn(ids=["c-1"], reason="recognized"))
        assert e.value.status_code == 409 and e.value.detail["code"] == "unbound_creditor"
        assert db.execute("SELECT status FROM creditors WHERE id='c-1'").fetchone()[0] == "open"

    def test_recognized_закрывает_с_причиной(self, db):
        from routers.finance import close_creditors, CloseIdsIn
        _cred(db, "c-1", 30_000)
        res = close_creditors(CloseIdsIn(ids=["c-1"], reason="recognized"))
        assert res["closed"] == 1
        row = db.execute("SELECT status, closed_reason FROM creditors WHERE id='c-1'").fetchone()
        assert tuple(row) == ("closed", "recognized")

    def test_409_завершения_несёт_дельту_сальдо(self, db):
        from routers.orders import _apply_status
        _cred(db, "c-1", 30_000)
        row = db.execute("SELECT * FROM orders WHERE id='o-1'").fetchone()
        with pytest.raises(HTTPException) as e:
            _apply_status(db, row, "completed")
        assert e.value.detail["ledger_delta"]["by_master"][0]["delta"] == -30_000

    def test_признанное_не_требует_подтверждения(self, db):
        from obligations import close_for_order
        _cred(db, "c-1", 30_000)
        _led(db, "l-1", 25_000, creditor_id="c-1")
        res = close_for_order(db, "o-1")
        assert res.get("needs_confirm") is None and res["closed"] == 1


class TestDeleteSetObligations:
    def test_с_деньгами_409(self, db):
        from routers.estimates import delete_obligations
        _cred(db, "c-1", 30_000, paid=5_000)
        with pytest.raises(HTTPException) as e:
            delete_obligations("s-1")
        assert e.value.status_code == 409
        assert db.execute("SELECT COUNT(*) FROM creditors").fetchone()[0] == 1
