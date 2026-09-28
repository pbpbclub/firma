"""Склейки ZenMoney и взаимозачёт банка на заграничной карте (28.09.2026).

Строки повторяют живые случаи сентября: покупка в Турции 20,02 ₾ + кэшбэк 638 ₽ на
Black одной строкой, банк гасит минус на лари из долларов по ≈2,55, приход Avosend
$219,31, склеенный с тратой 589,05 ₾.
"""
import sqlite3

import pytest

ACC = [
    ("black", "Black", "ccard", 12959.62),
    ("gel", "GEL Solo", "ccard", -1152.74),
    ("usd", "Dollar Solo", "ccard", 515.78),
]

TX = [
    # id, date, income, outcome, income_account, outcome_account, payee, comment
    ("m1", "2026-09-26", 638.0, 20.02, "Black", "GEL Solo", None, "Зачисление кэшбэка"),
    ("m2", "2026-08-20", 10000.0, 118.0, "Black", "Dollar Solo", "ANTHROPIC* CLAUDE SUB", None),
    ("x1", "2026-09-25", 263.86, 103.43, "GEL Solo", "Dollar Solo", None, None),
    ("x2", "2026-09-27", 927.65, 363.64, "GEL Solo", "Dollar Solo", None, None),
    ("x3", "2026-09-24", 148.09, 57.96, "GEL Solo", "Dollar Solo", None, None),
    # комиссия пакета: обмен по курсу обслуживания — в курс банка не идёт
    ("fee", "2026-09-26", 37.12, 10.0, "GEL Solo", "Dollar Solo", None, "Solo Premium Package Maintenance Fee"),
    ("glued", "2026-09-27", 219.31, 589.05, "Dollar Solo", "GEL Solo", None, None),
    ("top", "2026-09-10", 45.5, 1500.0, "GEL Solo", "Black", None, None),
    ("buy", "2026-09-26", 0.0, 46.21, "GEL Solo", "GEL Solo", "H&M HENNES MAURITZ", None),
]


@pytest.fixture
def mod(migrated, tmp_path, monkeypatch):
    import db
    zen = tmp_path / "zenmoney.db"
    z = sqlite3.connect(zen)
    z.execute("CREATE TABLE zm_accounts (id TEXT PRIMARY KEY, title TEXT, type TEXT, balance REAL, archive INTEGER DEFAULT 0)")
    z.execute("CREATE TABLE zm_transactions (id TEXT PRIMARY KEY, date TEXT, income REAL, outcome REAL,"
              " income_account TEXT, outcome_account TEXT, payee TEXT, comment TEXT, tags TEXT,"
              " deleted INTEGER DEFAULT 0, changed INTEGER)")
    z.executemany("INSERT INTO zm_accounts (id,title,type,balance) VALUES (?,?,?,?)", ACC)
    z.executemany("INSERT INTO zm_transactions (id,date,income,outcome,income_account,outcome_account,payee,comment)"
                  " VALUES (?,?,?,?,?,?,?,?)", TX)
    z.commit(); z.close()
    monkeypatch.setattr(db, "ZENMONEY_DB", zen)
    for aid, title, cur, vis, region in [("black", "Black", "RUB", "public", None),
                                         ("gel", "GEL Solo", "GEL", "private", "ge"),
                                         ("usd", "Dollar Solo", "USD", "private", "ge")]:
        migrated.execute("INSERT OR REPLACE INTO zm_account_meta (account_id,title,currency,visibility,region)"
                         " VALUES (?,?,?,?,?)", (aid, title, cur, vis, region))
    migrated.commit()
    import importlib
    import abroad
    import abroad_routes
    import zm_merge
    import zm_scope
    for m in (zm_scope, zm_merge, abroad_routes, abroad):
        importlib.reload(m)
    return abroad


def _scope():
    import zm_scope
    return zm_scope.Scope(owner=True)


def _items(mod, unmerged=None):
    s = _scope()
    return mod.decorate(mod.fetch_rows(s, "ge"), s, mod.load_rules(), mod.region_titles(s, "ge"),
                        unmerged=unmerged)


