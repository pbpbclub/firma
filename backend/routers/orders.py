from fastapi import APIRouter, Query, HTTPException, Body, Depends
from pydantic import BaseModel
from typing import Optional, List
from uuid import uuid4
from db import get_production, get_zenmoney
from auth import get_current_user
from routers.estimates import set_totals

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
    brand: Optional[str] = None,
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
            statuses = [s.strip() for s in status.split(",") if s.strip()]
            if len(statuses) == 1:
                sql += " AND o.status = ?"
                params.append(statuses[0])
            elif statuses:
                sql += f" AND o.status IN ({','.join('?' * len(statuses))})"
                params += statuses
        if brand:
            sql += " AND o.brand = ?"
            params.append(brand)
        if search:
            sql += " AND (o.title LIKE ? OR o.number LIKE ? OR c.name LIKE ?)"
            params += [f"%{search}%"] * 3
        sql += " GROUP BY o.id ORDER BY o.created_at DESC LIMIT ?"
        params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        # Факты транзита — одним проходом на весь список: иначе на каждый заказ
        # открывалась бы zenmoney.db, а список и карточка показали бы разные числа.
        tfacts = _transit_facts(conn)
        out = []
        for r in rows:
            m = _margin(conn, r["id"], r["price_plan"], r["cost_plan"], transit_facts=tfacts)
            out.append({
                **dict(r),
                # см. карточку заказа: цифры берём из активной сметы, поля — кэш
                "price_plan": m["revenue"],
                "cost_plan": m["cost"],
                "status_label": STATUS_LABELS.get(r["status"], r["status"]),
                "priority_label": PRIORITY_LABELS.get(r["priority"], r["priority"]),
                # Долг — от той же выручки, что и лестница (для draft-смет это сет, не поле заказа).
                "debt": round((m["revenue"] or 0) - (r["paid_total"] or 0), 2),
                # margin остаётся валовой (значение прежнее) — рядом полная лестница
                "margin": m["gross_profit"],
                "gross_profit": m["gross_profit"],
                "tax": m["tax"],
                "tax_pct": m["tax_pct"],
                "net_profit": m["net_profit"],
                "payment_type": m["payment_type"],
                # Транзит: счёт / план выплаты / факт / удержание — только у транзитных заказов
                "transit": m.get("transit"),
                "has_estimate": m["has_estimate"],
                "plan_source": m["plan_source"],
            })
        return out
    finally:
        conn.close()


def _name_score(a: str, b: str) -> float:
    wa = set((a or "").lower().split())
    wb = set((b or "").lower().split())
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / max(len(wa), len(wb))


def _amount_score(a: float, b: float) -> float:
    if not a and not b:
        return 1.0
    m = max(abs(a), abs(b))
    if not m:
        return 1.0
    return max(0.0, 1.0 - abs(a - b) / m)


@router.get("/suggest")
def suggest_orders(counterparty: str = "", amount: float = 0, limit: int = Query(10, le=50)):
    conn = get_production()
    try:
        rows = conn.execute(
            """SELECT o.id, o.number, o.title, o.price_plan, o.status,
                      c.name AS customer_name,
                      COALESCE(SUM(p.amount), 0) AS paid_total
               FROM orders o
               LEFT JOIN customers c ON c.id = o.customer_id
               LEFT JOIN payments p ON p.order_id = o.id
               WHERE o.archived = 0
               GROUP BY o.id
               ORDER BY o.created_at DESC LIMIT 200"""
        ).fetchall()
        # Транзитные факты — одним проходом на весь список (как в list_orders): иначе
        # _margin на каждый транзитный заказ заново сканировал бы expenses/creditors
        # и открывал бы zenmoney.db (N+1).
        tfacts = _transit_facts(conn)
        scored = []
        for r in rows:
            row = dict(r)
            # Цена — из активной сметы (у черновиков поле заказа устаревшее), чтобы
            # подсказка по сумме и долг совпадали с карточкой.
            m = _margin(conn, row["id"], row.get("price_plan") or 0, row.get("cost_plan") or 0,
                        transit_facts=tfacts)
            row["price_plan"] = m["revenue"]
            ns = _name_score(counterparty, (row.get("customer_name") or "") + " " + (row.get("title") or ""))
            as_ = _amount_score(amount, row.get("price_plan") or 0)
            row["score"] = round(0.6 * ns + 0.4 * as_, 3)
            row["debt"] = round((row.get("price_plan") or 0) - (row.get("paid_total") or 0), 2)
            scored.append(row)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:limit]
    finally:
        conn.close()


