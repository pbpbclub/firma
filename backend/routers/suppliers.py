from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import get_production
import sqlite3
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
        # exclude_unset: различаем «поле не прислали» и «прислали null для очистки».
        # Отсев None молча ронял бы очистку телефона/ИНН/заметки (запрос 200, значение старое).
        fields = body.model_dump(exclude_unset=True)
        if "name" in fields:
            name = (fields["name"] or "").strip()
            if not name:
                raise HTTPException(status_code=400, detail="name не может быть пустым")
            fields["name"] = name
            dup = conn.execute(
                "SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND id != ?",
                (name, supplier_id),
            ).fetchone()
            if dup:
                raise HTTPException(status_code=409, detail="Поставщик с таким названием уже есть")
        # Пустые строки в необязательных полях → NULL (не хранить "").
        for k in list(fields):
            if k != "name" and isinstance(fields[k], str) and not fields[k].strip():
                fields[k] = None
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            try:
                conn.execute(f"UPDATE suppliers SET {set_clause} WHERE id = ?", list(fields.values()) + [supplier_id])
                conn.commit()
            except sqlite3.IntegrityError:
                # страховка на гонку с UNIQUE(name): отдаём 409, а не 500
                raise HTTPException(status_code=409, detail="Поставщик с таким названием уже есть")
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
