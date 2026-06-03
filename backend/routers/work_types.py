from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import get_production
import uuid

router = APIRouter()


class WorkTypeCreate(BaseModel):
    name: str


@router.get("")
def list_work_types():
    conn = get_production()
    try:
        rows = conn.execute(
            "SELECT * FROM work_types ORDER BY sort_order, name"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("")
def create_work_type(body: WorkTypeCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    conn = get_production()
    try:
        existing = conn.execute(
            "SELECT * FROM work_types WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if existing:
            return dict(existing)
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM work_types").fetchone()[0]
        wid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO work_types (id, name, sort_order) VALUES (?, ?, ?)",
            (wid, name, max_order + 1)
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM work_types WHERE id = ?", (wid,)).fetchone())
    finally:
        conn.close()


@router.delete("/{work_type_id}")
def delete_work_type(work_type_id: str):
    conn = get_production()
    try:
        conn.execute("DELETE FROM master_work_types WHERE work_type_id = ?", (work_type_id,))
        conn.execute("DELETE FROM work_types WHERE id = ?", (work_type_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/{work_type_id}/masters")
def masters_for_work_type(work_type_id: str):
    """Masters linked to this work type."""
    conn = get_production()
    try:
        rows = conn.execute(
            """SELECT m.* FROM masters m
               JOIN master_work_types mwt ON mwt.master_id = m.id
               WHERE mwt.work_type_id = ?
               ORDER BY m.name""",
            (work_type_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/{work_type_id}/masters/{master_id}")
def link_master(work_type_id: str, master_id: str):
    conn = get_production()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO master_work_types (master_id, work_type_id) VALUES (?, ?)",
            (master_id, work_type_id)
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/{work_type_id}/masters/{master_id}")
def unlink_master(work_type_id: str, master_id: str):
    conn = get_production()
    try:
        conn.execute(
            "DELETE FROM master_work_types WHERE master_id = ? AND work_type_id = ?",
            (master_id, work_type_id)
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
