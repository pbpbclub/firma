from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from db import get_finance, get_production, get_analytics
import uuid

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
    bank_rows = []
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
        bank_rows = [dict(r) for r in rows]
    except Exception as e:
        bank_rows = []
    finally:
        conn.close()

    # Merge fund transactions from production.db
    fund_rows = []
    if not account:  # fund transactions have no bank account filter
        try:
            prod = get_production()
            fsql = """
                SELECT ft.id, ft.date, ft.direction, ft.amount, ft.note,
                       f.name AS fund_name
                FROM fund_transactions ft
                JOIN funds f ON f.id = ft.fund_id
                WHERE 1=1
            """
            fparams = []
            if direction:
                fsql += " AND ft.direction = ?"
                fparams.append(direction)
            if date_from:
                fsql += " AND ft.date >= ?"
                fparams.append(date_from)
            if date_to:
                fsql += " AND ft.date <= ?"
                fparams.append(date_to)
            if search:
                fsql += " AND (ft.note LIKE ? OR f.name LIKE ?)"
                fparams += [f"%{search}%"] * 2
            fsql += " ORDER BY ft.date DESC, ft.created_at DESC LIMIT ?"
            fparams.append(limit)
            for r in prod.execute(fsql, fparams).fetchall():
                fund_rows.append({
                    "id": r["id"],
                    "date": r["date"],
                    "direction": r["direction"],
                    "amount": r["amount"],
                    "counterparty": r["note"] or "",
                    "purpose": f"Фонд: {r['fund_name']}",
                    "bank": "fund",
                    "fund_name": r["fund_name"],
                    "source": "fund",
                })
            prod.close()
        except Exception:
            pass

    all_rows = bank_rows + fund_rows
    all_rows.sort(key=lambda x: (x.get("date") or "", x.get("id") or ""), reverse=True)
    return all_rows[:limit]


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

        totals = conn.execute(
            """
            SELECT
                SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) as total_in,
                SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) as total_out
            FROM transactions
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
            "total_in": round(totals["total_in"] or 0, 2) if totals else 0,
            "total_out": round(totals["total_out"] or 0, 2) if totals else 0,
            "monthly_chart": [dict(r) for r in monthly],
        }
    except Exception as e:
        return {"error": str(e)}
    finally:
        conn.close()


@router.get("/debtors")
def get_debtors():
    prod = get_production()
    fin = get_finance()
    try:
        # Orders with at least one approved estimate_set + manual payments
        orders = prod.execute(
            """
            SELECT
                o.id, o.number, o.title, o.status, o.deadline,
                c.name AS customer_name,
                o.price_plan, o.finance_tx_id,
                COALESCE(SUM(p.amount), 0) AS paid_manual
            FROM orders o
            LEFT JOIN customers c ON c.id = o.customer_id
            LEFT JOIN payments p ON p.order_id = o.id
            WHERE o.archived = 0
              AND o.status NOT IN ('cancelled', 'completed')
              AND EXISTS (
                  SELECT 1 FROM estimate_sets es
                  WHERE es.order_id = o.id AND es.status = 'approved'
              )
            GROUP BY o.id
            ORDER BY o.price_plan DESC
            """
        ).fetchall()

        # Build Map: bank_tx_id → payment amount (from production.db payments)
        bank_tx_map: dict = {}
        try:
            prod2 = get_production()
            brows = prod2.execute("SELECT bank_tx_id, amount FROM payments WHERE bank_tx_id IS NOT NULL").fetchall()
            for br in brows:
                bank_tx_map[br["bank_tx_id"]] = bank_tx_map.get(br["bank_tx_id"], 0) + (br["amount"] or 0)
            prod2.close()
        except Exception:
            pass

        STATUS_LABELS = {
            "draft": "Черновик", "estimate": "Смета", "project": "Проект",
            "in_production": "В производстве", "completed": "Завершён", "cancelled": "Отменён",
        }

        result = []
        for r in orders:
            row = dict(r)
            paid_total = row["paid_manual"]
            debt = round((row["price_plan"] or 0) - paid_total, 2)
            row["paid_total"] = round(paid_total, 2)
            row["paid_bank"] = 0
            row["debt"] = debt
            row["status_label"] = STATUS_LABELS.get(row["status"], row["status"])
            if debt > 0:
                result.append(row)

        result.sort(key=lambda x: x["debt"], reverse=True)
        total_debt = sum(r["debt"] for r in result)
        total_plan = sum(r["price_plan"] or 0 for r in result)
        total_paid = sum(r["paid_total"] for r in result)

        return {
            "items": result,
            "total": round(total_debt, 2),
            "total_plan": round(total_plan, 2),
            "total_paid": round(total_paid, 2),
        }
    finally:
        prod.close()
        fin.close()


# ── Кредиторы (кому должны мы) ───────────────────────────────────────────────

class CreditorIn(BaseModel):
    name: str
    total: float
    paid: float = 0
    description: Optional[str] = None
    order_id: Optional[str] = None
    due_date: Optional[str] = None
    estimate_item_id: Optional[str] = None


class CreditorPatch(BaseModel):
    paid: Optional[float] = None
    total: Optional[float] = None
    description: Optional[str] = None
    status: Optional[str] = None
    due_date: Optional[str] = None
    estimate_item_id: Optional[str] = None
    finance_tx_id: Optional[str] = None
    zenmoney_tx_id: Optional[str] = None


@router.get("/creditors")
def get_creditors(status: Optional[str] = None):
    conn = get_production()
    try:
        sql = """
            SELECT c.*, ei.title AS estimate_item_title
            FROM creditors c
            LEFT JOIN estimate_items ei ON ei.id = c.estimate_item_id
            WHERE 1=1
        """
        params = []
        if status == "all":
            pass  # no filter
        elif status:
            sql += " AND c.status = ?"
            params.append(status)
        else:
            sql += " AND c.status = 'open'"
        sql += " ORDER BY c.created_at DESC"
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        for r in rows:
            r["debt"] = round(r["total"] - r["paid"], 2)
        total_owed = sum(r["total"] for r in rows)
        total_paid = sum(r["paid"] for r in rows)
        return {
            "items": rows,
            "total_owed": round(total_owed, 2),
            "total_paid": round(total_paid, 2),
            "total_debt": round(total_owed - total_paid, 2),
        }
    finally:
        conn.close()


@router.post("/creditors", status_code=201)
def create_creditor(body: CreditorIn):
    conn = get_production()
    try:
        cid = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO creditors (id, name, total, paid, description, order_id, due_date, estimate_item_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (cid, body.name, body.total, body.paid,
             body.description, body.order_id, body.due_date, body.estimate_item_id),
        )
        conn.commit()
        row = dict(conn.execute(
            """SELECT c.*, ei.title AS estimate_item_title
               FROM creditors c LEFT JOIN estimate_items ei ON ei.id = c.estimate_item_id
               WHERE c.id = ?""", (cid,)
        ).fetchone())
        row["debt"] = round(row["total"] - row["paid"], 2)
        return row
    finally:
        conn.close()


@router.patch("/creditors/{creditor_id}")
def update_creditor(creditor_id: str, body: CreditorPatch):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM creditors WHERE id = ?", (creditor_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        fields, params = [], []
        for field, val in body.model_dump(exclude_none=True).items():
            fields.append(f"{field} = ?")
            params.append(val)
        if not fields:
            return dict(row)
        params.append(creditor_id)
        conn.execute(f"UPDATE creditors SET {', '.join(fields)} WHERE id = ?", params)
        conn.commit()
        row = dict(conn.execute("SELECT * FROM creditors WHERE id = ?", (creditor_id,)).fetchone())
        row["debt"] = round(row["total"] - row["paid"], 2)
        return row
    finally:
        conn.close()


@router.delete("/creditors/{creditor_id}")
def delete_creditor(creditor_id: str):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM creditors WHERE id = ?", (creditor_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("DELETE FROM creditors WHERE id = ?", (creditor_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Suggest helpers ──────────────────────────────────────────────────────────

def _name_score(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    a_words = set(a.lower().split())
    b_words = set(b.lower().split())
    union = a_words | b_words
    if not union:
        return 0.0
    return len(a_words & b_words) / len(union)


def _amount_score(a: float, b: float) -> float:
    denom = max(a, b)
    if denom == 0:
        return 0.0
    return max(0.0, 1.0 - abs(a - b) / denom)


@router.get("/transactions/suggest")
def suggest_transactions(name: str = "", amount: float = 0, direction: str = "out", limit: int = Query(10, le=50)):
    """Suggest finance transactions for linking."""
    conn = get_finance()
    try:
        rows = conn.execute(
            "SELECT * FROM transactions WHERE direction = ? ORDER BY date DESC LIMIT 500",
            (direction,),
        ).fetchall()
        scored = []
        for r in rows:
            tx = dict(r)
            label = (tx.get("counterparty") or "") + " " + (tx.get("purpose") or "")
            ns = _name_score(name, label)
            as_ = _amount_score(amount, tx.get("amount") or 0)
            score = 0.6 * ns + 0.4 * as_
            tx["score"] = round(score, 3)
            scored.append(tx)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:limit]
    finally:
        conn.close()


@router.get("/creditors/suggest")
def suggest_creditors(counterparty: str = "", amount: float = 0, limit: int = Query(10, le=50)):
    """Suggest creditors for linking to a finance transaction."""
    conn = get_production()
    try:
        rows = conn.execute(
            "SELECT * FROM creditors WHERE status = 'open' ORDER BY created_at DESC LIMIT 200"
        ).fetchall()
        scored = []
        for r in rows:
            c = dict(r)
            ns = _name_score(counterparty, c.get("name") or "")
            as_ = _amount_score(amount, c.get("total") or 0)
            score = 0.6 * ns + 0.4 * as_
            c["score"] = round(score, 3)
            c["debt"] = round(c["total"] - c["paid"], 2)
            scored.append(c)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:limit]
    finally:
        conn.close()


# ── Receivables (кто должен нам — из вики финагента) ─────────────────────────

class ReceivableCreate(BaseModel):
    client: str
    inn: Optional[str] = None
    invoice_num: Optional[str] = None
    invoice_date: Optional[str] = None
    amount: float
    paid: float = 0
    note: Optional[str] = None


class ReceivablePatch(BaseModel):
    paid: Optional[float] = None
    note: Optional[str] = None
    finance_tx_id: Optional[str] = None


@router.get("/receivables")
def get_receivables():
    try:
        conn = get_finance()
        try:
            rows = conn.execute(
                "SELECT * FROM receivables ORDER BY invoice_date DESC"
            ).fetchall()
            items = []
            for r in rows:
                row = dict(r)
                row["debt"] = round(row["amount"] - (row["paid"] or 0), 2)
                items.append(row)
            open_items = [r for r in items if r["debt"] > 0]
            return {
                "items": items,
                "open_items": open_items,
                "total_debt": round(sum(r["debt"] for r in open_items), 2),
                "total_amount": round(sum(r["amount"] for r in items), 2),
            }
        finally:
            conn.close()
    except Exception as e:
        return {"items": [], "open_items": [], "total_debt": 0, "total_amount": 0, "error": str(e)}


@router.post("/receivables")
def create_receivable(body: ReceivableCreate):
    try:
        conn = get_finance()
        try:
            cur = conn.execute(
                """INSERT INTO receivables (client, inn, invoice_num, invoice_date, amount, paid, note, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
                (body.client, body.inn, body.invoice_num, body.invoice_date,
                 body.amount, body.paid, body.note),
            )
            conn.commit()
            row = dict(conn.execute("SELECT * FROM receivables WHERE id = ?", (cur.lastrowid,)).fetchone())
            row["debt"] = round(row["amount"] - (row["paid"] or 0), 2)
            return row
        finally:
            conn.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/receivables/{rec_id}")
def update_receivable(rec_id: int, body: ReceivablePatch):
    try:
        conn = get_finance()
        try:
            row = conn.execute("SELECT * FROM receivables WHERE id = ?", (rec_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Not found")
            fields, params = [], []
            if body.paid is not None:
                fields.append("paid = ?"); params.append(body.paid)
            if body.note is not None:
                fields.append("note = ?"); params.append(body.note)
            if "finance_tx_id" in body.model_fields_set:
                fields.append("finance_tx_id = ?"); params.append(body.finance_tx_id)
            if fields:
                params.append(rec_id)
                conn.execute(f"UPDATE receivables SET {', '.join(fields)} WHERE id = ?", params)
                conn.commit()
            row = dict(conn.execute("SELECT * FROM receivables WHERE id = ?", (rec_id,)).fetchone())
            row["debt"] = round(row["amount"] - (row["paid"] or 0), 2)
            return row
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
