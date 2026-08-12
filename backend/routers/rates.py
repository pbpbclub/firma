"""Справочники costing-движка: ставки работ, выученные цены, правила сопоставления.

work_rates    — вид работ × исполнитель → ставка (master_id NULL = дефолт вида работ)
work_rate_tiers — ступени той же ставки по объёму партии («от 10 шт — 325 ₽»);
                ступеней нет → работает базовая work_rates.rate, как и раньше
price_book    — цены материалов вне прайсов materials.db (фанера/ткань/крепёж),
                выученные из ответов Юры и утверждённых смет
costing_rules — «название → номенклатура/рецептура/вид работ» (клон идеи payee_rules)

Роуты объявлены с полными путями (/api/...) — роутер монтируется без префикса.
"""
import re
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from audit import current_actor
from db import get_production, get_analytics_ro

router = APIRouter()

RATE_SCHEMES = ("fixed", "per_unit", "hourly", "percent")


def _log_rate_history(conn, kind: str, target_id: str, old_value, new_value: float,
                      scheme: Optional[str], comment: Optional[str] = None) -> None:
    """A2: след изменения ставки/цены (kind: work_rate | price_book | catalog_markup).
    Пишется в транзакции вызывающего; changed_by — актор запроса (audit.py)."""
    conn.execute(
        """INSERT INTO rate_history (id, kind, target_id, old_value, new_value, scheme, changed_by, comment, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
        (str(uuid.uuid4()), kind, target_id, old_value, new_value, scheme,
         current_actor.get(), comment),
    )


def norm_title(s: str) -> str:
    """Нормализация названия для паттернов: casefold + схлопнутые пробелы."""
    return re.sub(r"\s+", " ", (s or "").strip()).casefold()


def resolve_work_type(conn, work_type_id: Optional[str], name: Optional[str], create: bool = True):
    """id → строка; имя → поиск NOCASE (+создание, как в вебе). Возвращает row или None."""
    if work_type_id:
        return conn.execute("SELECT * FROM work_types WHERE id = ?", (work_type_id,)).fetchone()
    if not (name or "").strip():
        return None
    row = conn.execute("SELECT * FROM work_types WHERE name = ? COLLATE NOCASE", (name.strip(),)).fetchone()
    if row or not create:
        return row
    wid = str(uuid.uuid4())
    max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM work_types").fetchone()[0]
    conn.execute("INSERT INTO work_types (id, name, sort_order) VALUES (?, ?, ?)", (wid, name.strip(), max_order + 1))
    return conn.execute("SELECT * FROM work_types WHERE id = ?", (wid,)).fetchone()


def resolve_master(conn, master_id: Optional[str], name: Optional[str]):
    if master_id:
        return conn.execute("SELECT * FROM masters WHERE id = ?", (master_id,)).fetchone()
    if not (name or "").strip():
        return None
    return conn.execute("SELECT * FROM masters WHERE name = ? COLLATE NOCASE", (name.strip(),)).fetchone()


# ─── work_rates ──────────────────────────────────────────────────────────────

class WorkRateIn(BaseModel):
    work_type_id: Optional[str] = None
    work_type_name: Optional[str] = None   # альтернатива id (финагент шлёт имена)
    master_id: Optional[str] = None
    master_name: Optional[str] = None
    scheme: str = "per_unit"
    rate: float
    unit: Optional[str] = None
    note: Optional[str] = None
    source: str = "manual"
    tiers: Optional[list] = None      # ступени по объёму [{min_qty, rate, note}];
                                      # None = не трогать существующие, [] = снести
    variable: Optional[bool] = None   # ставка-ориентир: fill не подставляет, check просит
                                      # подтвердить. None = не передан → у существующей
                                      # ставки флаг сохраняется (финагентский rate-set его не шлёт)


def upsert_work_rate(conn, work_type_id: str, master_id: Optional[str], scheme: str,
                     rate: float, unit: Optional[str], note: Optional[str], source: str,
                     overwrite: bool = True, variable: Optional[bool] = None) -> str:
    """Единая точка записи ставки. overwrite=False — не трогать существующую
    (для bootstrap/learned: ручное всегда главнее автоматического).

    variable=None — «флаг не передан»: в UPDATE колонка не участвует, иначе любой
    вызывающий, который о флаге не знает (rate-set финагента, learned, bootstrap),
    молча снял бы «ориентир» и cost-fill начал бы подставлять цену без вопроса."""
    existing = conn.execute(
        "SELECT id, source, rate, scheme FROM work_rates WHERE work_type_id = ? AND IFNULL(master_id,'') = IFNULL(?, '')",
        (work_type_id, master_id),
    ).fetchone()
    if existing:
        if not overwrite:
            return "skipped"
        sets = ["scheme=?", "rate=?", "unit=?", "note=?", "source=?"]
        params: list = [scheme, rate, unit, note, source]
        if variable is not None:
            sets.append("variable=?")
            params.append(1 if variable else 0)
        params.append(existing["id"])
        conn.execute(
            f"UPDATE work_rates SET {', '.join(sets)}, updated_at=datetime('now') WHERE id=?",
            params,
        )
        # A2: до этой записи UPDATE затирал старую ставку безвозвратно —
        # «изменил ставку сварщика → прошлые сметы объяснить нечем».
        if (existing["rate"] or 0) != rate or (existing["scheme"] or "") != scheme:
            _log_rate_history(conn, "work_rate", existing["id"],
                              existing["rate"], rate, scheme, comment=source)
        return "updated"
    conn.execute(
        """INSERT INTO work_rates (id, work_type_id, master_id, scheme, rate, unit, note, source, variable)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (str(uuid.uuid4()), work_type_id, master_id, scheme, rate, unit, note, source, 1 if variable else 0),
    )
    return "created"


