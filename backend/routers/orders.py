from fastapi import APIRouter, Query, HTTPException, Body, Depends
from fastapi.responses import FileResponse
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
    offset: int = Query(0, ge=0),
):
    """Список заказов страницами. Потолок limit — 200, поэтому полноту выборки
    даёт offset, а не подобранный клиентом limit: дефолт фронта, равный потолку,
    лишь сдвигал тихое обрезание на 201-й заказ (code_rules 25.08.2026).
    Признак «есть ещё» — страница, вернувшая ровно limit строк (так и листает
    ordersApi.list)."""
    conn = get_production()
    try:
        sql = """
            SELECT
                o.id, o.number, o.title, o.status, o.priority,
                o.deadline, o.price_plan, o.cost_plan, o.created_at,
                o.archived, o.brand, o.settled_at,
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
        sql += " GROUP BY o.id ORDER BY o.created_at DESC LIMIT ? OFFSET ?"
        params += [limit, offset]

        rows = conn.execute(sql, params).fetchall()
        # Факты транзита — одним проходом на весь список: иначе на каждый заказ
        # открывалась бы zenmoney.db, а список и карточка показали бы разные числа.
        tfacts = _transit_facts(conn)
        discounts = _discounts(conn)   # тем же приёмом: скидка иначе читалась бы на строку
        extras = _extras_totals(conn)  # допработы — тоже одним запросом на весь список
        # Фактическая себестоимость всего списка двумя запросами (расходы +
        # непокрытые обязательства, тот же инвариант, что в _plan_fact).
        fcosts = _fact_costs(conn, [r["id"] for r in rows])
        out = []
        from obligations import open_rest_by_order
        open_rest = open_rest_by_order(conn)   # один coverage на весь список
        for r in rows:
            m = _margin(conn, r["id"], r["price_plan"], r["cost_plan"],
                        transit_facts=tfacts, discounts=discounts, extras=extras)
            # У транзита факт — выплата контрагенту: _fact_costs про zm_links
            # фин-агента не знает, а _transit_facts знает (и уже посчитан).
            if m.get("transit"):
                tf = tfacts.get(r["id"]) or {}
                cost_fact = round((tf.get("fact") or 0) + (tf.get("fact_extra") or 0), 2)
            else:
                cost_fact = fcosts.get(r["id"], 0.0)
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
                # План/факт себестоимости прямо в списке (запрос Юры 24.08.2026):
                # cost_plan уже выше = m["cost"], рядом факт, расхождение и покрытие.
                "cost_fact": cost_fact,
                "cost_delta": round(cost_fact - (m["cost"] or 0), 2),
                "cost_coverage": (round(cost_fact / m["cost"], 4) if m["cost"] else None),
                **_awaiting_flags(r["status"], m["revenue"], r["paid_total"], open_rest.get(r["id"], 0.0)),
                **_order_delta(r, m, cost_fact),
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
        # Факт себестоимости пачкой: подсказка в разноске показывает не только долг,
        # но и план/факт заказа — чтобы решение принималось не вслепую (24.08.2026).
        # _margin здесь и так считается на каждого кандидата, лишних запросов нет.
        fcosts = _fact_costs(conn, [r["id"] for r in rows])
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
            row["cost_plan"] = m["cost"]
            if m.get("transit"):
                tf = tfacts.get(row["id"]) or {}
                row["cost_fact"] = round((tf.get("fact") or 0) + (tf.get("fact_extra") or 0), 2)
            else:
                row["cost_fact"] = fcosts.get(row["id"], 0.0)
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


def _awaiting_flags(status: str, price_plan, paid_total, open_rest) -> dict:
    """Подсказки вокруг статуса — производные, в схеме ничего не храним.

    awaiting_hint: счёт/цена есть, оплат нет — похоже, заказ ждёт оплату; предлагаем
    Юре пометить (сам статус НЕ ставим — ручное решение).
    awaiting_paid_signal: по «ждущему» пришли деньги — сигнал «запускаем?», тоже без
    автоперехода: частичная предоплата ещё не значит, что работа началась.
    done_hint (ТЗ 03.09.2026, п.2): заказ в производстве и оплачен целиком — похоже,
    завершён (ORD-041 будка, ORD-042 вешалка висели «в производстве» после отгрузки
    и оплаты). Открытые остатки по обязательствам подсказку НЕ гасят: у Dakel план
    материалов без единого расхода, и ждать его покрытия — значит не подсказать
    никогда; остаток решается в окне завершения (409 obligations_unpaid). Сумма —
    done_open_rest (obligations.open_rest_by_order), чтобы подсказка предупредила.

    open_rest ОБЯЗАТЕЛЕН (04.09.2026). С дефолтом None и `or 0.0` «остаток не
    считали» превращалось в «остаток равен нулю»: подсказка «похоже, завершён»
    выдавалась без предупреждения о непокрытых обязательствах, и забытый аргумент
    у нового вызова был бы неотличим от честного нуля. Теперь забыть его нельзя —
    ошибка вылезет на вызове, а не тихим нулём на экране. Явный None отвергаем
    здесь же: без проверки он долетал бы до round() и падал 500 только в редкой
    ветке (in_production + оплачен целиком), а на всех прочих статусах молча
    проходил бы как «остатка нет»."""
    if open_rest is None:
        raise ValueError("_awaiting_flags: open_rest обязателен, None недопустим")
    fully_paid = (price_plan or 0) > 0 and (paid_total or 0) >= (price_plan or 0) - 0.01
    return {
        "awaiting_hint": status in ("estimate", "project")
                         and (price_plan or 0) > 0 and (paid_total or 0) <= 0,
        "awaiting_paid_signal": status == "awaiting_payment" and (paid_total or 0) > 0,
        "done_hint": status == "in_production" and fully_paid,
        "done_open_rest": round(open_rest, 2) if status == "in_production" and fully_paid else 0.0,
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


def _order_delta(r, m, cost_fact: float) -> dict:
    """«Дельта» — один ориентир Юры в таблице заказов, смысл зависит от стадии
    (решение 29.07.2026): план для сметы/ждущих, прогноз в работе, факт у завершённых.
    Всегда чистая, после УСН — та же цифра, что «Чистая · прогноз» в карточке.

    Транзит считается через _margin: там себестоимость уже замещена фактом выплаты
    (включая привязки фин-агента из zenmoney), о которых _plan_fact не знает.

    cost_fact приходит ПРЕДРАСЧЁТОМ (_fact_costs пачкой + транзит из _transit_facts).
    Раньше здесь на каждый completed/in_production вызывался _plan_fact — при
    limit=200 это сотни запросов, а у транзитных внутри ещё и _transit_facts без
    кэша, то есть скан всего производственного контура и открытие zenmoney.db на
    каждую строку списка. Формулы при этом те же:
      net_plan     ≡ m["net_profit"]                        (gross = revenue − cost)
      net_forecast ≡ revenue − max(cost, cost_fact) − tax"""
    status = r["status"]
    if m.get("transit"):
        src = "plan" if m["transit"]["state"] == "no_fact" else "fact"
        return {"delta": m["net_profit"], "delta_source": src}
    if status == "completed":
        if cost_fact > 0:
            # Итог закрытого заказа: выручка минус реальные траты минус налог.
            # net_forecast здесь не годится — его max(план, факт) занизил бы
            # прибыль заказа, закрытого дешевле плана.
            return {"delta": round(m["revenue"] - cost_fact - m["tax"], 2),
                    "delta_source": "fact"}
        return {"delta": m["net_profit"], "delta_source": "plan"}
    if status == "in_production":
        expected = max(m["cost"], cost_fact)
        return {"delta": round(m["revenue"] - expected - m["tax"], 2),
                "delta_source": "forecast"}
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
                # A3 (ТЗ 24.08.2026): позиция без строк состава в категории НЕ
                # раскладывается. Раньше её cost_total падал в «Прочее», а факт по
                # ней разносился настоящей категорией — у ORD-024 разбивка показывала
                # два перекоса по 16 000 ₽ («Работы: план 0 / факт 16 000» и
                # «Прочее: план 16 000 / факт 0») и читалась как ошибка разноски.
                # Теперь это отдельная строка «План без разбивки» рядом с категориями.
                plan_unbroken += it["cost_total"] or 0

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
    if plan_detail_sum == 0 and plan_unbroken == 0:
        # сет пуст или сметы нет вовсе — последний фолбэк: план заказа одной суммой.
        # Он тоже неразобранный: в «Прочее» не кладём (A3).
        plan_unbroken = round(cost_plan or 0, 2)
    # plan_by — только разобранный план: его сумма и есть сумма категорий.
    plan_total = round(plan_detail_sum + plan_unbroken, 2)

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
        # (ТЗ extra_works п.5). Сумма ПЛАНА категорий = cost_plan_estimate минус
        # plan_unbroken: неразобранный план в категории не раскладывается (A3),
        # он отдельной строкой. Сумма ФАКТА категорий = cost_fact_estimate.
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


# Что показывает сводка П/Ф. Отменённые не показываем никогда: там нечего сводить.
SUMMARY_SCOPES = {
    "active":    "o.status NOT IN ('completed', 'cancelled')",
    "completed": "o.status = 'completed'",
    "all":       "o.status != 'cancelled'",
}


@router.get("/plan-fact-summary")
def plan_fact_summary(scope: str = Query("active", description="active | completed | all")):
    """Сводка план/факт одним экраном (ТЗ 12).

    scope=completed — итог закрытых проектов: «что заложили, что вышло, сколько
    заработали». Раньше сводка жёстко отбрасывала completed, и посмотреть закрытый
    заказ можно было только поштучно в его карточке (запрос Юры 24.08.2026)."""
    if scope not in SUMMARY_SCOPES:
        raise HTTPException(status_code=400, detail=f"scope must be {'|'.join(SUMMARY_SCOPES)}")
    conn = get_production()
    try:
        rows = conn.execute(
            f"""SELECT o.id, o.number, o.title, o.status, o.price_plan, o.cost_plan,
                      COALESCE(SUM(p.amount), 0) AS paid_total
               FROM orders o LEFT JOIN payments p ON p.order_id = o.id
               WHERE {SUMMARY_SCOPES[scope]}
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
                # A3: сколько плана взято одной суммой, без состава. Приписку
                # «план без разбивки» вешаем на него, а не на detailed — detailed
                # бывает true и при частично разобранной смете.
                "plan_unbroken": pf["plan_unbroken"],
                # Итог закрытого заказа: у него прогноз бессмыслен, нужна факт-чистая —
                # ровно то же выражение, что в _order_delta для completed.
                "net_fact": round(pf["revenue"] - pf["cost_fact"] - pf["tax"], 2),
                # Касса, а не маржа: сколько пришло минус сколько потрачено. Считалось
                # в _plan_fact с самого начала и никуда не выводилось.
                "cash_collected_vs_cost": pf["cash_collected_vs_cost"],
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
            # Изъятие прибыли, не расход дела: показываем отдельно и ни в какие
            # суммы себестоимости/накладных не подмешиваем (ТЗ 03.09.2026).
            "owner_draw": gen.get("owner_draw", 0),
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


