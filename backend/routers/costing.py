"""Costing-движок: «заполнить себестоимость или спросить».

Один резолвер «строка сметы → источник цены», три потребителя: cost-check (dry-run),
cost-fill (apply) и — через них — блок в EstimateEditor и команды финагента.

Порядок резолва:
  позиция без строк → рецептура каталога (catalog_item_id / правило / точное имя) с живыми ценами;
  материал → material_code+прайс (заморозка) → правило название→код → exact-матч
             номенклатуры → price_book (выученные цены вне прайсов) → missing;
  работа   → work_type (+исполнитель) → work_rates (пара → дефолт вида) → missing;
             percent-схема = % от клиентской цены позиции (с bank_pct для безнала).
Missing идёт списком с готовой формулировкой вопроса (ask) — её показывает веб
и печатает финагент; ответ пишется в справочники (rates.py) и подставляется впредь.

Монтируется с prefix /api/estimates (rядом с estimates.router — тот и так ~1000 строк).
"""
import uuid
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import get_production, get_materials
from routers.estimates import (
    _lookup_cheapest, _recalc_item, _touch_set, _assert_set_editable, _now,
)
from routers.rates import norm_title, find_work_rate, find_price_book, find_costing_rule

router = APIRouter()


# ─── матчинг ────────────────────────────────────────────────────────────────

def _match_catalog_item(conn, title: str):
    """Позиция сметы → рецептура каталога: правило → точное имя → уникальный substring."""
    rule = find_costing_rule(conn, title, "catalog")
    if rule:
        row = conn.execute("SELECT * FROM catalog_items WHERE id = ?", (rule["target_id"],)).fetchone()
        if row:
            return row, "rule"
    t = norm_title(title)
    if not t:
        return None, None
    rows = conn.execute("SELECT * FROM catalog_items").fetchall()
    for r in rows:
        if norm_title(r["title"]) == t:
            return r, "exact"
    cands = [r for r in rows if norm_title(r["title"]) and (norm_title(r["title"]) in t or t in norm_title(r["title"]))]
    if len(cands) == 1:
        return cands[0], "fuzzy"
    return None, None


def _match_material_code(conn, title: str):
    """Название материала → код номенклатуры: правило → ТОЧНОЕ совпадение названия
    карточки (осторожно: похожие профили металла легко перепутать, substring не делаем —
    неоднозначное Юра привязывает один раз руками, дальше работает правило)."""
    rule = find_costing_rule(conn, title, "material")
    if rule:
        return rule["target_id"], "rule"
    t = norm_title(title)
    if not t:
        return None, None
    try:
        mconn = get_materials()
        try:
            for r in mconn.execute("SELECT code, title FROM catalog"):
                if norm_title(r["title"]) == t:
                    return r["code"], "exact"
        finally:
            mconn.close()
    except Exception:
        pass
    return None, None


def _client_price_per_unit(item, set_row) -> float:
    """Клиентская цена одного изделия позиции (та же формула, что set_totals)."""
    sale = item["sale_price"] or 0
    if (set_row["payment_type"] or "cash") == "bank":
        pct = item["bank_pct"] if item["bank_pct"] is not None else (set_row["bank_pct"] or 13)
        sale = sale * (1 + pct / 100)
    qty = item["quantity"] or 1
    return sale / qty if qty else sale


def _rate_price(rate, item, set_row, line_qty: float) -> float:
    """Цена строки по ставке. Все схемы кроме percent кладутся как unit_price=rate:
    fixed ₽/изделие ложится в qty=1 (умножение на кол-во изделий делает _recalc_item),
    per_unit/hourly — цена за единицу/час. percent — % от клиентской цены изделия."""
    if rate["scheme"] == "percent":
        per_unit_client = _client_price_per_unit(item, set_row)
        q = line_qty or 1
        return round(rate["rate"] / 100.0 * per_unit_client / q, 2)
    return round(rate["rate"], 2)


# ─── резолвер строки ────────────────────────────────────────────────────────

