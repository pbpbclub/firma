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
from money import client_price
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


def _work_price_history(conn, title: str, master_id: Optional[str], limit: int = 5) -> dict:
    """Что эта работа стоила раньше. Мастера называют цену каждый раз новую
    (сварка в сметах Юры: 1 700…30 000 ₽), поэтому фиксированная ставка врёт —
    показываем вилку и последние цены, а сумму он вводит сам.

    Ищем по названию строки: work_type_id заполнен у 2 строк из 75, master_id — ни у одной."""
    t = norm_title(title)
    if not t:
        return {}
    rows = conn.execute(
        """SELECT el.unit_price, el.unit, el.title, el.master_id,
                  es.created_at, o.title AS order_title, m.name AS master_name
           FROM estimate_lines el
           JOIN estimate_items ei ON ei.id = el.item_id
           JOIN estimate_sets es ON es.id = ei.set_id
           JOIN orders o ON o.id = es.order_id
           LEFT JOIN masters m ON m.id = el.master_id
           WHERE el.type IN ('labor','service') AND COALESCE(el.unit_price,0) > 0
           ORDER BY es.created_at DESC""",
    ).fetchall()
    same = [r for r in rows if norm_title(r["title"]) == t]
    if not same:
        return {}
    prices = sorted(r["unit_price"] for r in same)
    mid = len(prices) // 2
    median = prices[mid] if len(prices) % 2 else (prices[mid - 1] + prices[mid]) / 2
    # Вилка «обычно»: середина выборки, без выбросов по краям
    lo_i, hi_i = int(len(prices) * 0.25), max(0, int(len(prices) * 0.75) - 1)
    by_master = [r for r in same if master_id and r["master_id"] == master_id]
    recent = (by_master or same)[:limit]
    return {
        "count": len(same),
        "median": round(median, 2),
        "typical_min": prices[lo_i], "typical_max": prices[hi_i],
        "min": prices[0], "max": prices[-1],
        "recent": [{"price": r["unit_price"], "unit": r["unit"],
                    "date": (r["created_at"] or "")[:10],
                    "order": r["order_title"], "master": r["master_name"]} for r in recent],
    }


def _history_hint(h: dict) -> str:
    """Хвост вопроса: «обычно 2 500–6 000 ₽; последние — 3 000 (18.06, MIRRA), 4 500 (05.06)»."""
    if not h:
        return ""
    parts = []
    if h["count"] > 2 and h["typical_min"] != h["typical_max"]:
        parts.append(f"обычно {h['typical_min']:g}–{h['typical_max']:g} ₽")
    last = ", ".join(
        f"{r['price']:g}" + (f" ({r['date'][8:10]}.{r['date'][5:7]}, {r['order'][:18]})" if r["date"] and r["order"] else "")
        for r in h["recent"][:3])
    if last:
        parts.append(f"последние — {last}")
    return ("; ".join(parts) + ". ") if parts else ""


STUB_MARKUP = 2.0   # дефолт `production.py estimate-create --markup`


def _is_stub_cost(item) -> bool:
    """Себестоимость — заглушка `цена ÷ наценка` из production.py estimate-create,
    а не расчёт по составу: цена ровно вдвое больше себестоимости при дефолтной
    наценке 2.0. Осознанно введённые суммы (доставка в минус, транзит 13%) дают
    произвольную наценку и заглушками НЕ считаются — их видно отдельным списком."""
    cost = item["cost_total"] or 0
    sale = item["sale_price"] or 0
    markup = item["markup"] or 0
    if cost <= 0 or sale <= 0 or markup <= 0:
        return False
    return abs(markup - STUB_MARKUP) < 0.001 and abs(cost * markup - sale) < 1.0


def _is_sum_without_breakdown(item) -> bool:
    """Себестоимость введена одной суммой, состава нет — не тревожно, но видеть полезно."""
    return (item["cost_total"] or 0) > 0 and not _is_stub_cost(item)


