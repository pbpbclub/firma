from fastapi import APIRouter, Query, HTTPException
from typing import Optional, List
from pydantic import BaseModel
from db import get_production
import uuid
from datetime import datetime

router = APIRouter()

BOM_LINE_TYPES = ("material", "labor", "service", "delivery")


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
    material_id: Optional[str] = None      # legacy MES, не используется
    material_code: Optional[str] = None    # код номенклатуры materials.db (живые цены)
    work_type_id: Optional[str] = None
    master_id: Optional[str] = None
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
        plans = []
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
            plans.append(plan_unit)
            if has_fact:
                facts.append(actual_unit)

        plan_stats = None
        if plans:
            avg_plan = round(sum(plans) / len(plans), 2)
            plan_stats = {
                "count": len(plans),
                "avg_plan_unit": avg_plan,
                "min_plan_unit": round(min(plans), 2),
                "max_plan_unit": round(max(plans), 2),
                "last_plan_unit": plans[0],  # history sorted by date desc
                "deviation_pct": round((avg_plan - etalon_unit) / etalon_unit * 100, 1) if etalon_unit else None,
            }

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

        return {"etalon_unit": etalon_unit, "history": history, "stats": stats, "plan_stats": plan_stats}
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
                """INSERT INTO catalog_item_lines (id, item_id, type, title, qty, unit, unit_price, line_total,
                                                   material_id, material_code, work_type_id, master_id, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid.uuid4()), item_id, line.type, line.title, line.qty, line.unit,
                 line.unit_price, line.qty * line.unit_price,
                 line.material_id, line.material_code, line.work_type_id, line.master_id, i)
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
                """INSERT INTO catalog_item_lines (id, item_id, type, title, qty, unit, unit_price, line_total,
                                                   material_id, material_code, work_type_id, master_id, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid.uuid4()), item_id, line.type, line.title, line.qty, line.unit,
                 line.unit_price, line.qty * line.unit_price,
                 line.material_id, line.material_code, line.work_type_id, line.master_id, i)
            )
        conn.commit()
        item = conn.execute("SELECT * FROM catalog_items WHERE id = ?", (item_id,)).fetchone()
        lines = conn.execute("SELECT * FROM catalog_item_lines WHERE item_id = ? ORDER BY sort_order", (item_id,)).fetchall()
        result = dict(item)
        result["lines"] = [dict(l) for l in lines]
        return result
    finally:
        conn.close()


# ─── BOM из Blender (контракт: docs/bom-contract.md) ─────────────────────────

class BomLine(BaseModel):
    type: str = "material"                 # material | labor | service | delivery
    material_code: Optional[str] = None    # код номенклатуры materials.db (надёжный путь)
    title: Optional[str] = None            # или свободное название — приёмник матчит сам
    work_type: Optional[str] = None        # имя вида работ (labor/service)
    qty: float = 1
    unit: str = "шт"
    unit_price: Optional[float] = None     # явная цена (обычно не шлётся — снапшот считаем сами)


class BomIn(BaseModel):
    source: str = "blender"
    version: int = 1
    product: dict                          # {title, category?, brand?, catalog_item_id?, markup_pct?}
    mode: str = "upsert"                   # upsert (по catalog_item_id/названию) | create
    lines: List[BomLine]