SILENT_ASK, SILENT_REFRESH, SILENT_ARCHIVE = 14, 30, 60
SILENT_STATUSES = ("draft", "estimate", "project")


@router.get("/silent")
def silent_orders(min_days: int = Query(SILENT_ASK, ge=0)):
    """«Молчат» — просчёты и проекты без движения (правило фин-агента,
    `weekly_report.py::silent_orders`, просьба Юры 07.08.2026).

    Движение = максимум из: заведение заказа, последняя смета, последний платёж.
    `orders.updated_at` намеренно НЕ берём — он дёргается от любой технической
    правки и обнуляет счётчик тишины, хотя заказчик так и молчит. Заказы в
    производстве не считаем: там молчание ничего не меняет.
    Пороги: 14 дн. — напомнить, 30 — актуализировать цену, 60 — кандидат в архив
    (архивирует только Юра, автоматики нет).
    """
    from datetime import datetime, date
    from zoneinfo import ZoneInfo

    conn = get_production()
    try:
        ph = ",".join("?" * len(SILENT_STATUSES))
        rows = conn.execute(f"""
            SELECT o.id, o.number, o.title, o.status, o.price_plan,
                   c.name AS customer, o.brand,
                   MAX(COALESCE(o.created_at, ''),
                       COALESCE((SELECT MAX(s.created_at) FROM estimate_sets s WHERE s.order_id = o.id), ''),
                       COALESCE((SELECT MAX(p.paid_at)    FROM payments p     WHERE p.order_id = o.id), '')
                   ) AS moved_at
            FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
            WHERE o.status IN ({ph}) AND COALESCE(o.archived, 0) = 0
        """, SILENT_STATUSES).fetchall()
    finally:
        conn.close()

    today = datetime.now(ZoneInfo("Asia/Tbilisi")).date()
    out, undated = [], []
    for r in rows:
        # Дату движения не разобрали (нет created_at, битый формат). Молча
        # выбросить нельзя: заказ пропал бы из вкладки и выглядел как «движение
        # было» — отдаём отдельным списком, чтобы это было видно.
        try:
            days = (today - date.fromisoformat(str(r["moved_at"] or "")[:10])).days
        except ValueError:
            undated.append({"id": r["id"], "number": r["number"], "title": r["title"],
                            "status": r["status"], "customer": r["customer"],
                            "moved_at": r["moved_at"] or None})
            continue
        if days < min_days:
            continue
        step = ("archive" if days >= SILENT_ARCHIVE else
                "refresh" if days >= SILENT_REFRESH else "remind")
        out.append({
            "id": r["id"], "number": r["number"], "title": r["title"],
            "status": r["status"], "customer": r["customer"], "brand": r["brand"],
            "price_plan": r["price_plan"] or 0,
            "moved_at": str(r["moved_at"])[:10], "days": days, "step": step,
        })
    out.sort(key=lambda x: x["days"], reverse=True)
    return {
        "thresholds": {"ask": SILENT_ASK, "refresh": SILENT_REFRESH, "archive": SILENT_ARCHIVE},
        "total": len(out),
        "archive_candidates": sum(1 for r in out if r["step"] == "archive"),
        "orders": out,
        "undated": undated,          # дату движения не разобрали — тишину не посчитать
        "undated_count": len(undated),
    }


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

        # stages/events из старого MES здесь больше не читаются: обе таблицы пусты
        # (0 строк, ни одного INSERT в кодовой базе), фронт ключи не использовал —
        # два мёртвых запроса на каждое открытие карточки. История заказа — в
        # /timeline из audit_log.
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
            **_awaiting_flags(order["status"], m["revenue"], paid_total,
                              __import__("obligations").open_rest_by_order(conn, [oid]).get(oid, 0.0)),
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
    close_obligations: Optional[bool] = None   # подтверждение списания остатков
    only_ids: Optional[List[str]] = None       # закрыть только эти (чекбоксы окна)


