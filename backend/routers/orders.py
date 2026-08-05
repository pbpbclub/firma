from fastapi import APIRouter, Query, HTTPException, Body, Depends
from pydantic import BaseModel
from typing import Optional, List
from uuid import uuid4
from db import get_production, get_zenmoney
from auth import get_current_user
from audit import audit
from routers.estimates import set_totals

router = APIRouter()

STATUS_LABELS = {
    "draft": "Черновик",
    "estimate": "Смета",
    "project": "Проект",
    "in_production": "В производстве",
    # Смета/счёт есть, работа не началась — заказчик тянет с оплатой. Ставится
    # ТОЛЬКО вручную (решение Юры 28.07.2026): система лишь подсказывает.
    "awaiting_payment": "Ждёт оплаты",
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
        discounts = _discounts(conn)   # тем же приёмом: скидка иначе читалась бы на строку
        extras = _extras_totals(conn)  # допработы — тоже одним запросом на весь список
        out = []
        for r in rows:
            m = _margin(conn, r["id"], r["price_plan"], r["cost_plan"],
                        transit_facts=tfacts, discounts=discounts, extras=extras)
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
                "tax_base": m["tax_base"],
                "discount": m["discount"],
                "price_before_discount": m["price_before_discount"],
                "net_profit": m["net_profit"],
                "payment_type": m["payment_type"],
                # Транзит: счёт / план выплаты / факт / удержание — только у транзитных заказов
                "transit": m.get("transit"),
                "has_estimate": m["has_estimate"],
                "plan_source": m["plan_source"],
                **_awaiting_flags(r["status"], m["revenue"], r["paid_total"]),
                **_order_delta(conn, r, m, extras=extras),
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
        discounts = _discounts(conn)
        extras = _extras_totals(conn)
        scored = []
        for r in rows:
            row = dict(r)
            # Цена — из активной сметы (у черновиков поле заказа устаревшее), чтобы
            # подсказка по сумме и долг совпадали с карточкой.
            m = _margin(conn, row["id"], row.get("price_plan") or 0, row.get("cost_plan") or 0,
                        transit_facts=tfacts, discounts=discounts, extras=extras)
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

# «Деньги прошли через расчётный счёт» — одно выражение на систему (SQL-условие
# по строке payments). Признаком был bank_tx_id, и он врал в обе стороны: у оплат,
# внесённых руками и фин-агентом, он пуст, хотя это безнал (4 счёта от ООО через
# Т-Банк, 383 000 ₽), а заказ с активной сметой cash не начислял УСН вовсе на
# реально прошедшие 184 000 ₽ (ORD-023, 30.07.2026).
#
# Порядок разбора: явный channel → zenmoney_tx_id (по построению личная карта,
# см. ensure_payment_zenmoney_schema) → КОНСЕРВАТИВНО безнал. Консервативно,
# потому что недоначисленный УСН — налоговый риск, а лишний резерв в фонде —
# просто деньги на счету. Нал помечается явно: channel='cash'.
PAYMENT_IS_BANK_SQL = """
    COALESCE(NULLIF(channel, ''),
             CASE WHEN zenmoney_tx_id IS NOT NULL AND zenmoney_tx_id <> ''
                  THEN 'personal' ELSE 'bank' END) = 'bank'
"""


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


def _awaiting_flags(status: str, price_plan, paid_total) -> dict:
    """Подсказки вокруг «Ждёт оплаты» — производные, в схеме ничего не храним.

    awaiting_hint: счёт/цена есть, оплат нет — похоже, заказ ждёт оплату; предлагаем
    Юре пометить (сам статус НЕ ставим — ручное решение).
    awaiting_paid_signal: по «ждущему» пришли деньги — сигнал «запускаем?», тоже без
    автоперехода: частичная предоплата ещё не значит, что работа началась."""
    return {
        "awaiting_hint": status in ("estimate", "project")
                         and (price_plan or 0) > 0 and (paid_total or 0) <= 0,
        "awaiting_paid_signal": status == "awaiting_payment" and (paid_total or 0) > 0,
    }


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
        return facts.setdefault(oid, {"fact": 0.0, "fact_extra": 0.0, "contractor": None,
                                      "sources": [], "sources_extra": []})

    zm_seen = set()      # zenmoney_tx_id, уже учтённые своими источниками
    # (вид, tx_id, order_id) — дубль ловим ВНУТРИ заказа. Ключ без order_id был
    # глобальным и терял законный случай: один перевод оплачивает несколько заказов
    # (45 500 Годнику 12.05.2026 = 40 000 по ТО систем + 5 500 по рассылке — второй
    # расход отбрасывался, факт заказа занижался ровно на его долю).
    # Страховка от настоящей ошибки разноски (сумма частей больше самого перевода) —
    # отдельной проверкой в «Готовности» (costing.py::readiness → tx_overspread).
    tx_seen = set()
    # Третий контур дедупа — по СУММЕ. Ручной расход (или закрытое руками
    # обязательство) не несёт tx_id, и zm_link того же перевода не гасился по
    # zm_seen — факт задваивался (44 370 → 88 740). Совпадение суммы ±1 ₽ по тому
    # же заказу считаем тем же переводом; каждая сумма гасит только ОДНУ привязку,
    # чтобы настоящая вторая выплата той же суммы не потерялась.
    untied = {}          # order_id -> [суммы источников без zenmoney_tx_id]

    for r in conn.execute(
        """SELECT order_id, id, amount, title, supplier, zenmoney_tx_id, finance_tx_id, extra_id
           FROM expenses WHERE order_id IS NOT NULL"""
    ):
        keys = [(k, str(tx), r["order_id"]) for k, tx in (("fin", r["finance_tx_id"]),
                                                          ("zm", r["zenmoney_tx_id"])) if tx]
        if any(k in tx_seen for k in keys):
            # одна транзакция разнесена дважды ПО ОДНОМУ заказу (например, до и после
            # деградации инбокса) — в факт идёт только первый расход
            tx_seen.update(keys)
            continue
        tx_seen.update(keys)
        b = bucket(r["order_id"])
        # Расходы допработ — отдельным итогом: в _plan_fact/_margin факт допов уже
        # приплюсовывается своей строкой (extras), и попади они сюда — транзитный
        # заказ считал бы их дважды. Дедуп (tx_seen/zm_seen/untied) при этом общий:
        # перевод один, каким бы контуром он ни был описан.
        # Детализация идёт в тот же итог, что и сумма: sources — «чем подтверждён
        # fact», и расход допа туда попасть не может, иначе список «чем подтверждено»
        # в панели транзита складывается в сумму больше самого факта.
        b["fact_extra" if r["extra_id"] else "fact"] += r["amount"] or 0
        b["sources_extra" if r["extra_id"] else "sources"].append(
            {"kind": "expense", "amount": r["amount"] or 0,
             "title": r["title"], "payee": r["supplier"]})
        if r["supplier"] and not b["contractor"]:
            b["contractor"] = r["supplier"]
        if r["zenmoney_tx_id"]:
            zm_seen.add(str(r["zenmoney_tx_id"]))
        else:
            untied.setdefault(r["order_id"], []).append(r["amount"] or 0)

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
        if not r["zenmoney_tx_id"]:
            untied.setdefault(r["order_id"], []).append(r["paid"] or 0)

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

    def _consume_untied(order_id, outcome) -> bool:
        """Есть ли по заказу свой источник той же суммы без tx_id — и погасить его."""
        amounts = untied.get(order_id) or []
        for i, a in enumerate(amounts):
            if abs(a - outcome) <= 1:
                amounts.pop(i)
                return True
        return False

    for r in rows:
        if str(r["zm_tx_id"]) in zm_seen:
            continue                  # тот же перевод уже учтён расходом/обязательством
        if _consume_untied(r["order_id"], r["outcome"]):
            continue                  # ручной источник той же суммы — тот же перевод
        b = bucket(r["order_id"])
        b["fact"] += r["outcome"]
        b["sources"].append({"kind": "zm_link", "amount": r["outcome"],
                             "title": r["note"], "payee": r["contractor_name"] or r["payee"],
                             "date": r["date"]})
        if not b["contractor"]:
            b["contractor"] = r["contractor_name"] or r["payee"]

    for b in facts.values():
        b["fact"] = round(b["fact"], 2)
        b["fact_extra"] = round(b["fact_extra"], 2)
    return facts


def _order_delta(conn, r, m, extras=None) -> dict:
    """«Дельта» — один ориентир Юры в таблице заказов, смысл зависит от стадии
    (решение 29.07.2026): план для сметы/ждущих, прогноз в работе, факт у завершённых.
    Всегда чистая, после УСН — та же цифра, что «Чистая · прогноз» в карточке.

    Транзит считается через _margin: там себестоимость уже замещена фактом выплаты
    (включая привязки фин-агента из zenmoney), о которых _plan_fact не знает."""
    status = r["status"]
    if m.get("transit"):
        src = "plan" if m["transit"]["state"] == "no_fact" else "fact"
        return {"delta": m["net_profit"], "delta_source": src}
    if status in ("completed", "in_production"):
        pf = _plan_fact(conn, r["id"], r["cost_plan"] or 0, r["paid_total"] or 0,
                        r["price_plan"] or 0, extras=extras)
        if status == "completed":
            if pf["has_facts"]:
                # Итог закрытого заказа: выручка минус реальные траты минус налог.
                # net_forecast здесь не годится — его max(план, факт) занизил бы
                # прибыль заказа, закрытого дешевле плана.
                return {"delta": round(pf["revenue"] - pf["cost_fact"] - pf["tax"], 2),
                        "delta_source": "fact"}
            return {"delta": pf["net_plan"], "delta_source": "plan"}
        return {"delta": pf["net_forecast"], "delta_source": "forecast"}
    return {"delta": m["net_profit"], "delta_source": "plan"}


def _discounts(conn) -> dict:
    """Скидки по всем заказам одним запросом — предрасчёт для списков (как
    _transit_facts). Заказы без скидки в словарь не попадают: отсутствие ключа
    и есть «скидки нет»."""
    return {
        r["id"]: (r["discount"] or 0, r["discount_note"])
        for r in conn.execute(
            """SELECT id, discount, discount_note FROM orders
               WHERE COALESCE(discount,0) != 0 OR discount_note IS NOT NULL"""
        ).fetchall()
    }


def _extras_totals(conn) -> dict:
    """Допработы по всем заказам одним запросом — предрасчёт для списков (как
    _discounts). Заказы без допов в словарь не попадают."""
    return {
        r["order_id"]: {"count": r["n"], "price": round(r["p"] or 0, 2), "cost": round(r["c"] or 0, 2)}
        for r in conn.execute(
            """SELECT order_id, COUNT(*) AS n, COALESCE(SUM(price),0) AS p,
                      COALESCE(SUM(cost),0) AS c
               FROM order_extras GROUP BY order_id"""
        ).fetchall()
    }


def _order_extras(conn, oid: str) -> dict:
    """Допы одного заказа. Отдельный запрос вместо _extras_totals по всей базе —
    карточка заказа не должна сканировать чужие допы."""
    r = conn.execute(
        """SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS p, COALESCE(SUM(cost),0) AS c
           FROM order_extras WHERE order_id = ?""", (oid,)).fetchone()
    return {"count": r["n"] or 0, "price": round(r["p"] or 0, 2), "cost": round(r["c"] or 0, 2)}


def _check_extra(conn, oid: str, extra_id) -> Optional[str]:
    """Доп из тела запроса обязан принадлежать ЭТОМУ заказу.

    Без проверки платёж (или расход) по заказу A с extra_id допа заказа B молча
    попадает в paid/cost_fact чужого допа — обе карточки показывают одни и те же
    деньги как свои. Тот же контроль, что у creditor_id в expenses.create_from_tx."""
    if not extra_id:
        return None
    r = conn.execute("SELECT id FROM order_extras WHERE id = ? AND order_id = ?",
                     (extra_id, oid)).fetchone()
    if not r:
        raise HTTPException(status_code=400, detail="Допработа не принадлежит этому заказу")
    return r["id"]


def _overhead_month(conn, period: str = None) -> dict:
    """A8: накладные месяца ФАКТОМ — общехоз расходы (order_id IS NULL,
    purpose='overhead') + оплаченные постоянные обязательства месяца (аренда),
    не покрытые таким расходом (инвариант «одна оплата = один факт»)."""
    if not period:
        period = conn.execute("SELECT strftime('%Y-%m','now')").fetchone()[0]
    exp = conn.execute(
        """SELECT COALESCE(SUM(amount),0) FROM expenses
           WHERE order_id IS NULL AND purpose = 'overhead'
             AND strftime('%Y-%m', expense_date) = ?""", (period,)).fetchone()[0] or 0
    fixed = conn.execute(
        """SELECT COALESCE(SUM(c.paid),0) FROM creditors c
           WHERE c.kind = 'fixed' AND c.period = ?
             AND NOT EXISTS (SELECT 1 FROM expenses e WHERE (
                   e.creditor_id = c.id
                OR (e.finance_tx_id  IS NOT NULL AND e.finance_tx_id  = c.finance_tx_id)
                OR (e.zenmoney_tx_id IS NOT NULL AND e.zenmoney_tx_id = c.zenmoney_tx_id)))""",
        (period,)).fetchone()[0] or 0
    return {"period": period, "total": round(exp + fixed, 2),
            "expenses": round(exp, 2), "fixed": round(fixed, 2)}


def _fact_costs(conn, oids: list) -> dict:
    """Фактическая себестоимость ПАЧКОЙ заказов: расходы + непокрытые
    обязательства (тот же инвариант, что в _plan_fact, без разбивки по категориям).

    Пачкой, а не по заказу: единственный вызов — раскладка накладных по всему
    цеху, и два запроса на каждый заказ превращали открытие одной карточки
    в скан производственного контура (code_rules 17.07 — N+1)."""
    out = {oid: 0.0 for oid in oids}
    if not oids:
        return out
    ph = ", ".join("?" * len(oids))
    for r in conn.execute(
        f"SELECT order_id AS oid, COALESCE(SUM(amount),0) AS s FROM expenses "
        f"WHERE order_id IN ({ph}) GROUP BY order_id", oids
    ).fetchall():
        out[r["oid"]] += r["s"] or 0
    for r in conn.execute(
        f"""SELECT c.order_id AS oid, COALESCE(SUM(c.paid),0) AS s FROM creditors c
            WHERE c.order_id IN ({ph})
              AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.order_id = c.order_id AND (
                    e.creditor_id = c.id
                 OR (e.finance_tx_id  IS NOT NULL AND e.finance_tx_id  = c.finance_tx_id)
                 OR (e.zenmoney_tx_id IS NOT NULL AND e.zenmoney_tx_id = c.zenmoney_tx_id)))
            GROUP BY c.order_id""", oids
    ).fetchall():
        out[r["oid"]] += r["s"] or 0
    return {oid: round(v, 2) for oid, v in out.items()}


def _overhead_allocation(conn) -> dict:
    """A8 (решение Юры 04.08.2026): накладные текущего месяца делятся между
    заказами в производстве пропорционально их фактической себестоимости
    (база = загрузка цеха; при нулевых фактах — поровну). Считается на лету,
    сметы не трогает. Возвращает {"month": …, "orders": {oid: {...}}}."""
    month = _overhead_month(conn)
    rows = conn.execute(
        "SELECT id, title FROM orders WHERE status = 'in_production' AND COALESCE(archived,0) = 0"
    ).fetchall()
    out = {"month": month, "orders": {}}
    if not rows or month["total"] <= 0:
        return out
    facts = _fact_costs(conn, [r["id"] for r in rows])
    base_total = sum(facts.values())
    shares = {r["id"]: (facts[r["id"]] / base_total) if base_total > 0 else 1 / len(rows)
              for r in rows}
    amounts = {oid: round(month["total"] * s, 2) for oid, s in shares.items()}
    # Копейки независимого округления не растворяются: сумма долей обязана
    # сходиться с итогом месяца — иначе расхождение «строки ≠ итог» видно
    # только в UI дашборда и тестами бэкенда не ловится (code_rules 02.08).
    residual = round(month["total"] - sum(amounts.values()), 2)
    if abs(residual) >= 0.01:
        top = max(amounts, key=lambda oid: amounts[oid])
        amounts[top] = round(amounts[top] + residual, 2)
    for r in rows:
        out["orders"][r["id"]] = {
            "title": r["title"],
            "share": round(shares[r["id"]], 4),
            "amount": amounts[r["id"]],
            "fact_cost": facts[r["id"]],
        }
    return out


def _margin(conn, oid: str, price_plan, cost_plan, est=None, transit_facts=None,
            discounts=None, extras=None, overhead_alloc=None) -> dict:
    """Лестница прибыли по заказу. Единый источник правды — не дублировать выражением."""
    if est is None:
        est = _active_set(conn, oid)
    is_bank = bool(est and est["payment_type"] == "bank")
    is_transit = bool(est and est["payment_type"] == "transit")
    revenue = round(price_plan or 0, 2)
    # Скидка — договорённость в конце сделки; смета-документ не перекраивается,
    # к оплате = цена − discount. В списках передаётся предрасчётом _discounts
    # (иначе запрос на строку), для одиночных вызовов остаётся SELECT по заказу.
    if discounts is not None:
        d_val, discount_note = discounts.get(oid, (0, None))
    else:
        drow = conn.execute(
            "SELECT discount, discount_note FROM orders WHERE id = ?", (oid,)).fetchone()
        d_val = (drow["discount"] if drow else 0)
        discount_note = (drow["discount_note"] if drow else None)
    discount = round(d_val or 0, 2)
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
    # Допработы (ТЗ extra_works, 01.08.2026) — работы сверх утверждённой сметы.
    # Цена заказа = смета + допы, иначе оплата допа выглядит переплатой (Ануш: пришло
    # 164 400 при смете 157 530). Смета при этом не переписывается: суммы допов живут
    # в order_extras и приплюсовываются здесь, в единственном месте расчёта лестницы.
    # В списках передаётся предрасчётом _extras_totals (иначе запрос на строку).
    ex = (extras.get(oid) if extras is not None else _order_extras(conn, oid)) or {}
    ex_price, ex_cost = round(ex.get("price") or 0, 2), round(ex.get("cost") or 0, 2)
    if ex_price or ex_cost:
        revenue = round(revenue + ex_price, 2)
        cost = round(cost + ex_cost, 2)
    price_before_discount = revenue
    if discount:
        revenue = round(max(0.0, revenue - discount), 2)
    gross = round(revenue - cost, 2)
    # УСН платится с того, что прошло через расчётный счёт. У транзита деньги клиента
    # тоже приходят на р/с, поэтому налог берётся со ВСЕЙ суммы счёта, а не с удержания
    # (94 900 × 6% = 5 694 при удержании 12 400 — реальный доход 6 706, а не 12 400).
    #
    # Смешанная оплата (Спираль, 30.07.2026): часть безналом, часть налом/на личную
    # карту. Налом полученное через р/с не проходило — база УСН для bank-заказов:
    # банковские платежи + недоплаченный остаток (консервативно считаем, что остаток
    # придёт безналом). Закрытый заказ → налог только с реально прошедшего через р/с.
    prow = conn.execute(
        f"""SELECT COALESCE(SUM(amount), 0) AS total,
                   COALESCE(SUM(CASE WHEN {PAYMENT_IS_BANK_SQL}
                                     THEN amount ELSE 0 END), 0) AS bank_paid
            FROM payments WHERE order_id = ?""", (oid,)).fetchone()
    bank_paid = round(prow["bank_paid"] or 0, 2)
    paid_total_m = round(prow["total"] or 0, 2)
    if is_bank:
        tax_base = round(bank_paid + max(0.0, revenue - paid_total_m), 2)
    elif is_transit:
        tax_base = revenue
    else:
        # Смета cash/наличная, но деньги фактически прошли через р/с (ORD-023:
        # активной оказалась cash-смета при неснятом is_primary, УСН с реальных
        # 184 000 ₽ не начислялся вовсе). Налогооблагаемость даёт ФАКТ поступления,
        # а не тип сметы; остаток при cash-смете безналом НЕ прогнозируется.
        tax_base = bank_paid
    taxable = is_bank or is_transit or tax_base > 0
    tax = round(tax_base * TAX_PCT / 100, 2) if taxable else 0.0
    out = {
        "revenue": revenue,
        "price_before_discount": price_before_discount,
        "discount": discount,
        "discount_note": discount_note,
        "tax_base": tax_base,
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
        # Допработы отдельной строкой: сколько из выручки/себестоимости — сверх сметы.
        "extras": {"count": ex.get("count") or 0, "price": ex_price, "cost": ex_cost},
    }
    if transit:
        out["transit"] = transit
    # A8 — второй уровень маржи (решение Юры): чистая минус доля накладных месяца.
    # Появляется только у заказов в производстве (overhead_alloc передаёт get_order/
    # дашборд); сметы и план-факт этим не обрастают.
    if overhead_alloc is not None:
        share = (overhead_alloc.get("orders") or {}).get(oid)
        if share:
            out["overhead"] = {
                "amount": share["amount"],
                "share": share["share"],
                "month_total": overhead_alloc["month"]["total"],
                "period": overhead_alloc["month"]["period"],
            }
            out["net_with_overhead"] = round(out["net_profit"] - share["amount"], 2)
    return out


def _reserve_suggested(pf: dict, cost_plan) -> float:
    """Подсказка суммы резерва под материалы = материальная часть плана из сметы.

    Если смета без детализации (материалы не выделены) — предлагаем полную
    плановую себестоимость: лучше зарезервировать грубо, чем не зарезервировать."""
    for c in (pf.get("categories") or []):
        if c["category"] == "Материалы" and c["plan"] > 0:
            return round(c["plan"], 2)
    return round(cost_plan or 0, 2)


def _plan_fact(conn, oid: str, cost_plan: float, paid_total: float, price_plan: float = 0,
               extras=None) -> dict:
    """План (из активной сметы) / Факт (expenses + оплаченные обязательства) по категориям.

    План себестоимости — из строк утверждённой сметы (иначе последней не-superseded).
    Факт — фактические траты: expenses (вносит fin-agent) + creditors.paid (обязательства).

    extras — предрасчёт _extras_totals по всем заказам: обязателен для вызовов в цикле
    (сводка П/Ф, «дельта» в списке), иначе _margin делает свой SELECT на каждый заказ."""
    est = _active_set(conn, oid)

    plan_by = {b: 0.0 for b in _CAT_BUCKETS}
    plan_detail_sum = 0.0     # часть плана, разбитая строками состава
    plan_unbroken = 0.0       # позиции «одной суммой» — без состава
    if est:
        # План — ПО КАЖДОЙ позиции: со строками — её строки по типам (cost_total
        # позиции = Σ line_total × qty, см. _recalc_item), без строк — её cost_total
        # в категорию позиции. Раньше выбор был «всё или ничего» на весь сет:
        # одна разобранная позиция из шести выключала фолбэк, и у Горбачёва план
        # заказа схлопывался со 149 867 до 19 267 — «чистый прогноз» врал вчетверо.
        for it in conn.execute(
            "SELECT id, category, quantity, cost_total FROM estimate_items WHERE set_id = ?",
            (est["id"],)
        ).fetchall():
            rows = conn.execute(
                "SELECT type, COALESCE(SUM(line_total), 0) AS s FROM estimate_lines "
                "WHERE item_id = ? GROUP BY type", (it["id"],)
            ).fetchall()
            if rows:
                qty = it["quantity"] or 1
                for r in rows:
                    v = (r["s"] or 0) * qty
                    plan_by[_bucket(r["type"])] += v
                    plan_detail_sum += v
            else:
                v = it["cost_total"] or 0
                plan_by[_bucket(it["category"])] += v
                plan_unbroken += v

    fact_by = {b: 0.0 for b in _CAT_BUCKETS}
    is_transit_pf = bool(est and est["payment_type"] == "transit")
    if is_transit_pf:
        # Транзит: факт — целиком из _transit_facts (тот же источник, что панель
        # «Транзит»: expenses + creditors + zm_links фин-агента, с полным дедупом).
        # Свой подсчёт ниже не выполняем: он не видит zm_links — сводка П/Ф
        # показывала нули при живой выплате, — а вместе с ним задвоил бы факт.
        # tf["fact"] расходов допработ не содержит (см. _transit_facts): они идут
        # отдельной строкой extras ниже, иначе транзит считал бы их дважды.
        tf = _transit_facts(conn).get(oid) or {}
        fact_by["Работы"] = round(tf.get("fact") or 0, 2)   # выплата мастеру и есть работа
    if not is_transit_pf:
        # extra_id IS NULL — расходы допработ в разбивку по смете НЕ идут: у Ануша
        # два рейса Яндекса за 2 667 ₽ занижали маржу заказа, к которому отношения
        # не имеют. Они считаются отдельно ниже (extras) и входят в общий факт.
        for r in conn.execute("SELECT category AS c, COALESCE(SUM(amount),0) AS s FROM expenses "
                              "WHERE order_id = ? AND extra_id IS NULL GROUP BY category", (oid,)):
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
    ).fetchall() if not is_transit_pf else []
    for r in cred_rows:
        fact_by[_bucket(r["cat"])] += r["s"] or 0

    plan_detail_sum = round(plan_detail_sum, 2)
    plan_unbroken = round(plan_unbroken, 2)
    plan_total = round(sum(plan_by.values()), 2)
    if plan_total == 0:
        # сет пуст или сметы нет вовсе — последний фолбэк: план заказа одной суммой
        plan_total = round(cost_plan or 0, 2)
        if plan_total > 0:
            plan_by["Прочее"] += plan_total
            plan_unbroken = plan_total

    categories = []
    for b in _CAT_BUCKETS:
        p, f = round(plan_by[b], 2), round(fact_by[b], 2)
        if p == 0 and f == 0:
            continue
        categories.append({"category": b, "plan": p, "fact": f, "delta": round(f - p, 2)})

    cost_fact_estimate = round(sum(fact_by.values()), 2)

    # Маржа — от выручки, а НЕ от оплаченного: заплатил клиент или нет,
    # прибыльность заказа от этого не меняется. Налог берём из общей лестницы.
    m = _margin(conn, oid, price_plan, plan_total, est=est, extras=extras)
    tax = m["tax"]

    # Допработы отдельной строкой: план — order_extras.cost, факт — расходы с extra_id.
    ex = m["extras"]
    ex_fact = round(conn.execute(
        "SELECT COALESCE(SUM(amount),0) FROM expenses WHERE order_id = ? AND extra_id IS NOT NULL",
        (oid,)).fetchone()[0] or 0, 2)
    extras_block = {
        "count": ex["count"], "price": ex["price"],
        "cost_plan": ex["cost"], "cost_fact": ex_fact,
        # Маржа допов — до налога: УСН считается по заказу целиком (лестница в _margin).
        "gross": round(ex["price"] - max(ex["cost"], ex_fact), 2),
    }
    cost_fact = round(cost_fact_estimate + ex_fact, 2)
    # Итог разбивки — ровно сумма её же категорий. m["cost"] считается от сета
    # (set_totals по позициям), и у черновика с несинхронным cost_total позиции он
    # может разойтись с суммой строк: «m['cost'] − допы» тогда молча выдавал бы
    # за итог категорий число, которого в них нет.
    plan_estimate = plan_total
    # m["cost"] = план сметы + плановая себестоимость допов (единый источник).
    plan_total = m["cost"]
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
        # Сколько плана — позиции «одной суммой», без состава: UI подписывает,
        # что эта часть «Прочего» — «не разбито», а не реальная категория трат.
        "plan_unbroken": plan_unbroken,
        # Внесена ли хоть одна фактическая трата и какая доля плана закрыта фактом.
        # UI обязан смотреть сюда, прежде чем выдавать факт за полную картину.
        "has_facts": cost_fact > 0,
        "cost_coverage": round(cost_fact / plan_total, 4) if plan_total > 0 else None,
        "cost_plan": plan_total,
        # Разбивка по категориям — только смета: допы в неё не подмешиваются
        # (ТЗ extra_works п.5). Сумма категорий = cost_plan_estimate, не cost_plan.
        "cost_plan_estimate": plan_estimate,
        "cost_fact_estimate": cost_fact_estimate,
        "extras": extras_block,
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
        # Допы — одним запросом на всю сводку: _plan_fact зовётся в цикле, и без
        # предрасчёта _margin читал бы order_extras на каждый заказ (code_rules 27.07).
        extras = _extras_totals(conn)
        out = []
        for r in rows:
            pf = _plan_fact(conn, r["id"], r["cost_plan"] or 0, r["paid_total"] or 0,
                            r["price_plan"] or 0, extras=extras)
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
        # Траты вне клиентских заказов — отдельными строками, а не в себестоимости
        # заказов (ТЗ stock_and_samples 01.08.2026). В _plan_fact они не попадают
        # по определению: order_id IS NULL.
        gen = {r["purpose"]: round(r["s"] or 0, 2) for r in conn.execute(
            """SELECT purpose, SUM(amount) AS s FROM expenses
                WHERE order_id IS NULL AND purpose IS NOT NULL GROUP BY purpose""").fetchall()}
        written_off = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE stock_parent_id IS NOT NULL"
        ).fetchone()["s"]
        return {"orders": out, "general": {
            "stock_open": gen.get("stock", 0),
            "stock_written_off": round(written_off or 0, 2),
            "sample": gen.get("sample", 0),
            "overhead": gen.get("overhead", 0),
        }}
    finally:
        conn.close()


