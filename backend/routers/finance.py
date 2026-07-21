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
    """Текущий остаток = реальные балансы от банка (account_balances), а не разница по транзакциям."""
    conn = get_finance()
    try:
        accounts = []
        for acc, name in ACCOUNT_NAMES.items():
            row = conn.execute(
                "SELECT balance FROM account_balances WHERE account=? ORDER BY updated_at DESC LIMIT 1",
                (acc,),
            ).fetchone()
            bal = round(row["balance"], 2) if row else 0.0
            accounts.append({"account": acc, "name": name, "balance": bal})
        total = round(sum(a["balance"] for a in accounts), 2)
        return {"accounts": accounts, "total": total}
    except Exception as e:
        return {"error": str(e), "accounts": [], "total": 0}
    finally:
        conn.close()


@router.get("/free-cash")
def get_free_cash():
    """Свободные деньги = остаток по счетам − активные резервы заказов − балансы фондов.

    Ключевая цифра ТЗ-1: сколько денег реально мои, а сколько уже отложено (под
    материалы заказов, налоги, зарплату). Уходит в минус — кассовый разрыв виден сразу."""
    # Остаток — из finance.db
    fin = get_finance()
    try:
        balance = 0.0
        for acc in ACCOUNT_NAMES:
            row = fin.execute(
                "SELECT balance FROM account_balances WHERE account=? ORDER BY updated_at DESC LIMIT 1",
                (acc,),
            ).fetchone()
            balance += row["balance"] if row else 0.0
        balance = round(balance, 2)
    finally:
        fin.close()

    # Резервы и фонды — из production.db
    prod = get_production()
    try:
        reserves = [
            {"order_id": r["id"], "number": r["number"], "title": r["title"],
             "amount": round(r["reserved_amount"], 2)}
            for r in prod.execute(
                """SELECT id, number, title, reserved_amount FROM orders
                   WHERE reserved_amount > 0 AND reserve_released_at IS NULL AND status != 'cancelled'
                   ORDER BY reserved_amount DESC"""
            ).fetchall()
        ]
        reserved_total = round(sum(x["amount"] for x in reserves), 2)

        funds = [
            {"name": f["name"], "balance": round(f["balance"] or 0, 2)}
            for f in prod.execute(
                """SELECT fu.name,
                          COALESCE(SUM(CASE WHEN ft.direction='in' THEN ft.amount ELSE -ft.amount END), 0) AS balance
                   FROM funds fu LEFT JOIN fund_transactions ft ON ft.fund_id = fu.id
                   GROUP BY fu.id ORDER BY fu.created_at"""
            ).fetchall()
        ]
        funds_total = round(sum(x["balance"] for x in funds), 2)
    finally:
        prod.close()

    free = round(balance - reserved_total - funds_total, 2)
    return {
        "balance": balance,
        "reserved_total": reserved_total,
        "funds_total": funds_total,
        "free": free,
        "negative": free < 0,
        "reserves": reserves,
        "funds": funds,
    }


def _valid_date(date: str) -> bool:
    try:
        from datetime import datetime
        datetime.strptime(date, "%Y-%m-%d")
        return True
    except (ValueError, TypeError):
        return False


@router.get("/balance-at-date")
def get_balance_at_date(date: str):
    """Остаток на дату D (включительно) = реальный остаток − движения ПОСЛЕ D."""
    if not _valid_date(date):
        raise HTTPException(status_code=400, detail="date должна быть в формате YYYY-MM-DD")
    conn = get_finance()
    try:
        accounts = []
        for acc, name in ACCOUNT_NAMES.items():
            row = conn.execute(
                "SELECT balance FROM account_balances WHERE account=? ORDER BY updated_at DESC LIMIT 1",
                (acc,),
            ).fetchone()
            current = row["balance"] if row else 0.0
            after = conn.execute(
                """
                SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0) AS s
                FROM transactions WHERE account=? AND date > ?
                """,
                (acc, date),
            ).fetchone()["s"]
            accounts.append({"account": acc, "name": name, "balance": round(current - after, 2)})
        total = round(sum(a["balance"] for a in accounts), 2)
        return {"accounts": accounts, "total": total, "date": date}
    except HTTPException:
        raise
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


