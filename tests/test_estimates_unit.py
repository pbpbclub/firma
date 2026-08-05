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

    def test_явный_null_тотала_тоже_конфликт(self):
        """PATCH-семантика: присланный null — это «очисти поле», а не «не прислали».
        Раньше проверка была `is not None`, и очистка молча затиралась вычисленным
        тоталом (ревью 04.08.2026)."""
        with pytest.raises(HTTPException) as e:
            _apply_unit_fields(_f(client_unit=100, sale_price=None), quantity=1,
                               payment_type="cash", bank_pct=0)
        assert e.value.status_code == 400

    def test_количество_один_работает(self):
        fields = _f(cost_unit=81_250)
        _apply_unit_fields(fields, quantity=1, payment_type="cash", bank_pct=0)
        assert fields == {"cost_total": 81_250}


# ─── Цены при СОЗДАНИИ позиции и смета одним запросом (05.08.2026) ───────────
# Запрос фин-агента: его estimate-create писал сметы прямо в SQLite и держал
# свою копию формулы безнала — она отстала от money.py (делила на 1.13 вместо
# умножения на 0.87) и превратила счёт 280 800 ₽ по ART ГАММА в 285 700 ₽.
# Дубля больше нет: цены принимает API на создании.

@pytest.fixture
def prod_db(tmp_path, monkeypatch, schema_sql):
    import sqlite3, re
    from pathlib import Path
    import db
    prod = tmp_path / "production.db"
    c = sqlite3.connect(prod)
    for stmt in schema_sql:
        try:
            c.execute(stmt)
        except sqlite3.OperationalError:
            pass
    c.execute("INSERT INTO orders (id, number, title, status) VALUES ('o1', 'ORD-036', 'ART ГАММА', 'estimate')")
    c.commit()
    c.close()
    monkeypatch.setattr(db, "PRODUCTION_DB", prod)
    main_body = (Path(db.__file__).parent / "main.py").read_text().split("def startup():", 1)[1]
    for name in [n for n in re.findall(r"^\s{4}(\w+)\(\)", main_body, re.M) if n != "init_admin"]:
        getattr(db, name)()
    return prod


class TestCreateWithPrices:
    def test_позиция_создаётся_сразу_с_ценой_за_штуку(self, prod_db):
        from routers.estimates import create_set, add_item, SetCreate, ItemCreate
        s = create_set(SetCreate(order_id="o1", title="Смета", payment_type="cash"))
        it = add_item(s["id"], ItemCreate(title="Стол", quantity=8, cost_unit=33_750, sale_unit=54_000))
        assert (it["cost_total"], it["sale_price"]) == (270_000, 432_000)

    def test_client_unit_безнал_разворачивается_обратно_в_счёт(self, prod_db):
        """280 800 ₽ клиенту → sale 244 296 → счёт снова 280 800 (не 285 700)."""
        from routers.estimates import create_set_full, SetFullCreate, ItemCreate
        r = create_set_full(SetFullCreate(
            order_id="o1", title="Счёт", payment_type="bank", bank_pct=13.0,
            items=[ItemCreate(title="Гарнитур", quantity=1, client_unit=280_800, cost_unit=150_000)],
        ))
        assert r["items"][0]["sale_price"] == 244_296
        assert r["price"] == 280_800
        assert r["cost"] == 150_000

    def test_смета_одним_запросом_складывает_позиции(self, prod_db):
        from routers.estimates import create_set_full, SetFullCreate, ItemCreate
        r = create_set_full(SetFullCreate(
            order_id="o1", payment_type="cash",
            items=[ItemCreate(title="A", quantity=2, sale_unit=1_000, cost_unit=400),
                   ItemCreate(title="B", quantity=1, sale_price=3_000, cost_total=1_000)],
        ))
        assert len(r["items"]) == 2
        assert (r["price"], r["cost"]) == (5_000, 1_800)

    def test_конфликт_unit_и_total_при_создании_это_400(self, prod_db):
        from routers.estimates import create_set, add_item, SetCreate, ItemCreate
        s = create_set(SetCreate(order_id="o1", payment_type="cash"))
        with pytest.raises(HTTPException) as e:
            add_item(s["id"], ItemCreate(title="X", quantity=2, sale_unit=100, sale_price=200))
        assert e.value.status_code == 400

    def test_несуществующий_заказ_это_404(self, prod_db):
        from routers.estimates import create_set_full, SetFullCreate
        with pytest.raises(HTTPException) as e:
            create_set_full(SetFullCreate(order_id="нет-такого"))
        assert e.value.status_code == 404
