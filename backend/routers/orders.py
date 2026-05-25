from fastapi import APIRouter, Query, HTTPException, Body, Depends
from pydantic import BaseModel
from typing import Optional
from uuid import uuid4
from db import get_production
from auth import get_current_user

router = APIRouter()

STATUS_LABELS = {
    "draft": "Черновик",
    "estimate": "Смета",
    "project": "Проект",
    "in_production": "В производстве",
    "completed": "Завершён",
    "cancelled": "Отменён",
}

PRIORITY_LABELS = {
    "low": "Низкий",
    "normal": "Обычный",
    "high": "Высокий",
    "urgent": "Срочный",
}


@router.get("")
def list_orders(
    status: Optional[str] = None,
    search: Optional[str] = None,
    archived: bool = False,
    limit: int = Query(50, le=200),
):
    conn = get_production()
    try:
        sql = """
            SELECT
                o.id, o.number, o.title, o.status, o.priority,
                o.deadline, o.price_plan, o.cost_plan, o.created_at,
                o.archived, o.brand,
                c.id AS customer_id,
                c.name AS customer_name,
                c.full_name AS customer_full_name,
                c.inn AS customer_inn,
                c.phone AS customer_phone,
                c.email AS customer_email,
                c.wiki_ref AS customer_wiki_ref,
                c.finagent_ref AS customer_finagent_ref,
                COALESCE(SUM(p.amount), 0) AS paid_total
            FROM orders o
            LEFT JOIN customers c ON c.id = o.customer_id
            LEFT JOIN payments p ON p.order_id = o.id
            WHERE o.archived = ?
        """
        params: list = [1 if archived else 0]
        if status:
            sql += " AND o.status = ?"
            params.append(status)
        if search:
            sql += " AND (o.title LIKE ? OR o.number LIKE ? OR c.name LIKE ?)"
            params += [f"%{search}%"] * 3
        sql += " GROUP BY o.id ORDER BY o.created_at DESC LIMIT ?"
        params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        return [
            {
                **dict(r),
                "status_label": STATUS_LABELS.get(r["status"], r["status"]),
                "priority_label": PRIORITY_LABELS.get(r["priority"], r["priority"]),
                "debt": round((r["price_plan"] or 0) - (r["paid_total"] or 0), 2),
                "margin": round(
                    ((r["price_plan"] or 0) - (r["cost_plan"] or 0)), 2
                ),
            }
            for r in rows
        ]
    finally:
        conn.close()


@router.get("/{order_id}")
def get_order(order_id: str):
    conn = get_production()
    try:
        order = conn.execute(
            """
            SELECT o.*, c.id AS customer_id, c.name AS customer_name, c.full_name AS customer_full_name, c.inn AS customer_inn,
                c.phone AS customer_phone, c.email AS customer_email, c.contact AS customer_contact,
                c.wiki_ref AS customer_wiki_ref, c.finagent_ref AS customer_finagent_ref
            FROM orders o
            LEFT JOIN customers c ON c.id = o.customer_id
            WHERE o.id = ? OR o.number = ?
            """,
            (order_id, order_id),
        ).fetchone()
        if not order:
            return {"error": "not found"}

        order = dict(order)
        oid = order["id"]

        payments = conn.execute(
            "SELECT * FROM payments WHERE order_id = ? ORDER BY paid_at DESC",
            (oid,),
        ).fetchall()

        estimate_sets = conn.execute(
            "SELECT * FROM estimate_sets WHERE order_id = ? ORDER BY created_at DESC",
            (oid,),
        ).fetchall()

        stages = conn.execute(
            "SELECT * FROM stages WHERE order_id = ? ORDER BY sort_order",
            (oid,),
        ).fetchall()

        events = conn.execute(
            "SELECT * FROM events WHERE order_id = ? ORDER BY created_at DESC LIMIT 20",
            (oid,),
        ).fetchall()

        paid_total = sum(p["amount"] for p in payments)

        return {
            **order,
            "status_label": STATUS_LABELS.get(order["status"], order["status"]),
            "priority_label": PRIORITY_LABELS.get(order["priority"], order["priority"]),
            "paid_total": paid_total,
            "debt": round((order["price_plan"] or 0) - paid_total, 2),
            "margin": round((order["price_plan"] or 0) - (order["cost_plan"] or 0), 2),
            "payments": [dict(p) for p in payments],
            "estimate_sets": [dict(e) for e in estimate_sets],
            "stages": [dict(s) for s in stages],
            "events": [dict(e) for e in events],
        }
    finally:
        conn.close()


