from fastapi import APIRouter
from db import get_finance
from datetime import datetime

router = APIRouter()

INSURANCE_FIXED_2025 = 53_658  # фиксированная часть страховых взносов 2025


def current_quarter():
    m = datetime.now().month
    return (m - 1) // 3 + 1


@router.get("/summary")
def tax_summary():
    conn = get_finance()
    try:
        year = datetime.now().year
        quarter = current_quarter()

        # Доходы за текущий год (только входящие транзакции)
        income_year = conn.execute(
            """
            SELECT COALESCE(SUM(amount), 0) as total
            FROM transactions
            WHERE strftime('%Y', date) = ? AND amount > 0
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
            WHERE date >= ? AND strftime('%Y', date) = ? AND amount > 0
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
        }
    finally:
        conn.close()
