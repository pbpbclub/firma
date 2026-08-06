"""Покрытие обязательства фактом (backend/obligations.py).

Обязательства рождаются из строк сметы — это ПЛАН. Деньги подрядчику уходят
расходами, и `creditors.paid` при этом чаще всего не двигается (на 04.08.2026
отмечено оплаченными 2% суммы). Экран «Мы должны» показывал полный план как долг.

Покрытие считается на лету и НИЧЕГО не пишет в базу: `creditors.paid` остаётся
как был — иначе поехал бы инвариант «одна оплата = один факт» (CLAUDE.md).
"""
import sqlite3
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent / "backend"


@pytest.fixture
def db(conn):
    """Заказ в производстве + подрядчики. Схема — клон боевой (conftest)."""
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES ('o-1','ORD-901','Заказ','in_production')")
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES ('o-2','ORD-902','Другой','in_production')")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-1','Эдуард Малафеев')")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-2','Спектр-Колор')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status) VALUES ('s-1','o-1','approved')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-1','s-1','Изделие')")
    return conn


def _cred(conn, cid, name, total, *, oid="o-1", paid=0, line_id=None, status="open",
          fin_tx=None, zen_tx=None, kind=None):
    conn.execute(
        """INSERT INTO creditors (id, name, total, paid, order_id, status, estimate_line_id,
                                  estimate_item_id, finance_tx_id, zenmoney_tx_id, kind, created_at)
           VALUES (?,?,?,?,?,?,?,'i-1',?,?,?,datetime('now'))""",
        (cid, name, total, paid, oid, status, line_id, fin_tx, zen_tx, kind))


def _line(conn, lid, title, *, master_id=None, contractor=None, ltype="labor"):
    conn.execute(
        """INSERT INTO estimate_lines (id, item_id, type, title, master_id, contractor_name)
           VALUES (?,'i-1',?,?,?,?)""", (lid, ltype, title, master_id, contractor))


def _exp(conn, eid, amount, *, oid="o-1", master_id=None, supplier=None, cat="work",
         creditor_id=None, fin_tx=None, zen_tx=None, extra_id=None, purpose=None, date="2026-08-01"):
    conn.execute(
        """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                 creditor_id, finance_tx_id, zenmoney_tx_id, extra_id, purpose, expense_date)
           VALUES (?,?,'Трата',?,?,?,?,?,?,?,?,?,?)""",
        (eid, oid, amount, cat, supplier, master_id, creditor_id, fin_tx, zen_tx, extra_id, purpose, date))


class TestExplicitLinks:
    def test_расход_с_creditor_id_уменьшает_остаток(self, db):
        from obligations import coverage
        _cred(db, "c-1", "Материал: Зеркало", 10_000)
        _exp(db, "e-1", 6_200, creditor_id="c-1", cat="material")
        cov = coverage(db)["c-1"]
        assert cov["covered"] == 6_200
        assert cov["level"] == "creditor_id"

    def test_покрытие_не_трогает_paid_в_базе(self, db):
        """Ключевая страховка: считаем на лету, данные не правим."""
        from obligations import coverage
        _cred(db, "c-1", "Материал: Зеркало", 10_000)
        _exp(db, "e-1", 6_200, creditor_id="c-1", cat="material")
        coverage(db)
        assert db.execute("SELECT paid FROM creditors WHERE id='c-1'").fetchone()[0] == 0

    def test_paid_и_расход_одной_разноски_не_задваиваются(self, db):
        """from-tx при гашении поднимает paid И создаёт расход с creditor_id —
        это одни деньги. Сумма дала бы 24 000 при реальных 12 000 (ORD-020)."""
        from obligations import coverage, effective_debt
        _cred(db, "c-1", "Работа: Покраска", 40_000, paid=12_000)
        _exp(db, "e-1", 7_000, creditor_id="c-1")
        _exp(db, "e-2", 5_000, creditor_id="c-1")
        cov = coverage(db)["c-1"]
        row = dict(db.execute("SELECT * FROM creditors WHERE id='c-1'").fetchone())
        assert cov["covered_exact"] == 12_000
        assert effective_debt(row, cov) == 28_000

    def test_совпадение_по_tx_id(self, db):
        from obligations import coverage
        _cred(db, "c-1", "Работа: Сварка", 30_000, fin_tx="TX-77")
        _exp(db, "e-1", 30_000, fin_tx="TX-77")
        assert coverage(db)["c-1"]["covered"] == 30_000

    def test_тот_же_tx_id_другого_заказа_не_покрывает(self, db):
        """Один перевод легально кормит два заказа (Годник 45 500) — покрытие
        обязано оставаться в границах своего заказа."""
        from obligations import coverage
        _cred(db, "c-1", "Работа: Сварка", 30_000, fin_tx="TX-77")
        _exp(db, "e-1", 30_000, oid="o-2", fin_tx="TX-77")
        assert coverage(db).get("c-1", {}).get("covered", 0) == 0