VALID_STATUSES = set(STATUS_LABELS)   # один источник: ярлык есть — статус валиден


# Статус → причина закрытия обязательств (obligations.CLOSE_REASONS)
TERMINAL_REASONS = {"completed": "order_completed", "cancelled": "order_cancelled"}


def _apply_status(conn, row, new_status: str, *, close_obligations: bool = False,
                  only_ids: Optional[List[str]] = None) -> dict:
    """Смена статуса заказа + расчёты с подрядчиками.

    ЕДИНСТВЕННОЕ место, где статус превращается в закрытие обязательств: сюда
    заходят оба входа — PATCH /{id}/status и PATCH /{id} (там status в allowed).
    Разведи их — и правка через карточку тихо обошла бы закрытие.

    Завершение заказа = расчёты закрыты (решение Юры 04.08.2026). Если остались
    непокрытые остатки, без подтверждения отдаём 409 со списком: план сметы и
    факт расходятся законно, списывать молча нельзя."""
    from obligations import close_for_order, reopen_for_order, ledger_impact
    out = {}
    was = row["status"]
    # Терминальные статусы закрывают обязательства каждый своей причиной (26.08.2026:
    # отмена раньше ничего не закрывала, и план отменённого заказа начислялся в сальдо
    # подрядчика полным планом). Терминал → терминал причину закрытых не переписывает:
    # закрыто и есть закрыто; переоткрывается только причина ПОСЛЕДНЕГО терминала.
    if new_status in TERMINAL_REASONS and was != new_status:
        reason = TERMINAL_REASONS[new_status]
        res = close_for_order(conn, row["id"], force=close_obligations, only_ids=only_ids, reason=reason)
        if res.get("needs_confirm"):
            raise HTTPException(status_code=409, detail={
                "code": "obligations_unpaid",
                "target": new_status,
                "message": f"По заказу остаются незакрытые обязательства на {res['unpaid_total']:g} ₽",
                "unpaid_total": res["unpaid_total"],
                "items": res["items"],
                # как закрытие отразится на сальдо подрядчиков (ТЗ 03.09.2026)
                "ledger_delta": ledger_impact(conn, [i["id"] for i in res["items"]], reason),
            })
        how = "завершением" if new_status == "completed" else "отменой"
        for it in res.get("items", []):
            before = res.get("before_rows", {}).get(it["id"])
            audit(conn, "creditor", it["id"], "close",
                  f"Закрыто {how} заказа {row['number']}: «{it['name']}» "
                  f"план {it['plan']:g} ₽, факт {it['fact']:g} ₽, списано {it['debt']:g} ₽",
                  before_row=before)
        out = {"closed_obligations": res.get("closed", 0),
               "written_off": res.get("written_off", 0.0)}
    elif was in TERMINAL_REASONS and new_status not in TERMINAL_REASONS:
        # Вернули в работу: переоткрываем закрытое ЛЮБЫМ статусным терминалом —
        # закрытое вручную, архивацией и погашенное полностью остаётся закрытым.
        # Цепочка completed → cancelled → in_production иначе навсегда оставляла
        # закрытыми строки с order_completed: терминал → терминал причину не
        # переписывает, и последняя причина знает не про все закрытые строки.
        out = reopen_for_order(conn, row["id"], reason=list(TERMINAL_REASONS.values()))
    conn.execute("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?",
                 (new_status, row["id"]))
    summary = (f"«{row['title']}»: {STATUS_LABELS.get(was, was)} → "
               f"{STATUS_LABELS.get(new_status, new_status)}")
    if out.get("closed_obligations"):
        summary += f"; закрыто обязательств: {out['closed_obligations']} (списано {out['written_off']:g} ₽)"
    elif out.get("reopened"):
        summary += f"; переоткрыто обязательств: {out['reopened']}"
    audit(conn, "order", row["id"], "status", summary)
    return out