@router.get("/{order_id}/estimate")
def get_estimate(order_id: str):
    conn = get_production()
    try:
        order = conn.execute(
            "SELECT id FROM orders WHERE id = ? OR number = ?",
            (order_id, order_id),
        ).fetchone()
        if not order:
            return {"error": "not found"}

        sets = conn.execute(
            "SELECT * FROM estimate_sets WHERE order_id = ? ORDER BY created_at DESC",
            (order["id"],),
        ).fetchall()

        result = []
        for s in sets:
            items = conn.execute(
                "SELECT * FROM estimate_items WHERE set_id = ? ORDER BY sort_order",
                (s["id"],),
            ).fetchall()
            items_data = []
            for item in items:
                lines = conn.execute(
                    "SELECT * FROM estimate_lines WHERE item_id = ? ORDER BY sort_order",
                    (item["id"],),
                ).fetchall()
                items_data.append({**dict(item), "lines": [dict(l) for l in lines]})
            result.append({**dict(s), "items": items_data})

        return result
    finally:
        conn.close()


class StatusUpdate(BaseModel):
    status: str


VALID_STATUSES = {"draft", "estimate", "project", "in_production", "completed", "cancelled"}


@router.patch("/{order_id}/status")
def update_status(order_id: str, body: StatusUpdate):
    if body.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {body.status}")
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", (body.status, r["id"]))
        conn.commit()
        return {"ok": True, "status": body.status}
    finally:
        conn.close()


@router.patch("/{order_id}/archive")
def archive_order(order_id: str):
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("UPDATE orders SET archived = 1, updated_at = datetime('now') WHERE id = ?", (r["id"],))
        conn.commit()
        return {"ok": True, "archived": True}
    finally:
        conn.close()


@router.patch("/{order_id}/unarchive")
def unarchive_order(order_id: str):
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("UPDATE orders SET archived = 0, updated_at = datetime('now') WHERE id = ?", (r["id"],))
        conn.commit()
        return {"ok": True, "archived": False}
    finally:
        conn.close()


VALID_BRANDS = {"Мира", "PBPB", "Транзит"}


class BrandUpdate(BaseModel):
    brand: Optional[str]


@router.patch("/{order_id}/brand")
def update_brand(order_id: str, body: BrandUpdate):
    if body.brand is not None and body.brand not in VALID_BRANDS:
        raise HTTPException(status_code=400, detail=f"Invalid brand: {body.brand}")
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("UPDATE orders SET brand = ?, updated_at = datetime('now') WHERE id = ?", (body.brand, r["id"]))
        conn.commit()
        return {"ok": True, "brand": body.brand}
    finally:
        conn.close()


@router.delete("/{order_id}")
def delete_order(order_id: str):
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        oid = r["id"]
        # Удаляем связанные данные
        conn.execute("DELETE FROM payments WHERE order_id = ?", (oid,))
        conn.execute("DELETE FROM stages WHERE order_id = ?", (oid,))
        conn.execute("DELETE FROM events WHERE order_id = ?", (oid,))
        conn.execute("DELETE FROM estimate_items WHERE set_id IN (SELECT id FROM estimate_sets WHERE order_id = ?)", (oid,))
        conn.execute("DELETE FROM estimate_lines WHERE item_id IN (SELECT ei.id FROM estimate_items ei JOIN estimate_sets es ON ei.set_id = es.id WHERE es.order_id = ?)", (oid,))
        conn.execute("DELETE FROM estimate_sets WHERE order_id = ?", (oid,))
        conn.execute("DELETE FROM orders WHERE id = ?", (oid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("")
async def create_order(body: dict = Body(...), user=Depends(get_current_user)):
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title required")

    conn = get_production()
    try:
        row = conn.execute(
            "SELECT MAX(CAST(SUBSTR(number, 5) AS INTEGER)) as max_num FROM orders WHERE number LIKE 'ORD-%'"
        ).fetchone()
        max_num = row["max_num"] if row and row["max_num"] is not None else 0
        number = f"ORD-{max_num + 1:03d}"

        new_id = str(uuid4())
        conn.execute(
            """INSERT INTO orders (id, number, title, status, priority, deadline, customer_id, brand, created_at)
               VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, datetime('now'))""",
            (
                new_id,
                number,
                title,
                body.get("priority", "normal"),
                body.get("deadline") or None,
                body.get("customer_id") or None,
                body.get("brand") or None,
            ),
        )
        conn.commit()
        order = dict(conn.execute("SELECT * FROM orders WHERE id = ?", (new_id,)).fetchone())
        return order
    finally:
        conn.close()
