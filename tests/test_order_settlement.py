"""Актуальные обязательства (26.08.2026): закрытие с причиной при отмене и
архивации, «расчёты с клиентом закрыты» у заказа, защита удаления.

До этого отмена и архивация были голым UPDATE: строки уходили с экрана «Мы
должны», но начислялись в сальдо подрядчика полным планом (ORD-005: 149 867 ₽),
а завершённый заказ с непривязанными платежами висел в дебиторке вечно.
"""
import pytest
from fastapi import HTTPException


@pytest.fixture
def db(migrated):
    conn = migrated
    conn.execute("INSERT INTO orders (id, number, title, status, price_plan, cost_plan, archived) "
                 "VALUES ('o-1','ORD-901','Спираль','in_production',100000,60000,0)")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-1','Эдуард Малафеев')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status) VALUES ('s-1','o-1','approved')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-1','s-1','Изделие')")
    return conn


def _cred(conn, cid, name, total, *, paid=0, status="open", kind=None):
    conn.execute(
        """INSERT INTO creditors (id, name, total, paid, order_id, status, estimate_item_id, kind, created_at)
           VALUES (?,?,?,?,'o-1',?,'i-1',?,datetime('now'))""", (cid, name, total, paid, status, kind))


class _NoCloseConn:
    def __init__(self, conn): self._conn = conn
    def __getattr__(self, name): return getattr(self._conn, name)
    def close(self): pass


class TestReasons:
    def test_причина_прописывается(self, db):
        from obligations import close_for_order
        _cred(db, "c-1", "Сварка", 30_000)
        res = close_for_order(db, "o-1", force=True, reason="order_cancelled")
        assert res["reason"] == "order_cancelled"
        assert db.execute("SELECT closed_reason FROM creditors WHERE id='c-1'").fetchone()[0] == "order_cancelled"

    def test_переоткрывается_только_своя_причина(self, db):
        from obligations import reopen_for_order
        _cred(db, "c-1", "Сварка", 30_000, status="closed")
        _cred(db, "c-2", "Металл", 18_000, status="closed")
        db.execute("UPDATE creditors SET closed_reason='order_cancelled' WHERE id='c-1'")
        db.execute("UPDATE creditors SET closed_reason='order_archived' WHERE id='c-2'")
        assert reopen_for_order(db, "o-1", reason="order_archived")["reopened"] == 1
        got = dict(db.execute("SELECT id, status FROM creditors").fetchall())
        assert got == {"c-1": "closed", "c-2": "open"}

    def test_close_manual_всё_или_ничего(self, db):
        from obligations import close_manual
        _cred(db, "c-1", "Сварка", 30_000)
        _cred(db, "c-2", "Металл", 18_000, status="closed")
        with pytest.raises(ValueError) as e:
            close_manual(db, ["c-1", "c-2"])
        assert [b["id"] for b in e.value.args[0]] == ["c-2"]
        assert db.execute("SELECT status FROM creditors WHERE id='c-1'").fetchone()[0] == "open"
        res = close_manual(db, ["c-1"])
        assert res["closed"] == 1 and res["written_off"] == 30_000
        assert db.execute("SELECT closed_reason FROM creditors WHERE id='c-1'").fetchone()[0] == "manual"


class TestCancelAndArchive:
    def test_отмена_без_подтверждения_409_и_статус_не_меняется(self, db):
        from routers.orders import _apply_status
        _cred(db, "c-1", "Сварка", 30_000)
        row = db.execute("SELECT * FROM orders WHERE id='o-1'").fetchone()
        with pytest.raises(HTTPException) as e:
            _apply_status(db, row, "cancelled")
        assert e.value.status_code == 409 and e.value.detail["target"] == "cancelled"
        assert db.execute("SELECT status FROM orders WHERE id='o-1'").fetchone()[0] == "in_production"

    def test_подтверждённая_отмена_закрывает_с_причиной_и_журналом(self, db):
        from routers.orders import _apply_status
        _cred(db, "c-1", "Сварка", 30_000)
        row = db.execute("SELECT * FROM orders WHERE id='o-1'").fetchone()
        _apply_status(db, row, "cancelled", close_obligations=True)
        assert tuple(db.execute("SELECT status, closed_reason FROM creditors WHERE id='c-1'").fetchone()) == ("closed", "order_cancelled")
        kinds = {r[0] for r in db.execute("SELECT entity_type || '/' || action FROM audit_log").fetchall()}
        assert {"creditor/close", "order/status"} <= kinds

    def test_возврат_из_отмены_переоткрывает_только_отменённое(self, db):
        from routers.orders import _apply_status
        _cred(db, "c-1", "Сварка", 30_000)
        _cred(db, "c-2", "Металл", 18_000, status="closed")
        db.execute("UPDATE creditors SET closed_reason='manual' WHERE id='c-2'")
        row = db.execute("SELECT * FROM orders WHERE id='o-1'").fetchone()
        _apply_status(db, row, "cancelled", close_obligations=True)
        row = db.execute("SELECT * FROM orders WHERE id='o-1'").fetchone()
        _apply_status(db, row, "in_production")
        got = dict(db.execute("SELECT id, status FROM creditors").fetchall())
        assert got == {"c-1": "open", "c-2": "closed"}

    def test_архивация_409_потом_закрывает_и_пишет_журнал(self, db, monkeypatch):
        from routers import orders
        monkeypatch.setattr(orders, "get_production", lambda: _NoCloseConn(db))
        _cred(db, "c-1", "Сварка", 30_000)
        with pytest.raises(HTTPException) as e:
            orders.archive_order("o-1")
        assert e.value.status_code == 409 and e.value.detail["target"] == "archived"
        assert db.execute("SELECT archived FROM orders WHERE id='o-1'").fetchone()[0] == 0
        res = orders.archive_order("o-1", orders.ArchiveIn(close_obligations=True))
        assert res["archived"] is True and res["closed_obligations"] == 1
        assert db.execute("SELECT closed_reason FROM creditors WHERE id='c-1'").fetchone()[0] == "order_archived"
        assert db.execute("SELECT COUNT(*) FROM audit_log WHERE entity_type='order' AND action='archive'").fetchone()[0] == 1
        # обратно — переоткрывает закрытое архивацией
        res = orders.unarchive_order("o-1")
        assert res["reopened"] == 1
        assert db.execute("SELECT status FROM creditors WHERE id='c-1'").fetchone()[0] == "open"