def _resolve_line(conn, line, item, set_row) -> dict:
    ltype = line["type"] or "other"
    has_price = (line["unit_price"] or 0) > 0
    out = {
        "line_id": line["id"], "title": line["title"], "type": ltype,
        "qty": line["qty"], "unit": line["unit"], "unit_price": line["unit_price"] or 0,
        "status": "ok",
    }

    if ltype == "material":
        code, via = (line["material_code"], "code") if line["material_code"] else _match_material_code(conn, line["title"])
        if code:
            best = _lookup_cheapest(code)
            if best and best.get("price"):
                if not has_price:
                    out.update(status="proposed", source="materials", proposal={
                        "unit_price": best["price"], "material_code": code,
                        "price_supplier": best["supplier"], "price_date": best["price_date"], "via": via,
                    })
                elif line["material_code"] and abs((best["price"] or 0) - (line["unit_price"] or 0)) > 0.01:
                    # цена заморожена, но прайс уехал — предложение перезаморозки (refresh_materials)
                    out.update(status="refresh", source="materials", proposal={
                        "unit_price": best["price"], "material_code": code,
                        "price_supplier": best["supplier"], "price_date": best["price_date"],
                    })
                return out
        pb = find_price_book(conn, line["title"])
        if pb:
            if not has_price:
                out.update(status="proposed", source="price_book", proposal={
                    "unit_price": pb["price"], "price_book_id": pb["id"], "unit": pb["unit"],
                })
            return out
        if not has_price:
            out.update(status="missing", reason="no_material_match",
                       ask=f"Цена «{line['title'] or 'материал'}», ₽/{line['unit'] or 'ед'}?")
        return out

    if ltype in ("labor", "service"):
        wt_id, via = line["work_type_id"], "line"
        if not wt_id and (line["title"] or "").strip():
            wt = conn.execute(
                "SELECT id FROM work_types WHERE name = ? COLLATE NOCASE", (line["title"].strip(),)
            ).fetchone()
            if wt:
                wt_id, via = wt["id"], "name"
        if not wt_id:
            if not has_price:
                out.update(status="missing", reason="no_work_type",
                           ask=f"Работа «{line['title'] or '—'}»: какой это вид работ и почём?")
            return out
        rate = find_work_rate(conn, wt_id, line["master_id"])
        if not rate:
            if not has_price:
                wt = conn.execute("SELECT name FROM work_types WHERE id = ?", (wt_id,)).fetchone()
                master = conn.execute("SELECT name FROM masters WHERE id = ?", (line["master_id"],)).fetchone() if line["master_id"] else None
                who = f" у {master['name']}" if master else ""
                out.update(status="missing", reason="no_rate",
                           ask=f"Ставка за «{wt['name'] if wt else line['title']}»{who}: сколько и как (₽/шт, ₽/ч, фикс за изделие, % от цены)?",
                           work_type_id=wt_id,
                           work_type_name=wt["name"] if wt else None,
                           master_id=line["master_id"],
                           master_name=master["name"] if master else None)
            return out
        if not has_price:
            out.update(status="proposed",
                       source="percent" if rate["scheme"] == "percent" else "work_rate",
                       proposal={
                           "unit_price": _rate_price(rate, item, set_row, line["qty"]),
                           "work_rate_id": rate["id"], "scheme": rate["scheme"], "rate": rate["rate"],
                           **({"work_type_id": wt_id} if via == "name" else {}),
                       })
        return out

    # delivery / other
    if not has_price:
        out.update(status="missing", reason="no_price",
                   ask=f"«{line['title'] or ltype}»: сколько заложить, ₽?")
    return out


# ─── отчёт (dry-run) ────────────────────────────────────────────────────────

