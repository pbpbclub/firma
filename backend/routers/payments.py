"""Разноска поступлений: входящие банковские транзакции → payments по заказам.

Зеркало expenses-инбокса, но для direction='in'. «Разнесено» — не флаг на
транзакции (finance.db веб только читает), а производный признак: id транзакции
встречается в payments.bank_tx_id / orders.finance_tx_id / receivables.finance_tx_id.
Скрытые вручную (перевод между своими счетами, возврат) — production.inbox_dismissed.
Разные файлы БД, ATTACH в проекте не используется → анти-джойн делаем в Python.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from uuid import uuid4

from db import get_production, get_finance
from routers.orders import _plan_fact, _reserve_suggested

router = APIRouter()

DISMISS_SOURCE = "bank-in"


def _allocated_in_ids() -> set:
    """id входящих транзакций, уже привязанных к платежам/заказам/дебиторке."""
    used = set()
    conn = get_production()
    try:
        for col, tbl in (("bank_tx_id", "payments"), ("finance_tx_id", "orders")):
            try:
                for r in conn.execute(f"SELECT DISTINCT {col} FROM {tbl} WHERE {col} IS NOT NULL AND {col} != ''"):
                    used.add(str(r[0]))
            except Exception:
                pass  # колонки может не быть на старой схеме
    finally:
        conn.close()
    try:
        fin = get_finance()
        try:
            for r in fin.execute("SELECT DISTINCT finance_tx_id FROM receivables WHERE finance_tx_id IS NOT NULL AND finance_tx_id != ''"):
                used.add(str(r[0]))
        finally:
            fin.close()
    except Exception:
        pass
    return used


def _dismissed_map() -> dict:
    """tx_id → причина скрытия."""
    conn = get_production()
    try:
        return {
            str(r["tx_id"]): r["reason"]
            for r in conn.execute(
                "SELECT tx_id, reason FROM inbox_dismissed WHERE source = ?", (DISMISS_SOURCE,)
            )
        }
    finally:
        conn.close()


@router.get("/inbox")
def inbox(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    search: Optional[str] = None,
    amount_min: Optional[float] = None,
    amount_max: Optional[float] = None,
    show_dismissed: bool = False,
    limit: int = Query(100, le=500),
):
    """Неразнесённые поступления банка."""
    used = _allocated_in_ids()
    dismissed = _dismissed_map()
    out = []
    fin = get_finance()
    try:
        sql = "SELECT * FROM transactions WHERE direction = 'in'"
        params: list = []
        if date_from:
            sql += " AND date >= ?"; params.append(date_from)
        if date_to:
            sql += " AND date <= ?"; params.append(date_to)
        if amount_min is not None:
            sql += " AND amount >= ?"; params.append(amount_min)
        if amount_max is not None:
            sql += " AND amount <= ?"; params.append(amount_max)
        if search:
            sql += " AND (counterparty LIKE ? OR purpose LIKE ?)"; params += [f"%{search}%"] * 2
        sql += " ORDER BY date DESC, id DESC LIMIT ?"
        params.append(limit * 3)  # запас: часть отсеется как разнесённая/скрытая
        for r in fin.execute(sql, params).fetchall():
            tid = str(r["id"])
            if tid in used:
                continue
            if tid in dismissed and not show_dismissed:
                continue
            out.append({
                "id": tid, "source": "bank", "date": r["date"], "amount": r["amount"],
                "counterparty": r["counterparty"], "purpose": r["purpose"], "bank": r["bank"],
                "dismissed_reason": dismissed.get(tid),
            })
            if len(out) >= limit:
                break
    finally:
        fin.close()
    return {"items": out, "count": len(out)}


class PayAllocation(BaseModel):
    order_id: str
    amount: float
    note: Optional[str] = None


class PayFromTxIn(BaseModel):
    tx_id: str
    allocations: List[PayAllocation]


@router.post("/from-tx", status_code=201)
def payments_from_tx(body: PayFromTxIn):
    """Разнести входящую транзакцию на 1..N заказов. Сумма — целиком:
    частичная разноска (часть на заказ, часть личное) — отдельная итерация."""
    if not body.allocations:
        raise HTTPException(status_code=400, detail="allocations required")
    for a in body.allocations:
        if a.amount is None or a.amount <= 0:
            raise HTTPException(status_code=400, detail="allocation amount must be > 0")

    fin = get_finance()
    try:
        # id в finance.db — INTEGER (у ZenMoney UUID): сравниваем как строки.
        tx = fin.execute(
            "SELECT * FROM transactions WHERE CAST(id AS TEXT) = ?", (str(body.tx_id),)
        ).fetchone()
    finally:
        fin.close()
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if tx["direction"] != "in":
        raise HTTPException(status_code=400, detail="Транзакция не входящая")
    if str(body.tx_id) in _allocated_in_ids():
        raise HTTPException(status_code=409, detail="Транзакция уже привязана к платежу")

    total = round(sum(a.amount for a in body.allocations), 2)
    if abs(total - (tx["amount"] or 0)) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Сумма разноски {total} не равна сумме транзакции {tx['amount']}",
        )

    conn = get_production()
    try:
        created = []
        for a in body.allocations:
            o = conn.execute(
                "SELECT * FROM orders WHERE id = ? OR number = ?", (a.order_id, a.order_id)
            ).fetchone()
            if not o:
                raise HTTPException(status_code=404, detail=f"Заказ {a.order_id} не найден")
            pid = str(uuid4())
            conn.execute(
                """INSERT INTO payments (id, order_id, amount, paid_at, note, bank_tx_id, source, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'bank', datetime('now'))""",
                (pid, o["id"], round(a.amount, 2), tx["date"],
                 a.note or tx["purpose"] or tx["counterparty"], str(body.tx_id)),
            )
            created.append({"payment_id": pid, "order_id": o["id"], "order_row": o, "amount": round(a.amount, 2)})
        conn.execute(
            "DELETE FROM inbox_dismissed WHERE tx_id = ? AND source = ?",
            (str(body.tx_id), DISMISS_SOURCE),
        )
        conn.commit()

        # Подсказка резерва (как в orders.add_payment): пришли деньги по одному
        # заказу — предложить отложить материалы из сметы.
        result = {"ok": True, "payments": [
            {k: v for k, v in c.items() if k != "order_row"} for c in created
        ]}
        if len(created) == 1:
            o = created[0]["order_row"]
            pf = _plan_fact(conn, o["id"], o["cost_plan"] or 0, 0, o["price_plan"] or 0)
            result["reserve_suggested"] = _reserve_suggested(pf, o["cost_plan"] or 0)
            result["reserve_active"] = bool((o["reserved_amount"] or 0) > 0 and not o["reserve_released_at"])
            result["order_id"] = o["id"]
        return result
    finally:
        conn.close()


class DismissIn(BaseModel):
    reason: Optional[str] = None


@router.post("/inbox/{tx_id}/dismiss")
def dismiss_tx(tx_id: str, body: Optional[DismissIn] = None):
    """Скрыть поступление из инбокса (перевод между своими счетами, возврат...)."""
    conn = get_production()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO inbox_dismissed (tx_id, source, reason) VALUES (?, ?, ?)",
            (str(tx_id), DISMISS_SOURCE, body.reason if body else None),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/inbox/{tx_id}/dismiss")
def undismiss_tx(tx_id: str):
    conn = get_production()
    try:
        conn.execute(
            "DELETE FROM inbox_dismissed WHERE tx_id = ? AND source = ?",
            (str(tx_id), DISMISS_SOURCE),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
