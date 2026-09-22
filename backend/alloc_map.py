"""Единая карта разноски: транзакция → чем она уже разнесена (аудит 11.09.2026).

ДДС и «Личные» показывали подпись «куда разнесено» только по expenses, а мы с
фин-агентом разносим ещё пятью путями: лицевой счёт мастера (master_ledger с tx_id —
все выплаты Малафееву/Спектру с 03.08), привязки фин-агента (zm_links), платежи
заказчика (payments), оплаченные обязательства (creditors с tx_id), подотчёт
(accountable_ops), счета фин-агента (receivables). На экране всё это было пусто, а
инбокс предлагал разнести уже выплаченное с лицевого счёта.

build() возвращает {"bank:<id>" | "zen:<id>": [note, …]}, note = {kind, label, …}.
Виды: expense | payment | ledger | zm_link | creditor | accountable | receivable |
dismissed | self_transfer | service. Один запрос на источник, без N+1; недоступный
источник попадает в degraded[] — молчать нельзя (см. expenses._allocated_ids).

self_transfer: ZenMoney-перевод между своими (income>0 AND outcome>0) либо
контрагент по правилу payee_rules.entity_type='self' (Юрий Н., IURII N., НЕКРАСОВ
ЮРИЙ). Банк ИП → себе по решению Юры 11.09.2026 = owner_draw-расход (тогда note
kind=expense, purpose=owner_draw); без записи — «Перевод себе (не записан)»: сигнал.
service: комиссии банка, налоги, уведомления — подпись без записи."""
import sqlite3
from typing import Optional

from db import get_production, get_zenmoney, get_finance
from zm_scope import ABROAD_LABEL, ABROAD_LABEL_IN

KIND_LABELS = {
    "expense": "Расход", "payment": "Оплата заказа", "ledger": "Лицевой счёт",
    "zm_link": "Разноска фин-агента", "creditor": "Оплата обязательства",
    "accountable": "Под отчёт", "receivable": "Счёт", "dismissed": "Скрыто",
    "self_transfer": "Перевод себе", "service": "Служебное",
}
PURPOSE_LABELS = {
    "stock": "Запас", "sample": "Образцы", "overhead": "Накладные", "owner_draw": "Вывод себе",
    "contractor_pay": "Выплата подрядчику", "contractor_advance": "Аванс подрядчику",
    "contractor_third_party": "Оплата за подрядчика",
}
LEDGER_KIND_RU = {"payment": "Выплата", "advance": "Аванс", "offset": "Зачёт",
                  "third_party": "Оплата за него", "accrual": "Начисление", "adjust": "Корректировка"}
DISMISS_RU = {"self_transfer": "Перевод себе", "bank_fee": "Комиссия банка", "tax": "Налог",
              "internal": "Внутренний перевод", "refund": "Возврат",
              "reconciled": "Учтено сверкой с мастером (до 24.08.2026)"}
# Служебные операции банка — подпись без записи. Паттерны по контрагенту (lower).
SERVICE_PATTERNS = (
    ("ао \"тбанк\"", "Комиссия банка"), ("тбанк", "Комиссия банка"), ("пао сбербанк", "Комиссия банка"),
    ("сбербанк", "Комиссия банка"), ("фнс", "Налог"), ("казначейство", "Налог"),
    ("за услугу", "Услуга банка"),
)
# Владелец: фолбэк, если правил entity_type='self' в payee_rules ещё нет
SELF_FALLBACK = ("юрий н.", "юрий владимирович н", "юрий владимирович н.", "iurii n.",
                 "некрасов юрий", "некрасов юрий владимирович", "некрасов юрий владимирович ")


def self_patterns(conn) -> list[tuple[str, str]]:
    """[(pattern, match_type)] владельца из payee_rules + фолбэк."""
    out = []
    try:
        for r in conn.execute("SELECT pattern, match_type FROM payee_rules WHERE entity_type = 'self'").fetchall():
            out.append(((r["pattern"] or "").lower(), r["match_type"] or "exact"))
    except sqlite3.OperationalError:
        pass
    return out or [(p, "exact") for p in SELF_FALLBACK]


def is_self(name: Optional[str], patterns) -> bool:
    n = (name or "").strip().lower()
    if not n:
        return False
    for pat, mt in patterns:
        if (mt == "exact" and n == pat) or (mt == "prefix" and n.startswith(pat)) or (mt == "contains" and pat in n):
            return True
    return "некрасов юрий" in n


def service_label(counterparty: Optional[str]) -> Optional[str]:
    c = (counterparty or "").lower()
    for pat, label in SERVICE_PATTERNS:
        if pat in c:
            return label
    return None


