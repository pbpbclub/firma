from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from typing import Optional, List
from pydantic import BaseModel
from db import get_production
import uuid, subprocess, glob, os
from datetime import datetime

router = APIRouter()

# ─── helpers ────────────────────────────────────────────────────────────────

def _recalc_item(conn, item_id: str):
    """Recalculate cost_total from lines. Does NOT touch sale_price."""
    line_cost = conn.execute(
        "SELECT COALESCE(SUM(line_total), 0) FROM estimate_lines WHERE item_id = ?",
        (item_id,)
    ).fetchone()[0]
    row = conn.execute(
        "SELECT quantity, cost_total FROM estimate_items WHERE id = ?", (item_id,)
    ).fetchone()
    quantity = row["quantity"] or 1
    if line_cost > 0:
        cost_total = round(line_cost * quantity, 2)
    else:
        cost_total = row["cost_total"] or 0
    conn.execute(
        "UPDATE estimate_items SET cost_total = ? WHERE id = ?",
        (cost_total, item_id)
    )


def _now():
    return datetime.utcnow().isoformat()


def _touch_set(conn, item_id: str):
    conn.execute(
        """UPDATE estimate_sets SET updated_at = datetime('now')
           WHERE id = (SELECT set_id FROM estimate_items WHERE id = ?)""",
        (item_id,)
    )


def _sync_order_from_set(conn, set_id: str):
    """Recalculate order price_plan/cost_plan from all items in this set."""
    es = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
    if not es:
        return
    items = conn.execute(
        "SELECT cost_total, sale_price, bank_pct FROM estimate_items WHERE set_id = ?",
        (set_id,)
    ).fetchall()
    total_cost = sum((it["cost_total"] or 0) for it in items)
    set_bank_pct = es["bank_pct"] or 13
    if es["payment_type"] == "bank":
        total_price = sum(
            round((it["sale_price"] or 0) * (1 + (it["bank_pct"] or set_bank_pct) / 100))
            for it in items
        )
    else:
        total_price = sum((it["sale_price"] or 0) for it in items)
    conn.execute(
        "UPDATE orders SET price_plan = ?, cost_plan = ?, updated_at = datetime('now') WHERE id = ?",
        (total_price, total_cost, es["order_id"])
    )


def _sync_order_if_approved(conn, item_id: str):
    """Sync parent order totals if the item's set is approved."""
    row = conn.execute(
        """SELECT es.id, es.status FROM estimate_sets es
           JOIN estimate_items ei ON ei.set_id = es.id
           WHERE ei.id = ?""",
        (item_id,)
    ).fetchone()
    if row and row["status"] == "approved":
        _sync_order_from_set(conn, row["id"])


# ─── Models ─────────────────────────────────────────────────────────────────

class SetCreate(BaseModel):
    order_id: str
    title: Optional[str] = None
    payment_type: str = "cash"
    bank_pct: float = 13.0
    notes: Optional[str] = None


class SetUpdate(BaseModel):
    title: Optional[str] = None
    payment_type: Optional[str] = None
    bank_pct: Optional[float] = None
    status: Optional[str] = None
    notes: Optional[str] = None


class ItemCreate(BaseModel):
    title: str = ""
    category: Optional[str] = None
    markup: float = 2.0
    quantity: int = 1
    bank_pct: Optional[float] = None
    sort_order: int = 0


class ItemUpdate(BaseModel):
    title: Optional[str] = None
    category: Optional[str] = None
    brand: Optional[str] = None
    markup: Optional[float] = None
    quantity: Optional[int] = None
    sort_order: Optional[int] = None
    cost_total: Optional[float] = None
    bank_pct: Optional[float] = None


class LineCreate(BaseModel):
    type: str = "material"
    title: str = ""
    qty: float = 1.0
    unit: str = "шт"
    unit_price: float = 0.0
    sort_order: int = 0
    master_id: Optional[str] = None
    contractor_name: Optional[str] = None