@router.get("/overhead-summary")
def overhead_summary():
    """A8 для дашборда: накладные текущего месяца и их раскладка по заказам
    в производстве (база — фактическая себестоимость, решение Юры 04.08.2026)."""
    conn = get_production()
    try:
        alloc = _overhead_allocation(conn)
        return {
            "month": alloc["month"],
            "orders": [
                {"order_id": oid, **row} for oid, row in alloc["orders"].items()
            ],
        }
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
        # A3-лайт: «братские» платежи — эта же банковская транзакция разнесена
        # ещё и на другие заказы (Суздаль/Спираль-паттерн). Видно прямо у платежа.
        # Одним запросом на все транзакции карточки, а не по запросу на платёж.
        payments = [dict(p) for p in payments]
        tx_ids = [p["bank_tx_id"] for p in payments if p.get("bank_tx_id")]
        if tx_ids:
            ph = ", ".join("?" * len(tx_ids))
            sibs = {}
            for s in conn.execute(
                f"""SELECT p2.bank_tx_id AS tx, o.title, p2.amount FROM payments p2
                    JOIN orders o ON o.id = p2.order_id
                    WHERE p2.bank_tx_id IN ({ph}) AND p2.order_id != ?""",
                (*tx_ids, oid)
            ).fetchall():
                sibs.setdefault(s["tx"], []).append({"title": s["title"], "amount": s["amount"]})
            for p in payments:
                if sibs.get(p.get("bank_tx_id")):
                    p["siblings"] = sibs[p["bank_tx_id"]]

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
        # A8: второй уровень маржи — только у заказа в производстве (решение Юры)
        ov = _overhead_allocation(conn) if order.get("status") == "in_production" else None
        m = _margin(conn, oid, price_plan, order.get("cost_plan") or 0, overhead_alloc=ov)

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
            "tax_base": m["tax_base"],
            "discount": m["discount"],
            "discount_note": m["discount_note"],
            "price_before_discount": m["price_before_discount"],
            "net_profit": m["net_profit"],
            # A8: доля накладных месяца и маржа с их учётом — только in_production
            "overhead": m.get("overhead"),
            "net_with_overhead": m.get("net_with_overhead"),
            "payment_type": m["payment_type"],
            # Транзит: счёт / план выплаты / факт / удержание — только у транзитных заказов
            "transit": m.get("transit"),
            "has_estimate": m["has_estimate"],
            "plan_source": m["plan_source"],
            **_awaiting_flags(order["status"], m["revenue"], paid_total),
            # Резерв под материалы (ТЗ-1 задача 1). reserved_amount/reserve_released_at
            # льются через **order; сюда — производные для UI.
            "reserve_suggested": _reserve_suggested(pf, order.get("cost_plan") or 0),
            "reserve_active": bool((order.get("reserved_amount") or 0) > 0 and not order.get("reserve_released_at")),
            "plan_fact": pf,
            # Допработы — сверх утверждённой сметы; уже учтены в price_plan/cost_plan
            # выше (см. _margin), здесь — построчно для блока «Допработы».
            "extras": _extras_list(conn, oid),
            "extras_total": m["extras"],
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


