"""Живые прайсы поставщиков (materials.db) для смет.

materials.db (read-only):
  catalog(code, title, unit, mine, ...)   — единая номенклатура Юры
  links(supplier, supplier_name, code)     — карточка ↔ строка прайса поставщика
  prices(supplier, name, unit, price, price_date, ...) — прайсы ВРЭП/Металлинвест

Смета замораживает цену на момент составления (unit_price + price_date), а этот
роутер даёт актуальную цену и «у кого дешевле», плюс проверку протухшей сметы.
"""
from fastapi import APIRouter, Query
from typing import Optional

from db import get_materials

router = APIRouter()

SUPPLIER_LABEL = {"vrep": "ВРЭП", "metplus": "Металлинвест"}


def _supplier_prices(mconn, code: str):
    """Все актуальные цены по карточке, отсортированы дешёвая→дорогая."""
    rows = mconn.execute(
        """SELECT p.supplier, p.price, p.unit, p.price_date
           FROM links l JOIN prices p ON p.supplier = l.supplier AND p.name = l.supplier_name
           WHERE l.code = ? AND p.price IS NOT NULL
           ORDER BY p.price ASC""",
        (code,),
    ).fetchall()
    return [
        {
            "supplier": r["supplier"],
            "supplier_label": SUPPLIER_LABEL.get(r["supplier"], r["supplier"]),
            "price": r["price"],
            "unit": r["unit"],
            "price_date": r["price_date"],
        }
        for r in rows
    ]


def cheapest_price(mconn, code: str):
    """Самая дешёвая актуальная цена по карточке (или None)."""
    prices = _supplier_prices(mconn, code)
    return prices[0] if prices else None


@router.get("/search")
def search_materials(q: Optional[str] = None, limit: int = Query(40, le=200)):
    """Поиск по номенклатуре с подстановкой самой дешёвой цены (для автоподбора в смете)."""
    mconn = get_materials()
    try:
        # Cyrillic: SQLite LIKE фолдит только ASCII → фильтруем в Python (каталог небольшой).
        rows = mconn.execute("SELECT code, title, unit, mine FROM catalog ORDER BY mine DESC, title").fetchall()
        if q:
            needle = q.strip().casefold()
            rows = [r for r in rows if needle in (r["title"] or "").casefold() or needle in (r["code"] or "").casefold()]
        rows = rows[:limit]
        out = []
        for r in rows:
            prices = _supplier_prices(mconn, r["code"])
            best = prices[0] if prices else None
            out.append({
                # поля совместимы с пикером материала (MaterialTitle/onPickMaterial)
                "id": r["code"],
                "name": r["title"],
                "unit": r["unit"] or best["unit"] if best else r["unit"],
                "price": best["price"] if best else 0,
                "supplier": best["supplier"] if best else None,
                "supplier_label": best["supplier_label"] if best else None,
                "price_date": best["price_date"] if best else None,
                "alternatives": prices,
                "no_price": best is None,
            })
        return out
    finally:
        mconn.close()


@router.get("/supplier-sync")
def supplier_sync(code: str):
    """Свежесть прайса поставщика (для карточки в Вики): дата последнего синка и
    число позиций. code — значение prices.supplier (vrep|metplus)."""
    mconn = get_materials()
    try:
        r = mconn.execute(
            "SELECT MAX(price_date) AS last_date, COUNT(*) AS count FROM prices WHERE supplier = ?",
            (code,),
        ).fetchone()
        return {"code": code, "last_date": r["last_date"] if r else None, "count": (r["count"] if r else 0) or 0}
    finally:
        mconn.close()


@router.get("/{code}/prices")
def material_prices(code: str):
    """Все цены поставщиков по карточке номенклатуры + карточка."""
    mconn = get_materials()
    try:
        card = mconn.execute("SELECT code, title, unit, mine FROM catalog WHERE code = ?", (code,)).fetchone()
        prices = _supplier_prices(mconn, code)
        best = prices[0] if prices else None
        cheaper_by = None
        if len(prices) >= 2 and prices[-1]["price"] > 0:
            cheaper_by = round((prices[-1]["price"] - prices[0]["price"]) / prices[-1]["price"] * 100)
        return {
            "code": code,
            "title": card["title"] if card else code,
            "unit": card["unit"] if card else (best["unit"] if best else None),
            "best": best,
            "prices": prices,
            "cheaper_by_pct": cheaper_by,
        }
    finally:
        mconn.close()
