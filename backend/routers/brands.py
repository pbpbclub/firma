from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import get_production
import uuid

router = APIRouter()


class BrandCreate(BaseModel):
    name: str
    color: Optional[str] = None
    full_name: Optional[str] = None
    inn: Optional[str] = None
    account: Optional[str] = None
    description: Optional[str] = None
    positioning: Optional[str] = None
    notes: Optional[str] = None


class BrandUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    full_name: Optional[str] = None
    inn: Optional[str] = None
    account: Optional[str] = None
    description: Optional[str] = None
    positioning: Optional[str] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None


@router.get("")
def list_brands():
    conn = get_production()
    try:
        rows = conn.execute("SELECT * FROM brands ORDER BY sort_order, name").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("")
def create_brand(body: BrandCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    conn = get_production()
    try:
        existing = conn.execute("SELECT * FROM brands WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if existing:
            return dict(existing)
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM brands").fetchone()[0]
        data = {k: v for k, v in body.model_dump().items() if v is not None}
        data["id"] = str(uuid.uuid4())
        data["name"] = name
        data["sort_order"] = max_order + 1
        cols = ", ".join(data.keys())
        ph = ", ".join("?" * len(data))
        conn.execute(f"INSERT INTO brands ({cols}) VALUES ({ph})", tuple(data.values()))
        conn.commit()
        return dict(conn.execute("SELECT * FROM brands WHERE id = ?", (data["id"],)).fetchone())
    finally:
        conn.close()


@router.patch("/{brand_id}")
def update_brand(brand_id: str, body: BrandUpdate):
    conn = get_production()
    try:
        existing = conn.execute("SELECT * FROM brands WHERE id = ?", (brand_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Not found")
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE brands SET {set_clause} WHERE id = ?", list(fields.values()) + [brand_id])
            conn.commit()
        return dict(conn.execute("SELECT * FROM brands WHERE id = ?", (brand_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/{brand_id}")
def delete_brand(brand_id: str):
    conn = get_production()
    try:
        conn.execute("DELETE FROM brands WHERE id = ?", (brand_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