def find_work_rate(conn, work_type_id: str, master_id: Optional[str]):
    """Ставка: точная пара → дефолт вида работ (master_id IS NULL)."""
    if master_id:
        row = conn.execute(
            "SELECT * FROM work_rates WHERE work_type_id = ? AND master_id = ?",
            (work_type_id, master_id),
        ).fetchone()
        if row:
            return row
    return conn.execute(
        "SELECT * FROM work_rates WHERE work_type_id = ? AND master_id IS NULL",
        (work_type_id,),
    ).fetchone()


# ─── ступени ставки по объёму партии (ТЗ 12.08.2026) ────────────────────────

def list_tiers(conn, work_rate_id: str) -> list:
    return [dict(r) for r in conn.execute(
        "SELECT * FROM work_rate_tiers WHERE work_rate_id = ? ORDER BY min_qty",
        (work_rate_id,),
    ).fetchall()]


def batch_qty(scheme: str, line_qty: Optional[float], item_qty: Optional[float]) -> float:
    """Объём партии, по которому выбирается ступень.

    per_unit/hourly — единиц (часов) работы всего: qty строки × количество изделий
    в позиции (8 гибов на стул × 5 стульев = 40 гибов, а не 8).
    fixed/percent — величина ИТОГА на изделие, партия = количество изделий."""
    q_line = line_qty if line_qty and line_qty > 0 else 1
    q_item = item_qty if item_qty and item_qty > 0 else 1
    if scheme in ("per_unit", "hourly"):
        return q_line * q_item
    return q_item


def effective_rate(conn, rate_row, qty: Optional[float] = None) -> float:
    """Ставка с учётом ступеней: наибольший min_qty <= qty, иначе базовая rate.

    Ставки без ступеней и вызовы без qty работают ровно как раньше."""
    base = rate_row["rate"]
    if qty is None:
        return base
    row = conn.execute(
        """SELECT rate FROM work_rate_tiers
           WHERE work_rate_id = ? AND min_qty <= ?
           ORDER BY min_qty DESC LIMIT 1""",
        (rate_row["id"], qty),
    ).fetchone()
    return row["rate"] if row else base