def build(with_transactions: bool = True, scope=None) -> dict:
    """Карта по всем источникам. with_transactions=False — только по записям
    (без прохода по лентам банка/ZenMoney за self_transfer/service).

    `scope` — линза ZenMoney (`zm_scope.scope_for`): ключи `zen:` невидимых
    пользователю транзакций из карты вырезаются, иначе подпись «чем разнесено»
    рассказывала бы о приватных строках тому, кто самих строк не видит."""
    out: dict = {}
    degraded: list = []

    def put(kind: str, tx_key: str, **note):
        note.setdefault("kind", kind)
        note.setdefault("label", KIND_LABELS[kind])
        out.setdefault(tx_key, []).append(note)

    def keys(row, fin="finance_tx_id", zen="zenmoney_tx_id"):
        ks = []
        if row.get(fin):
            ks.append(f"bank:{row[fin]}")
        if row.get(zen):
            ks.append(f"zen:{row[zen]}")
        return ks

    conn = get_production()
    try:
        # expenses — разноска списаний (наша и фин-агента через API)
        for r in conn.execute("""
            SELECT e.id AS expense_id, e.amount, e.expense_date, e.category, e.title, e.purpose,
                   e.group_id, e.finance_tx_id, e.zenmoney_tx_id, e.master_id, m.name AS master_name,
                   o.id AS order_id, o.number, o.title AS order_title
              FROM expenses e LEFT JOIN orders o ON o.id = e.order_id LEFT JOIN masters m ON m.id = e.master_id
             WHERE e.finance_tx_id IS NOT NULL OR e.zenmoney_tx_id IS NOT NULL""").fetchall():
            d = dict(r)
            for k in keys(d):
                put("expense", k, label=(PURPOSE_LABELS.get(d["purpose"]) if d["purpose"] else None) or "Расход", **d)
        # payments — приходы по заказам
        for r in conn.execute("""
            SELECT p.id AS payment_id, p.amount, p.paid_at, p.note, p.group_id, p.extra_id,
                   p.bank_tx_id AS finance_tx_id, p.zenmoney_tx_id,
                   o.id AS order_id, o.number, o.title AS order_title
              FROM payments p LEFT JOIN orders o ON o.id = p.order_id
             WHERE p.bank_tx_id IS NOT NULL OR p.zenmoney_tx_id IS NOT NULL""").fetchall():
            d = dict(r)
            for k in keys(d):
                put("payment", k, label="Оплата допработы" if d["extra_id"] else "Оплата заказа", title=d["note"], **d)
        # master_ledger — выплаты через лицевой счёт
        for r in conn.execute("""
            SELECT l.id AS ledger_id, l.kind AS ledger_kind, l.amount, l.happened_at, l.note,
                   l.finance_tx_id, l.zenmoney_tx_id, l.master_id, m.name AS master_name,
                   o.id AS order_id, o.number, o.title AS order_title
              FROM master_ledger l LEFT JOIN masters m ON m.id = l.master_id LEFT JOIN orders o ON o.id = l.order_id
             WHERE l.finance_tx_id IS NOT NULL OR l.zenmoney_tx_id IS NOT NULL""").fetchall():
            d = dict(r)
            for k in keys(d):
                put("ledger", k, label=f"{LEDGER_KIND_RU.get(d['ledger_kind'], d['ledger_kind'])} · лицевой счёт",
                    title=d["note"], **d)
        # creditors — обязательства, оплаченные с привязкой к транзакции
        for r in conn.execute("""
            SELECT c.id AS creditor_id, c.name, c.total, c.paid, c.description, c.finance_tx_id, c.zenmoney_tx_id,
                   o.id AS order_id, o.number, o.title AS order_title
              FROM creditors c LEFT JOIN orders o ON o.id = c.order_id
             WHERE c.finance_tx_id IS NOT NULL OR c.zenmoney_tx_id IS NOT NULL""").fetchall():
            d = dict(r)
            for k in keys(d):
                put("creditor", k, title=d["description"] or d["name"], amount=d["paid"], **d)
        # accountable_ops — выдачи под отчёт
        for r in conn.execute("""
            SELECT a.id AS op_id, a.kind AS op_kind, a.amount, a.date, a.note, a.finance_tx_id, a.zenmoney_tx_id,
                   a.master_id, m.name AS master_name
              FROM accountable_ops a LEFT JOIN masters m ON m.id = a.master_id
             WHERE a.finance_tx_id IS NOT NULL OR a.zenmoney_tx_id IS NOT NULL""").fetchall():
            d = dict(r)
            for k in keys(d):
                put("accountable", k, title=d["note"], **d)
        # inbox_dismissed — скрыто с причиной
        for r in conn.execute("SELECT tx_id, source, reason FROM inbox_dismissed").fetchall():
            k = ("bank:" if (r["source"] or "").startswith("bank") else "zen:") + str(r["tx_id"])
            put("dismissed", k, label=DISMISS_RU.get(r["reason"] or "", None) or (r["reason"] or "Скрыто"),
                reason=r["reason"], source=r["source"])
        selfp = self_patterns(conn)
    finally:
        conn.close()

    zen_visible = None
    try:
        zc = get_zenmoney()
        try:
            if scope is not None and not scope.is_owner:
                zen_visible = {str(r["id"]) for r in zc.execute(
                    "SELECT id, income_account, outcome_account FROM zm_transactions WHERE deleted = 0"
                ).fetchall() if scope.visible(r)}
            for r in zc.execute("SELECT zm_tx_id, order_id, contractor_name, note FROM zm_links WHERE zm_tx_id IS NOT NULL").fetchall():
                put("zm_link", f"zen:{r['zm_tx_id']}", order_id=r["order_id"], master_name=r["contractor_name"],
                    title=r["note"], label="Разноска фин-агента")
            if with_transactions:
                for r in zc.execute("SELECT id, payee, income, outcome, income_account, outcome_account FROM zm_transactions WHERE deleted = 0").fetchall():
                    if scope is not None and not scope.visible(r):
                        continue
                    k = f"zen:{r['id']}"
                    if (r["income"] or 0) > 0 and (r["outcome"] or 0) > 0:
                        # Перевод, пересекающий границу, подписывается отдельно:
                        # это вывод себе за границу, а не движение между картами.
                        kind = scope.classify(r) if scope is not None else "public"
                        put("self_transfer", k,
                            label={"cross_out": ABROAD_LABEL, "cross_in": ABROAD_LABEL_IN}.get(
                                kind, "Перевод между своими счетами"))
                    elif is_self(r["payee"], selfp):
                        put("self_transfer", k, label="Пополнение с р/с ИП (вывод владельца)" if (r["income"] or 0) > 0 else "Перевод себе")
        finally:
            zc.close()
    except Exception as e:
        degraded.append(f"zenmoney: {e}")

    if zen_visible is not None:
        for k in [k for k in out if k.startswith("zen:") and k[4:] not in zen_visible]:
            out.pop(k, None)

    # order_title у zm_link — по order_id из production (одним запросом)
    zl_orders = {n["order_id"] for notes in out.values() for n in notes if n["kind"] == "zm_link" and n.get("order_id")}
    if zl_orders:
        conn = get_production()
        try:
            holes = ",".join("?" * len(zl_orders))
            titles = {r["id"]: (r["number"], r["title"]) for r in conn.execute(
                f"SELECT id, number, title FROM orders WHERE id IN ({holes})", list(zl_orders)).fetchall()}
            for notes in out.values():
                for n in notes:
                    if n["kind"] == "zm_link" and n.get("order_id") in titles:
                        n["number"], n["order_title"] = titles[n["order_id"]]
        finally:
            conn.close()

    try:
        fc = get_finance()
        try:
            for r in fc.execute("SELECT id, client, invoice_num, amount, paid, finance_tx_id FROM receivables WHERE finance_tx_id IS NOT NULL").fetchall():
                put("receivable", f"bank:{r['finance_tx_id']}", label=f"Счёт {r['invoice_num'] or ''}".strip(),
                    title=r["client"], amount=r["amount"])
            if with_transactions:
                owner_marked = {k for k, notes in out.items() if any(n["kind"] == "expense" and n.get("purpose") == "owner_draw" for n in notes)}
                for r in fc.execute("SELECT id, counterparty, direction FROM transactions").fetchall():
                    k = f"bank:{r['id']}"
                    if is_self(r["counterparty"], selfp):
                        if k not in owner_marked:
                            put("self_transfer", k, label="Перевод себе (не записан как вывод)" if r["direction"] == "out" else "Пополнение с личного",
                                unrecorded=r["direction"] == "out")
                    else:
                        sl = service_label(r["counterparty"])
                        if sl:
                            put("service", k, label=sl)
        finally:
            fc.close()
    except Exception as e:
        degraded.append(f"finance: {e}")

    return {"map": out, "degraded": degraded}


def allocated_keys() -> set:
    """Ключи транзакций, у которых есть хоть одна запись (не подпись): для инбокса."""
    res = build(with_transactions=False)
    return {k for k, notes in res["map"].items() if any(n["kind"] not in ("service",) for n in notes)}