@router.get("/by-brand")
def finance_by_brand():
    """Доход/расход/прибыль по брендам (через заказы)."""
    conn = get_production()
    try:
        NO_BRAND = "Без бренда"
        agg: dict = {}

        def slot(brand):
            b = brand or NO_BRAND
            if b not in agg:
                agg[b] = {"brand": b, "income": 0.0, "expense": 0.0,
                          "price_plan": 0.0, "cost_plan": 0.0, "orders_count": 0}
            return agg[b]

        # порядок/цвета брендов
        brand_meta = {}
        try:
            for r in conn.execute("SELECT name, color FROM brands ORDER BY sort_order, name").fetchall():
                brand_meta[r["name"]] = r["color"]
                slot(r["name"])  # показывать даже бренды без движений
        except Exception:
            pass

        # доход: платежи → заказ → бренд
        for r in conn.execute(
            """SELECT o.brand AS brand, COALESCE(SUM(p.amount),0) AS s
               FROM payments p JOIN orders o ON o.id = p.order_id
               GROUP BY o.brand""").fetchall():
            slot(r["brand"])["income"] += r["s"] or 0

        # расход: факт заказа = expenses + НЕпокрытые ими обязательства.
        # Раньше считались только creditors.paid — ручные/разнесённые расходы
        # без обязательства в брендовый P&L не попадали вовсе.
        # Дедуп тот же, что в orders._plan_fact (инвариант «одна оплата = один факт»).
        for r in conn.execute(
            """SELECT o.brand AS brand, COALESCE(SUM(e.amount),0) AS s
               FROM expenses e JOIN orders o ON o.id = e.order_id
               GROUP BY o.brand""").fetchall():
            slot(r["brand"])["expense"] += r["s"] or 0
        for r in conn.execute(
            """SELECT o.brand AS brand, COALESCE(SUM(c.paid),0) AS s
               FROM creditors c JOIN orders o ON o.id = c.order_id
               WHERE NOT EXISTS (
                 SELECT 1 FROM expenses e WHERE e.order_id = c.order_id AND (
                      e.creditor_id = c.id
                   OR (e.finance_tx_id  IS NOT NULL AND e.finance_tx_id  = c.finance_tx_id)
                   OR (e.zenmoney_tx_id IS NOT NULL AND e.zenmoney_tx_id = c.zenmoney_tx_id)))
               GROUP BY o.brand""").fetchall():
            slot(r["brand"])["expense"] += r["s"] or 0

        # план по заказам
        for r in conn.execute(
            """SELECT brand, COALESCE(SUM(price_plan),0) AS pp, COALESCE(SUM(cost_plan),0) AS cp,
                      COUNT(*) AS cnt
               FROM orders WHERE archived = 0 GROUP BY brand""").fetchall():
            s = slot(r["brand"])
            s["price_plan"] += r["pp"] or 0
            s["cost_plan"] += r["cp"] or 0
            s["orders_count"] += r["cnt"] or 0

        result = []
        for b, v in agg.items():
            v["profit"] = round(v["income"] - v["expense"], 2)
            v["income"] = round(v["income"], 2)
            v["expense"] = round(v["expense"], 2)
            v["price_plan"] = round(v["price_plan"], 2)
            v["cost_plan"] = round(v["cost_plan"], 2)
            v["color"] = brand_meta.get(b)
            result.append(v)
        # бренды с движением/планом вперёд, «Без бренда» в конец
        result.sort(key=lambda x: (x["brand"] == NO_BRAND, -(x["income"] + x["price_plan"])))
        return result
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
            pass  # без фильтров: ДДС сопоставляет транзакции со ВСЕМИ обязательствами, вкл. постоянные
        elif status:
            sql += " AND c.status = ? AND (c.kind IS NULL OR c.kind != 'fixed')"
            params.append(status)
        else:
            # kind='fixed' живут во вкладке «Постоянные» — в «Мы должны» не показываем
            sql += " AND c.status = 'open' AND (c.kind IS NULL OR c.kind != 'fixed')"
        sql += " ORDER BY c.created_at DESC"
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        for r in rows:
            r["debt"] = round(r["total"] - r["paid"], 2)
            plan = r.get("amount_plan")
            if plan is not None and r["paid"] > 0:
                r["variance"] = round(r["paid"] - plan, 2)
            else:
                r["variance"] = None
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


# ── Постоянные обязательства (шаблоны + месячные экземпляры в creditors) ─────

class FixedObligationIn(BaseModel):
    name: str
    amount: float
    pay_day: Optional[int] = None
    note: Optional[str] = None


class FixedObligationPatch(BaseModel):
    name: Optional[str] = None
    amount: Optional[float] = None
    pay_day: Optional[int] = None
    note: Optional[str] = None
    active: Optional[int] = None


def _current_month() -> str:
    from datetime import date
    return date.today().strftime("%Y-%m")


