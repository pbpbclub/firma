"""Ставки работ → цена строки сметы (costing._rate_price).

Схемы делятся на две группы, и путать их дорого: per_unit/hourly задают цену
ЗА ЕДИНИЦУ (умножение на qty правильное), fixed и percent задают ИТОГ строки
(умножение на qty — тихая ошибка в себестоимости).
"""
from routers.costing import _rate_price


def test_fixed_rate_is_per_item_not_multiplied_by_qty():
    """fixed 5 000 ₽/изделие при qty=3 остаётся 5 000 ₽, а не 15 000."""
    unit_price = _rate_price({"scheme": "fixed", "rate": 5000}, None, None, 3)
    line_total = 3 * unit_price
    assert abs(line_total - 5000) < 0.05, f"fixed раздулся до {line_total}"


def test_fixed_rate_with_qty_one():
    assert _rate_price({"scheme": "fixed", "rate": 5000}, None, None, 1) == 5000


def test_per_unit_rate_stays_per_unit():
    """per_unit/hourly — цена за единицу: qty умножает её честно."""
    assert _rate_price({"scheme": "per_unit", "rate": 1200}, None, None, 4) == 1200
    assert _rate_price({"scheme": "hourly", "rate": 800}, None, None, 6) == 800