def _cost_report(conn, set_id: str) -> dict:
    es = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
    if not es:
        raise HTTPException(status_code=404, detail="Set not found")
    items = conn.execute(
        "SELECT * FROM estimate_items WHERE set_id = ? ORDER BY sort_order", (set_id,)
    ).fetchall()

    out_items, missing = [], []
    counts = {"ok": 0, "proposed": 0, "refresh": 0, "missing": 0}
    lines_total = 0

    for item in items:
        lines = conn.execute(
            "SELECT * FROM estimate_lines WHERE item_id = ? ORDER BY sort_order", (item["id"],)
        ).fetchall()
        it_out = {"item_id": item["id"], "title": item["title"],
                  "quantity": item["quantity"], "cost_total": item["cost_total"],
                  "lines": [], "catalog_match": None}

        if not lines:
            # Позиция без состава (типовой случай финагентской сметы)
            cat, via = (None, None)
            if item["catalog_item_id"]:
                cat = conn.execute("SELECT * FROM catalog_items WHERE id = ?", (item["catalog_item_id"],)).fetchone()
                via = "id"
            if not cat:
                cat, via = _match_catalog_item(conn, item["title"])
            if cat:
                cat_lines_n = conn.execute(
                    "SELECT COUNT(*) FROM catalog_item_lines WHERE item_id = ?", (cat["id"],)
                ).fetchone()[0]
                it_out["catalog_match"] = {
                    "catalog_item_id": cat["id"], "title": cat["title"], "via": via,
                    "lines_count": cat_lines_n, "will_expand": cat_lines_n > 0,
                }
            elif (item["cost_total"] or 0) <= 0:
                missing.append({
                    "scope": "item", "id": item["id"], "kind": "catalog",
                    "title": item["title"],
                    "ask": f"Позиция «{item['title'] or 'Без названия'}» без состава и себестоимости — из чего состоит (материалы/работы) или какая рецептура каталога?",
                })

        for line in lines:
            lines_total += 1
            res = _resolve_line(conn, line, item, es)
            it_out["lines"].append(res)
            counts[res["status"]] = counts.get(res["status"], 0) + 1
            if res["status"] == "missing":
                entry = {"scope": "line", "id": line["id"], "kind": res.get("reason"),
                         "title": line["title"], "ask": res.get("ask"),
                         "unit": line["unit"], "qty": line["qty"], "line_type": res["type"]}
                # Контекст для форм ответа в вебе/у финагента
                for k in ("work_type_id", "work_type_name", "master_id", "master_name"):
                    if res.get(k):
                        entry[k] = res[k]
                missing.append(entry)

        out_items.append(it_out)

    return {
        "set_id": set_id,
        "set_status": es["status"],
        "items": out_items,
        "summary": {"lines_total": lines_total, **counts,
                    "items_expandable": sum(1 for i in out_items if (i["catalog_match"] or {}).get("will_expand"))},
        "missing": missing,
    }


@router.get("/sets/{set_id}/cost-check")
def cost_check(set_id: str):
    conn = get_production()
    try:
        return _cost_report(conn, set_id)
    finally:
        conn.close()


# ─── применение (cost-fill) ─────────────────────────────────────────────────