@router.get("/payments-map")
def payments_map():
    conn = get_production()
    try:
        rows = conn.execute(
            """SELECT p.id AS payment_id, p.amount, p.paid_at, p.bank_tx_id,
                      o.id AS order_id, o.number, o.title
               FROM payments p
               JOIN orders o ON o.id = p.order_id
               WHERE p.bank_tx_id IS NOT NULL"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── План/Факт по заказу ──────────────────────────────────────────────────────

# Категории для план-факта: и строки сметы, и expenses сводим в 4 корзины.
_CAT_BUCKETS = ["Материалы", "Работы", "Доставка", "Прочее"]

def _bucket(raw: str) -> str:
    r = (raw or "").lower()
    if r in ("material", "материал", "материалы"): return "Материалы"
    if r in ("labor", "service", "work", "работа", "работы", "услуга"): return "Работы"
    if r in ("delivery", "доставка"): return "Доставка"
    return "Прочее"


# ── Лестница прибыли ─────────────────────────────────────────────────────────
# Выручка (price_plan, к оплате клиентом)
#   − прямая себестоимость (cost_plan)   = валовая прибыль
#   − УСН 6% (только с безнала)          = чистая прибыль
# Следующий этаж (пока не делаем) — постоянные затраты.
#
# Про безнал: estimate_items.sale_price — цена «как за нал», при payment_type=bank
# сверху накручивается bank_pct и получается price_plan. Остаток надбавки после налога —
# это прибыль (подтверждено Юрой 17.07.2026), поэтому вычитаем только налог.
TAX_PCT = 6.0


def _active_set(conn, oid: str):
    """Активная смета заказа: approved → помеченная основной → последняя не-superseded.

    Флаг is_primary — ручной выбор Юры («утверждать буду ту, которую выберет заказчик»);
    он перебивает дату, но уступает утверждённой смете.

    Именно «иначе», а не «только approved»: у заказа может не быть утверждённой сметы
    (ORD-024 — draft), и тогда считать всё равно надо."""
    return conn.execute(
        """SELECT id, payment_type, bank_pct, status, COALESCE(is_primary,0) AS is_primary
           FROM estimate_sets WHERE order_id = ?
           ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'superseded' THEN 2 ELSE 1 END,
                    COALESCE(is_primary,0) DESC,
                    created_at DESC
           LIMIT 1""", (oid,)
    ).fetchone()


def _transit_facts(conn) -> dict:
    """Фактические выплаты контрагентам по транзитным заказам — одним проходом.

    Возвращает {order_id: {"fact": ₽, "contractor": имя|None, "sources": [...]}}.

    Три источника, и все три могут описывать ОДИН перевод:
      * expenses — родной механизм Firma, «Разноска» пишет сюда;
      * creditors.paid — оплаченные обязательства;
      * zm_links в zenmoney.db — привязки фин-агента (выплаты Юра делает с личных
        карт, в выписке ИП их нет вообще).

    ИНВАРИАНТ «одна оплата = один факт» распространяется и на zm_links: привязка
    фин-агента идёт в факт, только если тот же перевод не разнесён расходом и не
    закрыт обязательством. Без дедупа выплата 44 370 по ORD-027 превратилась бы
    в 88 740, а себестоимость транзита — вдвое.

    zenmoney.db недоступна — считаем по своим источникам, без падения."""
    facts = {}

    def bucket(oid):
        return facts.setdefault(oid, {"fact": 0.0, "contractor": None, "sources": []})

    zm_seen = set()      # zenmoney_tx_id, уже учтённые своими источниками

    for r in conn.execute(
        """SELECT order_id, id, amount, title, supplier, zenmoney_tx_id
           FROM expenses WHERE order_id IS NOT NULL"""
    ):
        b = bucket(r["order_id"])
        b["fact"] += r["amount"] or 0
        b["sources"].append({"kind": "expense", "amount": r["amount"] or 0,
                             "title": r["title"], "payee": r["supplier"]})
        if r["supplier"] and not b["contractor"]:
            b["contractor"] = r["supplier"]
        if r["zenmoney_tx_id"]:
            zm_seen.add(str(r["zenmoney_tx_id"]))

    # Обязательство — в факт, только если не покрыто расходом (то же условие, что в _plan_fact).
    # covered считаем флагом (а не отсекаем WHERE): покрытую строку в факт не берём,
    # но её zenmoney_tx_id всё равно кладём в zm_seen — иначе тот же перевод всплывёт
    # из zm_links и задвоит факт (обязательство, привязанное к расходу через creditor_id
    # без переноса tx_id на покрывающую запись, из суммы исключено, но перевод один).
    for r in conn.execute(
        """SELECT c.order_id, c.name, c.paid, c.zenmoney_tx_id,
                  EXISTS (
                    SELECT 1 FROM expenses e WHERE e.order_id = c.order_id AND (
                         e.creditor_id = c.id
                      OR (e.finance_tx_id  IS NOT NULL AND e.finance_tx_id  = c.finance_tx_id)
                      OR (e.zenmoney_tx_id IS NOT NULL AND e.zenmoney_tx_id = c.zenmoney_tx_id))
                  ) AS covered
           FROM creditors c
           WHERE c.order_id IS NOT NULL AND COALESCE(c.paid, 0) > 0"""
    ):
        if r["zenmoney_tx_id"]:
            zm_seen.add(str(r["zenmoney_tx_id"]))
        if r["covered"]:
            continue          # покрыто расходом — факт уже учтён через expenses
        b = bucket(r["order_id"])
        b["fact"] += r["paid"] or 0
        b["sources"].append({"kind": "creditor", "amount": r["paid"] or 0,
                             "title": r["name"], "payee": r["name"]})
        if r["name"] and not b["contractor"]:
            b["contractor"] = r["name"]

    try:
        zconn = get_zenmoney()
        try:
            rows = zconn.execute(
                """SELECT l.zm_tx_id, l.order_id, l.contractor_name, l.note,
                          t.date, t.payee, COALESCE(t.outcome, 0) AS outcome
                   FROM zm_links l JOIN zm_transactions t ON t.id = l.zm_tx_id
                   WHERE l.order_id IS NOT NULL AND COALESCE(t.outcome, 0) > 0"""
            ).fetchall()
        finally:
            zconn.close()
    except Exception:
        rows = []                     # базы нет или схема другая — работаем без неё

    for r in rows:
        if str(r["zm_tx_id"]) in zm_seen:
            continue                  # тот же перевод уже учтён расходом/обязательством
        b = bucket(r["order_id"])
        b["fact"] += r["outcome"]
        b["sources"].append({"kind": "zm_link", "amount": r["outcome"],
                             "title": r["note"], "payee": r["contractor_name"] or r["payee"],
                             "date": r["date"]})
        if not b["contractor"]:
            b["contractor"] = r["contractor_name"] or r["payee"]

    for b in facts.values():
        b["fact"] = round(b["fact"], 2)
    return facts


def _margin(conn, oid: str, price_plan, cost_plan, est=None, transit_facts=None) -> dict:
    """Лестница прибыли по заказу. Единый источник правды — не дублировать выражением."""
    if est is None:
        est = _active_set(conn, oid)
    is_bank = bool(est and est["payment_type"] == "bank")
    is_transit = bool(est and est["payment_type"] == "transit")
    revenue = round(price_plan or 0, 2)
    cost = round(cost_plan or 0, 2)
    plan_source = "manual"
    if est:
        plan_source = "approved" if est["status"] == "approved" else "draft"
        if plan_source == "draft":
            # orders.price_plan/cost_plan синкаются ТОЛЬКО при approve. Пока активен
            # черновик, считать по полям заказа нельзя: выручка была бы из устаревшего
            # поля, а себестоимость — из живых строк черновика, и маржа врала бы
            # «минусом на пустом месте». Берём обе суммы из самого сета.
            t = set_totals(conn, est["id"])
            if t["price"] > 0:   # у смет финагента sale_price бывает 0 — ручной план не затираем
                revenue = t["price"]
            if t["cost"] > 0:
                cost = t["cost"]
    transit = None
    if is_transit:
        # Транзит: выручка — сумма счёта как есть (не делим на 0,87, см. money.py),
        # себестоимость — выплата контрагенту. ПЛАН до факта, факт замещает план:
        # пустой себестоимость не бывает, иначе маржа незакрытого транзита равна
        # всему счёту (на ORD-026 это 185 000 вместо 24 050).
        if transit_facts is None:
            transit_facts = _transit_facts(conn)
        tf = transit_facts.get(oid) or {}
        plan = cost
        fact = round(tf.get("fact") or 0, 2)
        if fact > 0:
            cost = fact
        pct = (est["bank_pct"] if est and est["bank_pct"] is not None else 13.0)
        # Расхождение план/факт — сигнал, а не ошибка ввода (заплатил другую сумму,
        # частями или часть с р/с). Молча подменять план фактом без отметки нельзя.
        state = "no_fact" if fact <= 0 else ("matched" if abs(fact - plan) < 1 else "mismatch")
        transit = {
            "invoice": revenue,
            "plan": plan,
            "fact": fact,
            "rest": round(plan - fact, 2),
            "hold": round(revenue - cost, 2),
            "payout_pct": round(100 - pct, 2),
            "hold_pct": pct,
            "contractor": tf.get("contractor"),
            "state": state,
            "sources": tf.get("sources") or [],
        }
    gross = round(revenue - cost, 2)
    # УСН платится с того, что прошло через расчётный счёт. У транзита деньги клиента
    # тоже приходят на р/с, поэтому налог берётся со ВСЕЙ суммы счёта, а не с удержания
    # (94 900 × 6% = 5 694 при удержании 12 400 — реальный доход 6 706, а не 12 400).
    taxable = is_bank or is_transit
    tax = round(revenue * TAX_PCT / 100, 2) if taxable else 0.0
    out = {
        "revenue": revenue,
        "cost": cost,
        "gross_profit": gross,
        "tax": tax,
        "tax_pct": TAX_PCT if taxable else 0.0,
        "net_profit": round(gross - tax, 2),
        "payment_type": (est["payment_type"] if est else None) or "cash",
        "has_estimate": est is not None,
        # Откуда план: approved-смета / draft-смета / вручную (сметы нет).
        # UI обязан помечать draft — эти числа ещё не согласованы с клиентом.
        "plan_source": plan_source,
    }
    if transit:
        out["transit"] = transit
    return out


def _reserve_suggested(pf: dict, cost_plan) -> float:
    """Подсказка суммы резерва под материалы = материальная часть плана из сметы.

    Если смета без детализации (материалы не выделены) — предлагаем полную
    плановую себестоимость: лучше зарезервировать грубо, чем не зарезервировать."""
    for c in (pf.get("categories") or []):
        if c["category"] == "Материалы" and c["plan"] > 0:
            return round(c["plan"], 2)
    return round(cost_plan or 0, 2)


def _plan_fact(conn, oid: str, cost_plan: float, paid_total: float, price_plan: float = 0) -> dict:
    """План (из активной сметы) / Факт (expenses + оплаченные обязательства) по категориям.

    План себестоимости — из строк утверждённой сметы (иначе последней не-superseded).
    Факт — фактические траты: expenses (вносит fin-agent) + creditors.paid (обязательства)."""
    est = _active_set(conn, oid)

    plan_by = {b: 0.0 for b in _CAT_BUCKETS}
    if est:
        # cost_total позиции = Σ(line_total) × quantity → план по категории = Σ line_total×qty
        rows = conn.execute(
            """SELECT el.type AS t, COALESCE(SUM(el.line_total * ei.quantity), 0) AS s
               FROM estimate_lines el JOIN estimate_items ei ON ei.id = el.item_id
               WHERE ei.set_id = ? GROUP BY el.type""", (est["id"],)
        ).fetchall()
        for r in rows:
            plan_by[_bucket(r["t"])] += r["s"] or 0

    fact_by = {b: 0.0 for b in _CAT_BUCKETS}
    for r in conn.execute("SELECT category AS c, COALESCE(SUM(amount),0) AS s FROM expenses WHERE order_id = ? GROUP BY category", (oid,)):
        fact_by[_bucket(r["c"])] += r["s"] or 0
    # ИНВАРИАНТ: одна оплата = один факт. Обязательство попадает в факт, только если
    # оно НЕ покрыто расходом — иначе тот же платёж считался бы дважды (как expense
    # и как creditors.paid). Расход знает о покрытии через creditor_id либо через
    # совпадение id транзакции банка/ZenMoney.
    # Категория факта — из плановой строки/позиции, породившей обязательство
    # (обязательство, оплаченное напрямую, раньше целиком падало в «Прочее»
    # и ломало разбивку). Без привязки к смете — по-прежнему «Прочее».
    cred_rows = conn.execute(
        """SELECT COALESCE(el.type, ei.category, 'other') AS cat, COALESCE(SUM(c.paid), 0) AS s
           FROM creditors c
           LEFT JOIN estimate_lines el ON el.id = c.estimate_line_id
           LEFT JOIN estimate_items ei ON ei.id = c.estimate_item_id
           WHERE c.order_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM expenses e WHERE e.order_id = c.order_id AND (
                    e.creditor_id = c.id
                 OR (e.finance_tx_id  IS NOT NULL AND e.finance_tx_id  = c.finance_tx_id)
                 OR (e.zenmoney_tx_id IS NOT NULL AND e.zenmoney_tx_id = c.zenmoney_tx_id)))
           GROUP BY COALESCE(el.type, ei.category, 'other')""",
        (oid,)
    ).fetchall()
    for r in cred_rows:
        fact_by[_bucket(r["cat"])] += r["s"] or 0

    plan_detail_sum = round(sum(plan_by.values()), 2)
    # Фолбэки плана: строки → позиции сета (сметы финагента без строк) → cost_plan заказа.
    items_plan = 0.0
    if plan_detail_sum == 0 and est:
        for r in conn.execute(
            "SELECT category AS c, COALESCE(SUM(cost_total), 0) AS s FROM estimate_items WHERE set_id = ? GROUP BY category",
            (est["id"],)
        ):
            plan_by[_bucket(r["c"])] += r["s"] or 0
        items_plan = round(sum(plan_by.values()), 2)
    if plan_detail_sum > 0:
        plan_total = plan_detail_sum
    elif items_plan > 0:
        plan_total = items_plan
    else:
        plan_total = round(cost_plan or 0, 2)
        if plan_total > 0:
            plan_by["Прочее"] += plan_total

    categories = []
    for b in _CAT_BUCKETS:
        p, f = round(plan_by[b], 2), round(fact_by[b], 2)
        if p == 0 and f == 0:
            continue
        categories.append({"category": b, "plan": p, "fact": f, "delta": round(f - p, 2)})

    cost_fact = round(sum(fact_by.values()), 2)

    # Маржа — от выручки, а НЕ от оплаченного: заплатил клиент или нет,
    # прибыльность заказа от этого не меняется. Налог берём из общей лестницы.
    m = _margin(conn, oid, price_plan, plan_total, est=est)
    tax = m["tax"]
    gross_plan = round(m["revenue"] - plan_total, 2)

    # Прогноз: «выручка − факт» врал бы вверх, пока расходы не внесены целиком
    # (у ORD-023 внесена только резка → вышло бы +210к «прибыли» на пустом месте).
    # Поэтому берём наибольшее из плана и факта: план ещё предстоит потратить,
    # а перерасход сверх него уже съел маржу. Прогноз никогда не завышает.
    cost_expected = max(plan_total, cost_fact)
    gross_forecast = round(m["revenue"] - cost_expected, 2)

    return {
        "has_estimate": est is not None,
        "plan_source": m["plan_source"],
        "detailed": plan_detail_sum > 0,
        # Внесена ли хоть одна фактическая трата и какая доля плана закрыта фактом.
        # UI обязан смотреть сюда, прежде чем выдавать факт за полную картину.
        "has_facts": cost_fact > 0,
        "cost_coverage": round(cost_fact / plan_total, 4) if plan_total > 0 else None,
        "cost_plan": plan_total,
        "cost_fact": cost_fact,
        "cost_delta": round(cost_fact - plan_total, 2),
        "cost_expected": round(cost_expected, 2),
        "revenue": m["revenue"],
        "tax": tax,
        "gross_plan": gross_plan,
        "net_plan": round(gross_plan - tax, 2),
        "gross_forecast": gross_forecast,
        "net_forecast": round(gross_forecast - tax, 2),
        # Не маржа, а касса: сколько денег пришло минус сколько потрачено.
        # Полезно для кассового разрыва, но прибылью это называть нельзя.
        "cash_collected_vs_cost": round(paid_total - cost_fact, 2),
        "categories": categories,
    }


@router.get("/plan-fact-summary")
def plan_fact_summary():
    """Сводка план/факт по всем активным заказам одним экраном (ТЗ 12)."""
    conn = get_production()
    try:
        rows = conn.execute(
            """SELECT o.id, o.number, o.title, o.status, o.price_plan, o.cost_plan,
                      COALESCE(SUM(p.amount), 0) AS paid_total
               FROM orders o LEFT JOIN payments p ON p.order_id = o.id
               WHERE o.status NOT IN ('completed', 'cancelled')
               GROUP BY o.id ORDER BY o.deadline IS NULL, o.deadline ASC""",
        ).fetchall()
        out = []
        for r in rows:
            pf = _plan_fact(conn, r["id"], r["cost_plan"] or 0, r["paid_total"] or 0, r["price_plan"] or 0)
            if not pf["has_estimate"]:
                continue
            out.append({
                "id": r["id"],
                "number": r["number"],
                "title": r["title"],
                "status": r["status"],
                "status_label": STATUS_LABELS.get(r["status"], r["status"]),
                # Выручка из план-факта: для draft-смет это сет, а не устаревшее поле заказа.
                "price_plan": pf["revenue"],
                "paid_total": r["paid_total"] or 0,
                "plan_source": pf["plan_source"],
                "cost_plan": pf["cost_plan"],
                "cost_fact": pf["cost_fact"],
                "cost_delta": pf["cost_delta"],
                "net_plan": pf["net_plan"],
                "net_forecast": pf["net_forecast"],
                "tax": pf["tax"],
                "has_facts": pf["has_facts"],
                "cost_coverage": pf["cost_coverage"],
                "overspent": pf["cost_fact"] > pf["cost_plan"],
                "detailed": pf["detailed"],
            })
        return {"orders": out}
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
            "SELECT * FROM estimate_sets WHERE order_id = ? ORDER BY created_at ASC",
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
        price_plan = order.get("price_plan") or 0
        pf = _plan_fact(conn, oid, order.get("cost_plan") or 0, paid_total, price_plan)
        m = _margin(conn, oid, price_plan, order.get("cost_plan") or 0)

        return {
            **order,
            # Цена/себестоимость — из активной сметы, а не из полей заказа: они синкаются
            # только при approve, и у черновика карточка показывала одновременно старое
            # число (price_plan) и новое (долг, маржа). Поля таблицы остаются кэшем.
            "price_plan": m["revenue"],
            "cost_plan": m["cost"],
            "price_plan_stored": order.get("price_plan"),   # что лежит в таблице
            "status_label": STATUS_LABELS.get(order["status"], order["status"]),
            "priority_label": PRIORITY_LABELS.get(order["priority"], order["priority"]),
            "paid_total": paid_total,
            # Долг — от той же выручки, что и лестница (для draft-смет это сет, не поле заказа).
            "debt": round((m["revenue"] or 0) - paid_total, 2),
            # margin остаётся валовой (значение прежнее) — рядом полная лестница
            "margin": m["gross_profit"],
            "gross_profit": m["gross_profit"],
            "tax": m["tax"],
            "tax_pct": m["tax_pct"],
            "net_profit": m["net_profit"],
            "payment_type": m["payment_type"],
                # Транзит: счёт / план выплаты / факт / удержание — только у транзитных заказов
                "transit": m.get("transit"),
            "has_estimate": m["has_estimate"],
            "plan_source": m["plan_source"],
            # Резерв под материалы (ТЗ-1 задача 1). reserved_amount/reserve_released_at
            # льются через **order; сюда — производные для UI.
            "reserve_suggested": _reserve_suggested(pf, order.get("cost_plan") or 0),
            "reserve_active": bool((order.get("reserved_amount") or 0) > 0 and not order.get("reserve_released_at")),
            "plan_fact": pf,
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
            "SELECT * FROM estimate_sets WHERE order_id = ? ORDER BY created_at ASC",
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
                actual_paid = conn.execute(
                    "SELECT COALESCE(SUM(paid), 0) FROM creditors WHERE estimate_item_id = ?",
                    (item["id"],),
                ).fetchone()[0]
                obligations_count = conn.execute(
                    "SELECT COUNT(*) FROM creditors WHERE estimate_item_id = ?",
                    (item["id"],),
                ).fetchone()[0]
                items_data.append({
                    **dict(item),
                    "lines": [dict(l) for l in lines],
                    "actual_paid": round(actual_paid, 2),
                    "obligations_count": obligations_count,
                })
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


def _valid_brands(conn) -> set:
    try:
        return {r["name"] for r in conn.execute("SELECT name FROM brands").fetchall()}
    except Exception:
        return {"MeRA", "pbpb", "Транзит"}


class BrandUpdate(BaseModel):
    brand: Optional[str]


@router.patch("/{order_id}/brand")
def update_brand(order_id: str, body: BrandUpdate):
    conn0 = get_production()
    try:
        valid = _valid_brands(conn0)
    finally:
        conn0.close()
    if body.brand is not None and body.brand not in valid:
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


@router.patch("/{order_id}")
async def update_order(order_id: str, body: dict = Body(...)):
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")

        allowed = {"title", "priority", "deadline", "customer_id", "price_plan", "cost_plan", "brand", "status", "finance_tx_id"}
        fields, values = [], []
        for key in allowed:
            if key not in body:
                continue
            val = body[key]
            if key == "priority" and val not in {"low", "normal", "high", "urgent"}:
                raise HTTPException(status_code=400, detail=f"Invalid priority: {val}")
            if key == "status" and val not in VALID_STATUSES:
                raise HTTPException(status_code=400, detail=f"Invalid status: {val}")
            if key == "brand" and val is not None and val not in _valid_brands(conn):
                raise HTTPException(status_code=400, detail=f"Invalid brand: {val}")
            if key == "title" and val is not None:
                val = val.strip()
            fields.append(f"{key} = ?")
            values.append(val)

        if fields:
            fields.append("updated_at = datetime('now')")
            values.append(r["id"])
            conn.execute(f"UPDATE orders SET {', '.join(fields)} WHERE id = ?", values)
            conn.commit()

        return dict(conn.execute("SELECT * FROM orders WHERE id = ?", (r["id"],)).fetchone())
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
        # ИНВАРИАНТ: заказ — план-оболочка. Удаляем ТОЛЬКО его план-данные в production.db.
        # Факты не удаляем никогда: банковские транзакции (finance.db/ДДС), личные финансы
        # (zenmoney.db), каталог, обязательства (creditors) — основа системы.
        conn.execute("DELETE FROM payments WHERE order_id = ?", (oid,))
        conn.execute("DELETE FROM stages WHERE order_id = ?", (oid,))
        conn.execute("DELETE FROM events WHERE order_id = ?", (oid,))
        conn.execute("DELETE FROM expenses WHERE order_id = ?", (oid,))  # legacy MES, FK на orders
        # Порядок важен: FK включены (estimate_lines → estimate_items → estimate_sets),
        # удаляем от листьев к корню, иначе IntegrityError и заказ не удаляется.
        conn.execute("DELETE FROM estimate_lines WHERE item_id IN (SELECT ei.id FROM estimate_items ei JOIN estimate_sets es ON ei.set_id = es.id WHERE es.order_id = ?)", (oid,))
        conn.execute("DELETE FROM estimate_items WHERE set_id IN (SELECT id FROM estimate_sets WHERE order_id = ?)", (oid,))
        conn.execute("DELETE FROM estimate_sets WHERE order_id = ?", (oid,))
        # Обязательства сохраняем (это долги-факты, с привязками к транзакциям),
        # только отвязываем от удаляемого заказа и его смет.
        conn.execute("UPDATE creditors SET order_id = NULL, estimate_item_id = NULL, estimate_line_id = NULL WHERE order_id = ?", (oid,))
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


class PaymentCreate(BaseModel):
    amount: float
    paid_at: str
    note: Optional[str] = None
    bank_tx_id: Optional[str] = None


def _create_payment(conn, order_row, amount, paid_at, note=None, *, source, bank_tx_id=None) -> dict:
    """Единая точка вставки платежа: валидация + INSERT + возврат строки.

    Оба входа (ручной add_payment, разноска поступлений payments.from_tx) обязаны
    идти через неё — иначе правка правил создания (валидация, аудит, лимиты) доедет
    только до одного места. НЕ коммитит и НЕ открывает соединение: разноска пишет
    несколько платежей одной транзакцией на общем conn (см. payments.py)."""
    if amount is None or amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")
    if not (str(paid_at or "").strip()):
        raise HTTPException(status_code=400, detail="paid_at required")
    pid = str(uuid4())
    conn.execute(
        """INSERT INTO payments (id, order_id, amount, paid_at, note, bank_tx_id, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
        (pid, order_row["id"], round(amount, 2), paid_at, note, bank_tx_id, source),
    )
    return dict(conn.execute("SELECT * FROM payments WHERE id = ?", (pid,)).fetchone())


