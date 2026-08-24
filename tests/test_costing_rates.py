"""Ставки работ → цена строки сметы (costing._rate_price).

Схемы делятся на две группы, и путать их дорого: per_unit/hourly задают цену
ЗА ЕДИНИЦУ (умножение на qty правильное), fixed и percent задают ИТОГ строки
(умножение на qty — тихая ошибка в себестоимости).

С 12.08.2026 ставка берётся через rates.effective_rate — ей нужна база, чтобы
поискать ступени по объёму партии (work_rate_tiers). Здесь ступеней нет, значит
работает базовая rate: ровно то поведение, что проверялось до ступеней.
"""
import sqlite3

import pytest

from routers.costing import _rate_price


@pytest.fixture
def conn():
    """Пустые ступени: effective_rate не находит строки и берёт базовую ставку."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE work_rate_tiers (id TEXT, work_rate_id TEXT, min_qty REAL, rate REAL)")
    yield c
    c.close()


def test_fixed_rate_is_per_item_not_multiplied_by_qty(conn):
    """fixed 5 000 ₽/изделие при qty=3 остаётся 5 000 ₽, а не 15 000."""
    unit_price = _rate_price(conn, {"id": "r1", "scheme": "fixed", "rate": 5000}, None, None, 3)
    line_total = 3 * unit_price
    assert abs(line_total - 5000) < 0.05, f"fixed раздулся до {line_total}"


def test_fixed_rate_with_qty_one(conn):
    assert _rate_price(conn, {"id": "r1", "scheme": "fixed", "rate": 5000}, None, None, 1) == 5000


def test_per_unit_rate_stays_per_unit(conn):
    """per_unit/hourly — цена за единицу: qty умножает её честно."""
    assert _rate_price(conn, {"id": "r1", "scheme": "per_unit", "rate": 1200}, None, None, 4) == 1200
    assert _rate_price(conn, {"id": "r2", "scheme": "hourly", "rate": 800}, None, None, 6) == 800
