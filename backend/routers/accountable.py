# Подотчётные лица (ТЗ cash_expenses, 24.07.2026).
#
# Инвариант против задвоения: ВЫДАЧА под отчёт (перевод на карту / наличные из
# кассы) — НЕ расход по заказу, только перемещение денег. Расход возникает в
# момент оплаты поставщику (expenses.payment_source='accountable'). Баланс лица
# «на руках» = выдачи − возвраты − его оплаты поставщикам.
import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from db import get_production

router = APIRouter()


def _cash_fund_id(conn) -> Optional[str]:
    row = conn.execute("SELECT id FROM funds WHERE kind = 'cash'").fetchone()
    return row["id"] if row else None


def _balance(conn, master_id: str) -> float:
    issued = conn.execute(
        "SELECT COALESCE(SUM(CASE WHEN kind='issue' THEN amount ELSE -amount END), 0) "
        "FROM accountable_ops WHERE master_id = ?", (master_id,)
    ).fetchone()[0]
    spent = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) FROM expenses "
        "WHERE payment_source = 'accountable' AND accountable_person_id = ?", (master_id,)
    ).fetchone()[0]
    return round(issued - spent, 2)


@router.get("")
def list_accountable():
    """Подотчётные лица с балансами «на руках»."""
    conn = get_production()
    try:
        rows = conn.execute(
            "SELECT id, name FROM masters WHERE is_accountable = 1 ORDER BY name"
        ).fetchall()
        return [{"id": r["id"], "name": r["name"], "balance": _balance(conn, r["id"])} for r in rows]
    finally:
        conn.close()


class IssueFromTx(BaseModel):
    tx_id: str
    source: str = "bank"          # bank | zen
    master_id: str
    amount: float
    date: Optional[str] = None
    note: Optional[str] = None


@router.post("/issue-from-tx")
def issue_from_tx(body: IssueFromTx):
    """Оформить банковский/ZM-перевод как выдачу под отчёт (из Разноски).
    Транзакция исчезает из инбокса (учтена в accountable_ops), расход не создаётся."""
    if body.source not in ("bank", "zen"):
        raise HTTPException(status_code=400, detail="source must be bank|zen")
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")
    conn = get_production()
    try:
        m = conn.execute("SELECT id, name FROM masters WHERE id = ?", (body.master_id,)).fetchone()
        if not m:
            raise HTTPException(status_code=404, detail="Мастер не найден")
        col = "finance_tx_id" if body.source == "bank" else "zenmoney_tx_id"
        dup = conn.execute(
            f"SELECT id FROM accountable_ops WHERE {col} = ?", (str(body.tx_id),)
        ).fetchone()
        if dup:
            raise HTTPException(status_code=409, detail="Эта транзакция уже оформлена как выдача под отчёт")
        conn.execute("UPDATE masters SET is_accountable = 1 WHERE id = ?", (body.master_id,))
        conn.execute(
            f"""INSERT INTO accountable_ops (id, master_id, kind, amount, date, {col}, note)
                VALUES (?, ?, 'issue', ?, COALESCE(?, date('now')), ?, ?)""",
            (str(uuid.uuid4()), body.master_id, body.amount, body.date, str(body.tx_id),
             body.note or "Выдача под отчёт (перевод)"),
        )
        conn.commit()
        return {"ok": True, "master": m["name"], "balance": _balance(conn, body.master_id)}
    finally:
        conn.close()


class OpIn(BaseModel):
    kind: str                     # issue | return
    amount: float
    date: Optional[str] = None
    note: Optional[str] = None
    via_cash_fund: bool = True    # выдача из кассы / возврат в кассу — двигаем и кассу


@router.post("/{master_id}/ops")
def add_op(master_id: str, body: OpIn):
    """Ручная выдача (из кассы) или возврат остатка (в кассу)."""
    if body.kind not in ("issue", "return"):
        raise HTTPException(status_code=400, detail="kind must be issue|return")
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")
    conn = get_production()
    try:
        m = conn.execute("SELECT id, name FROM masters WHERE id = ?", (master_id,)).fetchone()
        if not m:
            raise HTTPException(status_code=404, detail="Мастер не найден")
        conn.execute("UPDATE masters SET is_accountable = 1 WHERE id = ?", (master_id,))
        op_id = str(uuid.uuid4())
        note = body.note or ("Выдача под отчёт" if body.kind == "issue" else "Возврат остатка")
        conn.execute(
            """INSERT INTO accountable_ops (id, master_id, kind, amount, date, note)
               VALUES (?, ?, ?, ?, COALESCE(?, date('now')), ?)""",
            (op_id, master_id, body.kind, body.amount, body.date, note),
        )
        # Зеркальное движение кассы: выдача — из кассы, возврат — в кассу.
        if body.via_cash_fund:
            fund_id = _cash_fund_id(conn)
            if fund_id:
                conn.execute(
                    """INSERT INTO fund_transactions (id, fund_id, direction, amount, note, date)
                       VALUES (?, ?, ?, ?, ?, COALESCE(?, date('now')))""",
                    (str(uuid.uuid4()), fund_id,
                     "out" if body.kind == "issue" else "in",
                     body.amount, f"{note} — {m['name']}", body.date),
                )
        conn.commit()
        return {"ok": True, "id": op_id, "balance": _balance(conn, master_id)}
    finally:
        conn.close()


@router.get("/{master_id}/ops")
def list_ops(master_id: str):
    conn = get_production()
    try:
        ops = [dict(r) for r in conn.execute(
            "SELECT * FROM accountable_ops WHERE master_id = ? ORDER BY date DESC, created_at DESC",
            (master_id,)
        ).fetchall()]
        spent = [dict(r) for r in conn.execute(
            """SELECT id, order_id, title, amount, expense_date AS date, supplier FROM expenses
               WHERE payment_source = 'accountable' AND accountable_person_id = ?
               ORDER BY expense_date DESC""",
            (master_id,)
        ).fetchall()]
        return {"ops": ops, "expenses": spent, "balance": _balance(conn, master_id)}
    finally:
        conn.close()


@router.delete("/ops/{op_id}")
def delete_op(op_id: str):
    conn = get_production()
    try:
        cur = conn.execute("DELETE FROM accountable_ops WHERE id = ?", (op_id,))
        conn.commit()
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Not found")
        return {"ok": True}
    finally:
        conn.close()