def _reserve_hint(conn, order_row) -> dict:
    """Подсказка резерва под материалы после платежа. paid_total — фактический
    (все платежи заказа), а не 0: prompt «отложить материалы» опирается на реальную
    оплату, иначе cash_collected_vs_cost в plan_fact считался бы по пустой оплате."""
    paid_total = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) FROM payments WHERE order_id = ?", (order_row["id"],)
    ).fetchone()[0] or 0
    pf = _plan_fact(conn, order_row["id"], order_row["cost_plan"] or 0, paid_total, order_row["price_plan"] or 0)
    return {
        "reserve_suggested": _reserve_suggested(pf, order_row["cost_plan"] or 0),
        "reserve_active": bool((order_row["reserved_amount"] or 0) > 0 and not order_row["reserve_released_at"]),
    }


@router.post("/{order_id}/payments")
def add_payment(order_id: str, body: PaymentCreate):
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        payment = _create_payment(conn, r, body.amount, body.paid_at, body.note,
                                  source="manual", bank_tx_id=body.bank_tx_id)
        conn.commit()
        payment.update(_reserve_hint(conn, r))
        payment["order_id"] = r["id"]
        return payment
    finally:
        conn.close()


@router.delete("/{order_id}/payments/{payment_id}")
def delete_payment(order_id: str, payment_id: str):
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM payments WHERE id = ? AND order_id IN (SELECT id FROM orders WHERE id = ? OR number = ?)", (payment_id, order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("DELETE FROM payments WHERE id = ?", (payment_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Резерв под материалы (ТЗ-1 задача 1) ─────────────────────────────────────

