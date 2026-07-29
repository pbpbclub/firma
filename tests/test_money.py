"""Формулы безнала и округлений (backend/money.py).

Модуль чистый — базы не нужны. Это ровно те цифры, которые уходят в счёт
клиенту, поэтому проверяем и граничные случаи: разворот условия «не bank»
однажды заставил транзит делиться на 0,87 вторым, чужим удержанием.
"""
import money


class TestClientPrice:
    def test_нал_возвращается_как_есть(self):
        assert money.client_price(195_600, "cash") == 195_600

    def test_безнал_делится_а_не_умножается(self):
        # Пример из шапки money.py: 195 600 / 0,87 = 224 827,59 → вверх до 224 900.
        assert money.client_price(195_600, "bank") == 224_900

    def test_безнал_без_округления(self):
        assert money.client_price(195_600, "bank", rounded=False) == 224_827.59

    def test_транзит_не_делится(self):
        """Сумма счёта по транзиту задана. Делить её на 0,87 — второе удержание."""
        assert money.client_price(185_000, "transit") == 185_000

    def test_пустой_тип_считается_налом(self):
        assert money.client_price(1_000, "") == 1_000
        assert money.client_price(1_000, None) == 1_000

    def test_ноль_и_отрицательное_не_ломают_деление(self):
        assert money.client_price(0, "bank") == 0
        assert money.client_price(-500, "bank") == -500

    def test_процент_сто_не_делит_на_ноль(self):
        assert money.client_price(1_000, "bank", pct=100) == 1_000

    def test_свой_процент(self):
        assert money.client_price(1_000, "bank", pct=20, rounded=False) == 1_250


class TestОбратныйХод:
    def test_cash_from_client_обратен_удержанию(self):
        assert money.cash_from_client(224_900, "bank") == round(224_900 * 0.87, 2)

    def test_cash_from_client_нал_как_есть(self):
        assert money.cash_from_client(224_900, "cash") == 224_900

    def test_bank_hold_считается_от_суммы_счёта(self):
        # 13% именно от счёта, а не от цены за нал — иначе удержание занижено.
        assert money.bank_hold(224_900) == 29_237.0


class TestОкругления:
    def test_вверх_до_сотни(self):
        assert money.round_up_money(224_827.59) == 224_900
        assert money.round_up_money(224_900) == 224_900

    def test_вниз_до_сотни(self):
        assert money.round_down_money(82_563) == 82_500
        assert money.round_down_money(82_500) == 82_500

    def test_ноль_не_превращается_в_шаг(self):
        assert money.round_up_money(0) == 0
        assert money.round_down_money(0) == 0

    def test_отрицательное_не_округляется(self):
        assert money.round_up_money(-50) == -50


class TestTransitPayout:
    def test_выплата_счёт_минус_удержание_вниз(self):
        # 185 000 × 0,87 = 160 950 → вниз до 160 900.
        assert money.transit_payout(185_000) == 160_900

    def test_нулевой_счёт(self):
        assert money.transit_payout(0) == 0

    def test_процент_сто_не_обнуляет_выплату(self):
        assert money.transit_payout(1_000, pct=100) == 1_000
