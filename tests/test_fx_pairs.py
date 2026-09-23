"""Пары курсов в обе стороны (23.09.2026).

Один перцентиль, прочитанный с двух концов: покупать валюту выгодно, когда она
дёшева, продавать — когда дорога. Ряды синтетические, сети нет.
"""
from datetime import date, timedelta

import pytest


@pytest.fixture
def fx_mod(migrated):
    import importlib
    import fx
    importlib.reload(fx)
    return fx


def _seed(conn, base, rates):
    for d, r in rates:
        conn.execute("INSERT OR REPLACE INTO fx_rates (date, base, quote, rate, source)"
                     " VALUES (?, ?, 'GEL', ?, 'nbg')", (d, base, r))
    conn.commit()


def _days(n):
    d0 = date.today()
    return [(d0 - timedelta(days=i)).isoformat() for i in range(n)][::-1]


def test_rub_gel_quote_is_rubles_per_lari(fx_mod, migrated):
    _seed(migrated, "RUB", [(_days(1)[0], 0.031)])
    rows = fx_mod.pair_series("RUB_GEL", 5)
    assert rows[-1]["rate"] == round(1 / 0.031, 4), "₽ за ₾ = 1 / (лари за рубль)"


def test_rub_usd_is_derived_on_common_dates(fx_mod, migrated):
    days = _days(3)
    _seed(migrated, "RUB", [(days[0], 0.031), (days[2], 0.032)])
    _seed(migrated, "USD", [(days[0], 2.6), (days[1], 2.61), (days[2], 2.62)])
    rows = fx_mod.pair_series("RUB_USD", 5)
    assert [r["date"] for r in rows] == [days[0], days[2]], "только даты, где есть обе котировки"
    assert rows[0]["rate"] == round(2.6 / 0.031, 4)


def test_directions_are_mirror_images(fx_mod, migrated):
    """Лари сегодня дёшевы (₽ за ₾ ниже, чем в 90% дней): покупать лари за рубли —
    окно, продавать лари за рубли — ждать."""
    days = _days(25)
    _seed(migrated, "RUB", [(d, 1 / 33.0) for d in days[:-1]] + [(days[-1], 1 / 30.0)])
    sig = fx_mod.pair_signal("RUB_GEL")
    by = {(d["from"], d["to"]): d["verdict"] for d in sig["directions"]}
    assert by[("RUB", "GEL")] == "good"
    assert by[("GEL", "RUB")] == "wait"


def test_expensive_lari_flips_the_verdicts(fx_mod, migrated):
    days = _days(25)
    _seed(migrated, "RUB", [(d, 1 / 30.0) for d in days[:-1]] + [(days[-1], 1 / 34.0)])
    by = {(d["from"], d["to"]): d["verdict"] for d in fx_mod.pair_signal("RUB_GEL")["directions"]}
    assert by[("RUB", "GEL")] == "wait"
    assert by[("GEL", "RUB")] == "good"


def test_thin_history_gives_no_verdict(fx_mod, migrated):
    _seed(migrated, "USD", [(d, 2.61) for d in _days(4)])
    sig = fx_mod.pair_signal("USD_GEL")
    assert all(d["verdict"] == "unknown" for d in sig["directions"])


def test_usd_gel_prices_the_dollar(fx_mod, migrated):
    """₾ за 1 $: оцениваем доллар в лари. Направления — GEL→USD (купить доллар)
    и USD→GEL (продать доллар), в этом порядке."""
    _seed(migrated, "USD", [(d, 2.61) for d in _days(12)])
    sig = fx_mod.pair_signal("USD_GEL")
    assert sig["price_of"] == "USD" and sig["in"] == "GEL"
    assert [(d["from"], d["to"]) for d in sig["directions"]] == [("GEL", "USD"), ("USD", "GEL")]
