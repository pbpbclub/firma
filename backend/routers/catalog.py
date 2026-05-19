from fastapi import APIRouter, Query
from typing import Optional
from db import get_production

router = APIRouter()


@router.get("")
def list_catalog(search: Optional[str] = None):
    """Каталог изделий из сметных данных + материалы."""
    conn = get_production()
    try:
        # Агрегируем уникальные изделия из estimate_items
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