def _client_price_per_unit(item, set_row) -> float:
    """Клиентская цена одного изделия позиции (та же формула, что set_totals)."""
    sale = item["sale_price"] or 0
    pct = set_row["bank_pct"]   # удержание — свойство сметы, см. money.py
    # rounded=False: округление до 100 ₽ — свойство ИТОГА счёта, а не цены за единицу
    sale = client_price(sale, set_row["payment_type"] or "cash", pct, rounded=False)
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
        # Цену работы НЕ подставляем автоматически: мастера называют её каждый раз
        # заново (сварка в сметах Юры: 1 700…30 000 ₽). Спрашиваем всегда, но с
        # подсказкой — вилка и последние цены из истории; ставка из справочника,
        # если есть, идёт лишь ориентиром.
        if not has_price:
            wt = conn.execute("SELECT name FROM work_types WHERE id = ?", (wt_id,)).fetchone() if wt_id else None
            master = conn.execute("SELECT name FROM masters WHERE id = ?", (line["master_id"],)).fetchone() if line["master_id"] else None
            who = f" у {master['name']}" if master else ""
            name = (wt["name"] if wt else None) or line["title"] or "—"
            hist = _work_price_history(conn, line["title"] or name, line["master_id"])
            rate = find_work_rate(conn, wt_id, line["master_id"]) if wt_id else None
            hint = _history_hint(hist)
            if not hint and rate:
                unit_lbl = {"per_unit": "₽/ед", "hourly": "₽/ч", "fixed": "₽ за изделие",
                            "percent": "%"}.get(rate["scheme"], "₽")
                hint = f"ориентир {rate['rate']:g} {unit_lbl}. "
            out.update(status="missing", reason="ask_price",
                       ask=f"Работа «{name}»{who}: {hint}Сколько в этот раз, ₽/{line['unit'] or 'ед'}?",
                       work_type_id=wt_id,
                       work_type_name=wt["name"] if wt else None,
                       master_id=line["master_id"],
                       master_name=master["name"] if master else None)
            if hist:
                out["history"] = hist
            if rate:
                out["prefill_scheme"] = rate["scheme"]
                out["prefill_rate"] = rate["rate"]
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
            elif _is_stub_cost(item):
                # Себестоимость = цена ÷ наценка: это заглушка estimate-create, а не
                # расчёт. Раньше она молча проходила как «посчитано» (cost_total > 0),
                # и отчёт показывал «вопросов 0» на смете без единой реальной цифры.
                missing.append({
                    "scope": "item", "id": item["id"], "kind": "stub",
                    "title": item["title"],
                    "cost_total": item["cost_total"], "sale_price": item["sale_price"],
                    # разделитель тысяч меняем только в самом числе: .replace на всей
                    # строке съедал запятую в тексте вопроса
                    "ask": (f"Позиция «{item['title'] or 'Без названия'}»: себестоимость "
                            f"{(item['cost_total'] or 0):,.0f}".replace(",", " ")
                            + " ₽ — это просто цена ÷ наценка, а не расчёт. Сколько она стоит на самом деле?"),
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
                # is not None, а не truthiness: prefill_rate=0 — валидный ориентир,
                # форма должна показать ноль, а не пустое поле
                for k in ("work_type_id", "work_type_name", "master_id", "master_name",
                          "prefill_scheme", "prefill_rate", "variable"):
                    if res.get(k) is not None:
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


# ─── готовность к заполнению: что мешает доверять цифрам ────────────────────

@router.get("/readiness")
def readiness():
    """Сводка «что не заполнено» по всем живым заказам: дубли смет, позиции с
    заглушкой вместо себестоимости, дыры и мусор в ставках. Один экран вместо
    обхода каждой сметы руками."""
    conn = get_production()
    try:
        orders = conn.execute(
            "SELECT id, number, title, brand, status FROM orders WHERE COALESCE(archived,0) = 0"
        ).fetchall()

        duplicate_sets, stub_items, sum_only_items = [], [], []
        for o in orders:
            sets = conn.execute(
                """SELECT id, title, status, created_at, updated_at FROM estimate_sets
                   WHERE order_id = ? AND COALESCE(status,'') != 'superseded'
                   ORDER BY created_at DESC""", (o["id"],)
            ).fetchall()
            enriched = []
            for s in sets:
                items = conn.execute(
                    "SELECT * FROM estimate_items WHERE set_id = ?", (s["id"],)
                ).fetchall()
                lines_n = conn.execute(
                    """SELECT COUNT(*) FROM estimate_lines el JOIN estimate_items ei ON ei.id = el.item_id
                       WHERE ei.set_id = ?""", (s["id"],)
                ).fetchone()[0]
                enriched.append({
                    "set_id": s["id"], "title": s["title"], "status": s["status"],
                    "created_at": s["created_at"], "updated_at": s["updated_at"],
                    "items": len(items), "lines": lines_n,
                    "sale_total": round(sum((i["sale_price"] or 0) for i in items), 2),
                    "cost_total": round(sum((i["cost_total"] or 0) for i in items), 2),
                })
                for it in items:
                    has_lines = conn.execute(
                        "SELECT COUNT(*) FROM estimate_lines WHERE item_id = ?", (it["id"],)
                    ).fetchone()[0]
                    if has_lines:
                        continue
                    entry = {
                        "order_id": o["id"], "order_number": o["number"],
                        "order_title": o["title"], "brand": o["brand"],
                        "set_id": s["id"], "set_status": s["status"],
                        "item_id": it["id"], "title": it["title"],
                        "quantity": it["quantity"], "markup": it["markup"],
                        "sale_price": it["sale_price"], "cost_total": it["cost_total"],
                    }
                    if _is_stub_cost(it):
                        stub_items.append(entry)
                    elif _is_sum_without_breakdown(it):
                        sum_only_items.append(entry)
            if len(enriched) > 1:
                duplicate_sets.append({
                    "order_id": o["id"], "order_number": o["number"],
                    "order_title": o["title"], "brand": o["brand"], "sets": enriched,
                })

        # Ставки: дыры и мусор. Ставка «Сварка 30 000 ₽/шт» выучена из истории целых
        # заказов — в новой смете подставится как цена за штуку и раздует себестоимость.
        rate_holes = [dict(r) for r in conn.execute(
            """SELECT wt.id, wt.name FROM work_types wt
               WHERE NOT EXISTS (SELECT 1 FROM work_rates wr WHERE wr.work_type_id = wt.id)
               ORDER BY wt.sort_order, wt.name"""
        ).fetchall()]
        suspicious_rates = [dict(r) for r in conn.execute(
            """SELECT wr.id, wr.rate, wr.scheme, wr.unit, wr.source,
                      wt.name AS work_type_name, m.name AS master_name
               FROM work_rates wr
               LEFT JOIN work_types wt ON wt.id = wr.work_type_id
               LEFT JOIN masters m ON m.id = wr.master_id
               WHERE wr.scheme IN ('per_unit','hourly') AND wr.rate >= 10000
               ORDER BY wr.rate DESC"""
        ).fetchall()]

        return {
            "duplicate_sets": duplicate_sets,
            "stub_items": stub_items,
            "sum_only_items": sum_only_items,
            "rate_holes": rate_holes,
            "suspicious_rates": suspicious_rates,
            "summary": {
                "orders_with_duplicates": len(duplicate_sets),
                "stub_items": len(stub_items),
                "sum_only_items": len(sum_only_items),
                "rate_holes": len(rate_holes),
                "suspicious_rates": len(suspicious_rates),
            },
        }
    finally:
        conn.close()


@router.post("/sets/{set_id}/keep-actual")
def keep_actual(set_id: str):
    """Оставить эту смету актуальной: остальные не-superseded сметы заказа помечаются
    заменёнными. Раньше superseded ставился только автоматически при approve соседней —
    у Юры из-за этого копились по три черновика на заказ."""
    conn = get_production()
    try:
        es = conn.execute("SELECT id, order_id FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not es:
            raise HTTPException(status_code=404, detail="Смета не найдена")
        cur = conn.execute(
            """UPDATE estimate_sets SET status = 'superseded', updated_at = datetime('now')
               WHERE order_id = ? AND id != ? AND COALESCE(status,'') != 'superseded'""",
            (es["order_id"], set_id))
        conn.commit()
        return {"ok": True, "kept": set_id, "superseded": cur.rowcount}
    finally:
        conn.close()