class ReserveIn(BaseModel):
    amount: float


@router.post("/{order_id}/reserve")
def set_reserve(order_id: str, body: ReserveIn):
    """Отложить сумму под закупку материалов. Пере-взвод: снимает прежнее «снято»."""
    if body.amount is None or body.amount < 0:
        raise HTTPException(status_code=400, detail="amount must be >= 0")
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute(
            "UPDATE orders SET reserved_amount = ?, reserve_released_at = NULL, updated_at = datetime('now') WHERE id = ?",
            (round(body.amount, 2), r["id"])
        )
        conn.commit()
        o = dict(conn.execute("SELECT * FROM orders WHERE id = ?", (r["id"],)).fetchone())
        o["reserve_active"] = bool((o["reserved_amount"] or 0) > 0 and not o["reserve_released_at"])
        return o
    finally:
        conn.close()


@router.post("/{order_id}/reserve/release")
def release_reserve(order_id: str):
    """Материалы закуплены — снять резерв (сумму оставляем как историю)."""
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute(
            "UPDATE orders SET reserve_released_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (r["id"],)
        )
        conn.commit()
        o = dict(conn.execute("SELECT * FROM orders WHERE id = ?", (r["id"],)).fetchone())
        o["reserve_active"] = False
        return o
    finally:
        conn.close()