def _row(id_):
    t = next(t for t in TX if t[0] == id_)
    return dict(zip(("id", "date", "income", "outcome", "income_account", "outcome_account", "payee", "comment"), t))


def test_auto_split_only_from_country_to_home(mod):
    """Грузия → РФ — всегда склейка (решение Юры 28.09.2026). РФ → Грузия —
    пополнение, обмен внутри карты — обмен: их автоматически не трогаем."""
    import zm_merge
    s = _scope()
    assert zm_merge.is_auto_split(_row("m1"), s)
    assert zm_merge.is_auto_split(_row("m2"), s)
    assert not zm_merge.is_auto_split(_row("top"), s)
    assert not zm_merge.is_auto_split(_row("x1"), s)
    assert not zm_merge.is_auto_split(_row("buy"), s), "одна нога — не склейка"


def test_unknown_account_is_not_split(mod):
    """Fail-closed: счёт вне реестра правилу не подпадает."""
    import zm_merge
    r = {**_row("m1"), "income_account": "Какая-то новая карта"}
    assert not zm_merge.is_auto_split(r, _scope())


def test_legs_read_as_ordinary_rows(mod):
    import zm_merge
    out_leg, in_leg = zm_merge.legs(_row("m1"))
    assert (out_leg["outcome"], out_leg["income"]) == (20.02, 0.0)
    assert out_leg["income_account"] == out_leg["outcome_account"] == "GEL Solo"
    assert (in_leg["income"], in_leg["outcome"]) == (638.0, 0.0)
    assert in_leg["income_account"] == in_leg["outcome_account"] == "Black"


def test_glued_purchase_becomes_expense(mod):
    """Покупка в Турции, склеенная с кэшбэком, — трата в лари, а не «перевод»."""
    by = {(i["id"], i["leg"]): i for i in _items(mod, unmerged={})}
    m1 = by[("m1", "outcome")]
    assert m1["kind"] == "expense" and m1["amount"] == 20.02 and m1["currency"] == "GEL"
    assert m1["split"] == "auto"
    assert m1["merged_with"] == {"account": "Black", "side": "income", "amount": 638.0, "currency": "RUB"}
    assert ("m1", "income") not in by, "рублёвая нога живёт в «Личных», не в разделе страны"
    gel = mod.spending(_items(mod, unmerged={}), currency="GEL")
    assert round(gel["spent"], 2) == round(20.02 + 46.21, 2)


def test_bank_exchange_shows_both_legs_and_rate(mod):
    by = {i["id"]: i for i in _items(mod, unmerged={})}
    x = by["x2"]
    assert x["kind"] == "exchange"
    assert (x["amount"], x["currency"], x["to_amount"], x["to_currency"]) == (363.64, "USD", 927.65, "GEL")
    assert x["rate"] == {"value": 2.551, "price_of": "USD", "in": "GEL"}
    # ₾ → $: курс всё равно «лари за доллар»
    assert by["glued"]["rate"]["price_of"] == "USD" and by["glued"]["rate"]["in"] == "GEL"
    res = mod.spending(_items(mod, unmerged={}), currency="USD")
    assert res["spent"] == 118.0, "обмен — не трата; в долларах только расклеенный Anthropic"


def test_manual_unmerge_inside_card(mod):
    """27.09: приход Avosend $219,31 склеен с тратой 589,05 ₾. По форме — обмен;
    расклеивает Юра, и получаются трата ₾ и пополнение $."""
    its = _items(mod, unmerged={"glued": {"tx_id": "glued"}})
    legs = {i["leg"]: i for i in its if i["id"] == "glued"}
    assert legs["outcome"]["kind"] == "expense" and legs["outcome"]["amount"] == 589.05
    assert legs["outcome"]["currency"] == "GEL" and legs["outcome"]["split"] == "manual"
    assert legs["income"]["kind"] == "income" and legs["income"]["currency"] == "USD"
    s = _scope()
    titles = set(mod.region_titles(s, "ge"))
    assert mod.topup_source(_row("glued"), s, titles, {}) is None, "без пометки — обмен, не пополнение"
    assert mod.topup_source(_row("glued"), s, titles, {"glued": {}}) == "anonymous"


