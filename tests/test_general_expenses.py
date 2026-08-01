"""Траты без заказа: запас, образцы, общехозяйственное (ТЗ stock_and_samples 01.08.2026).

Главное, что здесь охраняется: такие траты НЕ попадают в себестоимость клиентских
заказов, а списание запаса в заказ не двоит деньги — сумма «остаток запаса + списанное»
всегда равна исходной трате.

Схема в conftest клонируется с боевой базы, где миграции ещё нет, поэтому каждый тест
сам прогоняет ensure_general_expenses_schema() на своей in-memory копии — заодно это
и тест самой миграции (NOT NULL с order_id обязан сняться).
"""
import sqlite3

import pytest

import db as db_mod
import routers.general_expenses as gen_mod
import routers.orders as orders_mod
from fastapi import HTTPException
from routers.orders import _plan_fact


class _NoClose:
    def __init__(self, conn): self._c = conn
    def __getattr__(self, name): return getattr(self._c, name)
    def close(self): pass


@pytest.fixture
def gconn(conn, monkeypatch):
    """База с применённой миграцией; get_production подменён на неё."""
    wrapped = _NoClose(conn)
    monkeypatch.setattr(db_mod, "get_production", lambda: wrapped)
    monkeypatch.setattr(gen_mod, "get_production", lambda: wrapped)
    monkeypatch.setattr(orders_mod, "get_production", lambda: wrapped)
    db_mod.ensure_general_expenses_schema()
    return conn


def _order(conn, oid="o1", number="ORD-020", title="Спираль"):
    conn.execute("INSERT INTO orders (id, number, title, status) VALUES (?, ?, ?, 'in_production')",
                 (oid, number, title))


def test_migration_allows_null_order(gconn):
    """order_id стал NULLABLE, purpose и stock_parent_id на месте."""
    info = {r[1]: r for r in gconn.execute("PRAGMA table_info(expenses)").fetchall()}
    assert info["order_id"][3] == 0, "order_id обязан стать nullable"
    assert "purpose" in info and "stock_parent_id" in info
    gconn.execute("INSERT INTO expenses (id, order_id, title, amount, purpose) "
                  "VALUES ('e1', NULL, 'логотипы pbpb', 2300, 'stock')")
    assert gconn.execute("SELECT amount FROM expenses WHERE id='e1'").fetchone()[0] == 2300


def test_migration_idempotent_and_keeps_data(gconn):
    """Повторный прогон не пересобирает таблицу и не теряет строки."""
    _order(gconn)
    gconn.execute("INSERT INTO expenses (id, order_id, title, amount, category) "
                  "VALUES ('e1', 'o1', 'ламели', 9500, 'work')")
    db_mod.ensure_general_expenses_schema()
    db_mod.ensure_general_expenses_schema()
    rows = gconn.execute("SELECT id, order_id, amount FROM expenses").fetchall()
    assert [tuple(r) for r in rows] == [("e1", "o1", 9500)]


def test_general_expense_not_in_order_cost(gconn):
    """Запас и образцы не попадают в факт ни одного заказа."""
    _order(gconn)
    gconn.execute("INSERT INTO expenses (id, order_id, title, amount, category) "
                  "VALUES ('e1', 'o1', 'ламели', 9500, 'work')")
    gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="логотипы pbpb про запас", amount=2300, purpose="stock", category="work"))
    gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="образец на выставку", amount=15000, purpose="sample", category="material"))
    pf = _plan_fact(gconn, "o1", 0, 0, 0)
    assert pf["cost_fact"] == 9500


def test_write_off_moves_cost_without_doubling(gconn):
    """Списание запаса в заказ: заказ получает ровно списанную сумму, запас худеет."""
    _order(gconn)
    stock = gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="логотипы pbpb", amount=2300, purpose="stock", category="work",
        expense_date="2026-07-03", finance_tx_id="tx-1"))
    res = gen_mod.write_off(stock["id"], gen_mod.WriteOffIn(
        order_id="ORD-020", amount=800, expense_date="2026-08-01"))
    assert res["written_off"] == 800 and res["stock_left"] == 1500
    pf = _plan_fact(gconn, "o1", 0, 0, 0)
    assert pf["cost_fact"] == 800, "в заказ легла только списанная часть"
    # Сумма частей равна исходной трате — деньги не задвоились и не исчезли.
    total = gconn.execute("SELECT SUM(amount) FROM expenses WHERE id = ? OR stock_parent_id = ?",
                          (stock["id"], stock["id"])).fetchone()[0]
    assert round(total, 2) == 2300
    # Дата — использования, а не покупки; ссылка на транзакцию сохранена на обеих частях.
    child = gconn.execute("SELECT expense_date, finance_tx_id FROM expenses WHERE stock_parent_id = ?",
                          (stock["id"],)).fetchone()
    assert child["expense_date"] == "2026-08-01" and child["finance_tx_id"] == "tx-1"


