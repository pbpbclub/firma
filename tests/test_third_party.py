"""«Чужие деньги»: транзит третьим лицам через личные карты (ТЗ Юры 23.09.2026).

Помеченная нога — не доход и не трата Юры: уходит из трат раздела «Грузия»
целиком или частью, а по человеку считается «получено / выдано / остаток».
"""
import importlib

import pytest

from test_abroad_spending import mod, scope, items  # noqa: F401  (фикстура и помощники)


def _mark(migrated, tx_id, person, direction, amount=None, amount_rub=None):
    migrated.execute("INSERT OR REPLACE INTO zm_third_party (tx_id, person, direction, amount, amount_rub)"
                     " VALUES (?,?,?,?,?)", (tx_id, person, direction, amount, amount_rub))
    migrated.commit()


@pytest.fixture
def tp(mod):
    import third_party
    return importlib.reload(third_party)


def test_fully_marked_leg_leaves_spending(mod, tp, migrated):
    before = mod.spending(items(mod), currency="unknown")["spent"]
    _mark(migrated, "t6", "Жанна", "given")                 # снятие 90 — целиком Жанне
    it = {i["id"]: i for i in items(mod)}
    assert it["t6"]["kind"] == "third_party"
    assert it["t6"]["third_party"]["person"] == "Жанна"
    assert mod.spending(items(mod), currency="unknown")["spent"] == pytest.approx(before - 90)


def test_partial_mark_subtracts_only_part(mod, tp, migrated):
    _mark(migrated, "t6", "Жанна", "given", amount=60)
    t6 = next(i for i in items(mod) if i["id"] == "t6")
    assert t6["kind"] == "expense" and t6["amount"] == pytest.approx(30)


def test_person_balance_by_currency_and_rub(mod, tp, migrated):
    _mark(migrated, "t11", "Жанна", "given", amount_rub=None)  # рублёвая нога, 5000
    _mark(migrated, "t9", "Жанна", "received")                  # приход 2594 на BOG
    p = tp.people(scope(mod))[0]
    assert p["person"] == "Жанна" and p["count"] == 2
    assert p["rub_complete"] is False and p["balance_rub"] is None   # у валютной ноги нет рублей
    _mark(migrated, "t9", "Жанна", "received", amount_rub=7000)
    p = tp.people(scope(mod))[0]
    assert p["balance_rub"] == pytest.approx(2000)               # получено 7000, выдано 5000


def test_own_legs_for_zenmoney_report(tp):
    marks = {"x": {"direction": "received", "amount": None}, "y": {"direction": "given", "amount": 300}}
    assert tp.own_legs({"id": "x", "income": 72000, "outcome": 0}, marks) == (0.0, 0.0)
    assert tp.own_legs({"id": "y", "income": 0, "outcome": 500}, marks) == (0.0, 200.0)
    assert tp.own_legs({"id": "z", "income": 5, "outcome": 0}, marks) == (5.0, 0.0)
