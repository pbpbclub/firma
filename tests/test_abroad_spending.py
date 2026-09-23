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
    # пополнение грузинской карты с рублёвой: ушло 9 511,50 ₽, пришло 300 ₾ —
    # одна строка с ДВУМЯ ногами в разных валютах
    ("t12", "2026-09-17", 300.0, 9511.50, "Universal Account", "Black", "Себе", None),
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
    return mod.decorate(mod.fetch_rows(s, "ge"), s, mod.load_rules(), mod.region_titles(s, "ge"))


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


def test_two_legged_row_shows_the_leg_of_the_region(mod):
    """Пополнение карты региона с рублёвого счёта: в ленте Грузии обязана быть
    ГРУЗИНСКАЯ нога (300 ₾ на BOG), а не рублёвая сумма с чужого счёта."""
    t12 = next(i for i in items(mod) if i["id"] == "t12")
    assert t12["kind"] == "transfer"
    assert t12["amount"] == 300.0, "9 511,50 ₽ — нога чужого счёта, не наша"
    assert t12["account"] == "Universal Account"
    # Валюта у счетов-тёзок пока неизвестна — но она уж точно не рублёвая.
    assert t12["currency"] != "RUB"


def test_category_from_payee(mod):
    by = {i["id"]: i["category"] for i in items(mod)}
    assert by["t1"] == "groceries" and by["t2"] == "groceries"
    assert by["t3"] == "transport"
    assert by["t4"] == "infra", "Apple — инфраструктура, не личная подписка (решение Юры 23.09.2026)"
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
    its = mod.decorate(mod.fetch_rows(s, "ge"), s, mod.load_rules(),
                       mod.region_titles(s, "ge"))
    res = mod.spending(its)
    # Валюты РАЗНЫЕ, а не неизвестные: одного итога на всё нет — сводка считается
    # по одной валюте, остальные перечислены переключателем.
    keys = {g["key"] for g in res["by_currency"]}
    assert keys == {"GEL", "USD"}
    assert res["currency_auto"] is True and res["currency_filter"] == res["by_currency"][0]["key"]
    assert res["currency"] == res["currency_filter"], "итог подписан своей валютой"
    gel, usd = mod.spending(its, currency="GEL"), mod.spending(its, currency="USD")
    assert gel["currency"] == "GEL" and usd["currency"] == "USD"
    assert all(c["currency"] == "GEL" for c in gel["categories"])
    subs = next(c for c in usd["categories"] if c["category"] == "infra")
    assert subs["currency"] == "USD", "подписки в долларах перестают быть «непонятно чем»"
    groc = next(c for c in gel["categories"] if c["category"] == "groceries")
    assert groc["currency"] == "GEL"
    # 🔒 Лари с долларами не складываются ни в одной проекции.
    assert round(gel["spent"] + usd["spent"], 2) == round(
        sum(g["total"] for g in res["by_currency"]), 2)
    assert gel["spent"] != round(gel["spent"] + usd["spent"], 2)


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


# ── Период, дельта, столбики, счёт (23.09.2026) ─────────────────────────────

def test_buckets_scale_with_window(mod):
    its = items(mod)
    assert mod.window_buckets(its, "2026-09-01", "2026-09-22")["bucket_kind"] == "day"
    wk = mod.window_buckets(its, "2026-07-01", "2026-09-22")
    assert wk["bucket_kind"] == "week"
    assert all(b["period"] and b["period"][:4] == "2026" for b in wk["buckets"])
    assert mod.window_buckets(its, "2026-01-01", "2026-09-22")["bucket_kind"] == "month"
    # пустые дни остаются в ряду — тихий день не выпадает
    day = mod.window_buckets(its, "2026-09-01", "2026-09-22")
    assert len(day["buckets"]) == 22


def test_compare_adds_deltas(mod):
    its = items(mod)
    cur = mod.spending([i for i in its if i["date"] >= "2026-09-01"])
    prev = mod.spending([i for i in its if "2026-08-01" <= i["date"] < "2026-09-01"])
    res = mod.compare(cur, prev)
    assert res["prev"]["spent"] == 5.99, "в августе была одна трата — Apple"
    subs = next(c for c in res["categories"] if c["category"] == "subscriptions") if any(
        c["category"] == "subscriptions" for c in res["categories"]) else None
    assert subs is None or subs["prev_total"] == 5.99
    assert res["spent_delta_pct"] is not None


def test_month_summary_uses_full_months_only(mod):
    from datetime import date
    ms = mod.month_summary(items(mod), today=date(2026, 9, 22))
    assert ms["spent_mtd"] == round(12.40 + 8.00 + 6.50 + 90.00 + 22.00 + 17.00, 2)
    assert ms["full_months"] == 3, "июнь, июль, август — текущий сентябрь в норму не входит"
    assert ms["avg_month"] == round((5.99 + 5.99 + 5.99) / 3, 2)
    assert ms["pace_pct"] == round(22 / 30, 3)


def test_feed_rows_carry_account_and_ambiguity(mod):
    row = next(i for i in items(mod) if i["id"] == "t1")
    assert row["account"] == "Universal Account"
    assert row["account_ambiguous"] is True and row["account_id"] is None


def test_infra_category_and_seed_migration(migrated):
    """Инфраструктура (AI, инструменты) — своя категория (решение Юры 23.09.2026).
    Сидовые правила переезжают в неё, ручная правка Юры — нет."""
    cats = {r[0] for r in migrated.execute("SELECT code FROM abroad_categories")}
    assert "infra" in cats
    cat = migrated.execute("SELECT category FROM abroad_payee_rules WHERE pattern='anthropic'").fetchone()[0]
    assert cat == "infra"
    # Ручная правка: заметка не сидовая → миграция её не трогает
    migrated.execute("UPDATE abroad_payee_rules SET category='subscriptions', note='Юра решил иначе'"
                     " WHERE pattern='openai'")
    migrated.commit()
    import db
    db.ensure_abroad_categories_schema()
    db.ensure_abroad_infra_seed()
    cat = migrated.execute("SELECT category FROM abroad_payee_rules WHERE pattern='openai'").fetchone()[0]
    assert cat == "subscriptions", "правка из интерфейса не перетирается рестартом"


def test_shape_for_infographics(mod):
    """Дни недели, средний чек, среднее в день по КАЛЕНДАРНЫМ дням окна трат."""
    sept = [i for i in items(mod) if i["date"] >= "2026-09-01"]
    sh = mod.shape(sept)
    spent = 12.40 + 8.00 + 6.50 + 90.00 + 22.00 + 17.00
    assert sh["avg_check"] == round(spent / 6, 2)
    assert sh["span_days"] == 20-8+1, "с 08.09 по 20.09 включительно"
    assert sh["daily_avg"] == round(spent / 13, 2), "тихие дни тоже в знаменателе"
    assert sh["max_day"] == {"date": "2026-09-10", "total": 90.0}
    assert sum(d["count"] for d in sh["by_weekday"]) == 6
    assert [d["label"] for d in sh["by_weekday"]][0] == "Пн"


def test_first_date_of_region_history(mod):
    """Прошлое окно раньше истории карты — огрызок; дельту по нему не показываем."""
    assert mod.first_date(scope(mod), "ge") == "2026-06-20"
