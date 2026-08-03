"""Ввод цен «за штуку» в позициях смет (routers/estimates.py).

Запрос 03.08.2026: колонки «за штуку» в смете считались руками — «приходится
рассчитывать от общей себестоимости за штуку», фин-агент умножал на количество
сам и ошибался. API принимает cost_unit / sale_unit / client_unit и переводит
в тоталы; одновременно unit и его total — ошибка, а не тихий выбор.
"""
import pytest
from fastapi import HTTPException

from routers.estimates import _apply_unit_fields


def _f(**kw):
    return dict(kw)


class TestPerUnit:
    def test_cost_unit_умножается_на_количество(self):
        fields = _f(cost_unit=33_750)
        _apply_unit_fields(fields, quantity=8, payment_type="cash", bank_pct=0)
        assert fields == {"cost_total": 270_000}

    def test_sale_unit_умножается_на_количество(self):
        fields = _f(sale_unit=54_000)
        _apply_unit_fields(fields, quantity=8, payment_type="cash", bank_pct=0)
        assert fields == {"sale_price": 432_000}

    def test_client_unit_для_нала_равен_sale(self):
        fields = _f(client_unit=54_000)
        _apply_unit_fields(fields, quantity=8, payment_type="cash", bank_pct=0)
        assert fields == {"sale_price": 432_000}

    def test_client_unit_для_безнала_снимает_удержание(self):
        # клиенту за штуку 10 000 × 10 шт = 100 000 счёт → sale «за нал» = 87 000
        fields = _f(client_unit=10_000)
        _apply_unit_fields(fields, quantity=10, payment_type="bank", bank_pct=13.0)
        assert fields == {"sale_price": 87_000}

    def test_конфликт_unit_и_total_это_400(self):
        with pytest.raises(HTTPException) as e:
            _apply_unit_fields(_f(cost_unit=100, cost_total=800), quantity=8,
                               payment_type="cash", bank_pct=0)
        assert e.value.status_code == 400

    def test_количество_один_работает(self):
        fields = _f(cost_unit=81_250)
        _apply_unit_fields(fields, quantity=1, payment_type="cash", bank_pct=0)
        assert fields == {"cost_total": 81_250}
