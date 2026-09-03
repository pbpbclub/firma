"""Начисления лицевого счёта: проводка главнее строки сметы, закрытие с причиной
recognized держит долг (ТЗ фин-агента 03.09.2026, п.1).

03.09.2026 ручное закрытие «дублей» Малафеева уронило начисление на 111 500 ₽:
лента брала признанное закрытой строки как покрытую часть, а покрытия не было.
Сальдо перевернулось с «мы должны 87 100» на «должен отработать 24 400».
"""
import pytest


@pytest.fixture
def db(migrated):
    conn = migrated
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES ('o-1','ORD-901','МАФ','in_production')")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-1','Эдуард Малафеев')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status) VALUES ('s-1','o-1','approved')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-1','s-1','Изделие')")
    return conn


def _cred(conn, cid, total, *, paid=0, status="open", reason=None, name="Эдуард Малафеев"):
    conn.execute(
        """INSERT INTO creditors (id, name, total, paid, order_id, status, closed_reason, estimate_item_id, created_at)
           VALUES (?,?,?,?,'o-1',?,?,'i-1',datetime('now'))""", (cid, name, total, paid, status, reason))


def _led(conn, lid, amount, *, kind="accrual", creditor_id=None):
    conn.execute(
        """INSERT INTO master_ledger (id, master_id, kind, amount, happened_at, order_id, creditor_id, note)
           VALUES (?,'m-1',?,?,'2026-08-05','o-1',?,'сверка')""", (lid, kind, amount, creditor_id))


def _entries(conn):
    from routers.ledger import _entries, _totals
    m = dict(conn.execute("SELECT * FROM masters WHERE id='m-1'").fetchone())
    e = _entries(conn, m)
    return e, _totals(e)


class TestClosedReason:
    def test_recognized_держит_полную_сумму(self, db):
        _cred(db, "c-1", 93_500, status="closed", reason="recognized")
        e, t = _entries(db)
        assert t["accrued"] == 93_500 and t["balance"] == 93_500

    def test_manual_роняет_до_покрытой_части(self, db):
        _cred(db, "c-1", 93_500, status="closed", reason="manual")
        e, t = _entries(db)
        assert t["accrued"] == 0

    def test_без_причины_как_manual(self, db):
        _cred(db, "c-1", 93_500, paid=20_000, status="closed", reason=None)
        e, t = _entries(db)
        assert t["accrued"] == 20_000 and t["paid"] == 20_000 and t["balance"] == 0


class TestManualAccrualWins:
    def test_проводка_вытесняет_начисление_строки(self, db):
        _cred(db, "c-1", 30_000)
        _led(db, "l-1", 25_000, creditor_id="c-1")
        e, t = _entries(db)
        assert t["accrued"] == 25_000
        assert [x["source"] for x in e if x["kind"] == "accrual"] == ["ledger"]

    def test_paid_без_расхода_остаётся_выплатой(self, db):
        _cred(db, "c-1", 30_000, paid=10_000)
        _led(db, "l-1", 25_000, creditor_id="c-1")
        e, t = _entries(db)
        assert t["accrued"] == 25_000 and t["paid"] == 10_000 and t["balance"] == 15_000

    def test_plan_open_только_от_открытых_строк(self, db):
        _cred(db, "c-1", 30_000)
        _cred(db, "c-2", 10_000, status="closed", reason="recognized")
        e, t = _entries(db)
        assert t["accrued"] == 40_000 and t["plan_open"] == 30_000


class TestEntryGuard:
    def test_второе_ручное_начисление_по_строке_409(self, db):
        from fastapi import HTTPException
        from routers.ledger import create_entry, EntryIn
        _cred(db, "c-1", 30_000)
        db.commit()
        create_entry(EntryIn(master_id="m-1", kind="accrual", amount=25_000, creditor_id="c-1"))
        with pytest.raises(HTTPException) as e:
            create_entry(EntryIn(master_id="m-1", kind="accrual", amount=25_000, creditor_id="c-1"))
        assert e.value.status_code == 409

    def test_первое_ручное_начисление_по_открытой_строке_разрешено(self, db):
        from routers.ledger import create_entry, EntryIn
        _cred(db, "c-1", 30_000)
        db.commit()
        row = create_entry(EntryIn(master_id="m-1", kind="accrual", amount=25_000, creditor_id="c-1"))
        assert row["creditor_id"] == "c-1"