VALID_STATUSES = set(STATUS_LABELS)   # один источник: ярлык есть — статус валиден


@router.patch("/{order_id}/status")
def update_status(order_id: str, body: StatusUpdate):
    if body.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {body.status}")
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", (body.status, r["id"]))
        audit(conn, "order", r["id"], "status",
              f"«{r['title']}»: {STATUS_LABELS.get(r['status'], r['status'])} → {STATUS_LABELS.get(body.status, body.status)}")
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
        conn.execute(
            "UPDATE orders SET brand = ?, brand_id = (SELECT id FROM brands WHERE name = ? COLLATE NOCASE), "
            "updated_at = datetime('now') WHERE id = ?", (body.brand, body.brand, r["id"]))
        conn.commit()
        return {"ok": True, "brand": body.brand}
    finally:
        conn.close()


@router.patch("/{order_id}")
async def update_order(order_id: str, body: dict = Body(...)):
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")

        allowed = {"title", "priority", "deadline", "customer_id", "price_plan", "cost_plan", "brand", "status", "finance_tx_id", "discount", "discount_note"}
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
            if key == "brand":
                # Б2-лайт: текстовый бренд остаётся на переход, связь держит brand_id
                fields.append("brand_id = (SELECT id FROM brands WHERE name = ? COLLATE NOCASE)")
                values.append(val)

        if fields:
            fields.append("updated_at = datetime('now')")
            values.append(r["id"])
            conn.execute(f"UPDATE orders SET {', '.join(fields)} WHERE id = ?", values)
            audit(conn, "order", r["id"], "update",
                  f"«{r['title']}»: правка {', '.join(k for k in allowed if k in body)}",
                  before_row=r)
            conn.commit()

        return dict(conn.execute("SELECT * FROM orders WHERE id = ?", (r["id"],)).fetchone())
    finally:
        conn.close()


