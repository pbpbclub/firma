"""Денежные формулы Firma. Одно место на весь проект — раньше расчёт безнала был
скопирован в пяти местах (смета, costing, счёт, редактор, карточка заказа) и разъезжался.

Правило Юры (27.07.2026): «Я называю сумму за нал. Если оплачивать будут по безналу —
из суммы счёта по безналу я удержу 13%». То есть 13% удерживаются ИЗ суммы счёта,
а не накручиваются на цену нала:

    цена за нал:      195 600 ₽
    безнал:           195 600 / 0.87 = 224 827,59 ₽
    округление вверх: 224 900 ₽              ← сумма счёта
    удержание 13%:    224 900 × 0.13 = 29 237 ₽

Порядок расчёта зафиксирован: цена позиции (нал) → скидка → при безнале ÷ (1 − pct/100)
→ округление вверх до 100 ₽ → сумма счёта.
"""

import math

ROUND_STEP = 100        # шаг округления итогов, ₽ — «я не большая розница, чтобы 99,99»
DEFAULT_BANK_PCT = 13.0
# Удержание банка — свойство СМЕТЫ, а не отдельной позиции: Юра договаривается об
# одном проценте на счёт. Позиционный bank_pct в данных оказался мусором (в MIRRA
# от −53% до +66% — туда писали разницу цены, а не процент), поэтому в расчёте он не
# участвует. Поле осталось в схеме; расхождения с процентом сметы показывает
# вкладка «Готовность», чтобы Юра решил, что с ними делать.


def round_up_money(amount: float, step: int = ROUND_STEP) -> float:
    """Округление вверх до шага (по умолчанию 100 ₽) — всегда в пользу Юры.
    224 827,59 → 224 900. Ноль и отрицательные не трогаем."""
    if not amount or amount <= 0:
        return round(amount or 0, 2)
    return float(math.ceil(amount / step) * step)


def client_price(sale: float, payment_type: str, pct: float | None = None,
                 rounded: bool = True) -> float:
    """Сумма к оплате клиентом. Для нала — цена как есть; для безнала — цена, из которой
    после удержания pct% останется исходная сумма (делим, а не умножаем).

    rounded=False — без округления до 100 ₽ (нужно для промежуточных расчётов,
    например цены за единицу внутри позиции)."""
    sale = sale or 0
    if (payment_type or "cash") != "bank" or sale <= 0:
        return round(sale, 2)
    p = DEFAULT_BANK_PCT if pct is None else pct
    if p >= 100:                      # защита от деления на ноль/отрицательного
        return round(sale, 2)
    gross = sale / (1 - p / 100)
    return round_up_money(gross) if rounded else round(gross, 2)


def cash_from_client(client_total: float, payment_type: str, pct: float | None = None) -> float:
    """Обратная операция: из суммы счёта получить цену «как за нал».
    Нужна там, где Юра правит колонку «К оплате» руками."""
    client_total = client_total or 0
    if (payment_type or "cash") != "bank" or client_total <= 0:
        return round(client_total, 2)
    p = DEFAULT_BANK_PCT if pct is None else pct
    return round(client_total * (1 - p / 100), 2)


def bank_hold(client_total: float, pct: float | None = None) -> float:
    """Сколько удерживается из суммы безналичного счёта (13% от неё)."""
    p = DEFAULT_BANK_PCT if pct is None else pct
    return round((client_total or 0) * p / 100, 2)