# ── Фактические траты по заказу ──────────────────────────────────────────────
# Категория — только из 4 корзин: _bucket тотальная, любое иное значение молча
# уедет в «Прочее» и потеряется в план-факте.
EXPENSE_CATEGORIES = ("material", "work", "delivery", "other")


class ExpenseIn(BaseModel):
    title: str
    amount: float
    category: str = "other"
    supplier: Optional[str] = None
    master_id: Optional[str] = None
    expense_date: Optional[str] = None   # YYYY-MM-DD, по умолчанию сегодня
    finance_tx_id: Optional[str] = None
    zenmoney_tx_id: Optional[str] = None
    creditor_id: Optional[str] = None
    # Наличный контур: None = безнал/банк | cash_fund (из кассы) | accountable (через подотчётника)
    payment_source: Optional[str] = None
    accountable_person_id: Optional[str] = None


def _resolve_order(conn, order_id: str):
    r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Not found")
    return r["id"]


def _validate_expense(body: ExpenseIn):
    if not (body.title or "").strip():
        raise HTTPException(status_code=400, detail="title required")
    # Нулевой/отрицательный расход молча испортит факт и маржу.
    if body.amount is None or body.amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")
    if body.category not in EXPENSE_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"category must be one of {'|'.join(EXPENSE_CATEGORIES)}")
    if body.payment_source not in (None, "cash_fund", "accountable"):
        raise HTTPException(status_code=400, detail="payment_source must be cash_fund|accountable or empty")
    if body.payment_source == "accountable" and not body.accountable_person_id:
        raise HTTPException(status_code=400, detail="accountable_person_id required for payment_source=accountable")