@router.delete("/{order_id}")
def delete_order(order_id: str):
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        oid = r["id"]
        # ИНВАРИАНТ: заказ — план-оболочка. Удаляем ТОЛЬКО его план-данные в production.db.
        # Факты не удаляем никогда: банковские транзакции (finance.db/ДДС), личные финансы
        # (zenmoney.db), каталог, обязательства (creditors) — основа системы.
        conn.execute("DELETE FROM payments WHERE order_id = ?", (oid,))
        conn.execute("DELETE FROM stages WHERE order_id = ?", (oid,))
        conn.execute("DELETE FROM events WHERE order_id = ?", (oid,))
        # Касса фондов: движение связано fund_transactions.expense_id — иначе после
        # удаления расходов в кассе остаются фантомные списания (как в delete_expense).
        conn.execute(
            "DELETE FROM fund_transactions WHERE expense_id IN (SELECT id FROM expenses WHERE order_id = ?)",
            (oid,))
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
        audit(conn, "order", oid, "delete", f"Удалён заказ «{r['title']}» ({r['number']})",
              before_row=r)
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
            """INSERT INTO orders (id, number, title, status, priority, deadline, customer_id, brand, brand_id, created_at)
               VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, (SELECT id FROM brands WHERE name = ? COLLATE NOCASE), datetime('now'))""",
            (
                new_id,
                number,
                title,
                body.get("priority", "normal"),
                body.get("deadline") or None,
                body.get("customer_id") or None,
                body.get("brand") or None,
                body.get("brand") or None,
            ),
        )
        audit(conn, "order", new_id, "create", f"Создан заказ «{title}» ({number})")
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
    zenmoney_tx_id: Optional[str] = None   # платёж на личную карту → транзакция ZenMoney
    source: Optional[str] = None           # manual | personal (нал/личная карта)
    channel: Optional[str] = None          # bank | cash | personal — прошло ли через р/с
    extra_id: Optional[str] = None         # оплата допработы (order_extras.id), а не сметы


