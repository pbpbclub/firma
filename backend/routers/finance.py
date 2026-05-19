from fastapi import APIRouter, Query
from typing import Optional
from db import get_finance, get_production

router = APIRouter()

ACCOUNT_NAMES = {
    "40802810400004306154": "Т-Банк",
    "40802810113000047460": "Сбербанк",
}


@router.get("/balance")
def get_balance():
    conn = get_finance()
    try:
        rows = conn.execute(
            """
            SELECT account,
                SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) as balance
            FROM transactions
            GROUP BY account
            ORDER BY account
            """
        ).fetchall()
        accounts = [
            {**dict(r), "name": ACCOUNT_NAMES.get(r["account"], r["account"])}
            for r in rows
        ]
        total = sum(r["balance"] for r in rows)
        return {"accounts": accounts, "total": round(total, 2)}
    except Exception as e:
        return {"error": str(e), "accounts": [], "total": 0}
    finally:
        conn.close()


@router.get("/transactions")
def list_transactions(
    account: Optional[str] = None,
    direction: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(100, le=500),
):
    conn = get_finance()
    try:
        sql = "SELECT * FROM transactions WHERE 1=1"
        params = []
        if account:
            sql += " AND account = ?"
            params.append(account)
        if direction:
            sql += " AND direction = ?"
            params.append(direction)
        if date_from:
            sql += " AND date >= ?"
            params.append(date_from)
        if date_to:
            sql += " AND date <= ?"
            params.append(date_to)
        if search:
            sql += " AND (purpose LIKE ? OR counterparty LIKE ?)"
            params += [f"%{search}%"] * 2
        sql += " ORDER BY date DESC, id DESC LIMIT ?"
        params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        return {"error": str(e)}
    finally:
        conn.close()


@router.get("/summary")
def get_summary():
    conn = get_finance()
    try:
        month_data = conn.execute(
            """
            SELECT
                SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) as income,
                SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) as expense
            FROM transactions
            WHERE strftime('%Y-%m', date) = strftime('%Y-%m', 'now')
            """
        ).fetchone()

        monthly = conn.execute(
            """
            SELECT
                strftime('%Y-%m', date) as month,
                SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) as income,
                SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) as expense
            FROM transactions
            WHERE date >= date('now', '-6 months')
            GROUP BY month
            ORDER BY month
            """
        ).fetchall()

        return {
            "current_month": dict(month_data) if month_data else {},
            "monthly_chart": [dict(r) for r in monthly],
        }
    except Exception as e:
        return {"error": str(e)}
    finally:
        conn.close()


@router.get("/debtors")
def get_debtors():
    prod = get_production()
    try:
        rows = prod.execute(
            """
            SELECT
                o.number, o.title, o.status, o.deadline,
                c.name AS customer_name,
                o.price_plan,
                COALESCE(SUM(p.amount), 0) AS paid_total,
                o.price_plan - COALESCE(SUM(p.amount), 0) AS debt
            FROM orders o
            LEFT JOIN customers c ON c.id = o.customer_id
            LEFT JOIN payments p ON p.order_id = o.id
            WHERE o.status NOT IN ('cancelled', 'completed')
            GROUP BY o.id
            HAVING debt > 0
            ORDER BY debt DESC
            """
        ).fetchall()
        total_debt = sum(r["debt"] for r in rows)
        return {
            "items": [dict(r) for r in rows],
            "total": round(total_debt, 2),
        }
    finally:
        prod.close()
