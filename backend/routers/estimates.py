from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from typing import Optional, List, Literal
from pydantic import BaseModel
from audit import audit
from db import get_production, get_materials
from money import client_price, cash_from_client, DEFAULT_BANK_PCT
from routers.materials import cheapest_price
from routers.rates import find_work_rate, upsert_work_rate, upsert_price_book
import uuid, subprocess, glob, os
from datetime import datetime

router = APIRouter()

# ─── helpers ────────────────────────────────────────────────────────────────

def _lookup_cheapest(code: str):
    """Самая дешёвая актуальная цена по карточке номенклатуры (materials.db) или None."""
    if not code:
        return None
    mconn = get_materials()
    try:
        return cheapest_price(mconn, code)
    except Exception:
        return None
    finally:
        mconn.close()

def _recalc_item(conn, item_id: str):
    """Recalculate cost_total from lines. Does NOT touch sale_price.

    Якорь = цена (решение Юры 23.07.2026): если цена клиенту уже задана
    (sale_price > 0), при пересчёте себестоимости она держится, а markup
    подстраивается (= sale/cost) и показывает фактическую маржу. Это же
    размыкает контур percent-ставок costing (цена → %-работа → cost):
    после cost-fill хранимый markup больше не врёт."""
    line_cost = conn.execute(
        "SELECT COALESCE(SUM(line_total), 0) FROM estimate_lines WHERE item_id = ?",
        (item_id,)
    ).fetchone()[0]
    row = conn.execute(
        "SELECT quantity, cost_total, sale_price FROM estimate_items WHERE id = ?", (item_id,)
    ).fetchone()
    quantity = row["quantity"] or 1
    if line_cost > 0:
        cost_total = round(line_cost * quantity, 2)
    else:
        cost_total = row["cost_total"] or 0
    sale_price = row["sale_price"] or 0
    if sale_price > 0 and cost_total > 0:
        conn.execute(
            "UPDATE estimate_items SET cost_total = ?, markup = ? WHERE id = ?",
            (cost_total, round(sale_price / cost_total, 3), item_id)
        )
    else:
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


def totals_from_items(items, payment_type, bank_pct) -> dict:
    """Формула себестоимости/цены по уже загруженным позициям сета. Чистая (без БД) —
    чтобы очередь ревью считала пачкой, а set_totals не дублировал выражение."""
    total_cost = sum((it["cost_total"] or 0) for it in items)
    set_bank_pct = bank_pct if bank_pct is not None else DEFAULT_BANK_PCT
    if payment_type == "bank":
        # Безнал: 13% удерживаются ИЗ суммы счёта, поэтому делим, а не умножаем,
        # и округляем итог вверх до 100 ₽ (правило Юры, см. money.py).
        total_price = sum(
            client_price(it["sale_price"] or 0, "bank", set_bank_pct) for it in items
        )
    else:
        total_price = sum((it["sale_price"] or 0) for it in items)
    return {"cost": round(total_cost, 2), "price": round(total_price, 2)}


def set_totals(conn, set_id: str) -> dict:
    """Себестоимость и цена для клиента по сету (с банковской надбавкой при безнале).

    Единственная формула этих сумм: её используют и синк заказа при approve,
    и orders._margin для draft-смет, и очередь ревью. Не дублировать выражением."""
    es = conn.execute(
        "SELECT payment_type, bank_pct FROM estimate_sets WHERE id = ?", (set_id,)
    ).fetchone()
    if not es:
        return {"cost": 0.0, "price": 0.0}
    items = conn.execute(
        "SELECT cost_total, sale_price, bank_pct FROM estimate_items WHERE set_id = ?",
        (set_id,)
    ).fetchall()
    return totals_from_items(items, es["payment_type"], es["bank_pct"])


