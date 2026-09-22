"""Траты по заграничной карте: отбор, категории, аналитика (22.09.2026).

Данные повторяют боевую картину: три счёта BOG под ОДНИМ названием, латинские
получатели, снятие наличных с пометкой в назначении, доллары вперемешку с лари.
"""
import sqlite3

import pytest

ACC = [
    ("c8efea56", "Black", "ccard", 6942.62),
    ("17525302", "Universal Account", "ccard", 104.52),
    ("78f8908d", "Universal Account", "ccard", 101.06),
]

TX = [
    # id, date, income, outcome, income_account, outcome_account, payee, comment
    ("t1", "2026-09-20", 0.0, 12.40, "Universal Account", "Universal Account", "SPAR", None),
    ("t2", "2026-09-18", 0.0, 8.00, "Universal Account", "Universal Account", "Nikora", None),
    ("t3", "2026-09-15", 0.0, 6.50, "Universal Account", "Universal Account", "YANDEX.GO", None),
    ("t4", "2026-08-20", 0.0, 5.99, "Universal Account", "Universal Account", "APPLE.COM/BILL", None),
    ("t5", "2026-07-20", 0.0, 5.99, "Universal Account", "Universal Account", "APPLE.COM/BILL", None),
    ("t6", "2026-09-10", 0.0, 90.00, "Universal Account", "Universal Account", "Bank of Georgia", "Cash withdrawal"),
    ("t7", "2026-09-09", 0.0, 22.00, "Universal Account", "Universal Account", "llc lampionebi", None),
    ("t8", "2026-09-08", 0.0, 17.00, "Universal Account", "Universal Account", "неизвестный чудак", None),
    ("t9", "2026-09-05", 2594.0, 0.0, "Universal Account", "Universal Account", "shps niu pheiment sistem", "Private transfer"),
    ("t10", "2026-06-20", 0.0, 5.99, "Universal Account", "Universal Account", "APPLE.COM/BILL", None),
    # рублёвая строка — в регион не входит
    ("t11", "2026-09-19", 0.0, 5000.0, "Black", "Black", "Леонид Г.", None),
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

    for aid, cur, vis, region in [("c8efea56", "RUB", "public", None),
                                  ("17525302", "GEL", "private", "ge"),
                                  ("78f8908d", "USD", "private", "ge")]:
        migrated.execute("INSERT OR REPLACE INTO zm_account_meta (account_id,title,currency,visibility,region)"
                         " VALUES (?,?,?,?,?)",
                         (aid, "Black" if aid == "c8efea56" else "Universal Account", cur, vis, region))
    migrated.commit()

    import importlib
    import abroad
    import zm_scope
    importlib.reload(zm_scope)
    importlib.reload(abroad)
    return abroad


def scope(mod, owner=True):
    import zm_scope
    return zm_scope.Scope(owner=owner)


def items(mod):
    s = scope(mod)
    return mod.decorate(mod.fetch_rows(s, "ge"), s, mod.load_rules())


def test_seed_creates_categories_and_rules(migrated):
    cats = {r[0] for r in migrated.execute("SELECT code FROM abroad_categories")}
    assert {"groceries", "cafe", "transport", "cash", "other"} <= cats
    n = migrated.execute("SELECT COUNT(*) FROM abroad_payee_rules").fetchone()[0]
    assert n > 30, "стартовый набор правил по реальным получателям"


def test_rows_selected_by_account_title_not_currency(mod):
    """Валюта строки неизвестна (три счёта под одним именем), поэтому отбор идёт
    по названию счёта. Рублёвая строка в регион попасть не должна."""
    ids = {i["id"] for i in items(mod)}
    assert "t11" not in ids, "рублёвая карта — не Грузия"
    assert {"t1", "t2", "t3", "t6"} <= ids
    s = scope(mod)
    assert s.currency_of("Universal Account") == "unknown"


def test_category_from_payee(mod):
    by = {i["id"]: i["category"] for i in items(mod)}
    assert by["t1"] == "groceries" and by["t2"] == "groceries"
    assert by["t3"] == "transport"
    assert by["t4"] == "subscriptions"
    assert by["t8"] == "other", "незнакомый получатель — «прочее», а не выдуманная категория"


def test_cash_withdrawal_is_recognised_by_comment(mod):
    """В выписке BOG получателем снятия стоит сам банк — по имени это
    неотличимо от покупки, опознаём по назначению платежа."""
    by = {i["id"]: i["category"] for i in items(mod)}
    assert by["t6"] == "cash"


def test_longest_pattern_wins(mod):
    """«llc lampionebi» — магазин света, а не просто «llc ...»: частное правило
    должно перебивать общее."""
    by = {i["id"]: i["category"] for i in items(mod)}
    assert by["t7"] == "home"


def test_amounts_have_no_currency_while_accounts_share_a_name(mod):
    res = mod.spending(items(mod))
    assert res["currency"] is None and res["currency_split"] is False
    assert all(c["currency"] is None for c in res["categories"])
    assert res["count"] == 9, "девять трат; приход и рублёвая строка не в счёт"


def test_income_and_transfers_are_not_spending(mod):
    res = mod.spending(items(mod))
    assert all(i["kind"] != "income" for i in items(mod) if i["id"] != "t9")
    sept = next(m for m in res["months"] if m["period"] == "2026-09")
    assert sept["incomes"] == 2594.0, "приход показывается отдельно от трат"
    assert round(sept["total"], 2) == round(12.40 + 8.00 + 6.50 + 90.00 + 22.00 + 17.00, 2)


def test_recurring_needs_three_months(mod):
    rec = {r["payee"]: r for r in mod.recurring(items(mod))}
    assert "APPLE.COM/BILL" in rec and rec["APPLE.COM/BILL"]["months"] == 3
    assert "SPAR" not in rec, "разовая трата регулярной не становится"


def test_currency_appears_once_accounts_are_renamed(mod, migrated, tmp_path, monkeypatch):
    """Приёмка развилки: после переименования счетов тот же код сам разделит
    валюты — правок не требуется."""
    import db
    import importlib
    import sqlite3 as s3
    z = s3.connect(db.ZENMONEY_DB)
    z.execute("UPDATE zm_accounts SET title = 'Сола ₾' WHERE id = '17525302'")
    z.execute("UPDATE zm_accounts SET title = 'Сола $' WHERE id = '78f8908d'")
    z.execute("UPDATE zm_transactions SET income_account='Сола ₾', outcome_account='Сола ₾'"
              " WHERE income_account='Universal Account'")
    z.execute("UPDATE zm_transactions SET income_account='Сола $', outcome_account='Сола $'"
              " WHERE id IN ('t4','t5','t10')")
    z.commit(); z.close()
    migrated.execute("UPDATE zm_account_meta SET title='Сола ₾' WHERE account_id='17525302'")
    migrated.execute("UPDATE zm_account_meta SET title='Сола $' WHERE account_id='78f8908d'")
    migrated.commit()
    import zm_scope
    importlib.reload(zm_scope)
    importlib.reload(mod)

    s = zm_scope.Scope(owner=True)
    its = mod.decorate(mod.fetch_rows(s, "ge"), s, mod.load_rules())
    res = mod.spending(its)
    # Итог по всем тратам остаётся без валюты — она РАЗНАЯ, а не неизвестная,
    # и это другая причина: лари с долларами не складываются никогда.
    assert res["currency"] is None
    subs = next(c for c in res["categories"] if c["category"] == "subscriptions")
    assert subs["currency"] == "USD", "подписки в долларах перестают быть «непонятно чем»"
    groc = next(c for c in res["categories"] if c["category"] == "groceries")
    assert groc["currency"] == "GEL"


def test_every_region_endpoint_is_owner_only(mod):
    """Забыть гейт на новой ручке — самый дешёвый способ раскрыть личный контур,
    поэтому проверяем весь роутер целиком, а не отдельные ручки."""
    import inspect

    import privacy
    from routers import regions

    for route in regions.router.routes:
        params = inspect.signature(route.endpoint).parameters
        dep = params.get("user")
        assert dep is not None, f"{route.path}: нет параметра user"
        assert dep.default.dependency is privacy.require_owner, f"{route.path}: гейт не require_owner"
