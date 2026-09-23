"""Линза ZenMoney: валюты не смешиваются, приватное не течёт (22.09.2026).

Данные повторяют боевую картину после подключения карт Bank of Georgia:
рублёвые счета РФ, три счёта BOG под ОДНИМ названием «Universal Account»
и кросс-валютная строка «ушло 9 511,50 ₽ — пришло 300 ₾».
"""
import sqlite3

import pytest

ACC = [
    # id, title, type, balance
    ("c8efea56", "Black", "ccard", 6942.62),
    ("8af50bc5", "MasterCard Mass", "ccard", 82229.84),
    ("67009398", "Mir Cashback Card", "ccard", 1.88),
    ("81edcd65", "Cash", "cash", -10000.0),
    ("17525302", "Universal Account", "ccard", 104.52),
    ("78f8908d", "Universal Account", "ccard", 101.06),
    ("017783a4", "Universal Account", "ccard", 0.0),
    ("aaaa1111", "Сола ₾", "ccard", 300.0),      # уже переименованный счёт
]

TX = [
    # id, date, income, outcome, income_account, outcome_account, payee
    ("t-pub", "2026-09-10", 0.0, 5000.0, "Black", "Black", "Леонид Г."),
    ("t-cross", "2026-07-22", 300.0, 9511.5, "Сола ₾", "Mir Cashback Card", None),
    ("t-priv", "2026-09-21", 0.0, 62.0, "Сола ₾", "Сола ₾", "TEA HOUSE AT KIACHELI"),
    ("t-amb", "2026-09-21", 0.0, 118.0, "Universal Account", "Universal Account", "ANTHROPIC"),
]


@pytest.fixture
def scope_mod(migrated, tmp_path, monkeypatch):
    """Реестр из боевой миграции + подменённая zenmoney.db."""
    import db
    zen = tmp_path / "zenmoney.db"
    z = sqlite3.connect(zen)
    z.execute("CREATE TABLE zm_accounts (id TEXT PRIMARY KEY, title TEXT, type TEXT, balance REAL, archive INTEGER DEFAULT 0)")
    z.execute("CREATE TABLE zm_transactions (id TEXT PRIMARY KEY, date TEXT, income REAL, outcome REAL,"
              " income_account TEXT, outcome_account TEXT, payee TEXT, comment TEXT, tags TEXT,"
              " deleted INTEGER DEFAULT 0, changed INTEGER)")
    z.executemany("INSERT INTO zm_accounts (id,title,type,balance) VALUES (?,?,?,?)", ACC)
    z.executemany("INSERT INTO zm_transactions (id,date,income,outcome,income_account,outcome_account,payee)"
                  " VALUES (?,?,?,?,?,?,?)", TX)
    z.commit(); z.close()
    monkeypatch.setattr(db, "ZENMONEY_DB", zen)

    # Сид миграции знает боевые UUID; в тесте id укорочены — заводим реестр руками.
    # region как в бою: у карт Bank of Georgia он есть даже до назначения валюты —
    # это признак «заграничная карта», а не следствие валюты.
    for aid, title, cur, vis, region in [
        ("c8efea56", "Black", "RUB", "public", None),
        ("8af50bc5", "MasterCard Mass", "RUB", "public", None),
        ("67009398", "Mir Cashback Card", "RUB", "public", None),
        ("81edcd65", "Cash", "RUB", "public", None),
        ("17525302", "Universal Account", "unknown", "pending", "ge"),
        ("78f8908d", "Universal Account", "unknown", "pending", "ge"),
        ("017783a4", "Universal Account", "unknown", "pending", "ge"),
        ("aaaa1111", "Сола ₾", "GEL", "private", "ge"),
    ]:
        migrated.execute("INSERT OR REPLACE INTO zm_account_meta (account_id,title,currency,visibility,region)"
                         " VALUES (?,?,?,?,?)", (aid, title, cur, vis, region))
    migrated.commit()

    import importlib
    import zm_scope
    importlib.reload(zm_scope)
    return zm_scope


def owner(mod):
    return mod.Scope(owner=True)


def clerk(mod):
    return mod.Scope(owner=False)


def test_migration_creates_registry(migrated):
    cols = {r[1] for r in migrated.execute("PRAGMA table_info(zm_account_meta)")}
    assert {"account_id", "currency", "region", "visibility"} <= cols
    seeded = migrated.execute("SELECT COUNT(*) FROM zm_account_meta WHERE visibility='public' AND currency='RUB'").fetchone()[0]
    assert seeded == 15, "15 рублёвых счетов РФ должны быть засеяны по UUID"
    bog = migrated.execute("SELECT COUNT(*) FROM zm_account_meta WHERE visibility='pending' AND region='ge'").fetchone()[0]
    assert bog == 3, "три счёта Bank of Georgia ждут настройки, а не считаются рублями"


def test_totals_never_mix_currencies(scope_mod):
    totals = {t["currency"]: t["total"] for t in owner(scope_mod).totals()}
    assert totals["RUB"] == round(6942.62 + 82229.84 + 1.88, 2)
    assert totals["GEL"] == 300.0
    assert "unknown" not in totals, "ненастроенный счёт в итог не идёт"