def _expand_item_from_catalog(conn, item, set_row, catalog_item_id: str) -> int:
    """Развернуть рецептуру каталога в строки существующей позиции: материалы —
    с живыми ценами по material_code, работы — по ставкам. Возвращает число строк."""
    cat_lines = conn.execute(
        "SELECT * FROM catalog_item_lines WHERE item_id = ? ORDER BY sort_order", (catalog_item_id,)
    ).fetchall()
    for i, cl in enumerate(cat_lines):
        unit_price = cl["unit_price"] or 0
        price_supplier = price_date = None
        code = cl["material_code"]
        if code:
            best = _lookup_cheapest(code)
            if best and best.get("price"):
                unit_price, price_supplier, price_date = best["price"], best["supplier"], best["price_date"]
        if cl["type"] in ("labor", "service") and cl["work_type_id"]:
            rate = find_work_rate(conn, cl["work_type_id"], cl["master_id"])
            if rate:
                unit_price = _rate_price(rate, item, set_row, cl["qty"])
        conn.execute(
            """INSERT INTO estimate_lines (id, item_id, type, title, qty, unit, unit_price, line_total,
                                           sort_order, material_code, price_supplier, price_date,
                                           work_type_id, master_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (str(uuid.uuid4()), item["id"], cl["type"], cl["title"], cl["qty"], cl["unit"],
             unit_price, round((cl["qty"] or 0) * unit_price, 2), i,
             code, price_supplier, price_date, cl["work_type_id"], cl["master_id"], _now()),
        )
    conn.execute("UPDATE estimate_items SET catalog_item_id = ? WHERE id = ?", (catalog_item_id, item["id"]))
    return len(cat_lines)


class CostFillIn(BaseModel):
    expand_items: bool = True
    refresh_materials: bool = False
    only: Optional[List[str]] = None   # применить только к этим line_id


@router.post("/sets/{set_id}/cost-fill")
def cost_fill(set_id: str, body: Optional[CostFillIn] = None):
    body = body or CostFillIn()
    conn = get_production()
    try:
        _assert_set_editable(conn, set_id)
        es = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not es:
            raise HTTPException(status_code=404, detail="Set not found")

        applied = {"expanded_items": 0, "expanded_lines": 0, "filled_lines": 0, "refreshed_lines": 0}
        touched_items = set()

        # 1. Разворот пустых позиций из каталога
        if body.expand_items:
            report = _cost_report(conn, set_id)
            for it in report["items"]:
                cm = it.get("catalog_match") or {}
                if not it["lines"] and cm.get("will_expand"):
                    item_row = conn.execute("SELECT * FROM estimate_items WHERE id = ?", (it["item_id"],)).fetchone()
                    n = _expand_item_from_catalog(conn, item_row, es, cm["catalog_item_id"])
                    applied["expanded_items"] += 1
                    applied["expanded_lines"] += n
                    touched_items.add(it["item_id"])

        # 2. Заполнение по свежему отчёту (после разворота)
        report = _cost_report(conn, set_id)
        for it in report["items"]:
            for res in it["lines"]:
                if body.only and res["line_id"] not in body.only:
                    continue
                prop = res.get("proposal")
                if not prop:
                    continue
                if res["status"] == "refresh" and not body.refresh_materials:
                    continue
                if res["status"] not in ("proposed", "refresh"):
                    continue
                line = conn.execute("SELECT * FROM estimate_lines WHERE id = ?", (res["line_id"],)).fetchone()
                fields = {"unit_price": prop["unit_price"]}
                for k in ("material_code", "price_supplier", "price_date", "work_type_id"):
                    if prop.get(k):
                        fields[k] = prop[k]
                fields["line_total"] = round((line["qty"] or 0) * prop["unit_price"], 2)
                set_clause = ", ".join(f"{k} = ?" for k in fields)
                conn.execute(f"UPDATE estimate_lines SET {set_clause} WHERE id = ?",
                             list(fields.values()) + [res["line_id"]])
                if prop.get("price_book_id"):
                    conn.execute(
                        "UPDATE price_book SET times_used = COALESCE(times_used,0)+1, last_used_at = datetime('now') WHERE id = ?",
                        (prop["price_book_id"],),
                    )
                touched_items.add(line["item_id"])
                applied["refreshed_lines" if res["status"] == "refresh" else "filled_lines"] += 1

        for iid in touched_items:
            _recalc_item(conn, iid)
            # Позиция из каталога без продажной цены — первичная продажа = себест × наценка
            fresh = conn.execute("SELECT cost_total, sale_price, markup FROM estimate_items WHERE id = ?", (iid,)).fetchone()
            if fresh and (fresh["sale_price"] or 0) <= 0 and (fresh["cost_total"] or 0) > 0:
                conn.execute("UPDATE estimate_items SET sale_price = ? WHERE id = ?",
                             (round(fresh["cost_total"] * (fresh["markup"] or 2.0), 2), iid))
            _touch_set(conn, iid)
        conn.commit()

        final = _cost_report(conn, set_id)
        final["applied"] = applied
        return final
    finally:
        conn.close()