class LineUpdate(BaseModel):
    type: Optional[str] = None
    title: Optional[str] = None
    qty: Optional[float] = None
    unit: Optional[str] = None
    unit_price: Optional[float] = None
    sort_order: Optional[int] = None
    master_id: Optional[str] = None
    contractor_name: Optional[str] = None


class FromCatalog(BaseModel):
    set_id: str
    catalog_item_id: str


# ─── estimate_sets ───────────────────────────────────────────────────────────

@router.post("/sets")
def create_set(body: SetCreate):
    conn = get_production()
    try:
        set_id = str(uuid.uuid4())
        now = _now()
        conn.execute(
            """INSERT INTO estimate_sets (id, order_id, title, status, payment_type, bank_pct, notes, created_at, updated_at)
               VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)""",
            (set_id, body.order_id, body.title, body.payment_type, body.bank_pct, body.notes, now, now)
        )
        conn.commit()
        row = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.put("/sets/{set_id}")
def update_set(set_id: str, body: SetUpdate):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        if not fields:
            return dict(row)
        fields["updated_at"] = _now()
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(
            f"UPDATE estimate_sets SET {set_clause} WHERE id = ?",
            list(fields.values()) + [set_id]
        )
        if body.bank_pct is not None:
            conn.execute(
                "UPDATE estimate_items SET bank_pct = ? WHERE set_id = ?",
                (body.bank_pct, set_id)
            )
        conn.commit()
        updated = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if updated["status"] == "approved":
            _sync_order_from_set(conn, set_id)
            conn.commit()
        return dict(conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/sets/{set_id}")
def delete_set(set_id: str):
    conn = get_production()
    try:
        row = conn.execute("SELECT id FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        # cascade manually (SQLite foreign keys may not be enforced)
        items = conn.execute("SELECT id FROM estimate_items WHERE set_id = ?", (set_id,)).fetchall()
        for item in items:
            conn.execute("DELETE FROM estimate_lines WHERE item_id = ?", (item["id"],))
        conn.execute("DELETE FROM estimate_items WHERE set_id = ?", (set_id,))
        conn.execute("DELETE FROM estimate_sets WHERE id = ?", (set_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ─── estimate_items ──────────────────────────────────────────────────────────

@router.post("/sets/{set_id}/items")
def add_item(set_id: str, body: ItemCreate):
    conn = get_production()
    try:
        set_row = conn.execute("SELECT id, bank_pct FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not set_row:
            raise HTTPException(status_code=404, detail="Set not found")
        item_id = str(uuid.uuid4())
        bank_pct = body.bank_pct if body.bank_pct is not None else (set_row["bank_pct"] or 13)
        conn.execute(
            """INSERT INTO estimate_items (id, set_id, title, category, markup, quantity, overhead_pct, tax_pct, cost_total, sale_price, bank_pct, sort_order, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?)""",
            (item_id, set_id, body.title, body.category, body.markup, body.quantity, bank_pct, body.sort_order, _now())
        )
        conn.commit()
        set_status = conn.execute("SELECT status FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if set_status and set_status["status"] == "approved":
            _sync_order_from_set(conn, set_id)
            conn.commit()
        return dict(conn.execute("SELECT * FROM estimate_items WHERE id = ?", (item_id,)).fetchone())
    finally:
        conn.close()


@router.put("/items/{item_id}")
def update_item(item_id: str, body: ItemUpdate):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM estimate_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE estimate_items SET {set_clause} WHERE id = ?",
                list(fields.values()) + [item_id]
            )
        if "quantity" in fields:
            _recalc_item(conn, item_id)
        _touch_set(conn, item_id)
        _sync_order_if_approved(conn, item_id)
        conn.commit()
        return dict(conn.execute("SELECT * FROM estimate_items WHERE id = ?", (item_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/items/{item_id}")
def delete_item(item_id: str):
    conn = get_production()
    try:
        item_row = conn.execute(
            "SELECT set_id FROM estimate_items WHERE id = ?", (item_id,)
        ).fetchone()
        if not item_row:
            raise HTTPException(status_code=404, detail="Not found")
        set_id = item_row["set_id"]
        _touch_set(conn, item_id)
        conn.execute("DELETE FROM estimate_lines WHERE item_id = ?", (item_id,))
        conn.execute("DELETE FROM estimate_items WHERE id = ?", (item_id,))
        conn.commit()
        # Sync after deletion so totals exclude the removed item
        set_row = conn.execute("SELECT status FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if set_row and set_row["status"] == "approved":
            _sync_order_from_set(conn, set_id)
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/items/{item_id}/to-catalog")
def sync_item_to_catalog(item_id: str):
    conn = get_production()
    try:
        item = conn.execute("SELECT * FROM estimate_items WHERE id = ?", (item_id,)).fetchone()
        if not item:
            raise HTTPException(status_code=404, detail="Not found")
        item = dict(item)
        now = _now()
        catalog_id = item.get("catalog_item_id")

        if catalog_id and conn.execute("SELECT id FROM catalog_items WHERE id = ?", (catalog_id,)).fetchone():
            conn.execute(
                "UPDATE catalog_items SET title=?, brand=?, cost_total=?, sale_price=?, updated_at=? WHERE id=?",
                (item["title"] or "Без названия", item.get("brand"), item["cost_total"], item["sale_price"], now, catalog_id)
            )
            conn.execute("DELETE FROM catalog_item_lines WHERE item_id = ?", (catalog_id,))
        else:
            catalog_id = str(uuid.uuid4())
            markup_pct = round((item.get("markup") or 2.0) * 100 - 100, 1)
            conn.execute(
                """INSERT INTO catalog_items (id, title, brand, category, markup_pct, cost_total, sale_price, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (catalog_id, item["title"] or "Без названия", item.get("brand"), item.get("category"),
                 markup_pct, item["cost_total"], item["sale_price"], now, now)
            )
            conn.execute("UPDATE estimate_items SET catalog_item_id=? WHERE id=?", (catalog_id, item_id))

        lines = conn.execute(
            "SELECT * FROM estimate_lines WHERE item_id = ? ORDER BY sort_order", (item_id,)
        ).fetchall()
        for i, line in enumerate(lines):
            conn.execute(
                """INSERT INTO catalog_item_lines (id, item_id, type, title, qty, unit, unit_price, line_total, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid.uuid4()), catalog_id, line["type"], line["title"],
                 line["qty"], line["unit"], line["unit_price"], line["line_total"], i)
            )
        conn.commit()
        return {"catalog_item_id": catalog_id}
    finally:
        conn.close()


# ─── estimate_lines ──────────────────────────────────────────────────────────

@router.post("/items/{item_id}/lines")
def add_line(item_id: str, body: LineCreate):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM estimate_items WHERE id = ?", (item_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Item not found")
        line_id = str(uuid.uuid4())
        line_total = round(body.qty * body.unit_price, 2)
        conn.execute(
            """INSERT INTO estimate_lines (id, item_id, type, title, qty, unit, unit_price, line_total, sort_order, master_id, contractor_name, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (line_id, item_id, body.type, body.title, body.qty, body.unit, body.unit_price, line_total,
             body.sort_order, body.master_id, body.contractor_name, _now())
        )
        _recalc_item(conn, item_id)
        _touch_set(conn, item_id)
        _sync_order_if_approved(conn, item_id)
        conn.commit()
        return dict(conn.execute("SELECT * FROM estimate_lines WHERE id = ?", (line_id,)).fetchone())
    finally:
        conn.close()


@router.put("/lines/{line_id}")
def update_line(line_id: str, body: LineUpdate):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM estimate_lines WHERE id = ?", (line_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        # recalc line_total
        qty = fields.get("qty", row["qty"])
        unit_price = fields.get("unit_price", row["unit_price"])
        fields["line_total"] = round(qty * unit_price, 2)
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(
            f"UPDATE estimate_lines SET {set_clause} WHERE id = ?",
            list(fields.values()) + [line_id]
        )
        _recalc_item(conn, row["item_id"])
        _touch_set(conn, row["item_id"])
        _sync_order_if_approved(conn, row["item_id"])
        conn.commit()
        return dict(conn.execute("SELECT * FROM estimate_lines WHERE id = ?", (line_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/lines/{line_id}")
def delete_line(line_id: str):
    conn = get_production()
    try:
        row = conn.execute("SELECT item_id FROM estimate_lines WHERE id = ?", (line_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        item_id = row["item_id"]
        conn.execute("DELETE FROM estimate_lines WHERE id = ?", (line_id,))
        _recalc_item(conn, item_id)
        _touch_set(conn, item_id)
        _sync_order_if_approved(conn, item_id)
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ─── Import from catalog ─────────────────────────────────────────────────────

@router.post("/items/from-catalog")
def from_catalog(body: FromCatalog):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM estimate_sets WHERE id = ?", (body.set_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Set not found")
        cat = conn.execute("SELECT * FROM catalog_items WHERE id = ?", (body.catalog_item_id,)).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Catalog item not found")
        cat = dict(cat)
        cat_lines = conn.execute(
            "SELECT * FROM catalog_item_lines WHERE item_id = ? ORDER BY sort_order",
            (body.catalog_item_id,)
        ).fetchall()

        markup = 1 + (cat["markup_pct"] or 30) / 100
        item_id = str(uuid.uuid4())
        sort_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM estimate_items WHERE set_id = ?",
            (body.set_id,)
        ).fetchone()[0]
        set_bank_pct_row = conn.execute(
            "SELECT bank_pct FROM estimate_sets WHERE id = ?", (body.set_id,)
        ).fetchone()
        set_bank_pct = (set_bank_pct_row["bank_pct"] if set_bank_pct_row else None) or 13
        conn.execute(
            """INSERT INTO estimate_items (id, set_id, title, category, markup, overhead_pct, tax_pct, cost_total, sale_price, bank_pct, sort_order, created_at)
               VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?)""",
            (item_id, body.set_id, cat["title"], cat["category"], round(markup, 4), set_bank_pct, sort_order, _now())
        )
        for i, cl in enumerate(cat_lines):
            line_id = str(uuid.uuid4())
            line_total = round(cl["qty"] * cl["unit_price"], 2)
            conn.execute(
                """INSERT INTO estimate_lines (id, item_id, type, title, qty, unit, unit_price, line_total, sort_order, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (line_id, item_id, cl["type"], cl["title"], cl["qty"], cl["unit"], cl["unit_price"], line_total, i, _now())
            )
        _recalc_item(conn, item_id)
        # New item from catalog: set initial sale_price = cost × markup
        fresh = conn.execute("SELECT cost_total, markup FROM estimate_items WHERE id = ?", (item_id,)).fetchone()
        conn.execute(
            "UPDATE estimate_items SET sale_price = ? WHERE id = ?",
            (round((fresh["cost_total"] or 0) * (fresh["markup"] or 1.0), 2), item_id)
        )
        conn.commit()

        item = dict(conn.execute("SELECT * FROM estimate_items WHERE id = ?", (item_id,)).fetchone())
        lines = [dict(l) for l in conn.execute(
            "SELECT * FROM estimate_lines WHERE item_id = ? ORDER BY sort_order", (item_id,)
        ).fetchall()]
        item["lines"] = lines
        return item
    finally:
        conn.close()


# ─── Create obligations from approved estimate ───────────────────────────────

_LINE_TYPE_RU = {"material": "Материал", "labor": "Работа", "service": "Услуга", "delivery": "Доставка", "other": "Прочее"}


def _find_or_create_master(conn, name: str) -> str:
    """Find master by name or create new one, return master id."""
    row = conn.execute("SELECT id FROM masters WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
    if row:
        return row["id"]
    mid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO masters (id, name, created_at) VALUES (?, ?, datetime('now'))",
        (mid, name)
    )
    return mid


@router.post("/sets/{set_id}/create-obligations")
def create_obligations(set_id: str):
    conn = get_production()
    try:
        es = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not es:
            raise HTTPException(status_code=404, detail="Set not found")
        if es["status"] != "approved":
            raise HTTPException(status_code=400, detail="Set must be approved")
        order_id = es["order_id"]
        items = conn.execute(
            "SELECT * FROM estimate_items WHERE set_id = ? ORDER BY sort_order", (set_id,)
        ).fetchall()
        created = 0
        skipped = 0
        for item in items:
            lines = conn.execute(
                "SELECT * FROM estimate_lines WHERE item_id = ? ORDER BY sort_order", (item["id"],)
            ).fetchall()

            if lines:
                # Per-line obligations
                for line in lines:
                    existing = conn.execute(
                        "SELECT id FROM creditors WHERE estimate_line_id = ?", (line["id"],)
                    ).fetchone()
                    if existing:
                        skipped += 1
                        continue

                    # Resolve contractor
                    master_id = line["master_id"] if line["master_id"] else None
                    contractor = line["contractor_name"] or ""
                    if not master_id and contractor:
                        master_id = _find_or_create_master(conn, contractor)
                    if not contractor and master_id:
                        m = conn.execute("SELECT name FROM masters WHERE id = ?", (master_id,)).fetchone()
                        contractor = m["name"] if m else ""

                    type_label = _LINE_TYPE_RU.get(line["type"] or "other", "Прочее")
                    name = contractor or f"{type_label}: {line['title'] or 'Без названия'}"
                    description = f"{item['title'] or ''} — {line['title'] or type_label}".strip(" —")
                    amount = round(line["line_total"] or 0, 2)

                    cid = str(uuid.uuid4())
                    conn.execute(
                        """INSERT INTO creditors
                           (id, name, total, paid, description, order_id,
                            estimate_item_id, estimate_line_id, amount_plan,
                            status)
                           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'open')""",
                        (cid, name, amount, description, order_id,
                         item["id"], line["id"], amount),
                    )
                    created += 1
            else:
                # No lines: fall back to item-level obligation
                existing = conn.execute(
                    "SELECT id FROM creditors WHERE estimate_item_id = ? AND estimate_line_id IS NULL",
                    (item["id"],)
                ).fetchone()
                if existing:
                    skipped += 1
                    continue
                amount = round(item["cost_total"] or 0, 2)
                cid = str(uuid.uuid4())
                conn.execute(
                    """INSERT INTO creditors
                       (id, name, total, paid, description, order_id,
                        estimate_item_id, amount_plan, status)
                       VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'open')""",
                    (cid, item["title"] or "Без названия", amount,
                     f"Смета: {es['title'] or set_id}", order_id, item["id"], amount),
                )
                created += 1

        conn.commit()
        return {"created": created, "skipped": skipped}
    finally:
        conn.close()


@router.delete("/sets/{set_id}/obligations")
def delete_obligations(set_id: str):
    conn = get_production()
    try:
        item_ids = [r["id"] for r in conn.execute(
            "SELECT id FROM estimate_items WHERE set_id = ?", (set_id,)
        ).fetchall()]
        if not item_ids:
            return {"deleted": 0}
        placeholders = ",".join("?" * len(item_ids))
        result = conn.execute(
            f"DELETE FROM creditors WHERE estimate_item_id IN ({placeholders})", item_ids
        )
        conn.commit()
        return {"deleted": result.rowcount}
    finally:
        conn.close()


# ─── Invoice generation ──────────────────────────────────────────────────────

@router.post("/sets/{set_id}/invoice")
def generate_invoice(set_id: str):
    conn = get_production()
    try:
        es = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not es:
            raise HTTPException(status_code=404, detail="Set not found")
        order = conn.execute("SELECT number FROM orders WHERE id = ?", (es["order_id"],)).fetchone()
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
        order_number = order["number"]
    finally:
        conn.close()

    try:
        result = subprocess.run(
            ["python3", "/opt/firma/backend/invoice.py", "order", order_number, "--set-id", set_id],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr or "Invoice generation failed")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Invoice generation timed out")

    # Find the most recently generated PDF
    pattern = f"/opt/fin-agent/data/invoices/*.pdf"
    files = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    if not files:
        raise HTTPException(status_code=500, detail="PDF not found after generation")

    return FileResponse(
        files[0],
        media_type="application/pdf",
        filename=f"invoice-{order_number}.pdf",
    )