def test_pending_accounts_are_not_summed(scope_mod):
    s = owner(scope_mod)
    assert s.pending_count() == 3
    assert sum(t["total"] for t in s.totals()) == round(6942.62 + 82229.84 + 1.88 + 300.0, 2)


def test_same_title_makes_account_ambiguous(scope_mod):
    s = owner(scope_mod)
    assert s.account_of("Universal Account") is None, "три счёта под одним именем неразличимы"
    assert s.currency_of("Universal Account") == "unknown"
    assert all(a.ambiguous for a in s._accounts if a.title == "Universal Account")


def test_clerk_sees_no_private_or_pending_account(scope_mod):
    titles = {a.title for a in clerk(scope_mod).accounts()}
    assert titles == {"Black", "MasterCard Mass", "Mir Cashback Card"}
    assert all(t["currency"] == "RUB" for t in clerk(scope_mod).totals())


def test_clerk_sees_public_and_cross_rows_only(scope_mod):
    """Приватное и неоднозначное скрыто; кросс-строка остаётся — но в маске
    (см. test_clerk_sees_masked_cross_row): иначе у бухгалтера деньги уходят
    с Райффайзена в никуда и остаток не сходится."""
    s = clerk(scope_mod)
    rows = [dict(zip(("id", "date", "income", "outcome", "income_account", "outcome_account", "payee"), t)) for t in TX]
    visible = {r["id"] for r in s.filter_rows(rows)}
    assert visible == {"t-pub", "t-cross"}
    assert s.classify(rows[1]) == "cross_out"
    assert owner(scope_mod).classify(rows[2]) == "private_internal"


def test_tx_sql_filters_by_public_titles(scope_mod):
    import db
    frag, params = clerk(scope_mod).tx_sql()
    conn = db.get_zenmoney()
    try:
        rows = conn.execute("SELECT id FROM zm_transactions WHERE deleted=0" + frag, params).fetchall()
    finally:
        conn.close()
    assert {r["id"] for r in rows} == {"t-pub", "t-cross"}
    frag2, params2 = clerk(scope_mod).tx_sql(both_legs=True)
    conn = db.get_zenmoney()
    try:
        strict = conn.execute("SELECT id FROM zm_transactions WHERE deleted=0" + frag2, params2).fetchall()
    finally:
        conn.close()
    assert {r["id"] for r in strict} == {"t-pub"}, "в разноске кросс-строке делать нечего"
    assert owner(scope_mod).tx_sql() == ("", []), "владельцу фильтр не навешивается"


def test_owner_gate_is_not_role_based(monkeypatch):
    import privacy
    monkeypatch.delenv("FIRMA_PRIVATE_OWNERS", raising=False)
    assert privacy.is_owner({"email": "yuranek@pbpb.club", "role": "viewer"})
    assert not privacy.is_owner({"email": "someone@pbpb.club", "role": "admin"}), "роль admin доступа не даёт"
    assert not privacy.is_owner(None)
    monkeypatch.setenv("FIRMA_PRIVATE_OWNERS", "boss@pbpb.club")
    assert privacy.is_owner({"email": "BOSS@pbpb.club"})
    assert not privacy.is_owner({"email": "yuranek@pbpb.club"}), "переменная заменяет фолбэк, а не дополняет"


def test_account_meta_endpoint_is_owner_only(scope_mod, monkeypatch):
    """Ручки реестра закрыты гейтом, а не ролью."""
    import asyncio
    import privacy
    from fastapi import HTTPException
    monkeypatch.delenv("FIRMA_PRIVATE_OWNERS", raising=False)

    async def call(user):
        return await privacy.require_owner(user)

    assert asyncio.get_event_loop().run_until_complete(call({"email": "yuranek@pbpb.club", "role": "viewer"}))
    try:
        asyncio.get_event_loop().run_until_complete(call({"email": "nekrasovael@mail.ru", "role": "admin"}))
        assert False, "бухгалтер-админ не должен проходить гейт"
    except HTTPException as e:
        assert e.status_code == 403


# ── Волна 2: маска, а не сокрытие ───────────────────────────────────────────

def test_clerk_sees_masked_cross_row(scope_mod):
    """Бухгалтер видит рублёвую ногу вывода и не видит вторую."""
    s = clerk(scope_mod)
    row = dict(zip(("id", "date", "income", "outcome", "income_account", "outcome_account", "payee"), TX[1]))
    assert s.visible(row), "деньги ушли с рублёвой карты — строка обязана остаться, иначе остаток не сойдётся"
    m = s.mask(row)
    assert m["outcome"] == 9511.5 and m["outcome_account"] == "Mir Cashback Card"
    assert m["income"] == 0 and m["income_account"] is None
    assert m["payee"] == scope_mod.ABROAD_LABEL
    assert m.get("income_currency") is None, "валюта второй ноги — часть личного контура"
    assert m["abroad"] is True


def test_owner_row_is_not_masked(scope_mod):
    row = dict(zip(("id", "date", "income", "outcome", "income_account", "outcome_account", "payee"), TX[1]))
    m = owner(scope_mod).mask(row)
    assert m["income"] == 300.0 and m["income_account"] == "Сола ₾"


