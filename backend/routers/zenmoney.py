from fastapi import APIRouter, Query
from typing import Optional
from db import get_zenmoney, get_analytics, get_production
import json
import re
from datetime import datetime, timedelta

router = APIRouter()


@router.get("/accounts")
def get_accounts():
    conn = get_zenmoney()
    try:
        rows = conn.execute(
            "SELECT id, title, type, balance FROM zm_accounts WHERE archive=0 ORDER BY balance DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/transactions")
def get_transactions(
    month: Optional[str] = None,
    account: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(200, le=1000),
):
    conn = get_zenmoney()
    try:
        sql = "SELECT * FROM zm_transactions WHERE deleted=0"
        params = []

        if month:
            y, m = int(month[:4]), int(month[5:7])
            m2, y2 = (m + 1, y) if m < 12 else (1, y + 1)
            sql += " AND date >= ? AND date < ?"
            params += [f"{month}-01", f"{y2}-{m2:02d}-01"]

        if account:
            sql += " AND (outcome_account LIKE ? OR income_account LIKE ?)"
            params += [f"%{account}%", f"%{account}%"]

        if search:
            sql += " AND (payee LIKE ? OR comment LIKE ? OR tags LIKE ?)"
            params += [f"%{search}%"] * 3

        sql += " ORDER BY date DESC LIMIT ?"
        params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d.get("tags") or "[]")
            result.append(d)
        return result
    finally:
        conn.close()


@router.get("/report")
def get_report(month: Optional[str] = None):
    """Расходы по категориям за месяц."""
    conn = get_zenmoney()
    try:
        from datetime import datetime
        month = month or datetime.now().strftime("%Y-%m")
        y, m = int(month[:4]), int(month[5:7])
        m2, y2 = (m + 1, y) if m < 12 else (1, y + 1)
        date_from, date_to = f"{month}-01", f"{y2}-{m2:02d}-01"

        # Расходы по категориям
        expense_rows = conn.execute("""
            SELECT tags, SUM(outcome) as total, COUNT(*) as cnt
            FROM zm_transactions
            WHERE date >= ? AND date < ? AND deleted=0 AND outcome > 0 AND income=0
            GROUP BY tags ORDER BY total DESC
        """, (date_from, date_to)).fetchall()

        # Итоги
        totals = conn.execute("""
            SELECT
                SUM(CASE WHEN outcome > 0 AND income=0 THEN outcome ELSE 0 END) as expenses,
                SUM(CASE WHEN income > 0 AND outcome=0 THEN income ELSE 0 END) as incomes,
                SUM(CASE WHEN income > 0 AND outcome > 0 THEN outcome ELSE 0 END) as transfers
            FROM zm_transactions
            WHERE date >= ? AND date < ? AND deleted=0
        """, (date_from, date_to)).fetchone()

        categories = []
        for r in expense_rows:
            tags = json.loads(r["tags"] or "[]")
            categories.append({
                "category": tags[0] if tags else "Без категории",
                "total": round(r["total"], 2),
                "count": r["cnt"],
            })

        return {
            "month": month,
            "expenses": round(totals["expenses"] or 0, 2),
            "incomes": round(totals["incomes"] or 0, 2),
            "transfers": round(totals["transfers"] or 0, 2),
            "categories": categories,
        }
    finally:
        conn.close()


@router.get("/cashflow")
def get_cashflow(months: int = Query(6, le=24)):
    """ДДС по месяцам — для графика."""
    conn = get_zenmoney()
    try:
        rows = conn.execute("""
            SELECT
                strftime('%Y-%m', date) as month,
                SUM(CASE WHEN outcome > 0 AND income=0 THEN outcome ELSE 0 END) as expenses,
                SUM(CASE WHEN income > 0 AND outcome=0 THEN income ELSE 0 END) as incomes
            FROM zm_transactions
            WHERE deleted=0
            GROUP BY month
            ORDER BY month DESC
            LIMIT ?
        """, (months,)).fetchall()
        return list(reversed([dict(r) for r in rows]))
    finally:
        conn.close()


@router.get("/business")
def get_business_transactions(months: int = Query(3, le=12)):
    """Транзакции с личных карт, связанные с бизнесом (подрядчики + ИП)."""
    # Collect name tokens from creditors and contractors
    known: dict[str, str] = {}
    SKIP = {"ооо", "ип", "ао", "нкп", "фио", "зао", "пао"}

    def _add_name(name: str):
        for token in re.findall(r"[А-Яа-яЁё]{3,}", name):
            if token.lower() not in SKIP:
                known[token.lower()] = name

    try:
        prod = get_production()
        try:
            for row in prod.execute("SELECT name FROM creditors").fetchall():
                _add_name(row["name"])
        finally:
            prod.close()
    except Exception:
        pass

    try:
        aconn = get_analytics()
        try:
            for row in aconn.execute("SELECT name FROM contractors").fetchall():
                _add_name(row["name"])
        finally:
            aconn.close()
    except Exception:
        pass

    conn = get_zenmoney()
    try:
        date_from = (datetime.now() - timedelta(days=30 * months)).strftime("%Y-%m-%d")
        rows = conn.execute(
            "SELECT * FROM zm_transactions WHERE deleted=0 AND date >= ? ORDER BY date DESC",
            (date_from,),
        ).fetchall()

        result = []
        for r in rows:
            d = dict(r)
            if d.get("income", 0) > 0 and d.get("outcome", 0) > 0:
                continue  # skip transfers
            search_text = ((d.get("payee") or "") + " " + (d.get("comment") or "")).lower()
            matched = None
            for token, name in known.items():
                if token in search_text:
                    matched = name
                    break
            is_biz_income = any(kw in search_text for kw in ["некрасов", "pbpb", "пбпб"])
            if matched or is_biz_income:
                d["tags"] = json.loads(d.get("tags") or "[]")
                d["matched_contractor"] = matched
                d["is_business_income"] = is_biz_income
                result.append(d)

        return result
    finally:
        conn.close()
