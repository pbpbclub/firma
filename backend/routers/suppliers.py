from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import get_production
import uuid

router = APIRouter()


class SupplierCreate(BaseModel):
    name: str
    full_name: Optional[str] = None
    inn: Optional[str] = None
    category: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    contact: Optional[str] = None
    telegram: Optional[str] = None
    website: Optional[str] = None
    price_supplier: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None


class SupplierUpdate(BaseModel):
    name: Optional[str] = None
    full_name: Optional[str] = None
    inn: Optional[str] = None
    category: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    contact: Optional[str] = None
    telegram: Optional[str] = None
    website: Optional[str] = None
    price_supplier: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None
    sort_order: Optional[int] = None


@router.get("")
def list_suppliers():
    conn = get_production()
    try:
        rows = conn.execute("SELECT * FROM suppliers ORDER BY sort_order, name").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("")
def create_supplier(body: SupplierCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    conn = get_production()
    try:
        existing = conn.execute("SELECT * FROM suppliers WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if existing:
            return dict(existing)
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM suppliers").fetchone()[0]
        data = {k: v for k, v in body.model_dump().items() if v is not None}
        data["id"] = str(uuid.uuid4())
        data["name"] = name
        data["sort_order"] = max_order + 1
        cols = ", ".join(data.keys())
        ph = ", ".join("?" * len(data))
        conn.execute(f"INSERT INTO suppliers ({cols}) VALUES ({ph})", tuple(data.values()))
        conn.commit()
        return dict(conn.execute("SELECT * FROM suppliers WHERE id = ?", (data["id"],)).fetchone())
    finally:
        conn.close()


@router.patch("/{supplier_id}")
def update_supplier(supplier_id: str, body: SupplierUpdate):
    conn = get_production()
    try:
        existing = conn.execute("SELECT * FROM suppliers WHERE id = ?", (supplier_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Not found")
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE suppliers SET {set_clause} WHERE id = ?", list(fields.values()) + [supplier_id])
            conn.commit()
        return dict(conn.execute("SELECT * FROM suppliers WHERE id = ?", (supplier_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/{supplier_id}")
def delete_supplier(supplier_id: str):
    conn = get_production()
    try:
        conn.execute("DELETE FROM suppliers WHERE id = ?", (supplier_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