@router.patch("/{order_id}/status")
def update_status(order_id: str, body: StatusUpdate):
    if body.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {body.status}")
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        res = _apply_status(conn, r, body.status,
                            close_obligations=bool(body.close_obligations),
                            only_ids=body.only_ids)
        conn.commit()
        return {"ok": True, "status": body.status, **res}
    finally:
        conn.close()


class ArchiveIn(BaseModel):
    close_obligations: Optional[bool] = None
    only_ids: Optional[List[str]] = None


@router.patch("/{order_id}/archive")
def archive_order(order_id: str, body: Optional[ArchiveIn] = None):
    """В архив = обязательства заказа закрываются (причина order_archived) — с тем же
    409-подтверждением, что у завершения. До 26.08.2026 архивация была голым
    UPDATE archived=1: строки уходили с экрана «Мы должны», но продолжали
    начисляться в сальдо подрядчика полным планом, и следа в журнале не оставалось."""
    from obligations import close_for_order, ledger_impact
    body = body or ArchiveIn()
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        if r["archived"]:
            return {"ok": True, "archived": True, "closed_obligations": 0}
        res = close_for_order(conn, r["id"], force=bool(body.close_obligations),
                              only_ids=body.only_ids, reason="order_archived")
        if res.get("needs_confirm"):
            raise HTTPException(status_code=409, detail={
                "code": "obligations_unpaid", "target": "archived",
                "message": f"По заказу остаются незакрытые обязательства на {res['unpaid_total']:g} ₽",
                "unpaid_total": res["unpaid_total"], "items": res["items"],
                "ledger_delta": ledger_impact(conn, [i["id"] for i in res["items"]], "order_archived"),
            })
        for it in res.get("items", []):
            audit(conn, "creditor", it["id"], "close",
                  f"Закрыто архивацией заказа {r['number']}: «{it['name']}» "
                  f"план {it['plan']:g} ₽, факт {it['fact']:g} ₽, списано {it['debt']:g} ₽",
                  before_row=res.get("before_rows", {}).get(it["id"]))
        conn.execute("UPDATE orders SET archived = 1, updated_at = datetime('now') WHERE id = ?", (r["id"],))
        summary = f"«{r['title']}»: в архив"
        if res.get("closed"):
            summary += f"; закрыто обязательств: {res['closed']} (списано {res['written_off']:g} ₽)"
        audit(conn, "order", r["id"], "archive", summary, before_row=r)
        conn.commit()
        return {"ok": True, "archived": True, "closed_obligations": res.get("closed", 0),
                "written_off": res.get("written_off", 0.0)}
    finally:
        conn.close()


