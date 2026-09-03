"""Волна 4 (заглушить с причиной и датой, ТЗ п.7) и волна 5 (роли контрагентов, п.5)."""
import pytest
from fastapi import HTTPException


@pytest.fixture
def db(migrated):
    conn = migrated
    conn.execute("INSERT INTO customers (id, name) VALUES ('cu-1','Клиника')")
    conn.execute("INSERT INTO orders (id, number, title, status, price_plan, customer_id) VALUES ('o-1','ORD-901','Стойка','completed', 60000, 'cu-1')")
    conn.execute("INSERT INTO orders (id, number, title, status, price_plan, customer_id) VALUES ('o-2','ORD-902','Будка','in_production', 50000, 'cu-1')")
    conn.execute("INSERT INTO masters (id, name, role) VALUES ('m-1','Эдуард Малафеев','Мастер')")
    conn.execute("INSERT INTO masters (id, name, role) VALUES ('m-2','Марус','Партнёр')")
    conn.execute("INSERT INTO masters (id, name, role) VALUES ('m-3','Аренда мастерской','Накладные')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status) VALUES ('s-2','o-2','approved')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-2','s-2','Изделие')")
    conn.commit()
    return conn


class TestSnooze:
    def test_заказ_уходит_из_нам_должны_и_возвращается_по_сроку(self, db):
        from routers.finance import get_debtors, set_snooze, delete_snooze, SnoozeIn
        assert get_debtors()["total"] == 110_000          # o-1 60 000 + o-2 50 000
        set_snooze("order", "o-1", SnoozeIn(until="2099-12-31", reason="клиент тянет, не трогаем до НГ"))
        d = get_debtors()
        assert d["total"] == 50_000 and [s["id"] for s in d["snoozed"]] == ["o-1"]
        assert d["snoozed"][0]["snoozed"]["reason"].startswith("клиент")
        # истёкший снуз не действует
        db.execute("UPDATE snoozes SET until = '2020-01-01'"); db.commit()
        assert get_debtors()["total"] == 110_000
        # «навсегда» — until NULL
        set_snooze("order", "o-1", SnoozeIn(until=None, reason="навсегда"))
        assert get_debtors()["total"] == 50_000
        delete_snooze("order", "o-1")
        assert get_debtors()["total"] == 110_000

    def test_обязательство_уходит_из_осталось_потратить(self, db):
        from routers.finance import get_creditors, set_snooze, SnoozeIn, list_snoozes
        db.execute("""INSERT INTO creditors (id, name, total, paid, order_id, status, estimate_item_id, created_at)
                      VALUES ('c-1','Эдуард Малафеев',30000,0,'o-2','open','i-2',datetime('now'))"""); db.commit()
        assert get_creditors()["plan_rest_total"] == 30_000
        set_snooze("creditor", "c-1", SnoozeIn(until=None, reason="старая прикидка"))
        res = get_creditors()
        assert res["plan_rest_total"] == 0 and [s["id"] for s in res["snoozed"]] == ["c-1"]
        lst = list_snoozes()["items"]
        assert lst[0]["entity_type"] == "creditor" and "Малафеев" in lst[0]["title"]

    def test_неизвестный_вид_400(self, db):
        from routers.finance import set_snooze, SnoozeIn
        with pytest.raises(HTTPException) as e:
            set_snooze("master", "m-1", SnoozeIn(reason="x"))
        assert e.value.status_code == 400

    def test_журнал_пишется(self, db):
        from routers.finance import set_snooze, SnoozeIn
        set_snooze("order", "o-1", SnoozeIn(until="2099-01-01", reason="ждём"))
        row = db.execute("SELECT entity_type, action FROM audit_log ORDER BY rowid DESC LIMIT 1").fetchone()
        assert tuple(row) == ("order", "snooze")


class TestRoles:
    def test_роль_только_из_списка(self, db):
        from routers.masters import create_master, MasterCreate
        with pytest.raises(HTTPException) as e:
            create_master(MasterCreate(name="Кто-то", role="Сосед"))
        assert e.value.status_code == 400
        row = create_master(MasterCreate(name="Кто-то", role="Партнёр"))
        assert row["role"] == "Партнёр"

    def test_балансы_делятся_по_ролям(self, db):
        from routers.ledger import balances
        for lid, mid, amt in (("l-1", "m-1", 10_000), ("l-2", "m-2", 34_300), ("l-3", "m-3", 4_000)):
            db.execute("""INSERT INTO master_ledger (id, master_id, kind, amount, happened_at)
                          VALUES (?,?,'accrual',?,'2026-08-05')""", (lid, mid, amt))
        db.commit()
        b = balances(nonzero=True)
        kinds = {m["master_id"]: m["kind"] for m in b["items"]}
        assert kinds == {"m-1": "contractor", "m-2": "partner", "m-3": "overhead"}
        assert b["we_owe"] == 10_000 and b["partners_total"] == 34_300 and b["overhead_total"] == 4_000