class TierIn(BaseModel):
    min_qty: int
    rate: float
    note: Optional[str] = None


def _replace_tiers(conn, work_rate_id: str, tiers: list) -> None:
    conn.execute("DELETE FROM work_rate_tiers WHERE work_rate_id = ?", (work_rate_id,))
    for t in tiers:
        _insert_tier(conn, work_rate_id, t)


def _insert_tier(conn, work_rate_id: str, t: TierIn) -> None:
    if t.min_qty is None or t.min_qty < 1:
        raise HTTPException(status_code=400, detail="min_qty must be >= 1")
    if t.rate is None or t.rate <= 0:
        raise HTTPException(status_code=400, detail="tier rate must be > 0")
    conn.execute(
        """INSERT INTO work_rate_tiers (id, work_rate_id, min_qty, rate, note)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(work_rate_id, min_qty)
           DO UPDATE SET rate=excluded.rate, note=excluded.note, updated_at=datetime('now')""",
        (str(uuid.uuid4()), work_rate_id, int(t.min_qty), t.rate, t.note),
    )


@router.post("/api/work-rates/{rate_id}/tiers")
def add_tier(rate_id: str, body: TierIn):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM work_rates WHERE id = ?", (rate_id,)).fetchone():
            raise HTTPException(status_code=404, detail="rate not found")
        _insert_tier(conn, rate_id, body)
        conn.commit()
        return {"ok": True, "tiers": list_tiers(conn, rate_id)}
    finally:
        conn.close()


