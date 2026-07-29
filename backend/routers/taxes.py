from fastapi import APIRouter
from db import get_finance
from datetime import datetime

router = APIRouter()

INSURANCE_FIXED_2025 = 53_658  # фиксированная часть страховых взносов 2025

# ── Признак платежа в налоговую («контрагент-налоговая», решение Юры 24.07.2026) ──
# Матчим по контрагенту (ФНС/Казначейство России) и назначению (ЕНП/Единый налоговый).
# НЕ матчить по подстроке «налог»: она ловит переводы самому Юре («…налог» в назначении).
# SQL- и Python-версии держать согласованными; используется здесь (факт оплат),
# в expenses.py (авто-исключение из Разноски) и в finance.py (бейдж «налог» в ДДС).
TAX_TX_SQL = ("(counterparty LIKE '%ФНС%' OR counterparty LIKE '%Казначейство России%'"
              " OR purpose LIKE '%ЕНП%' OR purpose LIKE '%Единый налоговый%')")


def is_tax_tx(counterparty, purpose) -> bool:
    c = counterparty or ""
    p = purpose or ""
    return ("ФНС" in c or "Казначейство России" in c
            or "ЕНП" in p or "Единый налоговый" in p)


def current_quarter():
    m = datetime.now().month
    return (m - 1) // 3 + 1


@router.get("/summary")
def tax_summary():
    conn = get_finance()
    try:
        year = datetime.now().year
        quarter = current_quarter()

        # Доходы за текущий год — ТОЛЬКО поступления. В finance.db суммы
        # положительны у обеих ног (direction различает in/out), поэтому фильтр
        # amount > 0 без direction считал доходом и списания: база УСН за 2026
        # удваивалась (8,47 млн вместо 4,23 млн), фантомный налог +254 тыс.
        income_year = conn.execute(
            """
            SELECT COALESCE(SUM(amount), 0) as total
            FROM transactions
            WHERE strftime('%Y', date) = ? AND direction = 'in' AND amount > 0
            """,
            (str(year),),
        ).fetchone()["total"]

        # Доходы за текущий квартал
        q_start_month = (quarter - 1) * 3 + 1
        q_start = f"{year}-{q_start_month:02d}-01"
        income_quarter = conn.execute(
            """
            SELECT COALESCE(SUM(amount), 0) as total
            FROM transactions
            WHERE date >= ? AND strftime('%Y', date) = ? AND direction = 'in' AND amount > 0
            """,
            (q_start, str(year)),
        ).fetchone()["total"]

        # Уплаченные страховые взносы
        insurance_paid = 0
        try:
            insurance_paid = conn.execute(
                "SELECT COALESCE(SUM(amount), 0) as total FROM insurance_payments WHERE year = ?",
                (year,),
            ).fetchone()["total"]
        except Exception:
            pass

        # УСН 6%
        tax_year = round(income_year * 0.06, 2)
        tax_quarter = round(income_quarter * 0.06, 2)
        insurance_deduction = min(insurance_paid, tax_year)
        tax_to_pay = max(0, tax_quarter - insurance_deduction)

        # Дедлайн текущего квартала
        deadlines = {1: f"{year}-04-28", 2: f"{year}-07-28", 3: f"{year}-10-28", 4: f"{year+1}-04-28"}
        deadline = deadlines[quarter]

        # Фактические оплаты в ФНС (авто-распознанные банковские платежи).
        tax_paid_year = conn.execute(
            f"""SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
                WHERE direction = 'out' AND strftime('%Y', date) = ? AND {TAX_TX_SQL}""",
            (str(year),),
        ).fetchone()["total"]
        pay_rows = conn.execute(
            f"""SELECT id, date, amount, counterparty, purpose, bank FROM transactions
                WHERE direction = 'out' AND {TAX_TX_SQL}
                ORDER BY date DESC, id DESC"""
        ).fetchall()
        tax_payments = [dict(r) for r in pay_rows]
        tax_paid_total = round(sum(r["amount"] for r in tax_payments), 2)

        return {
            "year": year,
            "quarter": quarter,
            "income_year": round(income_year, 2),
            "income_quarter": round(income_quarter, 2),
            "tax_rate": 0.06,
            "tax_year": tax_year,
            "tax_quarter": tax_quarter,
            "insurance_fixed": INSURANCE_FIXED_2025,
            "insurance_paid": insurance_paid,
            "insurance_deduction": insurance_deduction,
            "tax_to_pay": tax_to_pay,
            "deadline": deadline,
            "tax_paid_year": round(tax_paid_year, 2),
            "tax_paid_total": tax_paid_total,
            "tax_payments": tax_payments,
        }
    finally:
        conn.close()