@router.post("/import-bom")
def import_bom(body: BomIn):
    """Ведомость материалов из Blender → карточка себестоимости каталога.

    Материалы резолвятся в номенклатуру (код как есть / выученное правило / точное
    название), цены — снапшот живых прайсов и ставок на момент импорта. Нерезолвнутые
    строки НЕ блокируют импорт: они лягут без кода и всплывут в cost-check как
    «нужен ввод» при развороте в смету."""
    from db import get_materials
    from routers.estimates import _lookup_cheapest
    from routers.costing import _match_material_code
    from routers.rates import resolve_work_type, find_work_rate, find_price_book, norm_title

    def _material_title(code: str):
        try:
            mconn = get_materials()
            try:
                r = mconn.execute("SELECT title FROM catalog WHERE code = ?", (code,)).fetchone()
                return r["title"] if r else None
            finally:
                mconn.close()
        except Exception:
            return None

    title = ((body.product or {}).get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="product.title required")
    if not body.lines:
        raise HTTPException(status_code=400, detail="lines required")
    for l in body.lines:
        if l.type not in BOM_LINE_TYPES:
            raise HTTPException(status_code=400, detail=f"line.type must be one of {'|'.join(BOM_LINE_TYPES)}")
        if not l.material_code and not (l.title or l.work_type):
            raise HTTPException(status_code=400, detail="line needs material_code, title or work_type")

    conn = get_production()
    try:
        _ensure_tables(conn)
        now = datetime.utcnow().isoformat()

        # Целевая карточка: id → точное название (upsert) → новая
        cat = None
        if (body.product or {}).get("catalog_item_id"):
            cat = conn.execute("SELECT * FROM catalog_items WHERE id = ?", (body.product["catalog_item_id"],)).fetchone()
        if not cat and body.mode == "upsert":
            for r in conn.execute("SELECT * FROM catalog_items").fetchall():
                if norm_title(r["title"]) == norm_title(title):
                    cat = r
                    break
        created = cat is None
        markup_pct = (body.product or {}).get("markup_pct") or (cat["markup_pct"] if cat else 30) or 30
        if created:
            item_id = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO catalog_items (id, title, category, brand, markup_pct, cost_total, sale_price, notes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)""",
                (item_id, title, (body.product or {}).get("category"), (body.product or {}).get("brand"),
                 markup_pct, f"BOM из {body.source}", now, now),
            )
        else:
            item_id = cat["id"]
            conn.execute("DELETE FROM catalog_item_lines WHERE item_id = ?", (item_id,))

        matched, unmatched = 0, []
        for i, l in enumerate(body.lines):
            line_title = (l.title or l.work_type or "").strip()
            code, wt_id, master_id = None, None, None
            unit_price = l.unit_price or 0

            if l.type == "material":
                code = l.material_code
                if not code and line_title:
                    code, _via = _match_material_code(conn, line_title)
                if code:
                    line_title = line_title or _material_title(code) or code
                    best = _lookup_cheapest(code)
                    if best and best.get("price"):
                        unit_price = unit_price or best["price"]
                        matched += 1
                    else:
                        unmatched.append({"title": line_title or code,
                                          "ask": f"Код «{code}» без цены в прайсах — почём «{line_title or code}», ₽/{l.unit}?"})
                else:
                    pb = find_price_book(conn, line_title)
                    if pb:
                        unit_price = unit_price or pb["price"]
                        matched += 1
                    elif not unit_price:
                        unmatched.append({"title": line_title,
                                          "ask": f"Материал «{line_title}» не найден в номенклатуре — какой это код или цена, ₽/{l.unit}?"})
            elif l.type in ("labor", "service"):
                wt = resolve_work_type(conn, None, l.work_type or line_title, create=True)
                if wt:
                    wt_id = wt["id"]
                    line_title = line_title or wt["name"]
                    rate = find_work_rate(conn, wt_id, None)
                    if rate and rate["scheme"] != "percent":
                        unit_price = unit_price or round(rate["rate"], 2)
                        matched += 1
                    elif not unit_price:
                        unmatched.append({"title": line_title,
                                          "ask": f"Ставка за «{wt['name']}»: сколько ₽/{l.unit}?"})

            conn.execute(
                """INSERT INTO catalog_item_lines (id, item_id, type, title, qty, unit, unit_price, line_total,
                                                   material_code, work_type_id, master_id, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid.uuid4()), item_id, l.type, line_title or "Без названия", l.qty, l.unit,
                 unit_price, round((l.qty or 0) * unit_price, 2), code, wt_id, master_id, i),
            )

        cost_total = conn.execute(
            "SELECT COALESCE(SUM(line_total), 0) FROM catalog_item_lines WHERE item_id = ?", (item_id,)
        ).fetchone()[0]
        conn.execute(
            "UPDATE catalog_items SET cost_total = ?, sale_price = ?, updated_at = ? WHERE id = ?",
            (round(cost_total, 2), round(cost_total * (1 + markup_pct / 100), 2), now, item_id),
        )
        conn.commit()
        return {
            "catalog_item_id": item_id,
            "created": created,
            "title": title,
            "lines_total": len(body.lines),
            "matched": matched,
            "unmatched": unmatched,
            "cost_total": round(cost_total, 2),
        }
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