@router.patch("/{order_id}/unarchive")
def unarchive_order(order_id: str):
    from obligations import reopen_for_order
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("UPDATE orders SET archived = 0, updated_at = datetime('now') WHERE id = ?", (r["id"],))
        # Обратно из архива — переоткрывается только закрытое архивацией.
        re = reopen_for_order(conn, r["id"], reason="order_archived")
        summary = f"«{r['title']}»: из архива"
        if re.get("reopened"):
            summary += f"; переоткрыто обязательств: {re['reopened']}"
        audit(conn, "order", r["id"], "unarchive", summary, before_row=r)
        conn.commit()
        return {"ok": True, "archived": False, "reopened": re.get("reopened", 0)}
    finally:
        conn.close()


class SettleIn(BaseModel):
    note: Optional[str] = None


SETTLEABLE = ("completed", "cancelled")


def _unlinked(conn, row) -> float:
    """Сколько по заказу «не привязано»: живая выручка (та же, что в карточке и
    дебиторке) минус разнесённые платежи."""
    m = _margin(conn, row["id"], row["price_plan"] or 0, row["cost_plan"] or 0)
    paid = conn.execute("SELECT COALESCE(SUM(amount),0) FROM payments WHERE order_id = ?",
                        (row["id"],)).fetchone()[0] or 0
    return round((m["revenue"] or 0) - paid, 2)


@router.post("/{order_id}/settle")
def settle_order(order_id: str, body: Optional[SettleIn] = None):
    """«Расчёты с клиентом закрыты»: долг по заказу перестаёт считаться дебиторкой.
    Цена, платежи, выручка и маржа НЕ меняются — это не скидка (discount), а
    признание, что оставшееся не привязано и привязано не будет. Только для
    завершённого/отменённого заказа: у живого долг живой."""
    body = body or SettleIn()
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        if r["status"] not in SETTLEABLE:
            raise HTTPException(status_code=409, detail={
                "code": "order_not_final",
                "message": "Закрыть расчёты можно только по завершённому или отменённому заказу"})
        # Ставить флаг можно ровно там, где виден его список: дебиторка и блок
        # settled[] в /finance/debtors исключают архив, и заглушённая сумма
        # архивного заказа не попала бы ни в один экран. Архивный заказ в
        # «Нам должны» и так не висит — закрывать по нему нечего.
        if r["archived"]:
            raise HTTPException(status_code=409, detail={
                "code": "order_archived",
                "message": "Заказ в архиве — он и так не в дебиторке. Сначала верните из архива"})
        if r["settled_at"]:
            raise HTTPException(status_code=409, detail={"code": "already_settled", "message": "Расчёты уже закрыты"})
        unlinked = _unlinked(conn, r)
        note = (body.note or "").strip() or None
        conn.execute("UPDATE orders SET settled_at = datetime('now'), settled_note = ?, updated_at = datetime('now') WHERE id = ?",
                     (note, r["id"]))
        audit(conn, "order", r["id"], "settle",
              f"«{r['title']}»: расчёты с клиентом закрыты, не привязано {unlinked:g} ₽"
              + (f" — {note}" if note else ""), before_row=r)
        conn.commit()
        return {"ok": True, "unlinked": unlinked}
    finally:
        conn.close()


@router.post("/{order_id}/unsettle")
def unsettle_order(order_id: str):
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM orders WHERE id = ? OR number = ?", (order_id, order_id)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        if not r["settled_at"]:
            raise HTTPException(status_code=409, detail={"code": "not_settled", "message": "Расчёты не закрыты"})
        conn.execute("UPDATE orders SET settled_at = NULL, settled_note = NULL, updated_at = datetime('now') WHERE id = ?",
                     (r["id"],))
        audit(conn, "order", r["id"], "unsettle", f"«{r['title']}»: расчёты с клиентом снова открыты", before_row=r)
        conn.commit()
        return {"ok": True}
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
        # Статус идёт тем же путём, что и PATCH /{id}/status: завершение заказа
        # закрывает расчёты с подрядчиками и требует подтверждения (см. _apply_status).
        status_applied = "status" in body and body["status"] != r["status"]
        if status_applied:
            if body["status"] not in VALID_STATUSES:
                raise HTTPException(status_code=400, detail=f"Invalid status: {body['status']}")
            _apply_status(conn, r, body["status"],
                          close_obligations=bool(body.get("close_obligations")),
                          only_ids=body.get("only_ids"))
        fields, values = [], []
        for key in allowed:
            if key not in body:
                continue
            val = body[key]
            if key == "priority" and val not in {"low", "normal", "high", "urgent"}:
                raise HTTPException(status_code=400, detail=f"Invalid priority: {val}")
            if key == "status":
                continue   # уже применён выше вместе с закрытием обязательств
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
        # Коммит и когда пришёл ОДИН status: _apply_status уже сменил статус и
        # закрыл обязательства, без коммита это откатилось бы при close().
        if fields or status_applied:
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
        # Картинки позиций сметы каскад снимет сам, файлы на диске — нет:
        # собираем пути до удаления, сносим после коммита (media.media_files_of).
        from routers.media import media_files_of, unlink_files
        media_paths = media_files_of(conn, estimate_item_ids=[
            x["id"] for x in conn.execute(
                """SELECT ei.id FROM estimate_items ei
                     JOIN estimate_sets es ON ei.set_id = es.id
                    WHERE es.order_id = ?""", (oid,)).fetchall()])
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
        unlink_files(media_paths)
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
    # Дата допа. Раньше в форме её не было вовсе, и доп ложился датой создания
    # записи — в ленте заказа ему не на что было опереться. Не прислали — сегодня.
    created_at: Optional[str] = None