def _sync_cash_fund(conn, eid: str, body: ExpenseIn):
    """Наличный расход из кассы = expense + списание кассы одной операцией.
    Движение кассы связано через fund_transactions.expense_id — правка/удаление
    расхода подчищает его (кассовый остаток не расходится с фактами)."""
    conn.execute("DELETE FROM fund_transactions WHERE expense_id = ?", (eid,))
    if body.payment_source == "cash_fund":
        fund = conn.execute("SELECT id FROM funds WHERE kind = 'cash'").fetchone()
        if fund:
            conn.execute(
                """INSERT INTO fund_transactions (id, fund_id, direction, amount, note, date, expense_id)
                   VALUES (?, ?, 'out', ?, ?, COALESCE(?, date('now')), ?)""",
                (str(uuid4()), fund["id"], body.amount, f"Расход: {body.title.strip()}",
                 body.expense_date, eid),
            )


def _autolink_creditor(conn, oid: str, body: ExpenseIn) -> Optional[str]:
    """Расход, оплативший обязательство, должен знать об этом — иначе двойной счёт.

    Если creditor_id не указан явно, ищем обязательство того же заказа с той же
    транзакцией банка/ZenMoney (правило дедупа, см. _plan_fact)."""
    if body.creditor_id:
        return body.creditor_id
    if body.finance_tx_id:
        r = conn.execute(
            "SELECT id FROM creditors WHERE order_id = ? AND finance_tx_id = ?", (oid, body.finance_tx_id)
        ).fetchone()
        if r:
            return r["id"]
    if body.zenmoney_tx_id:
        r = conn.execute(
            "SELECT id FROM creditors WHERE order_id = ? AND zenmoney_tx_id = ?", (oid, body.zenmoney_tx_id)
        ).fetchone()
        if r:
            return r["id"]
    return None


