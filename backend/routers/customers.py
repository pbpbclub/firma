from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, EmailStr
from typing import Optional
from uuid import uuid4
from db import get_production, get_finance
import os
import httpx

router = APIRouter()

_FIN_AGENT_ENV = "/opt/fin-agent/.env"


def _dadata_token() -> str:
    """DADATA_TOKEN from process env or fin-agent .env."""
    token = os.getenv("DADATA_TOKEN", "")
    if token:
        return token
    try:
        with open(_FIN_AGENT_ENV) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DADATA_TOKEN") and "=" in line:
                    return line.partition("=")[2].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""

class CustomerCreateRequest(BaseModel):
    name: str
    full_name: Optional[str] = None
    inn: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    contact: Optional[str] = None
    telegram: Optional[str] = None
    instagram: Optional[str] = None
    whatsapp: Optional[str] = None
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
    email: Optional[str] = None
    contact: Optional[str] = None
    telegram: Optional[str] = None
    instagram: Optional[str] = None
    whatsapp: Optional[str] = None
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


@router.get("/lookup-inn")
def lookup_inn(inn: str):
    token = _dadata_token()
    if not token:
        raise HTTPException(status_code=503, detail="DADATA_TOKEN not configured")
    inn = (inn or "").strip()
    if not inn:
        raise HTTPException(status_code=400, detail="inn required")
    try:
        r = httpx.post(
            "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party",
            json={"query": inn},
            headers={"Authorization": f"Token {token}", "Accept": "application/json"},
            timeout=10,
        )
        r.raise_for_status()
        suggestions = r.json().get("suggestions", [])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DaData error: {e}")
    if not suggestions:
        return {"found": False}
    d = suggestions[0]
    data = d.get("data", {}) or {}
    name_obj = data.get("name") or {}
    mgmt = data.get("management") or {}
    addr = (data.get("address") or {}).get("value")
    return {
        "found": True,
        "name": d.get("value"),
        "full_name": name_obj.get("full_with_opf"),
        "inn": data.get("inn"),
        "kpp": data.get("kpp"),
        "contact": mgmt.get("name"),
        "notes": addr,
    }


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
        data = {k: v for k, v in payload.model_dump().items() if v is not None}
        data["id"] = customer_id
        cols = ", ".join(data.keys())
        placeholders = ", ".join("?" * len(data))
        conn.execute(
            f"INSERT INTO customers ({cols}) VALUES ({placeholders})",
            tuple(data.values()),
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