def _extra_created_at(raw) -> Optional[str]:
    """Дата допа из тела запроса → канонический 'YYYY-MM-DD HH:MM:SS'.

    Форма шлёт голую дату (input type=date), база пишет datetime('now'). Без
    приведения в колонке смешивались два формата, а любая другая строка легла бы
    молча и навсегда сломала бы сортировку ленты (code_rules 24.08.2026)."""
    if raw is None or not str(raw).strip():
        return None
    s = str(raw).strip().replace("T", " ")
    from datetime import datetime
    for fmt, tail in (("%Y-%m-%d", " 00:00:00"), ("%Y-%m-%d %H:%M", ":00"),
                      ("%Y-%m-%d %H:%M:%S", "")):
        try:
            datetime.strptime(s, fmt)
            return s + tail
        except ValueError:
            continue
    raise HTTPException(status_code=400,
                        detail="created_at must be YYYY-MM-DD or YYYY-MM-DD HH:MM[:SS]")


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


@router.post("/{order_id}/card")
def order_card(order_id: str):
    """Карточка заказа «План / факт» одним PDF — то, что финагент присылает в Telegram.

    Ничего не считает заново: берёт готовый ответ карточки заказа (_plan_fact,
    _margin, платежи, расходы) и раскладывает по вёрстке. Рендер — общий card.py
    финагента, тот же, которым собирается КП."""
    import cards
    from datetime import date

    data = get_order(order_id)          # тот же контракт, что у веб-карточки
    pf = data.get("plan_fact") or {}
    # get_order расходы не отдаёт (у них свой эндпоинт) — берём тем же вызовом.
    exps = [e for e in (list_expenses(order_id).get("items") or []) if (e.get("amount") or 0) > 0]
    exps.sort(key=lambda e: -(e.get("amount") or 0))
    settled_label = {"advance": "закрыто авансом", "offset": "закрыто зачётом",
                     "third_party": "оплачено за него", "none": "ещё не оплачено"}
    path = cards.render(
        "order.html.j2",
        stem=f"order-{data.get('number') or order_id}",
        today=date.today().strftime("%d.%m.%Y"),
        order=data,
        customer=data.get("customer_name"),
        status_label=data.get("status_label"),
        revenue=pf.get("revenue") or data.get("price_plan") or 0,
        paid=data.get("paid_total") or 0,
        debt=data.get("debt") or 0,
        categories=pf.get("categories") or [],
        plan_unbroken=pf.get("plan_unbroken") or 0,
        cost_plan=pf.get("cost_plan") or 0,
        cost_fact=pf.get("cost_fact") or 0,
        cost_delta=pf.get("cost_delta") or 0,
        extras=pf.get("extras") or {},
        tax=pf.get("tax") or 0,
        # У заказа в работе факт внесён не весь, и «выручка − факт − налог» врала бы
        # вверх (у ORD-023 — 140 839 вместо 90 949). Тот же приём, что в _plan_fact:
        # завершённый считаем фактом, живой — прогнозом по max(план, факт).
        net=(round((pf.get("revenue") or 0) - (pf.get("cost_fact") or 0) - (pf.get("tax") or 0), 2)
             if data.get("status") == "completed" else (pf.get("net_forecast") or 0)),
        net_is_forecast=data.get("status") != "completed",
        net_plan=pf.get("net_plan") or 0,
        cost_expected=pf.get("cost_expected") or pf.get("cost_fact") or 0,
        cash_gap=pf.get("cash_collected_vs_cost") or 0,
        expenses=[{"title": e.get("title"), "amount": e.get("amount"),
                   "supplier": e.get("supplier") or "",
                   # Jinja печатает None как «None» — в карточке это выглядело
                   # «Роман ЛазаревNone». Пустая строка, а не None.
                   "settled": settled_label.get(e.get("settled_by") or "", "")} for e in exps],
    )
    return FileResponse(path, media_type="application/pdf",
                        filename=f"plan-fact-{data.get('number') or order_id}.pdf")