def _sync_order_from_set(conn, set_id: str):
    """Recalculate order price_plan/cost_plan from all items in this set."""
    es = conn.execute("SELECT order_id FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
    if not es:
        return
    t = set_totals(conn, set_id)
    conn.execute(
        "UPDATE orders SET price_plan = ?, cost_plan = ?, updated_at = datetime('now') WHERE id = ?",
        (t["price"], t["cost"], es["order_id"])
    )


def _resync_order_plan(conn, order_id: str) -> dict:
    """План заказа = его активная смета (порядок как в orders._active_set).

    Смет не осталось (например, единственную перенесли в другой заказ) — план
    обнуляется: он был выведен из этой сметы, и оставленный «хвост» врал бы
    в план-факте и дашборде. Прежние значения возвращаются наружу — чтобы их
    было видно в ответе move и в журнале."""
    before = conn.execute(
        "SELECT price_plan, cost_plan FROM orders WHERE id = ?", (order_id,)
    ).fetchone()
    row = conn.execute(
        """SELECT id FROM estimate_sets WHERE order_id = ?
           ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'superseded' THEN 2 ELSE 1 END,
                    COALESCE(is_primary,0) DESC, created_at DESC
           LIMIT 1""", (order_id,)
    ).fetchone()
    if row:
        _sync_order_from_set(conn, row["id"])
    else:
        conn.execute(
            "UPDATE orders SET price_plan = 0, cost_plan = 0, updated_at = ? WHERE id = ?",
            (_now(), order_id)
        )
    after = conn.execute(
        "SELECT price_plan, cost_plan FROM orders WHERE id = ?", (order_id,)
    ).fetchone()
    return {
        "price_before": (before["price_plan"] or 0) if before else 0,
        "price_after": (after["price_plan"] or 0) if after else 0,
        "cost_before": (before["cost_plan"] or 0) if before else 0,
        "cost_after": (after["cost_plan"] or 0) if after else 0,
        "sets_left": conn.execute(
            "SELECT COUNT(*) FROM estimate_sets WHERE order_id = ?", (order_id,)
        ).fetchone()[0],
    }


def _move_set(conn, set_id: str, target_order_id: str, confirm: bool = False) -> dict:
    """Перенести смету в другой заказ (просьба фин-агента 07.08.2026: просчёт
    кресла Карин завели отдельным ORD-033, хотя это часть проекта Полисад ORD-035 —
    раньше приходилось пересоздавать смету инструментом).

    За сметой едут её обязательства (creditors по позициям/строкам) и планы
    ОБОИХ заказов. Заказ-донор, оставшийся без смет, НЕ трогаем: возвращаем флаг
    donor_empty, удалять или архивировать решает Юра.

    Не коммитит — коммит на вызывающем."""
    row = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Set not found")
    src_id = row["order_id"]
    donor = conn.execute(
        "SELECT id, number, title FROM orders WHERE id = ?", (src_id,)
    ).fetchone()
    target = conn.execute(
        "SELECT id, number, title FROM orders WHERE id = ?", (target_order_id,)
    ).fetchone()
    if not target:
        raise HTTPException(status_code=404, detail="Заказ-приёмник не найден")
    if src_id == target_order_id:
        return {"moved": False, "reason": "same_order", "set_id": set_id,
                "order_id": target_order_id}
    # Утверждённая смета станет активной у приёмника и вытеснит его утверждённую —
    # это молча переписало бы план чужого заказа. Спрашиваем.
    if row["status"] == "approved":
        clash = conn.execute(
            "SELECT id, title, number FROM estimate_sets WHERE order_id = ? AND status = 'approved'",
            (target_order_id,)
        ).fetchall()
        if clash and not confirm:
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "target_has_approved",
                    "message": (f"У заказа «{target['title'] or target['number']}» уже есть "
                                f"утверждённая смета — перенос сделает её superseded. "
                                f"Повтори с confirm=true."),
                    "sets": [dict(c) for c in clash],
                },
            )
    conn.execute(
        "UPDATE estimate_sets SET order_id = ?, is_primary = 0, updated_at = ? WHERE id = ?",
        (target_order_id, _now(), set_id)
    )
    # Обязательства по позициям/строкам этой сметы — это план закупок ИМЕННО по ней,
    # у донора им делать нечего (иначе его сальдо «Мы должны» держит чужой долг).
    obligations_moved = conn.execute(
        """UPDATE creditors SET order_id = ?
           WHERE (order_id = ? OR order_id IS NULL)
             AND (estimate_item_id IN (SELECT id FROM estimate_items WHERE set_id = ?)
                  OR estimate_line_id IN (SELECT el.id FROM estimate_lines el
                                          JOIN estimate_items ei ON ei.id = el.item_id
                                          WHERE ei.set_id = ?))""",
        (target_order_id, src_id, set_id, set_id)
    ).rowcount
    if row["status"] == "approved":
        # supersede прочих смет приёмника + is_primary + синк его плана + догенерация
        # недостающих обязательств (дедуп по estimate_line_id — перенесённые не задвоятся).
        approve = _approve_set(conn, set_id)
        target_plan = {
            "price_before": approve["price_before"], "price_after": approve["price_after"],
            "cost_before": approve["cost_before"], "cost_after": approve["cost_after"],
            "sets_left": conn.execute(
                "SELECT COUNT(*) FROM estimate_sets WHERE order_id = ?", (target_order_id,)
            ).fetchone()[0],
        }
        obligations_created = approve["obligations"]
    else:
        target_plan = _resync_order_plan(conn, target_order_id)
        obligations_created = None
    donor_plan = _resync_order_plan(conn, src_id)
    donor_label = (donor["title"] or donor["number"] or src_id) if donor else src_id
    target_label = target["title"] or target["number"] or target_order_id
    audit(conn, "estimate", set_id, "move",
          f"Смета «{row['title'] or row['number'] or set_id}» перенесена: "
          f"{donor_label} → {target_label}; обязательств {obligations_moved}, "
          f"план донора {donor_plan['price_before']:g} → {donor_plan['price_after']:g} ₽, "
          f"план приёмника {target_plan['price_before']:g} → {target_plan['price_after']:g} ₽",
          before_row=row)
    return {
        "moved": True,
        "set_id": set_id,
        "status": row["status"],
        "from_order": {"id": src_id, "number": donor["number"] if donor else None,
                       "title": donor["title"] if donor else None, **donor_plan},
        "to_order": {"id": target_order_id, "number": target["number"],
                     "title": target["title"], **target_plan},
        "obligations_moved": obligations_moved,
        "obligations_created": obligations_created,
        # Донор остался без смет — решение об удалении/архиве за Юрой, сами не трогаем.
        "donor_empty": donor_plan["sets_left"] == 0,
    }


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


def _approve_set(conn, set_id: str) -> dict:
    """Довести утверждение сметы до конца: supersede прочих сетов, синк плана заказа,
    обязательства. Ожидает, что status='approved' уже проставлен. Единственная точка
    «сделать смету актуальной» — её зовут и PUT /sets/{id} (редактор), и
    POST /sets/{id}/approve (массовое ревью, финагент). Идемпотентна.

    Возвращает diff для ревью: цены заказа до/после, сколько обязательств создано."""
    es = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
    before = conn.execute(
        "SELECT price_plan, cost_plan FROM orders WHERE id = ?", (es["order_id"],)
    ).fetchone()
    superseded = conn.execute(
        "UPDATE estimate_sets SET status = 'superseded', updated_at = ? WHERE order_id = ? AND id != ? AND status != 'superseded'",
        (_now(), es["order_id"], set_id)
    ).rowcount
    # Утверждённая становится и основной: выбор заказчика зафиксирован в данных,
    # а не выведен из даты (см. _active_set).
    conn.execute("UPDATE estimate_sets SET is_primary = 0 WHERE order_id = ?", (es["order_id"],))
    conn.execute("UPDATE estimate_sets SET is_primary = 1 WHERE id = ?", (set_id,))
    _sync_order_from_set(conn, set_id)
    # Обязательства по строкам — чтобы разноска сразу могла привязывать оплату
    # к плановым позициям. Идемпотентно (дедуп по estimate_line_id).
    obligations = _gen_obligations(conn, es)
    # Обучение себестоимости: approve = «Юра подтвердил цифры» — лучший момент
    # зафиксировать знания. Материал без кода с ценой → price_book (цены вне
    # прайсов: фанера/ткань/крепёж) — материалы стабильны, их запоминать полезно.
    #
    # Ставки РАБОТ здесь больше не учим: мастера называют цену каждый раз новую
    # (сварка в сметах Юры: 1 700…30 000 ₽), и заучивание превращало разовую цену
    # в постоянную ставку — так в справочнике появились «Сварка 30 000 ₽/шт» и
    # «Покраска 40 000 ₽/шт», которые подставились бы в новую смету. Вместо ставки
    # costing показывает историю цен по этой работе и спрашивает сумму.
    learned = {"prices": 0, "rates": 0}
    for ln in conn.execute(
        """SELECT el.* FROM estimate_lines el JOIN estimate_items ei ON ei.id = el.item_id
           WHERE ei.set_id = ?""", (set_id,)
    ).fetchall():
        if (ln["type"] == "material" and not ln["material_code"]
                and (ln["unit_price"] or 0) > 0 and (ln["title"] or "").strip()):
            if upsert_price_book(conn, ln["title"].strip(), ln["unit_price"], ln["unit"],
                                 "exact", "learned", note="из утверждённой сметы",
                                 overwrite=False) == "created":
                learned["prices"] += 1
    after = conn.execute(
        "SELECT price_plan, cost_plan FROM orders WHERE id = ?", (es["order_id"],)
    ).fetchone()
    audit(conn, "estimate", set_id, "approve",
          f"Утверждена смета «{es['title'] or es['number'] or set_id}»: "
          f"план заказа {(before['price_plan'] or 0) if before else 0:g} → {(after['price_plan'] or 0) if after else 0:g} ₽")
    return {
        "set_id": set_id,
        "order_id": es["order_id"],
        "price_before": (before["price_plan"] or 0) if before else 0,
        "price_after": (after["price_plan"] or 0) if after else 0,
        "cost_before": (before["cost_plan"] or 0) if before else 0,
        "cost_after": (after["cost_plan"] or 0) if after else 0,
        "obligations": obligations,
        "superseded": superseded,
        "learned": learned,
    }


