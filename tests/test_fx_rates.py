"""Курсы Нацбанка и сигнал обмена (22.09.2026).

Сеть в тестах не трогаем: NBG отвечает по одной дате за запрос, и гонять его
из CI незачем. Проверяем то, что наше: нормализацию котировки, вердикт против
собственного разброса и честное молчание, когда данных мало.
"""
import pytest


@pytest.fixture
def fx_mod(migrated):
    import importlib
    import fx
    importlib.reload(fx)
    return fx


def _seed(conn, rates, base="USD"):
    for d, r in rates:
        conn.execute("INSERT OR REPLACE INTO fx_rates (date, base, quote, rate, source)"
                     " VALUES (?, ?, 'GEL', ?, 'nbg')", (d, base, r))
    conn.commit()


def _days(n, start="2026-09-01"):
    from datetime import date, timedelta
    d0 = date.today()
    return [(d0 - timedelta(days=i)).isoformat() for i in range(n)][::-1]


def test_migration_creates_fx_table(migrated):
    cols = {r[1] for r in migrated.execute("PRAGMA table_info(fx_rates)")}
    assert {"date", "base", "quote", "rate", "source"} <= cols


def test_rub_quote_normalised_to_one_unit(fx_mod):
    """NBG отдаёт рубли за 100 единиц. Без деления в базу легла бы «3,1 лари
    за рубль» — и любой пересчёт рублей в лари соврал бы в сто раз."""
    payload = [{"date": "2026-09-23T00:00:00.000Z", "currencies": [
        {"code": "RUB", "quantity": 100, "rate": 3.1028, "validFromDate": "2026-09-23T00:00:00.000Z"},
        {"code": "USD", "quantity": 1, "rate": 2.6104, "validFromDate": "2026-09-23T00:00:00.000Z"},
    ]}]
    import json
    from unittest.mock import patch

    class FakeResp:
        def read(self): return json.dumps(payload).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    with patch("urllib.request.urlopen", return_value=FakeResp()):
        rows = fx_mod._fetch()
    by = {r["base"]: r["rate"] for r in rows}
    assert by["RUB"] == 0.031028, "рубль приводится к одной единице"
    assert by["USD"] == 2.6104
    assert all(r["date"] == "2026-09-23" for r in rows)


def test_signal_says_wait_when_rate_is_low(fx_mod, migrated):
    days = _days(25)
    _seed(migrated, [(d, 2.70) for d in days[:-1]] + [(days[-1], 2.60)])
    s = fx_mod.signal("USD", "GEL")
    assert s["verdict"] == "wait"
    assert s["rate"] == 2.60
    assert s["best_30"] == 2.70


def test_signal_says_good_when_rate_is_high(fx_mod, migrated):
    days = _days(25)
    _seed(migrated, [(d, 2.60 + i * 0.001) for i, d in enumerate(days[:-1])] + [(days[-1], 2.75)])
    s = fx_mod.signal("USD", "GEL")
    assert s["verdict"] == "good"
    assert s["pct_month"] >= 0.8


def test_signal_is_silent_on_thin_history(fx_mod, migrated):
    """Меньше десяти дней — вердикта не выносим: «выгодно» из трёх точек
    это не вывод, а гадание."""
    _seed(migrated, [(d, 2.61) for d in _days(5)])
    s = fx_mod.signal("USD", "GEL")
    assert s["verdict"] == "unknown"
    assert "мало данных" in s["note"]


def test_signal_without_rates_does_not_crash(fx_mod):
    s = fx_mod.signal("USD", "GEL")
    assert s["verdict"] == "no_data"


def test_refresh_survives_network_failure(fx_mod):
    """Сеть — не повод ронять экран: отдаём, что есть в базе."""
    from unittest.mock import patch
    with patch("urllib.request.urlopen", side_effect=OSError("нет сети")):
        res = fx_mod.refresh(force=True)
    assert res["ok"] is False and res["stored"] == 0
