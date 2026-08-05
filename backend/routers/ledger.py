"""Лицевой счёт подрядчика — взаиморасчёты с оборотами в обе стороны и сальдо.

ТЗ фин-агента 05.08.2026. Расчёты с мастером шире, чем «расход по заказу»:
  • Кебра просит оплатить с ИП ткань для ЧУЖОГО заказа — деньги наши, себестоимость
    не наша ни по одному заказу: это аванс в натуре, гасится его будущими работами;
  • один перевод 20 000 ₽ уходит авансом сразу на два заказа;
  • «сколько мы должны мастеру на сегодня» не считается: начисления в creditors,
    выплаты в expenses, и вместе они нигде не сходятся.

РЕГИСТР СОБИРАЕТСЯ ИЗ СУЩЕСТВУЮЩИХ ИСТОЧНИКОВ, а не дублирует их (иначе оборот
задвоится, как задваивался факт до инварианта «одна оплата = один факт»):
  начислено   (+)  creditors по имени мастера — total;
  выплачено   (−)  expenses.master_id + creditors.paid, НЕ покрытые расходом;
  за него     (−)  expenses.purpose='contractor_third_party' (оплата третьему лицу);
  аванс       (−)  expenses.purpose='contractor_pay' (деньги мастеру вне заказа);
  зачёт/ручное     master_ledger — только то, чему нет места среди денег и обязательств.

Сальдо = Σ начислено − Σ выплачено. Плюс — мы должны мастеру, минус — он должен
отработать (выдан аванс).

Обе новые purpose живут ТОЛЬКО при order_id IS NULL, поэтому в себестоимость заказов
и в накладные (A8 фильтрует purpose='overhead') не попадают по построению.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from uuid import uuid4

from db import get_production

router = APIRouter()

# Знак оборота: +1 — мы должны больше, −1 — наш долг гасится.
KIND_SIGN = {"accrual": 1, "payment": -1, "third_party": -1, "offset": -1, "adjust": 1}
KIND_LABELS = {
    "accrual":     "Начислено",
    "payment":     "Выплачено",
    "third_party": "Оплачено за него",
    "offset":      "Зачёт",
    "adjust":      "Корректировка",
}
# purpose расходов, относящихся к лицевому счёту, а не к заказам
LEDGER_PURPOSES = ("contractor_pay", "contractor_third_party")


def _master(conn, master_id: str) -> dict:
    row = conn.execute("SELECT * FROM masters WHERE id = ?", (master_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Подрядчик не найден")
    return dict(row)


def _entries(conn, master: dict) -> list[dict]:
    """Лента оборотов по мастеру, от свежих к старым. Каждая строка — один оборот
    ровно из одного источника: дубли между creditors.paid и expenses снимаются тем
    же правилом, что в masters._paid_total (creditor_id либо совпадение id транзакции)."""
    mid, name = master["id"], master["name"]

    creditors = [dict(r) for r in conn.execute(
        """SELECT c.*, o.number AS order_number, o.title AS order_title
           FROM creditors c LEFT JOIN orders o ON o.id = c.order_id
           WHERE c.name = ?""", (name,)).fetchall()]
    expenses = [dict(r) for r in conn.execute(
        """SELECT e.*, o.number AS order_number, o.title AS order_title
           FROM expenses e LEFT JOIN orders o ON o.id = e.order_id
           WHERE e.master_id = ? OR (COALESCE(e.master_id,'') = '' AND e.supplier = ?)""",
        (mid, name)).fetchall()]
    manual = [dict(r) for r in conn.execute(
        """SELECT m.*, o.number AS order_number, o.title AS order_title
           FROM master_ledger m LEFT JOIN orders o ON o.id = m.order_id
           WHERE m.master_id = ?""", (mid,)).fetchall()]

    out = []

    def add(kind, amount, date, title, **ref):
        out.append({"kind": kind, "kind_label": KIND_LABELS[kind],
                    "sign": KIND_SIGN[kind], "amount": round(amount or 0, 2),
                    "effect": round(KIND_SIGN[kind] * (amount or 0), 2),
                    "date": (date or "")[:10], "title": title, **ref})

    for c in creditors:
        if c["status"] == "cancelled" or not c["total"]:
            continue
        add("accrual", c["total"], c.get("due_date") or c.get("created_at"),
            c.get("description") or "Обязательство по смете",
            source="creditor", ref_id=c["id"], order_id=c.get("order_id"),
            order_number=c.get("order_number"), order_title=c.get("order_title"))

    for e in expenses:
        kind = "third_party" if e.get("purpose") == "contractor_third_party" else "payment"
        add(kind, e["amount"], e.get("expense_date") or e.get("created_at"),
            e.get("title") or "Выплата",
            source="expense", ref_id=e["id"], order_id=e.get("order_id"),
            order_number=e.get("order_number"), order_title=e.get("order_title"),
            purpose=e.get("purpose"), supplier=e.get("supplier"),
            finance_tx_id=e.get("finance_tx_id"), zenmoney_tx_id=e.get("zenmoney_tx_id"),
            group_id=e.get("group_id"))

    # creditors.paid без расхода — платёж, отмеченный прямо на обязательстве.
    covered_ids = {e["creditor_id"] for e in expenses if e.get("creditor_id")}
    covered_fin = {e["finance_tx_id"] for e in expenses if e.get("finance_tx_id")}
    covered_zen = {e["zenmoney_tx_id"] for e in expenses if e.get("zenmoney_tx_id")}
    for c in creditors:
        if not c["paid"] or c["id"] in covered_ids:
            continue
        if c.get("finance_tx_id") and c["finance_tx_id"] in covered_fin:
            continue
        if c.get("zenmoney_tx_id") and c["zenmoney_tx_id"] in covered_zen:
            continue
        add("payment", c["paid"], c.get("updated_at") or c.get("created_at"),
            f"Оплата обязательства: {c.get('description') or c['name']}",
            source="creditor_paid", ref_id=c["id"], order_id=c.get("order_id"),
            order_number=c.get("order_number"), order_title=c.get("order_title"))

    # Ручные строки. Тот же дедуп: если операцию уже видно расходом — не повторяем.
    exp_ids = {e["id"] for e in expenses}
    for m in manual:
        if m.get("expense_id") and m["expense_id"] in exp_ids:
            continue
        if m.get("finance_tx_id") and m["finance_tx_id"] in covered_fin:
            continue
        if m.get("zenmoney_tx_id") and m["zenmoney_tx_id"] in covered_zen:
            continue
        add(m["kind"], m["amount"], m["happened_at"], m.get("note") or KIND_LABELS[m["kind"]],
            source="ledger", ref_id=m["id"], order_id=m.get("order_id"),
            order_number=m.get("order_number"), order_title=m.get("order_title"),
            creditor_id=m.get("creditor_id"))

    out.sort(key=lambda r: (r["date"] or "", r["kind"]), reverse=True)
    return out


def _totals(entries: list[dict]) -> dict:
    def s(*kinds):
        return round(sum(e["amount"] for e in entries if e["kind"] in kinds), 2)
    return {
        "accrued": s("accrual"),
        "paid": s("payment"),
        "third_party": s("third_party"),
        "offset": s("offset"),
        "adjust": round(sum(e["effect"] for e in entries if e["kind"] == "adjust"), 2),
        "balance": round(sum(e["effect"] for e in entries), 2),
    }


@router.get("/masters/{master_id}")
def master_ledger(master_id: str,
                  date_from: Optional[str] = None,
                  date_to: Optional[str] = None):
    """Лицевой счёт: сальдо на дату + лента оборотов.

    balance > 0 — мы должны мастеру; balance < 0 — у него наш аванс.
    date_to даёт «сальдо на дату»: обороты позже отсечки в расчёт не идут."""
    conn = get_production()
    try:
        master = _master(conn, master_id)
        entries = _entries(conn, master)
    finally:
        conn.close()
    if date_from:
        entries = [e for e in entries if (e["date"] or "") >= date_from]
    if date_to:
        entries = [e for e in entries if (e["date"] or "") <= date_to]
    totals = _totals(entries)
    return {"master": {"id": master["id"], "name": master["name"],
                       "role": master.get("role"), "status": master.get("status")},
            "date_from": date_from, "date_to": date_to,
            **totals, "entries": entries, "count": len(entries)}


@router.get("/balances")
def balances(date_to: Optional[str] = None,
             nonzero: bool = Query(True, description="только мастера с ненулевым сальдо")):
    """Сальдо по всем подрядчикам одним запросом — «кому и сколько мы должны»."""
    conn = get_production()
    try:
        masters = [dict(r) for r in conn.execute(
            "SELECT id, name, role, status FROM masters ORDER BY name").fetchall()]
        rows = []
        for m in masters:
            entries = _entries(conn, m)
            if date_to:
                entries = [e for e in entries if (e["date"] or "") <= date_to]
            t = _totals(entries)
            if nonzero and not entries:
                continue
            if nonzero and abs(t["balance"]) < 0.01 and not t["accrued"]:
                continue
            rows.append({**{k: m[k] for k in ("id", "name", "role", "status")},
                         "master_id": m["id"], **t, "entries_count": len(entries)})
    finally:
        conn.close()
    rows.sort(key=lambda r: -abs(r["balance"]))
    return {"items": rows, "count": len(rows), "date_to": date_to,
            "we_owe": round(sum(r["balance"] for r in rows if r["balance"] > 0), 2),
            "they_owe": round(-sum(r["balance"] for r in rows if r["balance"] < 0), 2)}


class EntryIn(BaseModel):
    master_id: str
    kind: str                       # accrual | payment | third_party | offset | adjust
    amount: float
    happened_at: Optional[str] = None
    order_id: Optional[str] = None
    note: Optional[str] = None
    creditor_id: Optional[str] = None
    expense_id: Optional[str] = None
    finance_tx_id: Optional[str] = None
    zenmoney_tx_id: Optional[str] = None
    source: str = "manual"


@router.post("/entries", status_code=201)
def create_entry(body: EntryIn):
    """Ручной оборот: зачёт встречных требований, начисление вне сметы, корректировка.

    Для оборотов, за которыми стоят реальные деньги, это НЕ тот вход — заводи расход
    (POST /api/ledger/contractor-pay либо разноску транзакции), иначе оборот
    задвоится: регистр видит и расход, и ручную строку."""
    if body.kind not in KIND_SIGN:
        raise HTTPException(status_code=400, detail=f"kind must be one of {'|'.join(KIND_SIGN)}")
    if body.amount is None or (body.amount <= 0 and body.kind != "adjust"):
        raise HTTPException(status_code=400, detail="amount must be > 0 (отрицательная — только у adjust)")
    conn = get_production()
    try:
        _master(conn, body.master_id)
        if body.order_id and not conn.execute(
                "SELECT 1 FROM orders WHERE id = ?", (body.order_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Заказ не найден")
        eid = str(uuid4())
        conn.execute(
            """INSERT INTO master_ledger (id, master_id, kind, amount, happened_at, order_id,
                                          note, creditor_id, expense_id, finance_tx_id,
                                          zenmoney_tx_id, source)
               VALUES (?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, ?)""",
            (eid, body.master_id, body.kind, body.amount, body.happened_at, body.order_id,
             body.note, body.creditor_id, body.expense_id, body.finance_tx_id,
             body.zenmoney_tx_id, body.source))
        conn.commit()
        row = dict(conn.execute("SELECT * FROM master_ledger WHERE id = ?", (eid,)).fetchone())
    finally:
        conn.close()
    return row


@router.delete("/entries/{entry_id}")
def delete_entry(entry_id: str):
    conn = get_production()
    try:
        cur = conn.execute("DELETE FROM master_ledger WHERE id = ?", (entry_id,))
        conn.commit()
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Оборот не найден")
    finally:
        conn.close()
    return {"ok": True}


class ContractorPayIn(BaseModel):
    """Оплата, относящаяся к лицевому счёту, а не к заказу.

    kind='third_party' — заплатили третьему лицу ПО ПРОСЬБЕ подрядчика (ткань «Весна»
    для его собственного заказа): деньги наши, себестоимость не наша.
    kind='advance'     — деньги самому подрядчику, заказ ещё не определён."""
    master_id: str
    amount: float
    kind: str = "third_party"        # third_party | advance
    title: Optional[str] = None
    supplier: Optional[str] = None
    category: str = "other"
    expense_date: Optional[str] = None
    source: Optional[str] = None     # bank | zen — если платёж есть в банке/ZenMoney
    tx_id: Optional[str] = None
    payment_source: Optional[str] = None
    note: Optional[str] = None


@router.post("/contractor-pay", status_code=201)
def contractor_pay(body: ContractorPayIn):
    """Завести оплату за подрядчика / аванс ему — расходом БЕЗ заказа.

    Ложится в expenses с purpose='contractor_third_party'|'contractor_pay' и master_id:
    в себестоимость заказов не идёт (order_id IS NULL), в накладные не идёт
    (A8 берёт только purpose='overhead'), а в лицевом счёте встаёт в дебет."""
    from routers.orders import EXPENSE_CATEGORIES
    from routers.expenses import _allocated_ids
    from routers.general_expenses import _sync_cash

    if body.kind not in ("third_party", "advance"):
        raise HTTPException(status_code=400, detail="kind must be third_party|advance")
    if body.category not in EXPENSE_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"category must be one of {'|'.join(EXPENSE_CATEGORIES)}")
    if not body.amount or body.amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")
    fin_id = zen_id = None
    if body.tx_id:
        if body.source not in ("bank", "zen"):
            raise HTTPException(status_code=400, detail="при tx_id нужен source=bank|zen")
        bank_done, zen_done, degraded = _allocated_ids()
        if degraded:
            raise HTTPException(status_code=503, detail="Список разнесённых транзакций прочитан не полностью — попробуй ещё раз через минуту")
        done = bank_done if body.source == "bank" else zen_done
        if str(body.tx_id) in done:
            raise HTTPException(status_code=409, detail="Транзакция уже разнесена")
        fin_id = body.tx_id if body.source == "bank" else None
        zen_id = body.tx_id if body.source == "zen" else None

    purpose = "contractor_third_party" if body.kind == "third_party" else "contractor_pay"
    conn = get_production()
    try:
        master = _master(conn, body.master_id)
        title = body.title or (
            f"Оплата за {master['name']}" + (f": {body.supplier}" if body.supplier else "")
            if body.kind == "third_party" else f"Аванс: {master['name']}")
        if body.note:
            # У expenses нет колонки note — примечание живёт в названии строки,
            # иначе оно потерялось бы молча.
            title = f"{title} ({body.note})"
        eid = str(uuid4())
        conn.execute(
            """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                     expense_date, source, finance_tx_id, zenmoney_tx_id,
                                     payment_source, purpose, match_status, matched_by, created_at)
               VALUES (?, NULL, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?,
                       'manual', 'ledger', datetime('now'))""",
            (eid, title, body.amount, body.category, body.supplier, body.master_id,
             body.expense_date, "bank" if body.source == "bank" else ("zenmoney" if body.source == "zen" else "manual"),
             fin_id, zen_id, body.payment_source, purpose))
        _sync_cash(conn, eid, body.payment_source, body.amount, title, body.expense_date)
        conn.commit()
        row = dict(conn.execute("SELECT * FROM expenses WHERE id = ?", (eid,)).fetchone())
    finally:
        conn.close()
    return {"expense": row, "purpose": purpose,
            "hint": "оборот виден в GET /api/ledger/masters/{master_id}"}