@router.get("/{order_id}/expenses")
def list_expenses(order_id: str):
    conn = get_production()
    try:
        oid = _resolve_order(conn, order_id)
        # Один запрос, агрегация в Python (code_rules: без N+1 на строку).
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM expenses WHERE order_id = ? ORDER BY expense_date DESC, created_at DESC", (oid,)
        ).fetchall()]
        by_category = {}
        for r in rows:
            b = _bucket(r["category"])
            by_category[b] = round(by_category.get(b, 0) + (r["amount"] or 0), 2)
        return {
            "items": rows,
            "total": round(sum(r["amount"] or 0 for r in rows), 2),
            "by_category": by_category,
        }
    finally:
        conn.close()


@router.get("/{order_id}/obligations")
def list_obligations(order_id: str):
    """Плановые строки заказа (обязательства) с фактом: план vs факт по сумме и исполнителю.

    Единица — обязательство (creditors) со ссылкой на строку сметы (estimate_line_id).
    План: строка сметы (title, категория, плановый исполнитель, amount_plan).
    Факт: expenses, привязанные к обязательству (creditor_id) → paid + фактические исполнители.
    """
    conn = get_production()
    try:
        oid = _resolve_order(conn, order_id)
        creds = [dict(r) for r in conn.execute(
            "SELECT * FROM creditors WHERE order_id = ? ORDER BY created_at", (oid,)
        ).fetchall()]

        # Факт по обязательствам: expenses.creditor_id → сумма + фактические исполнители.
        fact = {}  # creditor_id -> {"paid": x, "executors": {name}}
        for e in conn.execute(
            """SELECT ex.creditor_id AS cid, ex.amount AS amount, ex.master_id AS mid, m.name AS mname
                 FROM expenses ex LEFT JOIN masters m ON m.id = ex.master_id
                WHERE ex.order_id = ? AND ex.creditor_id IS NOT NULL""", (oid,)
        ).fetchall():
            f = fact.setdefault(e["cid"], {"paid": 0.0, "executors": []})
            f["paid"] += e["amount"] or 0
            nm = e["mname"]
            if nm and nm not in f["executors"]:
                f["executors"].append(nm)

        out = []
        for c in creds:
            line = None
            if c["estimate_line_id"]:
                line = conn.execute(
                    "SELECT title, type, master_id, contractor_name FROM estimate_lines WHERE id = ?",
                    (c["estimate_line_id"],)
                ).fetchone()
            # Плановый исполнитель: строка (master_id→имя / contractor_name), иначе имя обязательства.
            planned_executor = None
            category = "Прочее"
            if line:
                category = _bucket(line["type"])
                if line["master_id"]:
                    m = conn.execute("SELECT name FROM masters WHERE id = ?", (line["master_id"],)).fetchone()
                    planned_executor = m["name"] if m else None
                planned_executor = planned_executor or (line["contractor_name"] or None)
            title = (line["title"] if line and line["title"] else None) or c["name"]

            f = fact.get(c["id"], {"paid": 0.0, "executors": []})
            paid = round(f["paid"], 2)
            plan = round(c["amount_plan"] or c["total"] or 0, 2)
            actual = f["executors"]
            # Расхождение: другой/незапланированный исполнитель, либо переплата.
            exec_divergence = bool(actual) and (
                planned_executor is None or any(a != planned_executor for a in actual)
            )
            sum_divergence = paid > plan + 0.01
            out.append({
                "creditor_id": c["id"],
                "line_id": c["estimate_line_id"],
                "title": title,
                "category": category,
                "planned_amount": plan,
                "paid": paid,
                "remaining": round(max(plan - paid, 0), 2),
                "planned_executor": planned_executor,
                "actual_executors": actual,
                "status": c["status"],
                "divergence": exec_divergence or sum_divergence,
            })
        # Активная смета — чтобы разноска могла предложить «Утвердить смету», когда
        # обязательств ещё нет (черновик). Гейт сохраняется: creditors создаёт только approve.
        est = _active_set(conn, oid)
        active_set = {"id": est["id"], "status": est["status"]} if est else None
        return {"items": out, "active_set": active_set}
    finally:
        conn.close()


@router.post("/{order_id}/expenses", status_code=201)
def add_expense(order_id: str, body: ExpenseIn):
    _validate_expense(body)
    conn = get_production()
    try:
        oid = _resolve_order(conn, order_id)
        eid = str(uuid4())
        conn.execute(
            """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                     expense_date, source, creditor_id, finance_tx_id, zenmoney_tx_id,
                                     payment_source, accountable_person_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), 'manual', ?, ?, ?, ?, ?, datetime('now'))""",
            (eid, oid, body.title.strip(), body.amount, body.category, body.supplier, body.master_id,
             body.expense_date, _autolink_creditor(conn, oid, body), body.finance_tx_id, body.zenmoney_tx_id,
             body.payment_source, body.accountable_person_id if body.payment_source == "accountable" else None)
        )
        _sync_cash_fund(conn, eid, body)
        conn.commit()
        return dict(conn.execute("SELECT * FROM expenses WHERE id = ?", (eid,)).fetchone())
    finally:
        conn.close()