def _payment_channel(source, bank_tx_id, zenmoney_tx_id, channel=None) -> str:
    """Канал платежа при вставке. Пишем ЯВНО, а не оставляем NULL на разбор
    в _margin: база УСН не должна зависеть от того, кто и когда завёл строку."""
    if channel in ("bank", "cash", "personal"):
        return channel
    if bank_tx_id or source in ("bank", "sber", "bank-in", "fin-agent"):
        return "bank"
    if zenmoney_tx_id or source == "personal":
        return "personal"
    return "bank"   # консервативно, см. PAYMENT_IS_BANK_SQL


def _create_payment(conn, order_row, amount, paid_at, note=None, *, source, bank_tx_id=None, zenmoney_tx_id=None, channel=None, extra_id=None, matched_by=None, group_id=None) -> dict:
    """Единая точка вставки платежа: валидация + INSERT + журнал + возврат строки.

    Оба входа (ручной add_payment, разноска поступлений payments.from_tx) обязаны
    идти через неё — иначе правка правил создания (валидация, аудит, лимиты) доедет
    только до одного места. НЕ коммитит и НЕ открывает соединение: разноска пишет
    несколько платежей одной транзакцией на общем conn (см. payments.py).

    matched_by/group_id (A4/A3-лайт): 'inbox' — разнесли из инбокса поступлений,
    'order-card' — завели руками в карточке; group_id связывает N платежей одной
    разноски. match_status здесь всегда 'manual' — 'auto' пишет только
    автопривязка фин-агента (прямо в базу, со score)."""
    if amount is None or amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")
    if not (str(paid_at or "").strip()):
        raise HTTPException(status_code=400, detail="paid_at required")
    extra_id = _check_extra(conn, order_row["id"], extra_id)
    pid = str(uuid4())
    conn.execute(
        """INSERT INTO payments (id, order_id, amount, paid_at, note, bank_tx_id, zenmoney_tx_id, source, channel, extra_id,
                                 match_status, matched_by, group_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
        (pid, order_row["id"], round(amount, 2), paid_at, note, bank_tx_id, zenmoney_tx_id, source,
         _payment_channel(source, bank_tx_id, zenmoney_tx_id, channel), extra_id,
         "manual", matched_by, group_id),
    )
    audit(conn, "payment", pid, "create",
          f"Платёж {round(amount, 2):g} ₽ по «{order_row['title']}» ({paid_at})")
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
                                  source=body.source or "manual", bank_tx_id=body.bank_tx_id,
                                  zenmoney_tx_id=body.zenmoney_tx_id, channel=body.channel,
                                  extra_id=body.extra_id, matched_by="order-card")
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
        r = conn.execute("SELECT * FROM payments WHERE id = ? AND order_id IN (SELECT id FROM orders WHERE id = ? OR number = ?)", (payment_id, order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("DELETE FROM payments WHERE id = ?", (payment_id,))
        audit(conn, "payment", payment_id, "delete",
              f"Удалён платёж {r['amount']:g} ₽ ({r['paid_at']})", before_row=r)
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Допработы (ТЗ extra_works, 01.08.2026) ───────────────────────────────────

class ExtraIn(BaseModel):
    title: str
    price: float = 0
    cost: float = 0
    note: Optional[str] = None


def _extras_list(conn, oid: str) -> list:
    """Допы заказа с фактом: сколько по нему уже оплачено и сколько потрачено."""
    rows = conn.execute(
        """SELECT e.*,
                  (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.extra_id = e.id) AS paid,
                  (SELECT COALESCE(SUM(x.amount),0) FROM expenses x WHERE x.extra_id = e.id) AS cost_fact
           FROM order_extras e WHERE e.order_id = ? ORDER BY e.created_at""", (oid,)
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["paid"] = round(d["paid"] or 0, 2)
        d["cost_fact"] = round(d["cost_fact"] or 0, 2)
        # Маржа допа — по факту, если он уже есть (план себестоимости к тому моменту
        # обычно прикидочный), иначе по плану. Налог здесь не считаем: УСН — по заказу.
        d["gross"] = round((d["price"] or 0) - max(d["cost"] or 0, d["cost_fact"]), 2)
        d["rest"] = round((d["price"] or 0) - d["paid"], 2)
        out.append(d)
    return out


@router.get("/{order_id}/extras")
def list_extras(order_id: str):
    conn = get_production()
    try:
        return _extras_list(conn, _resolve_order(conn, order_id))
    finally:
        conn.close()


@router.post("/{order_id}/extras")
def add_extra(order_id: str, body: ExtraIn, user=Depends(get_current_user)):
    """Завести доп. Статус заказа НЕ меняется: доработки как раз и случаются
    после сдачи, completed-заказ остаётся завершённым."""
    if not (body.title or "").strip():
        raise HTTPException(status_code=400, detail="title required")
    if (body.price or 0) < 0 or (body.cost or 0) < 0:
        raise HTTPException(status_code=400, detail="price/cost must be >= 0")
    conn = get_production()
    try:
        oid = _resolve_order(conn, order_id)
        xid = str(uuid4())
        conn.execute(
            """INSERT INTO order_extras (id, order_id, title, price, cost, note, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (xid, oid, body.title.strip(), round(body.price or 0, 2), round(body.cost or 0, 2),
             body.note, (user or {}).get("name") or (user or {}).get("email")))
        conn.commit()
        return dict(conn.execute("SELECT * FROM order_extras WHERE id = ?", (xid,)).fetchone())
    finally:
        conn.close()


@router.put("/{order_id}/extras/{extra_id}")
def update_extra(order_id: str, extra_id: str, body: ExtraIn):
    if not (body.title or "").strip():
        raise HTTPException(status_code=400, detail="title required")
    conn = get_production()
    try:
        oid = _resolve_order(conn, order_id)
        r = conn.execute("SELECT id FROM order_extras WHERE id = ? AND order_id = ?",
                         (extra_id, oid)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute(
            """UPDATE order_extras SET title = ?, price = ?, cost = ?, note = ?,
                      updated_at = datetime('now') WHERE id = ?""",
            (body.title.strip(), round(body.price or 0, 2), round(body.cost or 0, 2),
             body.note, extra_id))
        conn.commit()
        return dict(conn.execute("SELECT * FROM order_extras WHERE id = ?", (extra_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/{order_id}/extras/{extra_id}")
def delete_extra(order_id: str, extra_id: str):
    """Удаление допа не трогает платежи и расходы — только снимает с них привязку:
    деньги реальны, потерять их вместе со строкой допа нельзя."""
    conn = get_production()
    try:
        oid = _resolve_order(conn, order_id)
        r = conn.execute("SELECT id FROM order_extras WHERE id = ? AND order_id = ?",
                         (extra_id, oid)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("UPDATE payments SET extra_id = NULL WHERE extra_id = ?", (extra_id,))
        conn.execute("UPDATE expenses SET extra_id = NULL WHERE extra_id = ?", (extra_id,))
        conn.execute("DELETE FROM order_extras WHERE id = ?", (extra_id,))
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
    # Расход по допработе (order_extras.id): в план-факт основной сметы не идёт
    extra_id: Optional[str] = None


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
                                     payment_source, accountable_person_id, extra_id, match_status, matched_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), 'manual', ?, ?, ?, ?, ?, ?, 'manual', 'order-card', datetime('now'))""",
            (eid, oid, body.title.strip(), body.amount, body.category, body.supplier, body.master_id,
             body.expense_date, _autolink_creditor(conn, oid, body), body.finance_tx_id, body.zenmoney_tx_id,
             body.payment_source, body.accountable_person_id if body.payment_source == "accountable" else None,
             _check_extra(conn, oid, body.extra_id))
        )
        _sync_cash_fund(conn, eid, body)
        audit(conn, "expense", eid, "create",
              f"Расход {body.amount:g} ₽ «{body.title.strip()}» ({body.category})")
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
            "SELECT * FROM expenses WHERE id = ? AND order_id IN (SELECT id FROM orders WHERE id = ? OR number = ?)",
            (expense_id, order_id, order_id)
        ).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        # extra_id разводит контуры учёта (смета vs доп), поэтому дефолт модели его
        # не затирает: поле не прислали — оставляем как было, прислали null — снимаем
        # привязку. Форма расхода шлёт его всегда, но клиент постарше (или скрипт)
        # иначе молча вернул бы расход допа в себестоимость сметы.
        extra_id = (_check_extra(conn, r["order_id"], body.extra_id)
                    if "extra_id" in body.model_fields_set else r["extra_id"])
        conn.execute(
            """UPDATE expenses SET title = ?, amount = ?, category = ?, supplier = ?, master_id = ?,
                      expense_date = COALESCE(?, expense_date), creditor_id = ?,
                      finance_tx_id = ?, zenmoney_tx_id = ?,
                      payment_source = ?, accountable_person_id = ?, extra_id = ?
               WHERE id = ?""",
            (body.title.strip(), body.amount, body.category, body.supplier, body.master_id,
             body.expense_date, _autolink_creditor(conn, r["order_id"], body),
             body.finance_tx_id, body.zenmoney_tx_id,
             body.payment_source, body.accountable_person_id if body.payment_source == "accountable" else None,
             extra_id, expense_id)
        )
        _sync_cash_fund(conn, expense_id, body)
        audit(conn, "expense", expense_id, "update",
              f"Правка расхода «{body.title.strip()}»: {body.amount:g} ₽", before_row=r)
        conn.commit()
        return dict(conn.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone())
    finally:
        conn.close()


class SplitPart(BaseModel):
    amount: float
    category: str
    title: Optional[str] = None
    # Часть, которая к этому заказу не относится: уходит «без заказа» с назначением
    # (ТЗ stock_and_samples 01.08.2026). purpose: stock | sample | overhead.
    # Пример: перевод 11 800 ₽ = 9 500 ₽ работы заказа + 2 300 ₽ логотипы про запас.
    purpose: Optional[str] = None


class SplitIn(BaseModel):
    parts: List[SplitPart]


@router.post("/{order_id}/expenses/{expense_id}/split")
def split_expense(order_id: str, expense_id: str, body: SplitIn):
    """Детализация: разбить один расход на несколько категорий (материалы/работы/…).
    Первая часть остаётся в исходной строке (id, ссылки целы — инвариант
    «одна оплата = один факт» не ломается), остальные — сиблинги с общим group_id.
    creditor_id, extra_id и tx-ссылки копируются на КАЖДУЮ часть (паттерн from-tx:
    несколько строк одной транзакции), иначе привязка теряется у сиблингов:
    обязательство недосчитает факт (list_obligations), а расход по допу вернётся
    в себестоимость сметы и занизит cost_fact допа. Часть с purpose уходит из
    заказа целиком — вместе с creditor_id снимается и extra_id. Наличный контур (payment_source=cash_fund)
    пересчитывает движение кассы для каждой части, а не оставляет одно на исходной
    строке на полную сумму — иначе касса рассинхронится при правке/удалении части."""
    from routers.general_expenses import PURPOSES
    if len(body.parts) < 2:
        raise HTTPException(status_code=400, detail="Нужно минимум 2 части")
    for p in body.parts:
        if p.category not in EXPENSE_CATEGORIES:
            raise HTTPException(status_code=400, detail=f"category must be one of {'|'.join(EXPENSE_CATEGORIES)}")
        if p.amount <= 0:
            raise HTTPException(status_code=400, detail="Сумма части должна быть > 0")
        if p.purpose is not None and p.purpose not in PURPOSES:
            raise HTTPException(status_code=400, detail=f"purpose must be {'|'.join(PURPOSES)}")
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
        if first.purpose:
            # Часть «в никуда»: уходит из заказа в общий контур. creditor_id снимаем —
            # обязательство принадлежит заказу, запас его не гасит (иначе факт заказа
            # недосчитается: покрытое обязательство исчезнет из обеих веток дедупа).
            conn.execute(
                """UPDATE expenses SET amount = ?, category = ?, title = COALESCE(?, title), group_id = ?,
                          order_id = NULL, purpose = ?, creditor_id = NULL, extra_id = NULL WHERE id = ?""",
                (first.amount, first.category, (first.title or "").strip() or None, group_id,
                 first.purpose, expense_id))
        else:
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
                                         payment_source, accountable_person_id, group_id, purpose,
                                         extra_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
                (eid, None if p.purpose else r["order_id"], p_title, p.amount, p.category,
                 r["supplier"], r["master_id"], r["expense_date"], r["source"],
                 None if p.purpose else r["creditor_id"], r["finance_tx_id"], r["zenmoney_tx_id"],
                 r["payment_source"], r["accountable_person_id"], group_id, p.purpose,
                 None if p.purpose else r["extra_id"]))
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
        audit(conn, "expense", expense_id, "delete",
              f"Удалён расход ({deleted} строк{'а' if deleted == 1 else ''})")
        conn.commit()
        return {"ok": True, "deleted": deleted}
    finally:
        conn.close()