@router.get("/fixed-obligations")
def list_fixed_obligations(month: Optional[str] = None):
    """Шаблоны постоянных расходов + состояние оплаты за месяц.

    Экземпляры до-создаются в creditors (kind='fixed', period=месяц) при первом
    обращении за месяц — гасятся обычной механикой (PATCH /creditors/{id})."""
    month = month or _current_month()
    import re as _re
    if not _re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise HTTPException(status_code=400, detail="month должен быть в формате YYYY-MM")
    conn = get_production()
    try:
        templates = [dict(r) for r in conn.execute(
            "SELECT * FROM fixed_obligations ORDER BY COALESCE(pay_day, 99), name"
        ).fetchall()]

        # До-создаём экземпляры за месяц для активных шаблонов
        for t in templates:
            if not t["active"]:
                continue
            exists = conn.execute(
                "SELECT id FROM creditors WHERE fixed_id = ? AND period = ?",
                (t["id"], month),
            ).fetchone()
            if not exists:
                day = min(max(int(t["pay_day"] or 1), 1), 28)
                conn.execute(
                    """INSERT INTO creditors (id, name, total, paid, description, due_date,
                                              status, kind, period, fixed_id)
                       VALUES (?, ?, ?, 0, ?, ?, 'open', 'fixed', ?, ?)""",
                    (str(uuid.uuid4()), t["name"], t["amount"], t["note"],
                     f"{month}-{day:02d}", month, t["id"]),
                )
        conn.commit()

        items = []
        for t in templates:
            inst = conn.execute(
                "SELECT id, total, paid, status, due_date, finance_tx_id, zenmoney_tx_id "
                "FROM creditors WHERE fixed_id = ? AND period = ?",
                (t["id"], month),
            ).fetchone()
            row = {**t, "creditor_id": None, "month_total": None, "paid": 0.0,
                   "debt": None, "status": None, "due_date": None,
                   "finance_tx_id": None, "zenmoney_tx_id": None}
            if inst:
                row.update({
                    "creditor_id": inst["id"],
                    "month_total": inst["total"],
                    "paid": inst["paid"],
                    "debt": round(inst["total"] - inst["paid"], 2),
                    "status": inst["status"],
                    "due_date": inst["due_date"],
                    "finance_tx_id": inst["finance_tx_id"],
                    "zenmoney_tx_id": inst["zenmoney_tx_id"],
                })
            items.append(row)

        act = [i for i in items if i["creditor_id"]]
        plan_month = sum(i["month_total"] or 0 for i in act)
        paid_month = sum(i["paid"] or 0 for i in act)
        return {
            "month": month,
            "items": items,
            "totals": {
                "plan_month": round(plan_month, 2),
                "paid_month": round(paid_month, 2),
                "debt_month": round(plan_month - paid_month, 2),
            },
        }
    finally:
        conn.close()


@router.post("/fixed-obligations", status_code=201)
def create_fixed_obligation(body: FixedObligationIn):
    conn = get_production()
    try:
        fid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO fixed_obligations (id, name, amount, pay_day, note) VALUES (?, ?, ?, ?, ?)",
            (fid, body.name, body.amount, body.pay_day, body.note),
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM fixed_obligations WHERE id = ?", (fid,)).fetchone())
    finally:
        conn.close()


@router.patch("/fixed-obligations/{fixed_id}")
def update_fixed_obligation(fixed_id: str, body: FixedObligationPatch):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM fixed_obligations WHERE id = ?", (fixed_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Not found")
        fields, params = [], []
        for field, val in body.model_dump(exclude_none=True).items():
            fields.append(f"{field} = ?")
            params.append(val)
        if fields:
            params.append(fixed_id)
            conn.execute(f"UPDATE fixed_obligations SET {', '.join(fields)} WHERE id = ?", params)
            conn.commit()
        return dict(conn.execute("SELECT * FROM fixed_obligations WHERE id = ?", (fixed_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/fixed-obligations/{fixed_id}")
def delete_fixed_obligation(fixed_id: str):
    """Удаляет шаблон; прошлые месячные экземпляры (история оплат) остаются."""
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM fixed_obligations WHERE id = ?", (fixed_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("DELETE FROM fixed_obligations WHERE id = ?", (fixed_id,))
        # Неоплаченный экземпляр ТЕКУЩЕГО месяца убираем, чтобы не висел мусор
        conn.execute(
            "DELETE FROM creditors WHERE fixed_id = ? AND period = ? AND paid = 0",
            (fixed_id, _current_month()),
        )
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
