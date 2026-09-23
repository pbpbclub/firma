"""Выводы за границу по маршрутам (23.09.2026).

Граничные случаи взяты из живых данных: Avosend одной ногой, внутренний шаг
Т-Банк → Райффайзен, возврат «Прочие поступления AVOSEND», Золотая корона,
перевод в Узбекистан, кросс-строка «рубли ушли — лари пришли».
"""
import pytest


@pytest.fixture
def scope():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
    from zm_scope import Account, Scope
    acc = lambda i, t, cur, reg: Account(i, t, "ccard", 0.0, cur, reg, "public" if reg is None else "private",
                                         None, False)
    return Scope(owner=True, accounts=[acc("1", "Black", "RUB", None), acc("2", "Mir Cashback Card", "RUB", None),
                                        acc("3", "MasterCard Mass", "RUB", None), acc("4", "GEL Solo", "GEL", "ge"),
                                        # Счёт вне реестра: валюта неизвестна, страны нет
                                        acc("5", "New Card", "unknown", None),
                                        acc("6", "TRY Wallet", "TRY", "tr")])


def row(out_acc, in_acc, outcome, income=0.0, payee=None, comment=None):
    return {"id": "x", "date": "2026-09-10", "outcome_account": out_acc, "income_account": in_acc,
            "outcome": outcome, "income": income, "payee": payee, "comment": comment}


def test_avosend_expense_is_outflow(scope):
    import abroad_routes as ar
    assert ar.route_of(row("Mir Cashback Card", "Mir Cashback Card", 16000, comment="AVOSEND"), scope) == "avosend"
    assert ar.route_of(row("Black", "Black", 5000.09, payee="Avosend"), scope) == "avosend"


def test_internal_hop_is_not_outflow(scope):
    """Т-Банк → Райффайзен — перевод между своими рублёвыми, иначе вывод посчитался бы дважды."""
    import abroad_routes as ar
    assert ar.route_of(row("Black", "Mir Cashback Card", 16000, 16000, comment="Юрий Владимирович Н"), scope) is None


def test_service_refund_is_not_outflow(scope):
    import abroad_routes as ar
    assert ar.route_of(row("MasterCard Mass", "Mir Cashback Card", 6000, 6000,
                           comment="Прочие поступления AVOSEND"), scope) is None


def test_golden_crown_uzbekistan_and_cross_row(scope):
    import abroad_routes as ar
    assert ar.route_of(row("Mir Cashback Card", "Mir Cashback Card", 4968, comment="Золотая корона"), scope) == "golden_crown"
    assert ar.route_of(row("Black", "Black", 8110, payee="MS 9",
                           comment="Курс конвертации: 1 RUB - 147.4 UZS"), scope) == "uz_ms9"
    assert ar.route_of(row("Black", "GEL Solo", 1500, 45.5), scope) == "direct"
    assert ar.route_of(row("Black", "GEL Solo", 7974, 250, payee="shps niu pheiment sistem"), scope) == "bog_direct"


def test_ordinary_spend_and_foreign_spend_are_not_outflows(scope):
    import abroad_routes as ar
    assert ar.route_of(row("Black", "Black", 900, payee="Пятёрочка"), scope) is None
    assert ar.route_of(row("GEL Solo", "GEL Solo", 12, payee="SPAR"), scope) is None, "трата в Грузии — не вывод"


def test_unconfigured_account_leg_is_not_rub_outflow(scope):
    """Счёт без назначенной валюты — fail-closed: сумма вывода показывается
    рублями, и нерублёвая нога в рублёвый итог попасть не может."""
    import abroad_routes as ar
    assert ar.route_of(row("New Card", "New Card", 16000, payee="Avosend"), scope) is None
    assert ar.route_of(row("GEL Solo", "GEL Solo", 300, payee="Avosend"), scope) is None


def test_outflows_skip_dateless_rows(scope):
    import abroad_routes as ar
    r = row("Black", "Black", 5000, payee="Avosend")
    r["date"] = None
    assert ar.outflows([r], scope) == []


def test_outflows_region_keeps_only_its_country(scope):
    """Кросс-строка в другую страну в раздел этой страны не идёт; строка-расход
    страны назначения не несёт и остаётся (маршрут — сервис, а не страна)."""
    import abroad_routes as ar
    ge = row("Black", "GEL Solo", 1500, 45.5)
    tr = row("Black", "TRY Wallet", 2000, 700)
    svc = row("Black", "Black", 5000, payee="Avosend")
    got = ar.outflows([ge, tr, svc], scope, region="ge")
    assert [o["to_region"] for o in got] == ["ge", None]
    assert [o["to_region"] for o in ar.outflows([ge, tr, svc], scope, region="tr")] == ["tr", None]
    assert len(ar.outflows([ge, tr, svc], scope)) == 3
