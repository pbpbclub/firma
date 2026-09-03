"""Волна 3 ТЗ 03.09.2026: резерв не обязательство (п.3), новая версия сметы
переносит обязательства (п.8), имена-заглушки не проходят (п.9).
"""
import pytest
from fastapi import HTTPException


@pytest.fixture
def db(migrated):
    conn = migrated
    conn.execute("INSERT INTO orders (id, number, title, status, price_plan) VALUES ('o-1','ORD-901','МАФ','in_production', 100000)")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-1','Эдуард Малафеев')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status, title) VALUES ('s-1','o-1','approved','Смета v1')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title, sort_order, quantity) VALUES ('i-1','s-1','Башня',0,1)")
    conn.commit()
    return conn


def _line(conn, lid, item, title, *, ltype="labor", master=None, contractor=None, code=None, total=1000, internal=0, sort=0):
    conn.execute("""INSERT INTO estimate_lines (id, item_id, type, title, qty, unit, unit_price, line_total, master_id,
                                                contractor_name, material_code, internal, sort_order)
                    VALUES (?,?,?,?,1,'шт',?,?,?,?,?,?,?)""",
                 (lid, item, ltype, title, total, total, master, contractor, code, internal, sort))
    conn.commit()


def _set(conn):
    return conn.execute("SELECT * FROM estimate_sets WHERE id='s-1'").fetchone()


class TestHasPayee:
    def test_правила(self):
        from obligations import has_payee, is_placeholder
        assert has_payee({"type": "service", "master_id": None, "contractor_name": "", "material_code": None, "internal": 0}) is False
        assert has_payee({"type": "service", "master_id": None, "contractor_name": "Лазер", "material_code": None, "internal": 0}) is True
        assert has_payee({"type": "labor", "master_id": None, "contractor_name": None, "material_code": None, "internal": 0}) is True
        assert has_payee({"type": "material", "master_id": None, "contractor_name": None, "material_code": None, "internal": 0}) is True
        assert has_payee({"type": "labor", "master_id": "m-1", "contractor_name": None, "material_code": None, "internal": 1}) is False
        assert is_placeholder("Позиция 2") and is_placeholder("Прочее: Сварка") and is_placeholder("  ")
        assert not is_placeholder("Эдуард Малафеев") and not is_placeholder("Материалы Иванова")


class TestGenSkipsInternal:
    def test_резерв_и_внутренняя_строка_не_рождают_обязательств(self, db):
        from routers.estimates import _gen_obligations
        _line(db, "l-1", "i-1", "Сварка", master="m-1", total=30_000)
        _line(db, "l-2", "i-1", "Резерв 10% на непредвиденное", ltype="service", total=9_348)
        _line(db, "l-3", "i-1", "Наценка", ltype="labor", total=500, internal=1)
        res = _gen_obligations(db, _set(db))
        assert res["created"] == 1 and res["skipped_internal"] == 2
        assert [r[0] for r in db.execute("SELECT estimate_line_id FROM creditors").fetchall()] == ["l-1"]

    def test_позиция_без_состава_с_именем_заглушкой(self, db):
        from routers.estimates import _gen_obligations
        db.execute("INSERT INTO estimate_items (id, set_id, title, cost_total) VALUES ('i-2','s-1','Позиция 2', 7000)"); db.commit()
        res = _gen_obligations(db, _set(db))
        assert res["created"] == 1 and res["skipped_internal"] == 1   # «Башня» — позиция без состава, имя честное


class TestStaleInternal:
    def test_плашка_и_закрытие_с_причиной_internal(self, db):
        from routers.finance import get_creditors, close_stale_obligations, CloseStaleIn
        _line(db, "l-2", "i-1", "Резерв 10%", ltype="service", total=9_348)
        db.execute("""INSERT INTO creditors (id, name, total, paid, order_id, status, estimate_item_id, estimate_line_id, created_at)
                      VALUES ('c-r','Услуга: Резерв 10%',9348,0,'o-1','open','i-1','l-2',datetime('now'))""")
        db.commit()
        res = get_creditors()
        assert res["stale"]["internal"]["count"] == 1 and res["stale"]["internal"]["total"] == 9_348
        assert res["items"][0]["no_payee"] is True
        out = close_stale_obligations(CloseStaleIn(kinds=["internal"]))
        assert out["closed"] == 1
        row = db.execute("SELECT status, closed_reason FROM creditors WHERE id='c-r'").fetchone()
        assert tuple(row) == ("closed", "internal")