class TestSettle:
    def test_живой_заказ_закрыть_нельзя(self, db, monkeypatch):
        from routers import orders
        monkeypatch.setattr(orders, "get_production", lambda: _NoCloseConn(db))
        with pytest.raises(HTTPException) as e:
            orders.settle_order("o-1")
        assert e.value.status_code == 409 and e.value.detail["code"] == "order_not_final"

    def test_settle_исключает_из_дебиторки_и_не_трогает_план_факт(self, db, monkeypatch):
        from routers import orders, finance
        from routers.orders import _plan_fact
        monkeypatch.setattr(orders, "get_production", lambda: _NoCloseConn(db))
        monkeypatch.setattr(finance, "get_production", lambda: _NoCloseConn(db))
        monkeypatch.setattr(finance, "get_finance", lambda: _NoCloseConn(db))
        db.execute("UPDATE orders SET status='completed' WHERE id='o-1'")
        db.execute("INSERT INTO payments (id, order_id, amount, paid_at) VALUES ('p-1','o-1',60000,'2026-08-01')")
        before = finance.get_debtors()
        assert [d["debt"] for d in before["items"]] == [40000]
        pf_before = _plan_fact(db, "o-1", 60000, 60000, 100000)

        res = orders.settle_order("o-1", orders.SettleIn(note="остаток не привяжем"))
        assert res["unlinked"] == 40000
        after = finance.get_debtors()
        assert after["items"] == [] and after["total"] == 0
        assert after["settled"][0]["unlinked"] == 40000 and after["settled"][0]["settled_note"] == "остаток не привяжем"
        assert _plan_fact(db, "o-1", 60000, 60000, 100000) == pf_before

        with pytest.raises(HTTPException) as e:
            orders.settle_order("o-1")
        assert e.value.detail["code"] == "already_settled"
        orders.unsettle_order("o-1")
        assert finance.get_debtors()["items"][0]["debt"] == 40000


class TestCreditorGuards:
    def test_удаление_с_paid_409(self, db, monkeypatch):
        from routers import finance
        monkeypatch.setattr(finance, "get_production", lambda: _NoCloseConn(db))
        _cred(db, "c-1", "Сварка", 30_000, paid=5_000)
        with pytest.raises(HTTPException) as e:
            finance.delete_creditor("c-1")
        assert e.value.status_code == 409 and e.value.detail["code"] == "creditor_has_money"
        assert db.execute("SELECT COUNT(*) FROM creditors").fetchone()[0] == 1

    def test_удаление_покрытого_расходом_409_а_нетронутого_ок(self, db, monkeypatch):
        from routers import finance
        monkeypatch.setattr(finance, "get_production", lambda: _NoCloseConn(db))
        _cred(db, "c-1", "Зеркало", 10_000)
        _cred(db, "c-2", "Металл", 18_000)
        db.execute("""INSERT INTO expenses (id, order_id, title, amount, category, creditor_id, expense_date)
                      VALUES ('e-1','o-1','Зеркало',10000,'material','c-1','2026-08-01')""")
        with pytest.raises(HTTPException) as e:
            finance.delete_creditor("c-1")
        assert e.value.detail["covered"] == 10000
        assert finance.delete_creditor("c-2")["ok"] is True

    def test_patch_closed_без_причины_ставит_manual(self, db, monkeypatch):
        from routers import finance
        monkeypatch.setattr(finance, "get_production", lambda: _NoCloseConn(db))
        _cred(db, "c-1", "Сварка", 30_000)
        finance.update_creditor("c-1", finance.CreditorPatch(status="closed"))
        assert db.execute("SELECT closed_reason FROM creditors WHERE id='c-1'").fetchone()[0] == "manual"
        finance.update_creditor("c-1", finance.CreditorPatch(status="open"))
        assert tuple(db.execute("SELECT closed_reason, closed_at FROM creditors WHERE id='c-1'").fetchone()) == (None, None)

    def test_close_stale_отменённый_закрывается_живой_нет(self, db, monkeypatch):
        from routers import finance
        monkeypatch.setattr(finance, "get_production", lambda: _NoCloseConn(db))
        _cred(db, "c-1", "Сварка", 30_000)
        with pytest.raises(HTTPException) as e:
            finance.close_stale_obligations(finance.CloseStaleIn(kinds=["cancelled"], order_ids=["o-1"]))
        assert e.value.status_code == 400
        db.execute("UPDATE orders SET status='cancelled' WHERE id='o-1'")
        res = finance.close_stale_obligations(finance.CloseStaleIn(kinds=["cancelled"], order_ids=["o-1"]))
        assert res["closed"] == 1 and res["by_kind"]["order_cancelled"]["closed"] == 1
        assert db.execute("SELECT closed_reason FROM creditors WHERE id='c-1'").fetchone()[0] == "order_cancelled"
        # stale в get_creditors теперь пуст, а закрытая строка начисляется признанным
        got = finance.get_creditors()
        assert got["stale"]["cancelled"]["count"] == 0
