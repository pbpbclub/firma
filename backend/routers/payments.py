"""Разноска поступлений: входящие банковские транзакции → payments по заказам.

Зеркало expenses-инбокса, но для direction='in'. «Разнесено» — не флаг на
транзакции (finance.db веб только читает), а производный признак: id транзакции
встречается в payments.bank_tx_id / orders.finance_tx_id / receivables.finance_tx_id.
Скрытые вручную (перевод между своими счетами, возврат) — production.inbox_dismissed.
Разные файлы БД, ATTACH в проекте не используется → анти-джойн делаем в Python.
"""
import sqlite3

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List

from db import get_production, get_finance
from routers.orders import _create_payment, _reserve_hint

router = APIRouter()

DISMISS_SOURCE = "bank-in"


def _is_missing_schema(exc: sqlite3.OperationalError) -> bool:
    """Отсутствие колонки/таблицы на старой схеме — ожидаемо, не деградация."""
    return "no such column" in str(exc).lower() or "no such table" in str(exc).lower()


def _allocated_in_ids() -> tuple[set, bool]:
    """id входящих транзакций, уже привязанных к платежам/заказам/дебиторке.

    Возвращает (used, degraded). degraded=True — набор «занятых» НЕПОЛОН из-за сбоя
    (недоступна БД, залочен файл): считать транзакцию неразнесённой по такому набору
    нельзя — иначе уже проведённое поступление разнесётся повторно. Отсутствие
    колонки/таблицы (старая схема) деградацией НЕ считается."""
    used = set()
    degraded = False
    conn = get_production()
    try:
        for col, tbl in (("bank_tx_id", "payments"), ("finance_tx_id", "orders")):
            try:
                for r in conn.execute(f"SELECT DISTINCT {col} FROM {tbl} WHERE {col} IS NOT NULL AND {col} != ''"):
                    used.add(str(r[0]))
            except sqlite3.OperationalError as e:
                if not _is_missing_schema(e):
                    degraded = True
    except Exception:
        degraded = True
    finally:
        conn.close()
    try:
        fin = get_finance()
        try:
            for r in fin.execute("SELECT DISTINCT finance_tx_id FROM receivables WHERE finance_tx_id IS NOT NULL AND finance_tx_id != ''"):
                used.add(str(r[0]))
        except sqlite3.OperationalError as e:
            if not _is_missing_schema(e):
                degraded = True
        finally:
            fin.close()
    except Exception:
        degraded = True  # finance.db недоступен целиком — набор неполон
    return used, degraded


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
    used, degraded = _allocated_in_ids()
    dismissed = _dismissed_map()
    out = []
    truncated = False
    fin = get_finance()
    try:
        where = "WHERE direction = 'in'"
        params: list = []
        if date_from:
            where += " AND date >= ?"; params.append(date_from)
        if date_to:
            where += " AND date <= ?"; params.append(date_to)
        if amount_min is not None:
            where += " AND amount >= ?"; params.append(amount_min)
        if amount_max is not None:
            where += " AND amount <= ?"; params.append(amount_max)
        if search:
            where += " AND (counterparty LIKE ? OR purpose LIKE ?)"; params += [f"%{search}%"] * 2

        # Разнесённые/скрытые отсеиваются в Python (три файла БД) → читаем страницами,
        # пока не набрали limit или не кончились строки. «Запас limit*N» терял бы
        # старые неразнесённые, когда разнесённых большинство.
        CHUNK = 300
        offset = 0
        done = False
        while not done and len(out) < limit:
            page = fin.execute(
                f"SELECT * FROM transactions {where} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?",
                params + [CHUNK, offset],
            ).fetchall()
            if len(page) < CHUNK:
                done = True  # последняя страница
            offset += CHUNK
            for r in page:
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
                    # набрали лимит, а строки в БД ещё есть → усечение
                    truncated = not (done and r is page[-1])
                    break
    finally:
        fin.close()
    return {"items": out, "count": len(out), "truncated": truncated, "degraded": degraded}


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
    used, degraded = _allocated_in_ids()
    if degraded:
        # Набор «уже разнесённых» неполон — не можем гарантировать, что транзакция
        # не проведена. Отказываем, а не рискуем дублем. Лучше повтор, чем два платежа.
        raise HTTPException(
            status_code=503,
            detail="Не удалось проверить, не разнесена ли транзакция — повторите позже",
        )
    if str(body.tx_id) in used:
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
            # Единая точка создания платежа (валидация + INSERT): та же, что у ручного
            # add_payment. Все N платежей разноски пишутся одной транзакцией на общем conn.
            note = a.note or tx["purpose"] or tx["counterparty"]
            _create_payment(conn, o, a.amount, tx["date"], note, source="bank", bank_tx_id=str(body.tx_id))
            created.append({"order_id": o["id"], "order_row": o, "amount": round(a.amount, 2)})
        conn.execute(
            "DELETE FROM inbox_dismissed WHERE tx_id = ? AND source = ?",
            (str(body.tx_id), DISMISS_SOURCE),
        )
        conn.commit()

        # Подсказка резерва: пришли деньги по одному заказу — предложить отложить
        # материалы из сметы (paid_total фактический — считает _reserve_hint).
        result = {"ok": True, "payments": [
            {"order_id": c["order_id"], "amount": c["amount"]} for c in created
        ]}
        if len(created) == 1:
            o = created[0]["order_row"]
            result.update(_reserve_hint(conn, o))
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