class TestRepoint:
    def _approve_v2(self, db):
        from routers.estimates import new_set_version, _approve_set
        v2 = new_set_version("s-1")
        db.execute("UPDATE estimate_sets SET status='approved' WHERE id=?", (v2["id"],)); db.commit()
        es = db.execute("SELECT * FROM estimate_sets WHERE id=?", (v2["id"],)).fetchone()
        res = _approve_set(db, v2["id"])
        db.commit()
        return v2["id"], res

    def test_перенос_сохраняет_оплату_и_не_плодит_дубли(self, db):
        from routers.estimates import _gen_obligations
        from routers.orders import _fact_costs
        _line(db, "l-1", "i-1", "Сварка", master="m-1", total=30_000, sort=0)
        _line(db, "l-2", "i-1", "Покраска", contractor="Спектр", total=12_000, sort=1)
        _gen_obligations(db, _set(db)); db.commit()
        c1 = db.execute("SELECT id FROM creditors WHERE estimate_line_id='l-1'").fetchone()[0]
        db.execute("""INSERT INTO expenses (id, order_id, title, amount, category, master_id, creditor_id, expense_date)
                      VALUES ('e-1','o-1','Сварка',10000,'work','m-1',?,'2026-08-01')""", (c1,))
        db.execute("UPDATE creditors SET paid = 10000 WHERE id = ?", (c1,)); db.commit()
        fact_before = _fact_costs(db, ["o-1"])
        v2, res = self._approve_v2(db)
        # цену сварки в v2 подняли — обязательство едет вместе с планом
        new_line = db.execute("""SELECT el.id FROM estimate_lines el JOIN estimate_items ei ON ei.id = el.item_id
                                  WHERE ei.set_id = ? AND el.title = 'Сварка'""", (v2,)).fetchone()[0]
        db.execute("UPDATE estimate_lines SET line_total = 35000, unit_price = 35000 WHERE id = ?", (new_line,)); db.commit()
        assert res["repointed"]["moved"] == 2 and res["obligations"]["created"] == 0
        row = db.execute("SELECT estimate_line_id, prev_estimate_line_id, paid, status FROM creditors WHERE id = ?", (c1,)).fetchone()
        assert row[0] == new_line and row[1] == "l-1" and row[2] == 10_000 and row[3] == "open"
        assert db.execute("SELECT COUNT(*) FROM creditors").fetchone()[0] == 2
        assert _fact_costs(db, ["o-1"]) == fact_before

    def test_несовпавшая_старая_закрывается_superseded(self, db):
        from routers.estimates import _gen_obligations
        _line(db, "l-1", "i-1", "Сварка", master="m-1", total=30_000)
        _gen_obligations(db, _set(db)); db.commit()
        v2, res = self._approve_v2(db)
        # в v2 сварку удалили
        db.execute("""DELETE FROM estimate_lines WHERE id IN (SELECT el.id FROM estimate_lines el
                      JOIN estimate_items ei ON ei.id = el.item_id WHERE ei.set_id = ?)""", (v2,)); db.commit()
        # переигрываем approve уже без строки: старое обязательство закрывается
        from routers.estimates import _approve_set
        db.execute("UPDATE creditors SET estimate_line_id='l-1', estimate_item_id='i-1', prev_estimate_line_id=NULL, prev_estimate_item_id=NULL")
        db.execute("UPDATE estimate_sets SET status='superseded', superseded_by=? WHERE id='s-1'", (v2,)); db.commit()
        res = _approve_set(db, v2)
        assert res["repointed"]["closed"] == 1
        assert db.execute("SELECT closed_reason FROM creditors").fetchone()[0] == "superseded_estimate"

    def test_unapprove_возвращает_на_старые_строки(self, db):
        from routers.estimates import _gen_obligations, unapprove_set, UnapproveIn
        _line(db, "l-1", "i-1", "Сварка", master="m-1", total=30_000)
        _gen_obligations(db, _set(db)); db.commit()
        c1 = db.execute("SELECT id FROM creditors").fetchone()[0]
        db.execute("UPDATE creditors SET paid = 5000 WHERE id = ?", (c1,)); db.commit()
        v2, _ = self._approve_v2(db)
        unapprove_set(v2, UnapproveIn(confirm=True))
        row = db.execute("SELECT estimate_line_id, prev_estimate_line_id, status FROM creditors WHERE id = ?", (c1,)).fetchone()
        assert tuple(row) == ("l-1", None, "open")
        assert db.execute("SELECT status FROM estimate_sets WHERE id='s-1'").fetchone()[0] == "draft"

    def test_double_sets_предупреждение(self, db):
        from routers.finance import get_creditors
        db.execute("INSERT INTO estimate_sets (id, order_id, status, title) VALUES ('s-2','o-1','superseded','Смета v0')")
        db.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-2','s-2','Башня')")
        for cid, item in (("c-1", "i-1"), ("c-2", "i-2")):
            db.execute("""INSERT INTO creditors (id, name, total, paid, order_id, status, estimate_item_id, created_at)
                          VALUES (?,'Эдуард Малафеев',1000,0,'o-1','open',?,datetime('now'))""", (cid, item))
        db.commit()
        ds = get_creditors()["double_sets"]
        assert len(ds) == 1 and {s["title"] for s in ds[0]["sets"]} == {"Смета v1", "Смета v0"}


class TestNameValidation:
    def test_заглушка_400(self, db):
        from routers.finance import create_creditor, CreditorIn
        with pytest.raises(HTTPException) as e:
            create_creditor(CreditorIn(name="Позиция 2", total=7000))
        assert e.value.status_code == 400
        assert db.execute("SELECT COUNT(*) FROM creditors").fetchone()[0] == 0