class TestByContractor:
    def test_расход_подрядчику_покрывает_его_обязательство(self, db):
        from obligations import coverage
        _line(db, "l-1", "Сварка", master_id="m-1")
        _cred(db, "c-1", "Работа: Сварка", 30_000, line_id="l-1")
        _exp(db, "e-1", 17_000, supplier="Эдуард Малафеев")
        cov = coverage(db)["c-1"]
        assert cov["covered_by_name"] == 17_000
        assert cov["level"] == "contractor"

    def test_имя_сопоставляется_нестрого(self, db):
        """`ООО ЯНДЕКС.ТАКСИ` и `ООО «Яндекс.Такси»` — один контрагент (_norm_name)."""
        from obligations import coverage
        db.execute("INSERT INTO masters (id, name) VALUES ('m-3','ООО «ЯНДЕКС.ТАКСИ»')")
        _cred(db, "c-1", "ООО ЯНДЕКС.ТАКСИ", 5_000)
        _exp(db, "e-1", 5_000, master_id="m-3", cat="delivery")
        assert coverage(db)["c-1"]["covered_by_name"] == 5_000

    def test_один_расход_делится_между_двумя_обязательствами(self, db):
        """Кошелёк: 20 000 закрывают первое (15 000) и второе на 5 000 — не оба целиком."""
        from obligations import coverage
        _line(db, "l-1", "Сварка 1", master_id="m-1")
        _line(db, "l-2", "Сварка 2", master_id="m-1")
        _cred(db, "c-1", "Работа: Сварка 1", 15_000, line_id="l-1")
        _cred(db, "c-2", "Работа: Сварка 2", 15_000, line_id="l-2")
        _exp(db, "e-1", 20_000, master_id="m-1")
        cov = coverage(db)
        assert sorted([cov["c-1"]["covered"], cov["c-2"]["covered"]]) == [5_000, 15_000]
        assert cov["c-1"]["covered"] + cov["c-2"]["covered"] == 20_000

    def test_покрытие_не_уходит_в_минус_и_не_течёт_на_чужого(self, db):
        from obligations import coverage
        _line(db, "l-1", "Сварка", master_id="m-1")
        _cred(db, "c-1", "Работа: Сварка", 30_000, line_id="l-1")
        _cred(db, "c-2", "Работа: Покраска", 20_000)   # другой подрядчик
        _exp(db, "e-1", 50_000, master_id="m-1")
        cov = coverage(db)
        assert cov["c-1"]["covered"] == 30_000          # не больше плана
        assert cov.get("c-2", {}).get("covered", 0) == 0

    def test_расход_потраченный_на_явную_связь_не_идёт_в_имя(self, db):
        """Кошелёк пуст: тот же расход не может закрыть второе обязательство."""
        from obligations import coverage
        _line(db, "l-1", "Сварка", master_id="m-1")
        _cred(db, "c-1", "Работа: Сварка", 30_000, line_id="l-1")
        _cred(db, "c-2", "Работа: Монтаж", 10_000)
        _exp(db, "e-1", 10_000, master_id="m-1", creditor_id="c-2")
        cov = coverage(db)
        assert cov["c-2"]["covered"] == 10_000
        assert cov["c-1"]["covered"] == 0


class TestExcluded:
    def test_расход_допработы_не_гасит_сметное_обязательство(self, db):
        from obligations import coverage
        db.execute("INSERT INTO order_extras (id, order_id, title, price, cost) VALUES ('x-1','o-1','Доп',0,0)")
        _line(db, "l-1", "Сварка", master_id="m-1")
        _cred(db, "c-1", "Работа: Сварка", 30_000, line_id="l-1")
        _exp(db, "e-1", 17_000, master_id="m-1", extra_id="x-1")
        assert coverage(db)["c-1"]["covered"] == 0

    def test_выплата_лицевого_счёта_и_накладные_не_участвуют(self, db):
        from obligations import coverage
        _line(db, "l-1", "Сварка", master_id="m-1")
        _cred(db, "c-1", "Работа: Сварка", 30_000, line_id="l-1")
        _exp(db, "e-1", 10_000, master_id="m-1", purpose="contractor_pay")
        _exp(db, "e-2", 5_000, master_id="m-1", purpose="overhead")
        assert coverage(db)["c-1"]["covered"] == 0

    def test_постоянные_обязательства_вне_покрытия(self, db):
        from obligations import coverage
        _cred(db, "c-1", "Аренда мастерской", 4_000, kind="fixed")
        assert "c-1" not in coverage(db)


class TestAmbiguous:
    def test_обязательство_без_подрядчика_даёт_подсказку_а_не_вычет(self, db):
        """«Доставка: Доставка» подрядчика не имеет. Рейсы такси по заказу —
        намёк («≈ вероятно закрыто»), но долг не уменьшают: разметка плана и
        факта по категориям в одном заказе расходится."""
        from obligations import coverage
        _line(db, "l-1", "Доставка", ltype="delivery")
        _cred(db, "c-1", "Доставка: Доставка", 14_400, line_id="l-1")
        _exp(db, "e-1", 5_013, supplier="ООО ЯНДЕКС.ТАКСИ", cat="delivery")
        cov = coverage(db)["c-1"]
        assert cov["covered"] == 0
        assert cov["ambiguous"] is True
        assert cov["bucket_hint"] == 5_013


class TestDeterminism:
    def test_повторный_расчёт_даёт_тот_же_ответ(self, db):
        from obligations import coverage
        _line(db, "l-1", "Сварка 1", master_id="m-1")
        _line(db, "l-2", "Сварка 2", master_id="m-1")
        _cred(db, "c-1", "Работа: Сварка 1", 15_000, line_id="l-1")
        _cred(db, "c-2", "Работа: Сварка 2", 15_000, line_id="l-2")
        _exp(db, "e-1", 8_000, master_id="m-1")
        _exp(db, "e-2", 9_000, master_id="m-1")
        first = coverage(db)
        second = coverage(db)
        assert {k: v["covered"] for k, v in first.items()} == {k: v["covered"] for k, v in second.items()}

    def test_фильтр_по_заказам_даёт_тот_же_результат(self, db):
        from obligations import coverage
        _cred(db, "c-1", "Материал: Зеркало", 10_000)
        _exp(db, "e-1", 6_200, creditor_id="c-1", cat="material")
        assert coverage(db, order_ids=["o-1"])["c-1"]["covered"] == coverage(db)["c-1"]["covered"]
