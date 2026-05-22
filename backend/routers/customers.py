from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, EmailStr
from typing import Optional
from uuid import uuid4
from db import get_production, get_finance

router = APIRouter()

class CustomerCreateRequest(BaseModel):
    name: str
    full_name: Optional[str] = None
    inn: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[EmailStr] = None
    contact: Optional[str] = None
    notes: Optional[str] = None
    wiki_ref: Optional[str] = None
    finagent_ref: Optional[str] = None
    source: Optional[str] = None
    status: Optional[str] = None


class CustomerUpdateRequest(BaseModel):
    name: Optional[str] = None
    full_name: Optional[str] = None
    inn: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[EmailStr] = None
    contact: Optional[str] = None
    notes: Optional[str] = None
    wiki_ref: Optional[str] = None
    finagent_ref: Optional[str] = None
    source: Optional[str] = None
    status: Optional[str] = None


@router.get("")
def list_customers(
    search: Optional[str] = None,
    limit: int = Query(100, le=500),
):
    conn = get_production()
    try:
        sql = "SELECT * FROM customers WHERE 1=1"
        params = []
        if search:
            sql += " AND (name LIKE ? OR full_name LIKE ? OR phone LIKE ? OR email LIKE ? OR inn LIKE ? OR contact LIKE ? OR wiki_ref LIKE ? OR finagent_ref LIKE ?)"
            params += [f"%{search}%"] * 8
        sql += " ORDER BY name LIMIT ?"
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/{customer_id}")
def get_customer(customer_id: str):
    prod = get_production()
    try:
        customer = prod.execute("SELECT * FROM customers WHERE id = ?", (customer_id,)).fetchone()
        if not customer:
            raise HTTPException(status_code=404, detail="Customer not found")
        customer = dict(customer)

        orders = prod.execute(
            """
            SELECT o.id, o.number, o.title, o.status, o.deadline, o.price_plan, o.cost_plan,
                COALESCE(SUM(p.amount), 0) AS paid_total,
                o.price_plan - COALESCE(SUM(p.amount), 0) AS debt
            FROM orders o
            LEFT JOIN payments p ON p.order_id = o.id
            WHERE o.customer_id = ?
            GROUP BY o.id
            ORDER BY o.created_at DESC
            """,
            (customer_id,),
        ).fetchall()
        orders = [dict(r) for r in orders]
        order_refs = [r["number"] for r in orders if r["number"]]
    finally:
        prod.close()

    finance = get_finance()
    try:
        conditions = []
        params = []
        if customer["name"]:
            conditions.append("(counterparty LIKE ? OR purpose LIKE ?)")
            params.extend([f"%{customer['name']}%", f"%{customer['name']}%"])
        if not conditions:
            transactions = []
        else:
            sql = "SELECT * FROM transactions WHERE " + " OR ".join(conditions) + " ORDER BY date DESC LIMIT 100"
            transactions = [dict(r) for r in finance.execute(sql, params).fetchall()]

        income = sum(r["amount"] for r in transactions if r["direction"] == "in")
        expense = sum(r["amount"] for r in transactions if r["direction"] == "out")
        balance = income - expense
        summary = {
            "count": len(transactions),
            "income": round(income, 2),
            "expense": round(expense, 2),
            "balance": round(balance, 2),
        }
    finally:
        finance.close()

    return {
        "customer": customer,
        "orders": orders,
        "transactions": transactions,
        "transaction_summary": summary,
    }


@router.post("")
def create_customer(payload: CustomerCreateRequest):
    conn = get_production()
    try:
        customer_id = str(uuid4())
        conn.execute(
            "INSERT INTO customers (id, name, full_name, inn, phone, email, contact, notes, wiki_ref, finagent_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                customer_id,
                payload.name,
                payload.full_name,
                payload.inn,
                payload.phone,
                payload.email,
                payload.contact,
                payload.notes,
                payload.wiki_ref,
                payload.finagent_ref,
            ),
        )
        conn.commit()
        return {"id": customer_id}
    finally:
        conn.close()


@router.delete("/{customer_id}")
def delete_customer(customer_id: str):
    conn = get_production()
    try:
        existing = conn.execute("SELECT id FROM customers WHERE id = ?", (customer_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Customer not found")
        conn.execute("DELETE FROM customers WHERE id = ?", (customer_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.put("/{customer_id}")
def update_customer(customer_id: str, payload: CustomerUpdateRequest):
    conn = get_production()
    try:
        existing = conn.execute("SELECT id FROM customers WHERE id = ?", (customer_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Customer not found")
        updates = []
        params = []
        for field in payload.__fields_set__:
            updates.append(f"{field} = ?")
            params.append(getattr(payload, field))
        if not updates:
            return {"ok": True}
        params.append(customer_id)
        conn.execute(f"UPDATE customers SET {', '.join(updates)} WHERE id = ?", tuple(params))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