@router.delete("/api/work-rate-tiers/{tier_id}")
def delete_tier(tier_id: str):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM work_rate_tiers WHERE id = ?", (tier_id,)).fetchone():
            raise HTTPException(status_code=404, detail="not found")
        conn.execute("DELETE FROM work_rate_tiers WHERE id = ?", (tier_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/api/work-rates")
def list_work_rates():
    conn = get_production()
    try:
        rows = conn.execute(
            """SELECT wr.*, wt.name AS work_type_name, m.name AS master_name
               FROM work_rates wr
               JOIN work_types wt ON wt.id = wr.work_type_id
               LEFT JOIN masters m ON m.id = wr.master_id
               ORDER BY wt.sort_order, wt.name, m.name"""
        ).fetchall()
        tiers_by_rate: dict = {}
        for t in conn.execute("SELECT * FROM work_rate_tiers ORDER BY min_qty").fetchall():
            tiers_by_rate.setdefault(t["work_rate_id"], []).append(dict(t))
        # Дыры: виды работ вовсе без ставок — финагенту и вебу видно, что спрашивать.
        no_rate = conn.execute(
            """SELECT wt.id, wt.name FROM work_types wt
               WHERE NOT EXISTS (SELECT 1 FROM work_rates wr WHERE wr.work_type_id = wt.id)
               ORDER BY wt.sort_order, wt.name"""
        ).fetchall()
        return {"rates": [{**dict(r), "tiers": tiers_by_rate.get(r["id"], [])} for r in rows],
                "work_types_without_rate": [dict(r) for r in no_rate]}
    finally:
        conn.close()


@router.post("/api/work-rates")
def create_work_rate(body: WorkRateIn):
    if body.scheme not in RATE_SCHEMES:
        raise HTTPException(status_code=400, detail=f"scheme must be one of {'|'.join(RATE_SCHEMES)}")
    if body.rate is None or body.rate <= 0:
        raise HTTPException(status_code=400, detail="rate must be > 0")
    conn = get_production()
    try:
        wt = resolve_work_type(conn, body.work_type_id, body.work_type_name)
        if not wt:
            raise HTTPException(status_code=400, detail="work_type_id or work_type_name required")
        master = resolve_master(conn, body.master_id, body.master_name)
        if (body.master_id or body.master_name) and not master:
            raise HTTPException(status_code=404, detail=f"Мастер не найден: {body.master_id or body.master_name}")
        upsert_work_rate(conn, wt["id"], master["id"] if master else None,
                         body.scheme, body.rate, body.unit, body.note, body.source,
                         variable=body.variable)
        row = conn.execute(
            "SELECT * FROM work_rates WHERE work_type_id = ? AND IFNULL(master_id,'') = IFNULL(?, '')",
            (wt["id"], master["id"] if master else None),
        ).fetchone()
        if body.tiers is not None:
            _replace_tiers(conn, row["id"], [TierIn(**t) if isinstance(t, dict) else t for t in body.tiers])
        conn.commit()
        return {**dict(row), "work_type_name": wt["name"],
                "master_name": master["name"] if master else None,
                "tiers": list_tiers(conn, row["id"])}
    finally:
        conn.close()


@router.delete("/api/work-rates/{rate_id}")
def delete_work_rate(rate_id: str):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM work_rates WHERE id = ?", (rate_id,)).fetchone():
            raise HTTPException(status_code=404, detail="not found")
        conn.execute("DELETE FROM work_rate_tiers WHERE work_rate_id = ?", (rate_id,))
        conn.execute("DELETE FROM work_rates WHERE id = ?", (rate_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/api/work-rates/bootstrap")
def bootstrap_work_rates():
    """Первичное наполнение ставок. Идемпотентно, существующее не перезаписывает.

    1) Вики финагента (analytics.contractors): pay_scheme/pay_rate → ставка на каждую
       связку мастера из master_work_types. mes_master_id хранит masters.id (!).
    2) История: creditors с estimate_line_id → строка с work_type_id → per_unit
       из amount_plan/qty."""
    created, skipped, details = 0, 0, []
    conn = get_production()
    try:
        # 1. Вики
        try:
            aconn = get_analytics_ro()
            try:
                contractors = aconn.execute(
                    """SELECT name, pay_scheme, pay_rate, pay_note, mes_master_id FROM contractors
                       WHERE pay_scheme IS NOT NULL AND pay_scheme != ''
                         AND pay_rate IS NOT NULL AND mes_master_id IS NOT NULL"""
                ).fetchall()
            finally:
                aconn.close()
        except Exception:
            contractors = []
        for c in contractors:
            scheme = c["pay_scheme"] if c["pay_scheme"] in RATE_SCHEMES else "per_unit"
            master = conn.execute("SELECT id, name FROM masters WHERE id = ?", (c["mes_master_id"],)).fetchone()
            if not master:
                continue
            links = conn.execute(
                "SELECT work_type_id FROM master_work_types WHERE master_id = ?", (master["id"],)
            ).fetchall()
            for l in links:
                res = upsert_work_rate(
                    conn, l["work_type_id"], master["id"], scheme, c["pay_rate"],
                    "шт" if scheme in ("fixed", "per_unit") else None,
                    c["pay_note"], "wiki", overwrite=False,
                )
                if res == "created":
                    created += 1
                    details.append(f"wiki: {c['name']} · {scheme} {c['pay_rate']}")
                else:
                    skipped += 1

        # 2. История обязательств по строкам смет
        hist = conn.execute(
            """SELECT el.work_type_id, el.master_id, el.qty, c.amount_plan
               FROM creditors c JOIN estimate_lines el ON el.id = c.estimate_line_id
               WHERE el.work_type_id IS NOT NULL AND c.amount_plan > 0"""
        ).fetchall()
        for h in hist:
            qty = h["qty"] or 1
            rate = round((h["amount_plan"] or 0) / qty, 2)
            if rate <= 0:
                continue
            res = upsert_work_rate(
                conn, h["work_type_id"], h["master_id"], "per_unit", rate, "шт",
                "из истории обязательств", "history", overwrite=False,
            )
            if res == "created":
                created += 1
            else:
                skipped += 1

        conn.commit()
        return {"created": created, "skipped": skipped, "details": details}
    finally:
        conn.close()


# ─── price_book ──────────────────────────────────────────────────────────────

class PriceBookIn(BaseModel):
    title: str
    price: float
    unit: Optional[str] = None
    match_type: str = "exact"
    pattern: Optional[str] = None   # по умолчанию norm_title(title)
    note: Optional[str] = None
    source: str = "manual"


def upsert_price_book(conn, title: str, price: float, unit: Optional[str], match_type: str,
                      source: str, note: Optional[str] = None, pattern: Optional[str] = None,
                      overwrite: bool = True) -> str:
    pat = norm_title(pattern or title)
    existing = conn.execute(
        "SELECT id, price FROM price_book WHERE pattern = ? AND match_type = ?", (pat, match_type)
    ).fetchone()
    if existing:
        if not overwrite:
            return "skipped"
        conn.execute(
            """UPDATE price_book SET title=?, price=?, unit=?, note=?, source=?, updated_at=datetime('now')
               WHERE id=?""",
            (title, price, unit, note, source, existing["id"]),
        )
        if (existing["price"] or 0) != price:
            _log_rate_history(conn, "price_book", str(existing["id"]),
                              existing["price"], price, None, comment=source)
        return "updated"
    conn.execute(
        """INSERT INTO price_book (pattern, match_type, title, unit, price, source, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (pat, match_type, title, unit, price, source, note),
    )
    return "created"


def find_price_book(conn, title: str):
    """exact по норме → contains-правила (паттерн входит в название)."""
    t = norm_title(title)
    if not t:
        return None
    row = conn.execute(
        "SELECT * FROM price_book WHERE match_type = 'exact' AND pattern = ?", (t,)
    ).fetchone()
    if row:
        return row
    for r in conn.execute("SELECT * FROM price_book WHERE match_type = 'contains'"):
        if r["pattern"] and r["pattern"] in t:
            return r
    return None


@router.get("/api/price-book")
def list_price_book(search: Optional[str] = None):
    conn = get_production()
    try:
        sql = "SELECT * FROM price_book"
        params: list = []
        if search:
            sql += " WHERE pattern LIKE ? OR title LIKE ?"
            params = [f"%{search}%"] * 2
        sql += " ORDER BY updated_at DESC"
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


@router.post("/api/price-book")
def create_price_book(body: PriceBookIn):
    if not (body.title or "").strip():
        raise HTTPException(status_code=400, detail="title required")
    if body.price is None or body.price <= 0:
        raise HTTPException(status_code=400, detail="price must be > 0")
    if body.match_type not in ("exact", "contains"):
        raise HTTPException(status_code=400, detail="match_type must be exact|contains")
    conn = get_production()
    try:
        upsert_price_book(conn, body.title.strip(), body.price, body.unit, body.match_type,
                          body.source, body.note, body.pattern)
        conn.commit()
        return dict(conn.execute(
            "SELECT * FROM price_book WHERE pattern = ? AND match_type = ?",
            (norm_title(body.pattern or body.title), body.match_type),
        ).fetchone())
    finally:
        conn.close()


@router.delete("/api/price-book/{entry_id}")
def delete_price_book(entry_id: int):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM price_book WHERE id = ?", (entry_id,)).fetchone():
            raise HTTPException(status_code=404, detail="not found")
        conn.execute("DELETE FROM price_book WHERE id = ?", (entry_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ─── costing_rules ───────────────────────────────────────────────────────────

RULE_KINDS = ("material", "catalog", "work")


class CostingRuleIn(BaseModel):
    pattern: str
    kind: str                       # material | catalog | work
    target_id: str
    match_type: str = "exact"
    source: str = "learned"


def find_costing_rule(conn, title: str, kind: str):
    t = norm_title(title)
    if not t:
        return None
    row = conn.execute(
        "SELECT * FROM costing_rules WHERE kind = ? AND match_type = 'exact' AND pattern = ?",
        (kind, t),
    ).fetchone()
    if row:
        return row
    for r in conn.execute("SELECT * FROM costing_rules WHERE kind = ? AND match_type = 'contains'", (kind,)):
        if r["pattern"] and r["pattern"] in t:
            return r
    return None


@router.get("/api/costing-rules")
def list_costing_rules(kind: Optional[str] = None):
    conn = get_production()
    try:
        sql, params = "SELECT * FROM costing_rules", []
        if kind:
            sql += " WHERE kind = ?"
            params = [kind]
        sql += " ORDER BY kind, pattern"
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


@router.post("/api/costing-rules")
def create_costing_rule(body: CostingRuleIn):
    if body.kind not in RULE_KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {'|'.join(RULE_KINDS)}")
    if not (body.pattern or "").strip() or not (body.target_id or "").strip():
        raise HTTPException(status_code=400, detail="pattern and target_id required")
    if body.match_type not in ("exact", "contains"):
        raise HTTPException(status_code=400, detail="match_type must be exact|contains")
    pat = norm_title(body.pattern)
    conn = get_production()
    try:
        existing = conn.execute(
            "SELECT id FROM costing_rules WHERE pattern = ? AND kind = ?", (pat, body.kind)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE costing_rules SET target_id=?, match_type=?, source=?, updated_at=datetime('now') WHERE id=?",
                (body.target_id, body.match_type, body.source, existing["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO costing_rules (pattern, match_type, kind, target_id, source) VALUES (?, ?, ?, ?, ?)",
                (pat, body.match_type, body.kind, body.target_id, body.source),
            )
        conn.commit()
        return dict(conn.execute(
            "SELECT * FROM costing_rules WHERE pattern = ? AND kind = ?", (pat, body.kind)
        ).fetchone())
    finally:
        conn.close()


@router.delete("/api/costing-rules/{rule_id}")
def delete_costing_rule(rule_id: int):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM costing_rules WHERE id = ?", (rule_id,)).fetchone():
            raise HTTPException(status_code=404, detail="not found")
        conn.execute("DELETE FROM costing_rules WHERE id = ?", (rule_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/api/work-prices")
def work_prices():
    """История цен на работы: что и почём делали раньше. Заменяет справочник ставок
    там, где цена разовая — Юре нужна вилка и последние цифры, а не «одна ставка»."""
    conn = get_production()
    try:
        rows = conn.execute(
            """SELECT el.title, el.unit, el.unit_price, el.master_id,
                      es.created_at, o.title AS order_title, o.brand, m.name AS master_name
               FROM estimate_lines el
               JOIN estimate_items ei ON ei.id = el.item_id
               JOIN estimate_sets es ON es.id = ei.set_id
               JOIN orders o ON o.id = es.order_id
               LEFT JOIN masters m ON m.id = el.master_id
               WHERE el.type IN ('labor','service') AND COALESCE(el.unit_price,0) > 0
               ORDER BY es.created_at DESC"""
        ).fetchall()
        groups: dict = {}
        for r in rows:
            key = norm_title(r["title"])
            if not key:
                continue
            g = groups.setdefault(key, {"title": (r["title"] or "").strip(), "prices": [], "recent": []})
            g["prices"].append(r["unit_price"])
            if len(g["recent"]) < 5:
                g["recent"].append({
                    "price": r["unit_price"], "unit": r["unit"],
                    "date": (r["created_at"] or "")[:10],
                    "order": r["order_title"], "brand": r["brand"], "master": r["master_name"],
                })
        out = []
        for g in groups.values():
            p = sorted(g["prices"])
            mid = len(p) // 2
            median = p[mid] if len(p) % 2 else (p[mid - 1] + p[mid]) / 2
            lo, hi = int(len(p) * 0.25), max(0, int(len(p) * 0.75) - 1)
            out.append({
                "title": g["title"], "count": len(p),
                "min": p[0], "max": p[-1], "median": round(median, 2),
                "typical_min": p[lo], "typical_max": p[hi],
                "last": g["recent"][0]["price"] if g["recent"] else None,
                "recent": g["recent"],
            })
        out.sort(key=lambda x: -x["count"])
        return {"items": out, "count": len(out)}
    finally:
        conn.close()