def _assert_set_editable(conn, set_id: str):
    """Утверждённая смета заморожена: клиент её согласовал, правки — только новой версией."""
    row = conn.execute("SELECT status FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
    if row and row["status"] == "approved":
        raise HTTPException(
            status_code=409,
            detail="Смета утверждена и заморожена. Создай новую версию (POST /sets/{id}/new-version).",
        )


def _assert_item_editable(conn, item_id: str):
    row = conn.execute("SELECT set_id FROM estimate_items WHERE id = ?", (item_id,)).fetchone()
    if row:
        _assert_set_editable(conn, row["set_id"])


# ─── Models ─────────────────────────────────────────────────────────────────

# Тип расчёта — закрытый список. Раньше поле было свободной строкой, и опечатка
# молча означала «не безнал»: сумма считалась бы как за наличку.
#   cash    — цены за наличный расчёт
#   bank    — 13% удерживаются ИЗ суммы счёта (счёт = цена ÷ 0,87, см. money.py)
#   transit — деньги клиента проходят через р/с, себестоимость = выплата контрагенту,
#             сумма счёта НЕ пересчитывается
PAYMENT_TYPES = ("cash", "bank", "transit")


class SetCreate(BaseModel):
    order_id: str
    title: Optional[str] = None
    payment_type: Literal["cash", "bank", "transit"] = "cash"
    bank_pct: float = 13.0
    notes: Optional[str] = None


class SetUpdate(BaseModel):
    # order_id здесь = перенос сметы в другой заказ (тот же код, что и POST /sets/{id}/move,
    # но без confirm: конфликт утверждённых смет вернёт 409 и потребует move).
    order_id: Optional[str] = None
    title: Optional[str] = None
    payment_type: Optional[Literal["cash", "bank", "transit"]] = None
    bank_pct: Optional[float] = None
    status: Optional[str] = None
    notes: Optional[str] = None


def _apply_unit_fields(fields: dict, *, quantity: int, payment_type: str, bank_pct) -> None:
    """Перевести ввод «за штуку» в хранимые тоталы (запрос Юры/Елены 03.08.2026:
    «приходится рассчитывать от общей себестоимости за штуку»).

    cost_unit   → cost_total = unit × qty
    sale_unit   → sale_price = unit × qty            (цена «за нал» за штуку)
    client_unit → sale_price = cash_from_client(unit × qty)   (к оплате за штуку)

    Одновременно unit и его total — 400: тихий выбор одного из двух чисел
    молча исказил бы смету. Поля-униты вычищаются: это не колонки.

    Конфликт проверяется по НАЛИЧИЮ ключа (fields приходит из exclude_unset),
    а не по `is not None`: присланный явно null — это «очисти поле», и вместе
    с ценой за штуку он такое же противоречие, как и число."""
    qty = quantity or 1
    if "cost_unit" in fields and "cost_total" in fields:
        raise HTTPException(status_code=400, detail="Либо cost_unit, либо cost_total — не оба сразу")
    if ("sale_unit" in fields or "client_unit" in fields) and "sale_price" in fields:
        raise HTTPException(status_code=400, detail="Либо цена за штуку, либо sale_price — не оба сразу")
    if "sale_unit" in fields and "client_unit" in fields:
        raise HTTPException(status_code=400, detail="Либо sale_unit, либо client_unit — не оба сразу")

    cu = fields.pop("cost_unit", None)
    su = fields.pop("sale_unit", None)
    klu = fields.pop("client_unit", None)
    if cu is not None:
        fields["cost_total"] = round(cu * qty, 2)
    if su is not None:
        fields["sale_price"] = round(su * qty, 2)
    if klu is not None:
        fields["sale_price"] = round(cash_from_client(klu * qty, payment_type, bank_pct), 2)


class ItemCreate(BaseModel):
    title: str = ""
    category: Optional[str] = None
    markup: float = 2.0
    quantity: int = 1
    bank_pct: Optional[float] = None
    sort_order: int = 0
    cost_total: Optional[float] = None
    sale_price: Optional[float] = None
    # Ввод «за штуку» — те же поля и те же правила, что в ItemUpdate
    # (запрос фин-агента 05.08.2026: заводить позицию сразу с ценами, чтобы
    # его CLI не держал собственную копию формулы безнала).
    cost_unit: Optional[float] = None
    sale_unit: Optional[float] = None
    client_unit: Optional[float] = None


class SetFullCreate(SetCreate):
    """Смета одним запросом: шапка + позиции (см. POST /sets/full)."""
    items: List[ItemCreate] = []


class ItemUpdate(BaseModel):
    title: Optional[str] = None
    category: Optional[str] = None
    brand: Optional[str] = None
    markup: Optional[float] = None
    quantity: Optional[int] = None
    sort_order: Optional[int] = None
    cost_total: Optional[float] = None
    sale_price: Optional[float] = None
    bank_pct: Optional[float] = None
    # Ввод «за штуку» (виртуальные, в колонки не пишутся — см. _apply_unit_fields)
    cost_unit: Optional[float] = None
    sale_unit: Optional[float] = None
    client_unit: Optional[float] = None


class LineCreate(BaseModel):
    type: str = "material"
    title: str = ""
    qty: float = 1.0
    unit: str = "шт"
    unit_price: float = 0.0
    sort_order: int = 0
    master_id: Optional[str] = None
    contractor_name: Optional[str] = None
    work_type_id: Optional[str] = None
    material_code: Optional[str] = None
    price_supplier: Optional[str] = None
    price_date: Optional[str] = None


class LineUpdate(BaseModel):
    type: Optional[str] = None
    title: Optional[str] = None
    qty: Optional[float] = None
    unit: Optional[str] = None
    unit_price: Optional[float] = None
    sort_order: Optional[int] = None
    master_id: Optional[str] = None
    contractor_name: Optional[str] = None
    work_type_id: Optional[str] = None
    material_code: Optional[str] = None
    price_supplier: Optional[str] = None
    price_date: Optional[str] = None
    no_learn: Optional[bool] = None   # true → не писать learned-ставку (цена «только в эту смету»)


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
        # A10: новая смета — всегда новый контур себестоимости (legacy только у
        # созданных до запуска costing-движка 22.07.2026, их метит миграция).
        conn.execute(
            """INSERT INTO estimate_sets (id, order_id, title, status, payment_type, bank_pct, notes, costing_version, created_at, updated_at)
               VALUES (?, ?, ?, 'draft', ?, ?, ?, 'catalog_v1', ?, ?)""",
            (set_id, body.order_id, body.title, body.payment_type, body.bank_pct, body.notes, now, now)
        )
        audit(conn, "estimate", set_id, "create", f"Создана смета «{body.title or '—'}»")
        conn.commit()
        row = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.post("/sets/full")
def create_set_full(body: SetFullCreate):
    """Смета целиком одним запросом: сет + позиции с ценами (в т.ч. «за штуку»).

    Ради этого эндпоинта фин-агент отказался от прямой записи в SQLite — там
    жила своя копия формулы безнала, которая уже разъезжалась с money.py
    (счёт 280 800 ₽ по ART ГАММА превратился в 285 700 ₽). Единственный
    источник расчёта — client_price/cash_from_client, здесь и нигде больше."""
    conn = get_production()
    try:
        if not conn.execute("SELECT 1 FROM orders WHERE id = ?", (body.order_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Order not found")
        set_id = str(uuid.uuid4())
        now = _now()
        conn.execute(
            """INSERT INTO estimate_sets (id, order_id, title, status, payment_type, bank_pct, notes, costing_version, created_at, updated_at)
               VALUES (?, ?, ?, 'draft', ?, ?, ?, 'catalog_v1', ?, ?)""",
            (set_id, body.order_id, body.title, body.payment_type, body.bank_pct, body.notes, now, now)
        )
        for it in body.items:
            _insert_item(conn, set_id, it, body.payment_type, body.bank_pct)
        audit(conn, "estimate", set_id, "create",
              f"Создана смета «{body.title or '—'}» ({len(body.items)} поз.)")
        totals = set_totals(conn, set_id)
        conn.commit()
        items = [dict(r) for r in conn.execute(
            "SELECT * FROM estimate_items WHERE set_id = ? ORDER BY sort_order", (set_id,)
        ).fetchall()]
        return {
            "set_id": set_id,
            "set": dict(conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()),
            "items": items,
            "cost": totals["cost"],
            "price": totals["price"],
        }
    finally:
        conn.close()


@router.put("/sets/{set_id}")
def update_set(set_id: str, body: SetUpdate):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        fields = body.model_dump(exclude_unset=True)   # присланный null очищает поле
        move_to = fields.pop("order_id", None)
        if not fields:
            if move_to:
                _move_set(conn, set_id, move_to)
                conn.commit()
                return dict(conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone())
            return dict(row)
        # У утверждённой сметы суммы согласованы с клиентом: менять payment_type/bank_pct нельзя.
        if row["status"] == "approved" and ("payment_type" in fields or "bank_pct" in fields):
            raise HTTPException(status_code=409, detail="Смета утверждена — тип оплаты и банковский % заморожены. Создай новую версию.")
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
        # Коммит ОДИН и в самом конце: если сюда пришёл status='approved', то
        # supersede прочих смет, is_primary, синк заказа и обязательства должны
        # зафиксироваться вместе со сменой статуса. Ранний commit оставлял после
        # падения _approve_set заказ с двумя активными сметами и старым планом.
        # Перенос — до approve-ветки: иначе смета успела бы утвердиться на заказе-доноре
        # (supersede его смет, синк его плана) и только потом уехать.
        if move_to:
            _move_set(conn, set_id, move_to)
        updated = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if updated["status"] == "approved":
            # Одна активная смета на заказ: supersede прочих + синк заказа + обязательства.
            _approve_set(conn, set_id)
        else:
            audit(conn, "estimate", set_id, "update",
                  f"Правка сметы: {', '.join(k for k in fields if k != 'updated_at')}",
                  before_row=row)
        conn.commit()
        return dict(conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone())
    finally:
        conn.close()


class MoveIn(BaseModel):
    order_id: str
    confirm: bool = False


@router.post("/sets/{set_id}/move")
def move_set(set_id: str, body: MoveIn):
    """Перенести смету в другой заказ вместе с обязательствами; планы обоих
    заказов пересчитываются. Заказ-донор без смет остаётся как есть — в ответе
    `donor_empty: true`, что с ним делать, решает Юра."""
    conn = get_production()
    try:
        res = _move_set(conn, set_id, body.order_id, confirm=body.confirm)
        conn.commit()
        return res
    finally:
        conn.close()


class ApproveIn(BaseModel):
    force: bool = False


@router.post("/sets/{set_id}/approve")
def approve_set(set_id: str, body: Optional[ApproveIn] = None):
    """Пометить смету актуальной. Для уже утверждённой — идемпотентно
    (догенерит недостающие обязательства, вернёт no-op diff)."""
    force = bool(body and body.force)
    conn = get_production()
    try:
        es = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not es:
            raise HTTPException(status_code=404, detail="Set not found")
        already = es["status"] == "approved"
        if not already:
            t = set_totals(conn, set_id)
            # Сметы финагента бывают без продажных цен — approve обнулил бы цену заказа.
            if t["price"] <= 0 and not force:
                raise HTTPException(
                    status_code=409,
                    detail="В смете нет продажных цен — после утверждения цена заказа станет 0 ₽. Если так и надо, повтори с force=true.",
                )
            conn.execute(
                "UPDATE estimate_sets SET status = 'approved', updated_at = ? WHERE id = ?",
                (_now(), set_id)
            )
        diff = _approve_set(conn, set_id)
        conn.commit()
        diff["already_approved"] = already
        return diff
    finally:
        conn.close()


@router.get("/review-queue")
def review_queue():
    """Очередь смет к утверждению: draft-сеты живых заказов, у которых нет более
    свежего approved. Для ревью — дельта «план заказа сейчас → станет после approve»
    и признаки рисков: без строк (обязательства лягут крупно, по позициям),
    без продажных цен (approve обнулит цену заказа)."""
    conn = get_production()
    try:
        rows = conn.execute(
            """SELECT es.id, es.title, es.created_at, es.payment_type, es.bank_pct,
                      es.order_id, o.number AS order_number, o.title AS order_title,
                      o.status AS order_status, o.price_plan AS order_price_plan,
                      o.cost_plan AS order_cost_plan, c.name AS customer_name
               FROM estimate_sets es
               JOIN orders o ON o.id = es.order_id
               LEFT JOIN customers c ON c.id = o.customer_id
               WHERE es.status = 'draft' AND o.archived = 0 AND o.status != 'cancelled'
                 AND NOT EXISTS (
                   SELECT 1 FROM estimate_sets a
                   WHERE a.order_id = es.order_id AND a.status = 'approved'
                     AND a.created_at > es.created_at)
               ORDER BY o.created_at DESC, es.created_at DESC"""
        ).fetchall()

        # Пачкой вместо 2N+1: все позиции и счётчики строк для сетов очереди — двумя
        # запросами, дальше только раскладка в Python (читающий эндпоинт в БД не пишет).
        set_ids = [r["id"] for r in rows]
        items_by_set: dict = {sid: [] for sid in set_ids}
        counts_by_set: dict = {sid: {"items": 0, "lines": 0, "lines_no_price": 0} for sid in set_ids}
        if set_ids:
            ph = ",".join("?" * len(set_ids))
            for it in conn.execute(
                f"SELECT set_id, cost_total, sale_price, bank_pct FROM estimate_items WHERE set_id IN ({ph})",
                set_ids,
            ):
                items_by_set[it["set_id"]].append(it)
            for c in conn.execute(
                f"""SELECT ei.set_id AS set_id,
                           COUNT(DISTINCT ei.id) AS items, COUNT(el.id) AS lines,
                           SUM(CASE WHEN el.id IS NOT NULL AND IFNULL(el.unit_price, 0) <= 0 THEN 1 ELSE 0 END) AS lines_no_price
                    FROM estimate_items ei LEFT JOIN estimate_lines el ON el.item_id = ei.id
                    WHERE ei.set_id IN ({ph}) GROUP BY ei.set_id""",
                set_ids,
            ):
                counts_by_set[c["set_id"]] = {"items": c["items"], "lines": c["lines"], "lines_no_price": c["lines_no_price"]}

        out = []
        for r in rows:
            t = totals_from_items(items_by_set[r["id"]], r["payment_type"], r["bank_pct"])
            counts = counts_by_set[r["id"]]
            out.append({
                "set_id": r["id"],
                "set_title": r["title"],
                "set_created_at": r["created_at"],
                "payment_type": r["payment_type"],
                "bank_pct": r["bank_pct"],
                "order_id": r["order_id"],
                "order_number": r["order_number"],
                "order_title": r["order_title"],
                "order_status": r["order_status"],
                "customer_name": r["customer_name"],
                "items_count": counts["items"] or 0,
                "lines_count": counts["lines"] or 0,
                "lines_no_price": counts["lines_no_price"] or 0,
                "set_cost": t["cost"],
                "set_price": t["price"],
                "price_plan_now": r["order_price_plan"] or 0,
                "cost_plan_now": r["order_cost_plan"] or 0,
                "price_delta": round(t["price"] - (r["order_price_plan"] or 0), 2),
                "cost_delta": round(t["cost"] - (r["order_cost_plan"] or 0), 2),
            })
        return {"sets": out}
    finally:
        conn.close()


@router.delete("/sets/{set_id}")
def delete_set(set_id: str):
    conn = get_production()
    try:
        row = conn.execute("SELECT id, status FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        if row["status"] == "approved":
            raise HTTPException(status_code=409, detail="Утверждённую смету нельзя удалить (по ней выставлен счёт). Сначала переведи в superseded.")
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


@router.post("/sets/{set_id}/new-version")
def new_set_version(set_id: str):
    """Новая редактируемая версия сметы: полная копия (позиции + строки) в статусе draft.

    Утверждённая смета заморожена (клиент согласовал) — правки идут в новой версии;
    при её утверждении старая автоматически уйдёт в superseded."""
    conn = get_production()
    try:
        src = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not src:
            raise HTTPException(status_code=404, detail="Not found")
        now = _now()
        new_id = str(uuid.uuid4())
        base_title = (src["title"] or "Смета").split(" · v")[0]
        version = conn.execute(
            "SELECT COUNT(*) FROM estimate_sets WHERE order_id = ?", (src["order_id"],)
        ).fetchone()[0] + 1
        conn.execute(
            """INSERT INTO estimate_sets (id, order_id, title, status, payment_type, bank_pct, notes, created_at, updated_at)
               VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)""",
            (new_id, src["order_id"], f"{base_title} · v{version}", src["payment_type"], src["bank_pct"], src["notes"], now, now)
        )
        items = conn.execute(
            "SELECT * FROM estimate_items WHERE set_id = ? ORDER BY sort_order", (set_id,)
        ).fetchall()
        for it in items:
            new_item_id = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO estimate_items (id, set_id, title, category, brand, markup, quantity, overhead_pct,
                                               tax_pct, cost_total, sale_price, bank_pct, sort_order, catalog_item_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (new_item_id, new_id, it["title"], it["category"], it["brand"], it["markup"], it["quantity"],
                 it["overhead_pct"], it["tax_pct"], it["cost_total"], it["sale_price"], it["bank_pct"],
                 it["sort_order"], it["catalog_item_id"], now)
            )
            for ln in conn.execute("SELECT * FROM estimate_lines WHERE item_id = ? ORDER BY sort_order", (it["id"],)):
                conn.execute(
                    """INSERT INTO estimate_lines (id, item_id, type, title, qty, unit, unit_price, line_total,
                                                   material_id, sort_order, master_id, contractor_name, work_type_id,
                                                   material_code, price_supplier, price_date, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (str(uuid.uuid4()), new_item_id, ln["type"], ln["title"], ln["qty"], ln["unit"],
                     ln["unit_price"], ln["line_total"], ln["material_id"], ln["sort_order"],
                     ln["master_id"], ln["contractor_name"], ln["work_type_id"],
                     ln["material_code"], ln["price_supplier"], ln["price_date"], now)
                )
        conn.commit()
        return dict(conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (new_id,)).fetchone())
    finally:
        conn.close()


@router.get("/sets/{set_id}/price-check")
def price_check(set_id: str):
    """Проверка протухшей сметы: возраст >14 дней или подорожание металла >5%.

    Сравнивает замороженную цену привязанных материалов с текущей дешёвой из прайса.
    Возвращает алерты для баннера «пересчитать перед выставлением счёта»."""
    STALE_DAYS = 14
    RISE_PCT = 5.0
    conn = get_production()
    try:
        s = conn.execute("SELECT id, created_at, updated_at FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not s:
            raise HTTPException(status_code=404, detail="Not found")
        # Возраст сметы — по последнему изменению
        age_days = None
        ref = s["updated_at"] or s["created_at"]
        if ref:
            try:
                dt = datetime.fromisoformat(ref.replace("Z", ""))
                age_days = (datetime.utcnow() - dt).days
            except Exception:
                age_days = None

        mat_lines = conn.execute(
            """SELECT el.id, el.title, el.unit_price, el.material_code, el.price_supplier, el.price_date
               FROM estimate_lines el JOIN estimate_items ei ON ei.id = el.item_id
               WHERE ei.set_id = ? AND el.material_code IS NOT NULL AND el.material_code != ''""",
            (set_id,)
        ).fetchall()

        mconn = get_materials()
        risen = []
        linked = 0
        try:
            for ln in mat_lines:
                linked += 1
                best = cheapest_price(mconn, ln["material_code"])
                if not best or not ln["unit_price"] or ln["unit_price"] <= 0:
                    continue
                cur = best["price"]
                frozen = ln["unit_price"]
                pct = round((cur - frozen) / frozen * 100, 1)
                if pct > RISE_PCT:
                    risen.append({
                        "line_id": ln["id"],
                        "title": ln["title"],
                        "frozen_price": frozen,
                        "current_price": cur,
                        "supplier": best.get("supplier_label") or best.get("supplier"),
                        "pct": pct,
                    })
        finally:
            mconn.close()

        stale_age = age_days is not None and age_days > STALE_DAYS
        return {
            "age_days": age_days,
            "stale_age": stale_age,
            "linked_materials": linked,
            "risen": risen,
            "any_risen": len(risen) > 0,
            "stale": bool(stale_age or risen),
        }
    finally:
        conn.close()


# ─── estimate_items ──────────────────────────────────────────────────────────

def _insert_item(conn, set_id: str, body: ItemCreate, payment_type: str, set_bank_pct) -> str:
    """Вставка позиции сметы с ценами (в т.ч. «за штуку»). Без commit — вызывающий
    решает, чем закрыть транзакцию. Общая точка для add_item и create_set_full."""
    item_id = str(uuid.uuid4())
    bank_pct = body.bank_pct if body.bank_pct is not None else (set_bank_pct or DEFAULT_BANK_PCT)
    sort_order = body.sort_order
    if not sort_order:
        sort_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM estimate_items WHERE set_id = ?", (set_id,)
        ).fetchone()[0]
    fields = body.model_dump(exclude_unset=True)
    # bank_pct берём эффективный (переданный в позиции важнее сетового): цена
    # «к оплате» за штуку должна разворачиваться тем же процентом, что и хранится.
    _apply_unit_fields(
        fields,
        quantity=body.quantity or 1,
        payment_type=payment_type or "cash",
        bank_pct=bank_pct,
    )
    conn.execute(
        """INSERT INTO estimate_items (id, set_id, title, category, markup, quantity, overhead_pct, tax_pct, cost_total, sale_price, bank_pct, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)""",
        (item_id, set_id, body.title, body.category, body.markup, body.quantity,
         fields.get("cost_total") or 0, fields.get("sale_price") or 0,
         bank_pct, sort_order, _now())
    )
    return item_id


@router.post("/sets/{set_id}/items")
def add_item(set_id: str, body: ItemCreate):
    conn = get_production()
    try:
        set_row = conn.execute(
            "SELECT id, payment_type, bank_pct FROM estimate_sets WHERE id = ?", (set_id,)
        ).fetchone()
        if not set_row:
            raise HTTPException(status_code=404, detail="Set not found")
        _assert_set_editable(conn, set_id)
        item_id = _insert_item(conn, set_id, body, set_row["payment_type"], set_row["bank_pct"])
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
        _assert_item_editable(conn, item_id)
        fields = body.model_dump(exclude_unset=True)   # присланный null очищает поле
        es = conn.execute(
            """SELECT es.payment_type, es.bank_pct FROM estimate_sets es
               JOIN estimate_items ei ON ei.set_id = es.id WHERE ei.id = ?""",
            (item_id,)).fetchone()
        _apply_unit_fields(
            fields,
            quantity=fields.get("quantity") or row["quantity"] or 1,
            payment_type=(es["payment_type"] if es else "cash") or "cash",
            bank_pct=es["bank_pct"] if es else None,
        )
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE estimate_items SET {set_clause} WHERE id = ?",
                list(fields.values()) + [item_id]
            )
            # Журнал — только денежные правки позиции, не каждое переименование
            if fields.keys() & {"cost_total", "sale_price", "markup", "quantity", "bank_pct"}:
                audit(conn, "estimate_item", item_id, "update",
                      f"Позиция «{row['title']}»: {', '.join(sorted(fields))}", before_row=row)
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
        _assert_set_editable(conn, set_id)
        _touch_set(conn, item_id)
        before = conn.execute("SELECT * FROM estimate_items WHERE id = ?", (item_id,)).fetchone()
        conn.execute("DELETE FROM estimate_lines WHERE item_id = ?", (item_id,))
        conn.execute("DELETE FROM estimate_items WHERE id = ?", (item_id,))
        audit(conn, "estimate_item", item_id, "delete",
              f"Удалена позиция «{before['title']}» ({before['sale_price'] or 0:g} ₽)", before_row=before)
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
            # Привязки (номенклатура/вид работ/исполнитель) едут в каталог —
            # чтобы разворот обратно в смету тянул живые цены и ставки.
            conn.execute(
                """INSERT INTO catalog_item_lines (id, item_id, type, title, qty, unit, unit_price, line_total,
                                                   sort_order, material_code, work_type_id, master_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid.uuid4()), catalog_id, line["type"], line["title"],
                 line["qty"], line["unit"], line["unit_price"], line["line_total"], i,
                 line["material_code"], line["work_type_id"], line["master_id"])
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
        _assert_item_editable(conn, item_id)
        line_id = str(uuid.uuid4())
        unit_price = body.unit_price
        price_supplier = body.price_supplier
        price_date = body.price_date
        # Привязка к номенклатуре: замораживаем самую дешёвую актуальную цену + дату прайса.
        if body.material_code and (unit_price == 0 or not price_date):
            best = _lookup_cheapest(body.material_code)
            if best:
                if unit_price == 0:
                    unit_price = best["price"]
                price_supplier = price_supplier or best["supplier"]
                price_date = price_date or best["price_date"]
        line_total = round(body.qty * unit_price, 2)
        title = body.title
        # If work_type chosen, sync title to its name
        if body.work_type_id:
            wt = conn.execute("SELECT name FROM work_types WHERE id = ?", (body.work_type_id,)).fetchone()
            if wt:
                title = wt["name"]
        conn.execute(
            """INSERT INTO estimate_lines (id, item_id, type, title, qty, unit, unit_price, line_total, sort_order, master_id, contractor_name, work_type_id, material_code, price_supplier, price_date, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (line_id, item_id, body.type, title, body.qty, body.unit, unit_price, line_total,
             body.sort_order, body.master_id, body.contractor_name, body.work_type_id,
             body.material_code, price_supplier, price_date, _now())
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
        _assert_item_editable(conn, row["item_id"])
        # exclude_unset: обновляются только присланные поля, присланный null пишется
        # как NULL — можно ОТВЯЗАТЬ мастера/вид работ/материал, а не только заменить.
        fields = body.model_dump(exclude_unset=True)
        no_learn = bool(fields.pop("no_learn", False) or False)   # не колонка — только флаг поведения
        # If work_type chosen, sync title to its name
        if fields.get("work_type_id"):
            wt = conn.execute("SELECT name FROM work_types WHERE id = ?", (fields["work_type_id"],)).fetchone()
            if wt:
                fields["title"] = wt["name"]
        # Привязка к номенклатуре: если пришёл material_code без явной цены/даты — заморозить дешёвую.
        if fields.get("material_code") and ("unit_price" not in fields or "price_date" not in fields):
            best = _lookup_cheapest(fields["material_code"])
            if best:
                fields.setdefault("unit_price", best["price"])
                fields.setdefault("price_supplier", best["supplier"])
                fields.setdefault("price_date", best["price_date"])
        # recalc line_total
        qty = fields.get("qty", row["qty"]) or 0
        unit_price = fields.get("unit_price", row["unit_price"]) or 0
        fields["line_total"] = round(qty * unit_price, 2)
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(
            f"UPDATE estimate_lines SET {set_clause} WHERE id = ?",
            list(fields.values()) + [line_id]
        )
        # Auto-link master ↔ work_type
        final = conn.execute("SELECT * FROM estimate_lines WHERE id = ?", (line_id,)).fetchone()
        if final["master_id"] and final["work_type_id"]:
            conn.execute(
                "INSERT OR IGNORE INTO master_work_types (master_id, work_type_id) VALUES (?, ?)",
                (final["master_id"], final["work_type_id"])
            )
        # Ставку работы из строки НЕ запоминаем: цена работы у Юры разовая (мастер
        # называет её заново каждый раз), а разовая цена в справочнике потом молча
        # подставилась бы в другую смету. Историю цен costing собирает из самих строк.
        if fields.keys() & {"unit_price", "qty", "line_total"}:
            audit(conn, "estimate_line", line_id, "update",
                  f"Строка «{row['title']}»: {row['unit_price'] or 0:g} → {final['unit_price'] or 0:g} ₽/{final['unit'] or 'ед'}",
                  before_row=row)
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
        _assert_item_editable(conn, item_id)
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
        _assert_set_editable(conn, body.set_id)
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
            """INSERT INTO estimate_items (id, set_id, title, category, markup, overhead_pct, tax_pct, cost_total, sale_price, bank_pct, sort_order, catalog_item_id, created_at)
               VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)""",
            (item_id, body.set_id, cat["title"], cat["category"], round(markup, 4), set_bank_pct, sort_order, body.catalog_item_id, _now())
        )
        for i, cl in enumerate(cat_lines):
            line_id = str(uuid.uuid4())
            # Живые цены вместо статичных из каталога: материал — по коду из прайса
            # (с заморозкой поставщика/даты), работа — по ставке вид×исполнитель.
            # percent-ставки здесь не считаем (продажная цена позиции ещё 0) —
            # их доводит cost-fill. Статичная unit_price каталога — фолбэк.
            unit_price = cl["unit_price"] or 0
            price_supplier = price_date = None
            applied_rate = rate_scheme = rate_date = None
            if cl["material_code"]:
                best = _lookup_cheapest(cl["material_code"])
                if best and best.get("price"):
                    unit_price, price_supplier, price_date = best["price"], best["supplier"], best["price_date"]
            if cl["type"] in ("labor", "service") and cl["work_type_id"]:
                rate = find_work_rate(conn, cl["work_type_id"], cl["master_id"])
                if rate and rate["scheme"] != "percent":
                    unit_price = round(rate["rate"], 2)
                    # A9: снимок применённой ставки (симметрия price_supplier/price_date)
                    applied_rate, rate_scheme = rate["rate"], rate["scheme"]
                    rate_date = _now()[:10]
            line_total = round((cl["qty"] or 0) * unit_price, 2)
            conn.execute(
                """INSERT INTO estimate_lines (id, item_id, type, title, qty, unit, unit_price, line_total,
                                               sort_order, material_code, price_supplier, price_date,
                                               work_type_id, master_id, applied_rate, rate_scheme, rate_date, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (line_id, item_id, cl["type"], cl["title"], cl["qty"], cl["unit"], unit_price, line_total, i,
                 cl["material_code"], price_supplier, price_date, cl["work_type_id"], cl["master_id"],
                 applied_rate, rate_scheme, rate_date, _now())
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


def _gen_obligations(conn, es) -> dict:
    """Сгенерировать обязательства по строкам утверждённой сметы. Идемпотентно
    (дедуп по estimate_line_id / estimate_item_id). Переиспользуется автогенерацией
    при approve и ручным эндпоинтом."""
    order_id = es["order_id"]
    # Транзит обязательств по позициям не рождает (решение 05.08.2026, ТЗ фин-агента).
    # Себестоимость транзитного заказа = выплата контрагенту и ведётся расходами
    # (expenses) / привязками zm_links, а позиции сметы там — месяцы обслуживания,
    # а не работы подрядчиков. Оплаченное обязательство становилось ВТОРЫМ источником
    # в _transit_facts, и инвариант «одна оплата = один факт» его не гасил: расходы
    # заведены агрегированно (80 000 за январь+февраль), обязательства помесячно —
    # ни tx_id, ни сумма не совпадают. Так себестоимость ORD-036 стала 430 200
    # вместо 230 200, а чистая ушла в −181 335.
    if (es["payment_type"] or "") == "transit":
        return {"created": 0, "skipped": 0, "reason": "transit"}
    items = conn.execute(
        "SELECT * FROM estimate_items WHERE set_id = ? ORDER BY sort_order", (es["id"],)
    ).fetchall()
    created = 0
    skipped = 0
    for item in items:
        lines = conn.execute(
            "SELECT * FROM estimate_lines WHERE item_id = ? ORDER BY sort_order", (item["id"],)
        ).fetchall()

        if lines:
            for line in lines:
                existing = conn.execute(
                    "SELECT id FROM creditors WHERE estimate_line_id = ?", (line["id"],)
                ).fetchone()
                if existing:
                    skipped += 1
                    continue
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
                        estimate_item_id, estimate_line_id, amount_plan, status)
                       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'open')""",
                    (cid, name, amount, description, order_id, item["id"], line["id"], amount),
                )
                created += 1
        else:
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
                 f"Смета: {es['title'] or es['id']}", order_id, item["id"], amount),
            )
            created += 1
    return {"created": created, "skipped": skipped}


@router.post("/sets/{set_id}/create-obligations")
def create_obligations(set_id: str):
    conn = get_production()
    try:
        es = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not es:
            raise HTTPException(status_code=404, detail="Set not found")
        if es["status"] != "approved":
            raise HTTPException(status_code=400, detail="Set must be approved")
        res = _gen_obligations(conn, es)
        conn.commit()
        return res
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

INVOICES_DIR = "/opt/firma/data/invoices"
KP_DIR = "/opt/firma/data/kp"


def _extract_pdf_path(stdout: str):
    """Путь готового PDF из вывода генератора — маркер [SEND_FILE:...].

    Инцидент 03.08.2026: вместо разбора stdout результат искался глобом по
    ахиву фин-агента (/opt/fin-agent/data/invoices) — кнопка каждый раз
    отдавала чужой счёт от 1 июня."""
    import re as _re
    m = _re.search(r"\[SEND_FILE:([^\]]+)\]", stdout or "")
    return m.group(1) if m else None


def _kp_args(set_row, items, *, brand, title, out_path) -> list:
    """Аргументы для генератора КП фин-агента (/opt/ai-os/tools/kp.py create).

    Формат --item: name:qty:ral:material:price — цена клиенту ЗА ШТУКУ
    (kp.py сам умножит), для безнала удержание уже в цене (client_price).
    Двоеточия в названии заменяются на «∶», иначе ломают формат.

    Сумма считается ТЕМ ЖЕ вызовом, что и в счёте (invoice.py::cmd_order):
    client_price с округлением вверх до 100 ₽. Ревью 04.08.2026: здесь стояло
    rounded=False, и КП по той же смете показывало клиенту сумму на десятки
    рублей меньше счёта — расхождение видно только клиенту."""
    if not items:
        raise HTTPException(status_code=400, detail="В смете нет позиций — КП собирать не из чего")
    args = ["create", "--subtitle", (title or "")[:120],
            "--logo", "mera" if (brand or "").lower() in ("mera", "мера") else "pbpb"]
    for it in items:
        qty = it["quantity"] or 1
        client_total = round(client_price(it["sale_price"] or 0,
                                          set_row["payment_type"] or "cash",
                                          set_row["bank_pct"]))
        unit = round(client_total / qty)
        name = (it["title"] or "Позиция").replace(":", "∶")
        args += ["--item", f"{name}:{qty}:::{unit}"]
    args += ["--output", out_path]
    return args


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

    # Путь результата — из stdout генератора (маркер [SEND_FILE:...]).
    # Фолбэк — glob по СВОЕМУ каталогу и ТОЛЬКО по этому заказу: глоб по всему
    # архиву отдавал чужой счёт (инцидент 03.08.2026).
    pdf = _extract_pdf_path(result.stdout)
    if not pdf or not os.path.exists(pdf):
        files = sorted(glob.glob(f"{INVOICES_DIR}/invoice_{order_number}_*.pdf"),
                       key=os.path.getmtime, reverse=True)
        pdf = files[0] if files else None
    if not pdf:
        raise HTTPException(status_code=500,
                            detail=f"PDF не найден после генерации: {(result.stderr or result.stdout or '')[:300]}")

    return FileResponse(
        pdf,
        media_type="application/pdf",
        filename=f"invoice-{order_number}.pdf",
    )


@router.post("/sets/{set_id}/kp")
def generate_kp(set_id: str):
    """КП по смете — генератором фин-агента (/opt/ai-os/tools/kp.py): шаблон
    один на систему, его правки у фин-агента подхватываются автоматически."""
    conn = get_production()
    try:
        es = conn.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
        if not es:
            raise HTTPException(status_code=404, detail="Set not found")
        order = conn.execute("SELECT number, title, brand FROM orders WHERE id = ?", (es["order_id"],)).fetchone()
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
        items = conn.execute(
            "SELECT title, quantity, sale_price FROM estimate_items WHERE set_id = ? ORDER BY sort_order",
            (set_id,)).fetchall()
    finally:
        conn.close()

    os.makedirs(KP_DIR, exist_ok=True)
    out_path = f"{KP_DIR}/kp_{order['number']}_{set_id[:8]}.pdf"
    args = _kp_args(es, [dict(i) for i in items],
                    brand=order["brand"], title=order["title"], out_path=out_path)
    # Имя файла детерминированное: КП от прошлого запуска замаскирует провал
    # генератора (маркера пути, как у счёта, kp.py не печатает). Сносим ДО вызова —
    # тогда «файл есть» значит «его создал этот запуск».
    if os.path.exists(out_path):
        os.remove(out_path)
    try:
        result = subprocess.run(["python3", "/opt/ai-os/tools/kp.py"] + args,
                                capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise HTTPException(status_code=500,
                                detail=f"Генерация КП упала: {(result.stderr or result.stdout or '')[:300]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Генерация КП: таймаут")
    if not os.path.exists(out_path):
        raise HTTPException(status_code=500,
                            detail=f"КП не найдено после генерации: {(result.stdout or '')[:300]}")
    return FileResponse(out_path, media_type="application/pdf",
                        filename=f"kp-{order['number']}.pdf")
