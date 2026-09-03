"""Выплаты лицевого счёта в покрытии обязательств (ТЗ фин-агента 03.09.2026, п.1).

Деньги мастеру часто уходят с личной карты Юры и попадают в лицевой счёт ручной
проводкой `payment`, а не расходом по заказу. Покрытие видело только expenses —
обязательство оставалось «непокрытым», а долг перед человеком показывался дважды.

🔒 covered_ledger — ОТДЕЛЬНОЕ поле. В начисления закрытых строк лицевого счёта
(ledger._build_entries) оно не входит: проводка уже стоит в ленте минусом, и
поднять ею же начисление значило бы начислить дважды (ORD-017 Спектр-Колор).
"""
import pytest


@pytest.fixture
def db(conn):
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES ('o-1','ORD-901','Заказ','in_production')")
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES ('o-2','ORD-902','Другой','in_production')")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-1','Эдуард Малафеев')")
    conn.execute("INSERT INTO masters (id, name) VALUES ('m-2','Спектр-Колор')")
    conn.execute("INSERT INTO estimate_sets (id, order_id, status) VALUES ('s-1','o-1','approved')")
    conn.execute("INSERT INTO estimate_items (id, set_id, title) VALUES ('i-1','s-1','Изделие')")
    return conn


def _cred(conn, cid, name, total, *, oid="o-1", paid=0, line_id=None, status="open", fin_tx=None):
    conn.execute(
        """INSERT INTO creditors (id, name, total, paid, order_id, status, estimate_line_id,
                                  estimate_item_id, finance_tx_id, created_at)
           VALUES (?,?,?,?,?,?,?,'i-1',?,datetime('now'))""",
        (cid, name, total, paid, oid, status, line_id, fin_tx))


def _line(conn, lid, title, *, master_id=None):
    conn.execute("INSERT INTO estimate_lines (id, item_id, type, title, master_id) VALUES (?,'i-1','labor',?,?)",
                 (lid, title, master_id))


def _exp(conn, eid, amount, *, creditor_id=None, fin_tx=None, master_id=None):
    conn.execute(
        """INSERT INTO expenses (id, order_id, title, amount, category, master_id, creditor_id, finance_tx_id, expense_date)
           VALUES (?,'o-1','Трата',?,'work',?,?,?,'2026-08-01')""", (eid, amount, master_id, creditor_id, fin_tx))


def _led(conn, lid, master_id, amount, *, kind="payment", oid=None, creditor_id=None,
         expense_id=None, fin_tx=None):
    conn.execute(
        """INSERT INTO master_ledger (id, master_id, kind, amount, happened_at, order_id, creditor_id,
                                      expense_id, finance_tx_id, note)
           VALUES (?,?,?,?,'2026-08-05',?,?,?,?,'проводка')""",
        (lid, master_id, kind, amount, oid, creditor_id, expense_id, fin_tx))


class TestLedgerInCoverage:
    def test_проводка_с_creditor_id_покрывает_и_режет_остаток(self, db):
        from obligations import coverage, effective_debt, recognized
        _cred(db, "c-1", "Эдуард Малафеев", 30_000)
        _led(db, "l-1", "m-1", 12_000, creditor_id="c-1")
        cov = coverage(db)["c-1"]
        assert cov["covered_ledger"] == 12_000
        assert cov["covered_exact"] == 0 and cov["covered_by_name"] == 0
        assert cov["sources"][0]["source"] == "ledger" and cov["sources"][0]["level"] == "creditor_id"
        row = db.execute("SELECT * FROM creditors WHERE id='c-1'").fetchone()
        assert effective_debt(row, cov) == 18_000
        # лицевой счёт начисляет БЕЗ учёта своих же выплат
        assert recognized(row, cov, with_ledger=False) == 0
        assert recognized(row, cov, with_ledger=True) == 12_000

    def test_проводка_по_tx_id_обязательства_это_L2(self, db):
        from obligations import coverage
        _cred(db, "c-1", "Эдуард Малафеев", 30_000, fin_tx="tx-7")
        _led(db, "l-1", "m-1", 30_000, fin_tx="tx-7")
        cov = coverage(db)["c-1"]
        assert cov["covered_ledger"] == 30_000 and cov["sources"][0]["level"] == "tx_id"

    def test_проводка_уже_видная_расходом_не_считается_второй_раз(self, db):
        from obligations import coverage
        _cred(db, "c-1", "Эдуард Малафеев", 30_000)
        _exp(db, "e-1", 10_000, creditor_id="c-1", fin_tx="tx-9")
        _led(db, "l-1", "m-1", 10_000, creditor_id="c-1", expense_id="e-1")
        _led(db, "l-2", "m-1", 10_000, creditor_id="c-1", fin_tx="tx-9")
        cov = coverage(db)["c-1"]
        assert cov["covered_exact"] == 10_000 and cov["covered_ledger"] == 0

    def test_L3_по_мастеру_в_границах_заказа_только_для_открытых(self, db):
        from obligations import coverage
        _line(db, "ln-1", "Сварка", master_id="m-1")
        _cred(db, "c-1", "Работа: Сварка", 20_000, line_id="ln-1")
        _cred(db, "c-2", "Работа: Сварка", 20_000, oid="o-2", status="closed")
        _led(db, "l-1", "m-1", 8_000, oid="o-1")          # тому же мастеру, тот же заказ
        _led(db, "l-2", "m-2", 8_000, oid="o-1")          # другой мастер — мимо
        _led(db, "l-3", "m-1", 8_000, oid="o-2")          # закрытое обязательство — ничего
        cov = coverage(db)
        assert cov["c-1"]["covered_ledger"] == 8_000 and cov["c-1"]["sources"][0]["level"] == "contractor"
        assert cov["c-2"]["covered_ledger"] == 0

    def test_накопление_не_превышает_план(self, db):
        from obligations import coverage
        _cred(db, "c-1", "Эдуард Малафеев", 10_000)
        _led(db, "l-1", "m-1", 6_000, creditor_id="c-1")
        _led(db, "l-2", "m-1", 6_000, creditor_id="c-1")
        cov = coverage(db)["c-1"]
        assert cov["covered_ledger"] == 10_000 and cov["covered"] == 10_000

    def test_начисление_не_покрытие(self, db):
        from obligations import coverage
        _cred(db, "c-1", "Эдуард Малафеев", 10_000)
        _led(db, "l-1", "m-1", 10_000, kind="accrual", creditor_id="c-1")
        assert coverage(db)["c-1"]["covered_ledger"] == 0


class TestReasons:
    def test_новые_причины_закрытия(self):
        from obligations import CLOSE_REASONS
        assert {"recognized", "internal", "superseded_estimate"} <= set(CLOSE_REASONS)

    def test_recognized_принимает_row_и_dict(self, db):
        from obligations import recognized
        cov = {"covered_exact": 5_000, "covered_by_name": 1_000, "covered_ledger": 2_000}
        assert recognized({"paid": 3_000}, cov) == 8_000
        assert recognized({"paid": 6_000}, cov, with_ledger=False) == 7_000
        assert recognized({"paid": 0}, None) == 0