def test_write_off_more_than_left_rejected(gconn):
    _order(gconn)
    stock = gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="фанера впрок", amount=1000, purpose="stock", category="material"))
    gen_mod.write_off(stock["id"], gen_mod.WriteOffIn(order_id="o1", amount=600))
    with pytest.raises(HTTPException) as e:
        gen_mod.write_off(stock["id"], gen_mod.WriteOffIn(order_id="o1", amount=600))
    assert e.value.status_code == 400


def test_write_off_only_for_stock(gconn):
    _order(gconn)
    s = gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="образец", amount=500, purpose="sample", category="material"))
    with pytest.raises(HTTPException):
        gen_mod.write_off(s["id"], gen_mod.WriteOffIn(order_id="o1"))


def test_undo_write_off_returns_amount(gconn):
    _order(gconn)
    stock = gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="фанера впрок", amount=1000, purpose="stock", category="material"))
    r = gen_mod.write_off(stock["id"], gen_mod.WriteOffIn(order_id="o1", amount=400))
    gen_mod.undo_write_off(r["expense"]["id"])
    assert gconn.execute("SELECT amount FROM expenses WHERE id = ?", (stock["id"],)).fetchone()[0] == 1000
    assert _plan_fact(gconn, "o1", 0, 0, 0)["cost_fact"] == 0


def test_split_part_leaves_order(gconn):
    """Живой случай: 11 800 ₽ = 9 500 ₽ заказу + 2 300 ₽ в запас одной операцией."""
    _order(gconn)
    gconn.execute(
        "INSERT INTO expenses (id, order_id, title, amount, category, finance_tx_id) "
        "VALUES ('e1', 'o1', 'Ант Сервис (Денис Мельничук)', 11800, 'work', 'tx-9')")
    orders_mod.split_expense("ORD-020", "e1", orders_mod.SplitIn(parts=[
        orders_mod.SplitPart(amount=9500, category="work", title="порезка ламелей"),
        orders_mod.SplitPart(amount=2300, category="work", title="логотипы pbpb про запас",
                             purpose="stock"),
    ]))
    assert _plan_fact(gconn, "o1", 0, 0, 0)["cost_fact"] == 9500
    g = gconn.execute("SELECT amount, purpose, finance_tx_id FROM expenses WHERE order_id IS NULL").fetchone()
    assert (g["amount"], g["purpose"], g["finance_tx_id"]) == (2300, "stock", "tx-9")


def test_split_general_part_drops_creditor_link(gconn):
    """Часть, ушедшая в запас, не должна числиться гасящей обязательство заказа:
    иначе дедуп «одна оплата = один факт» вычтет обязательство из факта заказа,
    а расхода там уже нет — факт недосчитается."""
    _order(gconn)
    gconn.execute("INSERT INTO creditors (id, name, total, paid, status, order_id, finance_tx_id) "
                  "VALUES ('c1', 'Ант Сервис', 11800, 11800, 'closed', 'o1', 'tx-9')")
    gconn.execute(
        "INSERT INTO expenses (id, order_id, title, amount, category, finance_tx_id, creditor_id) "
        "VALUES ('e1', 'o1', 'Ант Сервис', 11800, 'work', 'tx-9', 'c1')")
    orders_mod.split_expense("o1", "e1", orders_mod.SplitIn(parts=[
        orders_mod.SplitPart(amount=9500, category="work"),
        orders_mod.SplitPart(amount=2300, category="work", purpose="stock"),
    ]))
    g = gconn.execute("SELECT creditor_id FROM expenses WHERE order_id IS NULL").fetchone()
    assert g["creditor_id"] is None
    # Факт заказа: расход 9 500 покрывает обязательство (creditor_id) → 11 800 не добавляется.
    assert _plan_fact(gconn, "o1", 0, 0, 0)["cost_fact"] == 9500


def test_summary_splits_stock_and_samples(gconn):
    _order(gconn)
    s = gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="фанера впрок", amount=1000, purpose="stock", category="material"))
    gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="образец", amount=15000, purpose="sample", category="material"))
    gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="интернет", amount=900, purpose="overhead", category="other"))
    gen_mod.write_off(s["id"], gen_mod.WriteOffIn(order_id="o1", amount=400))
    out = gen_mod.summary()
    assert out["stock_open"] == 600         # не списанный остаток
    assert out["stock_written_off"] == 400  # ушло в заказ, там и есть себестоимость
    assert out["sample"] == 15000 and out["overhead"] == 900


def test_delete_blocked_when_written_off(gconn):
    _order(gconn)
    s = gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="фанера впрок", amount=1000, purpose="stock", category="material"))
    gen_mod.write_off(s["id"], gen_mod.WriteOffIn(order_id="o1", amount=400))
    with pytest.raises(HTTPException) as e:
        gen_mod.delete_general(s["id"])
    assert e.value.status_code == 409


def test_list_shows_written_off(gconn):
    _order(gconn)
    s = gen_mod.create_general(gen_mod.GeneralExpenseIn(
        title="фанера впрок", amount=1000, purpose="stock", category="material"))
    gen_mod.write_off(s["id"], gen_mod.WriteOffIn(order_id="o1", amount=400))
    item = gen_mod.list_general(purpose="stock")["items"][0]
    assert item["amount"] == 600 and item["written_off"] == 400
    assert item["written_off_orders"] == "Спираль"
