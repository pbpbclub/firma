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
    for aid, title, cur, vis in [
        ("c8efea56", "Black", "RUB", "public"),
        ("8af50bc5", "MasterCard Mass", "RUB", "public"),
        ("67009398", "Mir Cashback Card", "RUB", "public"),
        ("81edcd65", "Cash", "RUB", "public"),
        ("17525302", "Universal Account", "unknown", "pending"),
        ("78f8908d", "Universal Account", "unknown", "pending"),
        ("017783a4", "Universal Account", "unknown", "pending"),
        ("aaaa1111", "Сола ₾", "GEL", "private"),
    ]:
        migrated.execute("INSERT OR REPLACE INTO zm_account_meta (account_id,title,currency,visibility,region)"
                         " VALUES (?,?,?,?,?)", (aid, title, cur, vis, "ge" if cur == "GEL" else None))
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


def test_clerk_does_not_see_private_or_cross_rows(scope_mod):
    s = clerk(scope_mod)
    rows = [dict(zip(("id", "date", "income", "outcome", "income_account", "outcome_account", "payee"), t)) for t in TX]
    visible = {r["id"] for r in s.filter_rows(rows)}
    assert visible == {"t-pub"}, "приватные, неоднозначные и кросс-строки бухгалтеру не видны"
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
    assert {r["id"] for r in rows} == {"t-pub"}
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
