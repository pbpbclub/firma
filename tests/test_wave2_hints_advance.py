"""Волна 2 ТЗ 03.09.2026: «похоже, заказ завершён» (п.2) и технические сальдо (п.6).

Отрицательное сальдо без явного аванса — дырка в разноске, не «нам должны»:
на 03.09.2026 так висели Ант Сервис 37 772, Роман Лазарев 28 000, Самсонов
23 250 — у всех начислено 0. Аванс — только явно помеченная выплата
(purpose=contractor_advance) или расход, закрытый авансом (settled_by=advance).
"""
import pytest


@pytest.fixture
def db(migrated):
    conn = migrated
    conn.execute("INSERT INTO orders (id, number, title, status, price_plan) VALUES ('o-1','ORD-901','Будка','in_production', 50000)")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-1','Эдуард Малафеев')")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-2','Ант Сервис')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status) VALUES ('s-1','o-1','approved')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-1','s-1','Изделие')")
    conn.commit()
    return conn


def _cred(conn, cid, total, *, paid=0, name="Эдуард Малафеев"):
    conn.execute("""INSERT INTO creditors (id, name, total, paid, order_id, status, estimate_item_id, created_at)
                    VALUES (?,?,?,?,'o-1','open','i-1',datetime('now'))""", (cid, name, total, paid))
    conn.commit()


def _pay(conn, amount):
    conn.execute("INSERT INTO payments (id, order_id, amount, paid_at) VALUES (lower(hex(randomblob(8))),'o-1',?,'2026-08-20')", (amount,))
    conn.commit()


def _gexp(conn, eid, master, amount, purpose):
    conn.execute("""INSERT INTO expenses (id, order_id, title, amount, category, master_id, purpose, expense_date)
                    VALUES (?,NULL,'вне заказа',?,'work',?,?,'2026-08-01')""", (eid, amount, master, purpose))
    conn.commit()


class TestDoneHint:
    def test_флаг_только_при_полной_оплате_и_без_остатков(self, db):
        from routers.orders import _awaiting_flags
        assert _awaiting_flags("in_production", 50_000, 50_000, 0.0)["done_hint"] is True
        assert _awaiting_flags("in_production", 50_000, 49_000, 0.0)["done_hint"] is False
        # открытый остаток подсказку не гасит — его решает окно завершения
        f = _awaiting_flags("in_production", 50_000, 50_000, 1_500.0)
        assert f["done_hint"] is True and f["done_open_rest"] == 1_500
        assert _awaiting_flags("completed", 50_000, 50_000, 0.0)["done_hint"] is False

    def test_остаток_обязателен_а_не_молчаливый_ноль(self, db):
        """04.09.2026: у open_rest был дефолт None и `or 0.0` в теле — забытый
        аргумент нового вызова выглядел бы как честный ноль, и подсказка
        «похоже, завершён» уходила бы без предупреждения об остатке."""
        from routers.orders import _awaiting_flags
        with pytest.raises(TypeError):
            _awaiting_flags("in_production", 50_000, 50_000)

    def test_остаток_по_заказу_не_считает_признанное(self, db):
        from obligations import open_rest_by_order
        _cred(db, "c-1", 30_000)
        _cred(db, "c-2", 20_000, paid=20_000)
        db.execute("""INSERT INTO master_ledger (id, master_id, kind, amount, happened_at, order_id, creditor_id)
                      VALUES ('l-1','m-1','accrual',25000,'2026-08-05','o-1','c-1')"""); db.commit()
        assert open_rest_by_order(db) == {}
        db.execute("DELETE FROM master_ledger"); db.commit()
        assert open_rest_by_order(db) == {"o-1": 30_000}

    def test_карточка_и_экран_денег_несут_подсказку(self, db):
        from routers.orders import get_order
        from routers.finance import get_creditors
        _pay(db, 50_000)
        assert get_order("o-1")["done_hint"] is True
        done = get_creditors()["looks_done"]
        assert [d["number"] for d in done] == ["ORD-901"]
        _cred(db, "c-1", 5_734)
        o = get_order("o-1")
        assert o["done_hint"] is True and o["done_open_rest"] == 5_734
        assert get_creditors()["looks_done"][0]["open_rest"] == 5_734


class TestAdvanceState:
    def _bal(self):
        from routers.ledger import balances
        return balances(nonzero=True)

    def test_выплата_без_начислений_это_дырка_разноски(self, db):
        _gexp(db, "e-1", "m-2", 37_772, "contractor_pay")
        b = self._bal()
        it = {m["master_id"]: m for m in b["items"]}
        assert it["m-2"]["state"] == "unallocated" and it["m-2"]["balance"] == -37_772
        assert b["they_owe"] == 0 and b["unallocated_total"] == 37_772

    def test_явный_аванс_это_аванс(self, db):
        _gexp(db, "e-1", "m-2", 48_538, "contractor_advance")
        b = self._bal()
        it = {m["master_id"]: m for m in b["items"]}
        assert it["m-2"]["state"] == "advance" and it["m-2"]["advance"] == 48_538
        assert b["they_owe"] == 48_538 and b["unallocated_total"] == 0

    def test_нулевое_сальдо_не_отдаётся(self, db):
        _gexp(db, "e-1", "m-2", 10_000, "contractor_pay")
        db.execute("""INSERT INTO master_ledger (id, master_id, kind, amount, happened_at)
                      VALUES ('l-1','m-2','accrual',10000,'2026-08-05')"""); db.commit()
        assert [m["master_id"] for m in self._bal()["items"]] == []

    def test_кнопка_выдать_аванс_ставит_contractor_advance(self, db):
        from routers.ledger import contractor_pay, ContractorPayIn
        contractor_pay(ContractorPayIn(master_id="m-2", kind="advance", amount=5_000, category="work"))
        row = db.execute("SELECT purpose FROM expenses WHERE master_id='m-2'").fetchone()
        assert row[0] == "contractor_advance"
        assert self._bal()["items"][0]["state"] == "advance"

    def test_ручной_kind_advance_в_регистр_нельзя(self, db):
        from fastapi import HTTPException
        from routers.ledger import create_entry, EntryIn
        with pytest.raises(HTTPException) as e:
            create_entry(EntryIn(master_id="m-2", kind="advance", amount=1))
        assert e.value.status_code == 400