@router.get("/{order_id}/timeline")
def order_timeline(order_id: str, limit: int = Query(50, le=200)):
    """Лента «что происходило с заказом» — из журнала изменений (audit_log).

    Таблицы events/stages из старого MES пусты и никем не пишутся; настоящая
    история копится в audit_log (пишут 27 вызовов audit() в 7 роутерах), но
    журнал ключуется сущностью, а не заказом. Здесь события собираются по связям:
    payment/expense/creditor → order_id живой строки, сметы — через estimate_sets,
    позиции — через set_id.

    Удалённая строка джойном не доедет — её order_id достаётся из снимка `changes`
    (audit пишет полный JSON строки ДО изменения). Снимок — состояние ДО правки,
    поэтому по нему связываем ТОЛЬКО то, чего джойном не достать (code_rules
    25.08.2026): удаление (строки уже нет) и перенос сметы (донору нужно видеть,
    куда она ушла). Иначе строка, переехавшая на другой заказ, висела бы в ленте
    прежнего владельца вечно, а снимок любой сущности с полем order_id (подотчёт,
    общие расходы) молча попадал бы в историю заказа. Такие записи помечены
    `from_snapshot: 1` — связь восстановлена по снимку, а не по живой строке.

    Ветки собраны UNION ALL, а не цепочкой OR: OR с json_extract заставлял
    сканировать весь журнал на каждое открытие ленты, здесь каждая ветка идёт по
    idx_audit_entity(entity_type, entity_id), а снимки — в границах своего типа.

    Summary в журнале уже человекочитаемые («Утверждена смета…», «Платёж N ₽…») —
    отдаём как есть, не переписываем."""
    conn = get_production()
    try:
        oid = _resolve_order(conn, order_id)
        rows = conn.execute(
            """WITH ev AS (
                 SELECT a.id, a.created_at, a.action, a.entity_type, a.summary, 0 AS snap
                   FROM audit_log a
                  WHERE a.entity_type = 'order' AND a.entity_id = :oid
                 UNION ALL
                 SELECT a.id, a.created_at, a.action, a.entity_type, a.summary, 0
                   FROM audit_log a
                  WHERE a.entity_type = 'payment' AND a.entity_id IN
                        (SELECT id FROM payments WHERE order_id = :oid)
                 UNION ALL
                 SELECT a.id, a.created_at, a.action, a.entity_type, a.summary, 0
                   FROM audit_log a
                  WHERE a.entity_type = 'expense' AND a.entity_id IN
                        (SELECT id FROM expenses WHERE order_id = :oid)
                 UNION ALL
                 SELECT a.id, a.created_at, a.action, a.entity_type, a.summary, 0
                   FROM audit_log a
                  WHERE a.entity_type = 'creditor' AND a.entity_id IN
                        (SELECT id FROM creditors WHERE order_id = :oid)
                 UNION ALL
                 SELECT a.id, a.created_at, a.action, a.entity_type, a.summary, 0
                   FROM audit_log a
                  WHERE a.entity_type = 'estimate' AND a.entity_id IN
                        (SELECT id FROM estimate_sets WHERE order_id = :oid)
                 UNION ALL
                 SELECT a.id, a.created_at, a.action, a.entity_type, a.summary, 0
                   FROM audit_log a
                  WHERE a.entity_type = 'estimate_item' AND a.entity_id IN
                        (SELECT i.id FROM estimate_items i
                          JOIN estimate_sets s ON s.id = i.set_id
                         WHERE s.order_id = :oid)
                 UNION ALL
                 SELECT a.id, a.created_at, a.action, a.entity_type, a.summary, 1
                   FROM audit_log a
                  WHERE a.action = 'delete'
                    AND a.entity_type IN ('payment', 'expense', 'creditor', 'estimate')
                    AND json_extract(a.changes, '$.order_id') = :oid
                 UNION ALL
                 SELECT a.id, a.created_at, a.action, a.entity_type, a.summary, 1
                   FROM audit_log a
                  WHERE a.action = 'delete' AND a.entity_type = 'estimate_item'
                    AND json_extract(a.changes, '$.set_id') IN
                        (SELECT id FROM estimate_sets WHERE order_id = :oid)
                 UNION ALL
                 SELECT a.id, a.created_at, a.action, a.entity_type, a.summary, 1
                   FROM audit_log a
                  WHERE a.action = 'move' AND a.entity_type = 'estimate'
                    AND json_extract(a.changes, '$.order_id') = :oid
               )
               SELECT id, created_at, action, entity_type, summary,
                      MIN(snap) AS from_snapshot
                 FROM ev GROUP BY id
                ORDER BY created_at DESC LIMIT :lim""",
            {"oid": oid, "lim": limit},
        ).fetchall()
        return {"items": [dict(r) for r in rows], "count": len(rows)}
    finally:
        conn.close()


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
            """INSERT INTO order_extras (id, order_id, title, price, cost, note, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))""",
            (xid, oid, body.title.strip(), round(body.price or 0, 2), round(body.cost or 0, 2),
             body.note, (user or {}).get("name") or (user or {}).get("email"),
             _extra_created_at(body.created_at)))
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
            # created_at правится ТОЙ ЖЕ формой, что и заводит доп: поле, проведённое
            # только в INSERT, давало на правке даты 200 и молча старое значение
            # (code_rules 24.08.2026). Не прислали — оставляем как было.
            """UPDATE order_extras SET title = ?, price = ?, cost = ?, note = ?,
                      created_at = COALESCE(?, created_at),
                      updated_at = datetime('now') WHERE id = ?""",
            (body.title.strip(), round(body.price or 0, 2), round(body.cost or 0, 2),
             body.note, _extra_created_at(body.created_at), extra_id))
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