def test_private_internal_row_stays_hidden(scope_mod):
    row = dict(zip(("id", "date", "income", "outcome", "income_account", "outcome_account", "payee"), TX[2]))
    assert not clerk(scope_mod).visible(row), "трата в кафе Тбилиси бухгалтеру не видна"


def test_mask_does_not_turn_transfer_into_expense(scope_mod, monkeypatch):
    """🔒 Классифицируй → агрегируй → маскируй.

    Если замаскировать раньше агрегата, вывод себе за границу встанет
    бухгалтеру в расходы по категориям (income=0 — признак расхода везде)."""
    monkeypatch.delenv("FIRMA_PRIVATE_OWNERS", raising=False)
    from routers import zenmoney as zr
    clerk_user = {"email": "nekrasovael@mail.ru", "role": "admin"}
    rep = zr.get_report(month="2026-07", currency="RUB", user=clerk_user)
    assert rep["expenses"] == 0, "вывод себе за границу — не расход"
    assert rep["transfers"] == 9511.5, "он перевод, и остаётся переводом"
    assert all(c["category"] != scope_mod.ABROAD_LABEL for c in rep["categories"])


def test_abroad_summary_same_for_clerk_and_owner(scope_mod, monkeypatch):
    monkeypatch.delenv("FIRMA_PRIVATE_OWNERS", raising=False)
    from routers import finance as fr
    owner_user = {"email": "yuranek@pbpb.club", "role": "admin"}
    clerk_user = {"email": "nekrasovael@mail.ru", "role": "admin"}
    a = fr.abroad_summary(months=12, user=owner_user)
    b = fr.abroad_summary(months=12, user=clerk_user)
    assert a["total"] == b["total"] == 9511.5
    assert b["rows"] and all("amount_rub" in r and "date" in r for r in b["rows"])
    assert all("currency" not in r and "received" not in r for r in b["rows"]), "из-за границы не отдаём ничего"


def test_zen_inbox_runs_and_skips_foreign_rows(scope_mod, monkeypatch):
    """Инбокс разноски: рублёвые публичные строки и ничего заграничного.

    Тест существует потому, что zen-ветка инбокса — единственное место, где
    «перевод себе» и валютный фильтр стоят рядом с постраничным обходом:
    22.09.2026 переменная правил там оказалась объявлена в соседней ветке,
    и ручка падала 500 на живом сервере, а не в тестах."""
    monkeypatch.delenv("FIRMA_PRIVATE_OWNERS", raising=False)
    from routers import expenses as er
    for who in ({"email": "yuranek@pbpb.club", "role": "admin"},
                {"email": "nekrasovael@mail.ru", "role": "admin"}):
        res = er.inbox(source="zen", date_from="2026-01-01", limit=50, user=who)
        items = res["items"] if isinstance(res, dict) else res
        assert all("Universal" not in str(i.get("account") or "") for i in items)
        assert all(i.get("amount") for i in items)


def test_ambiguous_title_blocks_rows_not_balances(scope_mod, migrated):
    """Одинаковое название бьёт по СТРОКАМ, а не по остаткам.

    Валюта счёта известна по id — остаток в лари посчитать можно. Нельзя другое:
    понять, какому из трёх счетов принадлежит строка, потому что в
    zm_transactions нога хранится названием."""
    migrated.execute("UPDATE zm_account_meta SET currency = 'GEL', visibility = 'private' WHERE account_id = '17525302'")
    migrated.execute("UPDATE zm_account_meta SET currency = 'USD', visibility = 'private' WHERE account_id = '78f8908d'")
    migrated.commit()
    import importlib
    import zm_scope
    importlib.reload(zm_scope)
    s = zm_scope.Scope(owner=True)

    totals = {t["currency"]: t["total"] for t in s.totals()}
    assert totals["GEL"] == 104.52 + 300.0, "остаток лари считается, хотя имя делят три счёта"
    assert totals["USD"] == 101.06
    assert s.account_of("Universal Account") is None, "строку всё равно не привязать"
    assert s.currency_of("Universal Account") == "unknown"
    assert s.ambiguous_count() == 3

    # И бухгалтеру эти деньги по-прежнему не видны
    clerk_totals = {t["currency"] for t in zm_scope.Scope(owner=False).totals()}
    assert clerk_totals == {"RUB"}


def test_home_contour_excludes_foreign_accounts(scope_mod, monkeypatch):
    """Решение Юры 23.09.2026: заграничные карты — только в своём разделе.

    «Личные» показывают домашний контур; иначе один и тот же остаток считается
    дважды и непонятно, где правда."""
    monkeypatch.delenv("FIRMA_PRIVATE_OWNERS", raising=False)
    s = owner(scope_mod)
    home = {a.title for a in s.home_accounts()}
    assert "Сола ₾" not in home and "Universal Account" not in home
    assert "Black" in home
    assert all(t["currency"] == "RUB" for t in s.totals(region=None))
    ge = {a.title for a in s.accounts(region="ge")}
    assert ge == {"Сола ₾", "Universal Account"}, "раздел страны видит свои счета"