@router.put("/{order_id}/expenses/{expense_id}")
def update_expense(order_id: str, expense_id: str, body: ExpenseIn):
    _validate_expense(body)
    conn = get_production()
    try:
        r = conn.execute(
            "SELECT id, order_id FROM expenses WHERE id = ? AND order_id IN (SELECT id FROM orders WHERE id = ? OR number = ?)",
            (expense_id, order_id, order_id)
        ).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute(
            """UPDATE expenses SET title = ?, amount = ?, category = ?, supplier = ?, master_id = ?,
                      expense_date = COALESCE(?, expense_date), creditor_id = ?,
                      finance_tx_id = ?, zenmoney_tx_id = ?,
                      payment_source = ?, accountable_person_id = ?
               WHERE id = ?""",
            (body.title.strip(), body.amount, body.category, body.supplier, body.master_id,
             body.expense_date, _autolink_creditor(conn, r["order_id"], body),
             body.finance_tx_id, body.zenmoney_tx_id,
             body.payment_source, body.accountable_person_id if body.payment_source == "accountable" else None,
             expense_id)
        )
        _sync_cash_fund(conn, expense_id, body)
        conn.commit()
        return dict(conn.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone())
    finally:
        conn.close()


class SplitPart(BaseModel):
    amount: float
    category: str
    title: Optional[str] = None


class SplitIn(BaseModel):
    parts: List[SplitPart]


@router.post("/{order_id}/expenses/{expense_id}/split")
def split_expense(order_id: str, expense_id: str, body: SplitIn):
    """Детализация: разбить один расход на несколько категорий (материалы/работы/…).
    Первая часть остаётся в исходной строке (id, ссылки целы — инвариант
    «одна оплата = один факт» не ломается), остальные — сиблинги с общим group_id.
    creditor_id и tx-ссылки копируются на КАЖДУЮ часть (паттерн from-tx: несколько
    строк одной транзакции), иначе привязка к обязательству теряется у сиблингов
    (list_obligations недосчитал бы факт). Наличный контур (payment_source=cash_fund)
    пересчитывает движение кассы для каждой части, а не оставляет одно на исходной
    строке на полную сумму — иначе касса рассинхронится при правке/удалении части."""
    if len(body.parts) < 2:
        raise HTTPException(status_code=400, detail="Нужно минимум 2 части")
    for p in body.parts:
        if p.category not in EXPENSE_CATEGORIES:
            raise HTTPException(status_code=400, detail=f"category must be one of {'|'.join(EXPENSE_CATEGORIES)}")
        if p.amount <= 0:
            raise HTTPException(status_code=400, detail="Сумма части должна быть > 0")
    conn = get_production()
    try:
        r = conn.execute(
            "SELECT * FROM expenses WHERE id = ? AND order_id IN (SELECT id FROM orders WHERE id = ? OR number = ?)",
            (expense_id, order_id, order_id)
        ).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        total = sum(p.amount for p in body.parts)
        if abs(total - (r["amount"] or 0)) > 0.01:
            raise HTTPException(
                status_code=400,
                detail=f"Сумма частей {total:.2f} не сходится с расходом {r['amount']:.2f}")
        group_id = r["group_id"] or str(uuid4())
        first = body.parts[0]
        first_title = (first.title or "").strip() or r["title"]
        conn.execute(
            "UPDATE expenses SET amount = ?, category = ?, title = COALESCE(?, title), group_id = ? WHERE id = ?",
            (first.amount, first.category, (first.title or "").strip() or None, group_id, expense_id))
        # Наличный контур: движение кассы пересчитываем под НОВУЮ сумму части — иначе
        # на исходной строке осталось бы списание на полную сумму (см. код-правило 2026-07-24).
        _sync_cash_fund(conn, expense_id, ExpenseIn(
            title=first_title, amount=first.amount, category=first.category,
            payment_source=r["payment_source"], expense_date=r["expense_date"]))
        new_ids = []
        for p in body.parts[1:]:
            eid = str(uuid4())
            new_ids.append(eid)
            p_title = (p.title or "").strip() or r["title"]
            conn.execute(
                """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                         expense_date, source, creditor_id, finance_tx_id, zenmoney_tx_id,
                                         payment_source, accountable_person_id, group_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
                (eid, r["order_id"], p_title, p.amount, p.category,
                 r["supplier"], r["master_id"], r["expense_date"], r["source"],
                 r["creditor_id"], r["finance_tx_id"], r["zenmoney_tx_id"],
                 r["payment_source"], r["accountable_person_id"], group_id))
            # Каждая часть — своё движение кассы, а не одно на исходной строке.
            _sync_cash_fund(conn, eid, ExpenseIn(
                title=p_title, amount=p.amount, category=p.category,
                payment_source=r["payment_source"], expense_date=r["expense_date"]))
        conn.commit()
        rows = [dict(x) for x in conn.execute(
            "SELECT * FROM expenses WHERE id IN ({}) ORDER BY created_at".format(
                ",".join("?" * (len(new_ids) + 1))), [expense_id] + new_ids).fetchall()]
        return {"ok": True, "group_id": group_id, "items": rows}
    finally:
        conn.close()


@router.delete("/{order_id}/expenses/{expense_id}")
def delete_expense(order_id: str, expense_id: str, with_group: bool = False):
    """with_group=true удаляет всю группу разноски (одна поездка на несколько заказов)."""
    conn = get_production()
    try:
        r = conn.execute(
            "SELECT id, group_id FROM expenses WHERE id = ? AND order_id IN (SELECT id FROM orders WHERE id = ? OR number = ?)",
            (expense_id, order_id, order_id)
        ).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        if with_group and r["group_id"]:
            ids = [x["id"] for x in conn.execute("SELECT id FROM expenses WHERE group_id = ?", (r["group_id"],)).fetchall()]
            cur = conn.execute("DELETE FROM expenses WHERE group_id = ?", (r["group_id"],))
            deleted = cur.rowcount
        else:
            ids = [expense_id]
            conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
            deleted = 1
        # Подчистить связанные движения кассы (наличные расходы).
        for x in ids:
            conn.execute("DELETE FROM fund_transactions WHERE expense_id = ?", (x,))
        conn.commit()
        return {"ok": True, "deleted": deleted}
    finally:
        conn.close()