# A1 (ТЗ 24.08.2026): «чем закрыт расход». NULL у старых строк = cash.
# Смысловая нагрузка и таблица видов — в ledger.SETTLED_KIND (единственное место,
# где значение превращается в движение по лицевому счёту).
SETTLED_BY_VALUES = (None, "cash", "advance", "offset", "third_party", "none")
# Значения, при которых деньги этим расходом НЕ двигались.
NON_CASH_SETTLEMENTS = ("advance", "offset", "third_party", "none")


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
    # A1 (ТЗ 24.08.2026) «чем закрыт расход»: cash (деньги ушли этим расходом,
    # дефолт и поведение старых строк) | advance (закрыто ранее выданным авансом) |
    # offset (взаимозачёт) | third_party (закрыто оплатой за мастера третьему лицу) |
    # none (работа принята, ещё должны). На себестоимость заказа НЕ влияет — влияет
    # только на лицевой счёт подрядчика (ledger.SETTLED_KIND).
    settled_by: Optional[str] = None


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
    if body.settled_by not in SETTLED_BY_VALUES:
        raise HTTPException(status_code=400,
                            detail=f"settled_by must be one of {'|'.join(v for v in SETTLED_BY_VALUES if v)} or empty")
    if body.settled_by in NON_CASH_SETTLEMENTS:
        # Кому зачитываем — обязательная часть смысла: без мастера непонятно,
        # чей аванс закрыт, и лицевой счёт такую строку просто не увидит.
        if not body.master_id:
            raise HTTPException(status_code=400,
                                detail="master_id required: без подрядчика непонятно, чей аванс/зачёт закрывает расход")
        # Денег не было — значит не было и наличного контура.
        if body.payment_source:
            raise HTTPException(status_code=400,
                                detail="payment_source несовместим с settled_by ≠ cash: деньги этим расходом не двигались")


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
            """SELECT ex.creditor_id AS cid, ex.amount AS amount, ex.master_id AS mid, m.name AS mname,
                      ex.settled_by AS settled_by
                 FROM expenses ex LEFT JOIN masters m ON m.id = ex.master_id
                WHERE ex.order_id = ? AND ex.creditor_id IS NOT NULL""", (oid,)
        ).fetchall():
            f = fact.setdefault(e["cid"], {"paid": 0.0, "executors": [], "settled": {}})
            f["paid"] += e["amount"] or 0
            nm = e["mname"]
            if nm and nm not in f["executors"]:
                f["executors"].append(nm)
            # A2 п.3: чем закрыто — деньгами, зачётом, авансом, оплатой за него.
            # Суммой по каждому виду: одно обязательство закрывается несколькими
            # способами (ORD-023: аванс + оплата за него + зачёт).
            k = e["settled_by"] or "cash"
            f["settled"][k] = round(f["settled"].get(k, 0) + (e["amount"] or 0), 2)

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

            f = fact.get(c["id"], {"paid": 0.0, "executors": [], "settled": {}})
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
                # {вид закрытия: сумма} — «чем закрыто» в карточке обязательства.
                "settled": f.get("settled") or {},
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
                                     payment_source, accountable_person_id, extra_id, settled_by,
                                     match_status, matched_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), 'manual', ?, ?, ?, ?, ?, ?, ?, 'manual', 'order-card', datetime('now'))""",
            (eid, oid, body.title.strip(), body.amount, body.category, body.supplier, body.master_id,
             body.expense_date, _autolink_creditor(conn, oid, body), body.finance_tx_id, body.zenmoney_tx_id,
             body.payment_source, body.accountable_person_id if body.payment_source == "accountable" else None,
             _check_extra(conn, oid, body.extra_id), body.settled_by)
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
        # settled_by — тем же правилом: клиент постарше, не знающий поля, не должен
        # молча превращать «закрыто зачётом» в «деньги ушли» и переворачивать сальдо.
        settled_by = (body.settled_by if "settled_by" in body.model_fields_set
                      else r["settled_by"])
        conn.execute(
            """UPDATE expenses SET title = ?, amount = ?, category = ?, supplier = ?, master_id = ?,
                      expense_date = COALESCE(?, expense_date), creditor_id = ?,
                      finance_tx_id = ?, zenmoney_tx_id = ?,
                      payment_source = ?, accountable_person_id = ?, extra_id = ?, settled_by = ?
               WHERE id = ?""",
            (body.title.strip(), body.amount, body.category, body.supplier, body.master_id,
             body.expense_date, _autolink_creditor(conn, r["order_id"], body),
             body.finance_tx_id, body.zenmoney_tx_id,
             body.payment_source, body.accountable_person_id if body.payment_source == "accountable" else None,
             extra_id, settled_by, expense_id)
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
                          order_id = NULL, purpose = ?, creditor_id = NULL, extra_id = NULL,
                          settled_by = NULL WHERE id = ?""",
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
                                         extra_id, settled_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
                (eid, None if p.purpose else r["order_id"], p_title, p.amount, p.category,
                 r["supplier"], r["master_id"], r["expense_date"], r["source"],
                 None if p.purpose else r["creditor_id"], r["finance_tx_id"], r["zenmoney_tx_id"],
                 r["payment_source"], r["accountable_person_id"], group_id, p.purpose,
                 None if p.purpose else r["extra_id"],
                 # settled_by копируется по той же причине, что creditor_id: без него
                 # части расхода «закрыто зачётом» стали бы выплатами и перевернули
                 # сальдо мастера. Часть, ушедшая из заказа (purpose), к расчётам с
                 # подрядчиком отношения не имеет — там NULL.
                 None if p.purpose else r["settled_by"]))
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