def test_manual_unmerge_of_topup_is_not_direct_route(mod):
    """Расклеенная «рубли → Грузия» без приметы маршрута — не вывод себе."""
    import abroad_routes
    s = _scope()
    assert abroad_routes.route_of(_row("top"), s) == "direct"
    assert abroad_routes.route_of(_row("top"), s, {"top": {}}) is None


def test_bank_rate_is_median_of_recent_exchanges(mod):
    br = mod.bank_rate(_scope(), "ge")
    assert br["source"] == "bank" and br["samples"] == 3, "комиссия пакета в курс не идёт"
    assert br["rate"] == round(sorted([263.86 / 103.43, 927.65 / 363.64, 148.09 / 57.96])[1], 4)


def test_usd_position_subtracts_gel_debt(mod):
    pos = mod.usd_position({"USD": 515.78, "GEL": -1152.74}, 50.0, 2.55)
    assert pos["gel_debt"] == 1152.74
    assert pos["usd_for_debt"] == round(1152.74 / 2.55, 2)
    assert pos["usd_effective"] == round(515.78 - 1152.74 / 2.55, 2)
    assert pos["usd_free"] == round(515.78 - 1152.74 / 2.55 - 50, 2)
    plus = mod.usd_position({"USD": 100.0, "GEL": 300.0}, 0.0, 2.55)
    assert plus["usd_effective"] == 100.0, "плюс на лари доллары не увеличивает"
    assert mod.usd_position({"USD": 100.0, "GEL": -10.0}, 0.0, None)["debt_unpriced"] is True


def test_personal_report_counts_glued_home_leg_as_income(mod):
    """«Личные»: кэшбэк и поступление на Black, склеенные с тратами в Грузии, —
    приходы, а не «переводы из-за границы»."""
    from routers import zenmoney
    import importlib
    importlib.reload(zenmoney)
    u = {"email": "yuranek@pbpb.club", "role": "admin"}
    assert zenmoney.get_report(month="2026-09", currency="RUB", user=u)["incomes"] == 638.0
    assert zenmoney.get_report(month="2026-08", currency="RUB", user=u)["incomes"] == 10000.0
    flow = {m["month"]: m for m in zenmoney.get_cashflow(months=6, currency="RUB", user=u)}
    assert flow["2026-09"]["incomes"] == 638.0
    assert flow["2026-09"]["expenses"] == 0, "пополнение с Black — вывод себе, не расход и не склейка"


def test_accountant_sees_glued_leg_as_plain_income(mod):
    s = __import__("zm_scope").Scope(owner=False)
    d = s.mask(_row("m1"), split=True)
    assert d["payee"] == "Поступление" and d["abroad"] is False
    assert d["outcome"] == 0 and d["income"] == 638.0
    assert d["comment"] is None, "чья это нога — неизвестно, назначение скрыто"


def test_unmerge_endpoint_marks_and_unmarks(mod):
    """Ручка расклейки: только двуногая строка раздела; авто-склейку не помечаем;
    снятая пометка возвращает обмен."""
    from fastapi import HTTPException
    from routers import regions
    import importlib
    importlib.reload(regions)
    u = {"email": "yuranek@pbpb.club", "role": "admin"}
    assert regions.unmerge("ge", regions.UnmergeBody(tx_id="glued"), user=u)["unmerged"] is True
    legs = {i["leg"] for i in _items(mod) if i["id"] == "glued"}
    assert legs == {"outcome", "income"}, "пометка из базы подхватывается лентой"
    for bad in ("buy", "m1", "nope"):
        with pytest.raises(HTTPException):
            regions.unmerge("ge", regions.UnmergeBody(tx_id=bad), user=u)
    regions.remerge("ge", "glued", user=u)
    assert [i["kind"] for i in _items(mod) if i["id"] == "glued"] == ["exchange"]
