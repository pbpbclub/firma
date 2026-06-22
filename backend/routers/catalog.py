from fastapi import APIRouter, Query, HTTPException
from typing import Optional, List
from pydantic import BaseModel
from db import get_production
import uuid
from datetime import datetime

router = APIRouter()


def _ensure_tables(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS catalog_items (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            category    TEXT,
            markup_pct  REAL DEFAULT 30,
            cost_total  REAL DEFAULT 0,
            sale_price  REAL DEFAULT 0,
            notes       TEXT,
            created_at  TEXT DEFAULT (datetime('now')),
            updated_at  TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS catalog_item_lines (
            id          TEXT PRIMARY KEY,
            item_id     TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
            type        TEXT NOT NULL,
            title       TEXT NOT NULL,
            qty         REAL DEFAULT 1,
            unit        TEXT DEFAULT 'шт',
            unit_price  REAL DEFAULT 0,
            line_total  REAL DEFAULT 0,
            material_id TEXT,
            sort_order  INTEGER DEFAULT 0
        );
    """)
    conn.commit()


class LineIn(BaseModel):
    type: str
    title: str
    qty: float = 1
    unit: str = "шт"
    unit_price: float = 0
    material_id: Optional[str] = None
    sort_order: int = 0


class ItemIn(BaseModel):
    title: str
    category: Optional[str] = None
    brand: Optional[str] = None
    markup_pct: float = 30
    notes: Optional[str] = None
    lines: List[LineIn] = []


@router.get("")
def list_catalog(search: Optional[str] = None):
    conn = get_production()
    try:
        sql = """
            SELECT
                ei.title,
                ei.category,
                COUNT(*) as times_ordered,
                AVG(ei.sale_price) as avg_price,
                MIN(ei.sale_price) as min_price,
                MAX(ei.sale_price) as max_price,
                AVG(ei.cost_total) as avg_cost
            FROM estimate_items ei
            WHERE ei.title IS NOT NULL AND ei.title != ''
        """
        params = []
        if search:
            sql += " AND ei.title LIKE ?"
            params.append(f"%{search}%")
        sql += " GROUP BY ei.title ORDER BY times_ordered DESC"
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/materials")
def list_materials(search: Optional[str] = None, limit: int = Query(100, le=500)):
    conn = get_production()
    try:
        sql = "SELECT * FROM materials WHERE 1=1"
        params = []
        if search:
            sql += " AND (name LIKE ? OR sku LIKE ? OR supplier LIKE ?)"
            params += [f"%{search}%"] * 3
        sql += " ORDER BY name LIMIT ?"
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/items")
def list_items():
    conn = get_production()
    try:
        _ensure_tables(conn)
        rows = conn.execute(
            "SELECT * FROM catalog_items ORDER BY updated_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/items/{item_id}")
def get_item(item_id: str):
    conn = get_production()
    try:
        _ensure_tables(conn)
        item = conn.execute(
            "SELECT * FROM catalog_items WHERE id = ?", (item_id,)
        ).fetchone()
        if not item:
            raise HTTPException(status_code=404, detail="Not found")
        lines = conn.execute(
            "SELECT * FROM catalog_item_lines WHERE item_id = ? ORDER BY sort_order",
            (item_id,)
        ).fetchall()
        result = dict(item)
        result["lines"] = [dict(l) for l in lines]
        return result
    finally:
        conn.close()


@router.get("/items/{item_id}/cost-history")
def cost_history(item_id: str):
    """Факт-себестоимость изделия по заказам vs эталон каталога.

    Эталон = catalog_items.cost_total (на 1 шт). Факт по позиции = сумма
    привязанных к её обязательствам реальных оплат (creditors.paid) — как в
    orders.py. В средние идут только позиции с фактом (actual_paid > 0).
    """
    conn = get_production()
    try:
        _ensure_tables(conn)
        cat = conn.execute(
            "SELECT cost_total FROM catalog_items WHERE id = ?", (item_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        etalon_unit = round(cat["cost_total"] or 0, 2)

        rows = conn.execute(
            """SELECT ei.id, ei.quantity, ei.cost_total, ei.title,
                      o.id AS order_id, o.number AS order_number,
                      o.title AS order_title, o.status AS order_status,
                      o.created_at AS order_date
               FROM estimate_items ei
               JOIN estimate_sets es ON es.id = ei.set_id
               JOIN orders o ON o.id = es.order_id
               WHERE ei.catalog_item_id = ?
               ORDER BY o.created_at DESC""",
            (item_id,)
        ).fetchall()

        history = []
        facts = []
        for r in rows:
            qty = r["quantity"] or 1
            actual_paid = conn.execute(
                "SELECT COALESCE(SUM(paid), 0) FROM creditors WHERE estimate_item_id = ?",
                (r["id"],)
            ).fetchone()[0] or 0
            plan_unit = round((r["cost_total"] or 0) / qty, 2)
            actual_unit = round(actual_paid / qty, 2)
            has_fact = actual_paid > 0
            history.append({
                "order_id": r["order_id"],
                "order_number": r["order_number"],
                "title": r["order_title"] or r["title"],
                "date": r["order_date"],
                "status": r["order_status"],
                "qty": qty,
                "plan_unit": plan_unit,
                "actual_unit": actual_unit,
                "actual_total": round(actual_paid, 2),
                "has_fact": has_fact,
            })
            if has_fact:
                facts.append(actual_unit)

        stats = None
        if facts:
            avg_actual = round(sum(facts) / len(facts), 2)
            stats = {
                "count": len(facts),
                "avg_actual_unit": avg_actual,
                "min_actual_unit": round(min(facts), 2),
                "max_actual_unit": round(max(facts), 2),
                "last_actual_unit": facts[0],  # history sorted by date desc
                "deviation_pct": round((avg_actual - etalon_unit) / etalon_unit * 100, 1) if etalon_unit else None,
            }

        return {"etalon_unit": etalon_unit, "history": history, "stats": stats}
    finally:
        conn.close()


@router.post("/items")
def create_item(body: ItemIn):
    conn = get_production()
    try:
        _ensure_tables(conn)
        item_id = str(uuid.uuid4())
        cost_total = sum(l.qty * l.unit_price for l in body.lines)
        sale_price = cost_total * (1 + body.markup_pct / 100)
        now = datetime.utcnow().isoformat()
        conn.execute(
            """INSERT INTO catalog_items (id, title, category, brand, markup_pct, cost_total, sale_price, notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (item_id, body.title, body.category, body.brand, body.markup_pct, cost_total, sale_price, body.notes, now, now)
        )
        for i, line in enumerate(body.lines):
            conn.execute(
                """INSERT INTO catalog_item_lines (id, item_id, type, title, qty, unit, unit_price, line_total, material_id, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid.uuid4()), item_id, line.type, line.title, line.qty, line.unit,
                 line.unit_price, line.qty * line.unit_price, line.material_id, i)
            )
        conn.commit()
        item = conn.execute("SELECT * FROM catalog_items WHERE id = ?", (item_id,)).fetchone()
        lines = conn.execute("SELECT * FROM catalog_item_lines WHERE item_id = ? ORDER BY sort_order", (item_id,)).fetchall()
        result = dict(item)
        result["lines"] = [dict(l) for l in lines]
        return result
    finally:
        conn.close()


@router.put("/items/{item_id}")
def update_item(item_id: str, body: ItemIn):
    conn = get_production()
    try:
        _ensure_tables(conn)
        existing = conn.execute("SELECT id FROM catalog_items WHERE id = ?", (item_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Not found")
        cost_total = sum(l.qty * l.unit_price for l in body.lines)
        sale_price = cost_total * (1 + body.markup_pct / 100)
        now = datetime.utcnow().isoformat()
        conn.execute(
            """UPDATE catalog_items SET title=?, category=?, brand=?, markup_pct=?, cost_total=?, sale_price=?, notes=?, updated_at=?
               WHERE id=?""",
            (body.title, body.category, body.brand, body.markup_pct, cost_total, sale_price, body.notes, now, item_id)
        )
        conn.execute("DELETE FROM catalog_item_lines WHERE item_id = ?", (item_id,))
        for i, line in enumerate(body.lines):
            conn.execute(
                """INSERT INTO catalog_item_lines (id, item_id, type, title, qty, unit, unit_price, line_total, material_id, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid.uuid4()), item_id, line.type, line.title, line.qty, line.unit,
                 line.unit_price, line.qty * line.unit_price, line.material_id, i)
            )
        conn.commit()
        item = conn.execute("SELECT * FROM catalog_items WHERE id = ?", (item_id,)).fetchone()
        lines = conn.execute("SELECT * FROM catalog_item_lines WHERE item_id = ? ORDER BY sort_order", (item_id,)).fetchall()
        result = dict(item)
        result["lines"] = [dict(l) for l in lines]
        return result
    finally:
        conn.close()


@router.delete("/items/{item_id}")
def delete_item(item_id: str):
    conn = get_production()
    try:
        _ensure_tables(conn)
        existing = conn.execute("SELECT id FROM catalog_items WHERE id = ?", (item_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("DELETE FROM catalog_item_lines WHERE item_id = ?", (item_id,))
        conn.execute("DELETE FROM catalog_items WHERE id = ?", (item_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


class DeleteByTitlesBody(BaseModel):
    titles: List[str]


@router.delete("/by-titles")
def delete_by_titles(body: DeleteByTitlesBody):
    """Delete all estimate_items (and their lines) matching the given titles."""
    conn = get_production()
    try:
        deleted = 0
        for title in body.titles:
            item_ids = [r["id"] for r in conn.execute(
                "SELECT id FROM estimate_items WHERE title = ?", (title,)
            ).fetchall()]
            for iid in item_ids:
                conn.execute("DELETE FROM estimate_lines WHERE item_id = ?", (iid,))
            result = conn.execute("DELETE FROM estimate_items WHERE title = ?", (title,))
            deleted += result.rowcount
        conn.commit()
        return {"deleted": deleted}
    finally:
        conn.close()
