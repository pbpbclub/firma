"""«Чужие деньги» — пометка транзита третьим лицам на личных картах (23.09.2026).

Ставит Юра из ленты («Личные», «Грузия») и фин-агент при разноске. Весь роутер
под `require_owner`: это личный контур. Логика и формулы — `third_party.py`.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import third_party
from audit import audit
from db import get_production
from privacy import require_owner
from zm_scope import scope_for

router = APIRouter()


class MarkIn(BaseModel):
    tx_id: str
    person: str
    direction: str | None = None     # received | given; по умолчанию — по форме строки
    amount: float | None = None      # часть ноги; не передано — вся нога
    amount_rub: float | None = None  # рублёвый эквивалент выдачи в валюте
    note: str | None = None


@router.get("")
def list_marks(person: str | None = None, user=Depends(require_owner)):
    scope = scope_for(user)
    return {"people": third_party.people(scope), "entries": third_party.entries(scope, person)}


@router.get("/people")
def list_people(user=Depends(require_owner)):
    return third_party.people(scope_for(user))


@router.put("")
@router.post("")
def mark(body: MarkIn, user=Depends(require_owner)):
    """Пометить ногу операции ZenMoney чужими деньгами (повтор — перезапись)."""
    person = (body.person or "").strip()
    if not person:
        raise HTTPException(400, "person обязателен — чьи это деньги")
    row = third_party.fetch_rows([body.tx_id]).get(body.tx_id)
    if not row or row.get("deleted"):
        raise HTTPException(404, "операция ZenMoney не найдена")
    inc, out = row.get("income") or 0, row.get("outcome") or 0
    direction = body.direction
    if direction is None:
        if inc > 0 and out > 0:
            raise HTTPException(400, {"error": "direction_required",
                                      "message": "у перевода две ноги — укажи direction: received или given"})
        direction = "received" if inc > 0 else "given"
    if direction not in third_party.DIRECTIONS:
        raise HTTPException(400, "direction: received | given")
    leg = third_party.leg_amount(row, direction)
    if leg <= 0:
        raise HTTPException(400, {"error": "empty_leg",
                                  "message": f"у операции нет ноги {'прихода' if direction == 'received' else 'расхода'}"})
    if body.amount is not None and not (0 < body.amount <= leg + third_party.EPS):
        raise HTTPException(400, f"amount должен быть в пределах ноги (0; {leg}]")
    if body.amount_rub is not None and body.amount_rub <= 0:
        raise HTTPException(400, "amount_rub > 0")
    amount = None if body.amount is None or abs(body.amount - leg) < third_party.EPS else round(body.amount, 2)
    conn = get_production()
    try:
        prev = conn.execute("SELECT * FROM zm_third_party WHERE tx_id = ?", (body.tx_id,)).fetchone()
        conn.execute(
            "INSERT INTO zm_third_party (tx_id, person, direction, amount, amount_rub, note, created_by)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(tx_id) DO UPDATE SET person = excluded.person, direction = excluded.direction,"
            " amount = excluded.amount, amount_rub = excluded.amount_rub, note = excluded.note,"
            " updated_at = datetime('now')",
            (body.tx_id, person, direction, amount, body.amount_rub, body.note, (user or {}).get("email") if isinstance(user, dict) else getattr(user, "email", None)))
        audit(conn, "zm_third_party", body.tx_id, "update" if prev else "create",
              f"Чужие деньги: {person}, {'получено за' if direction == 'received' else 'выдано'}", prev)
        conn.commit()
    finally:
        conn.close()
    scope = scope_for(user)
    entry = next((e for e in third_party.entries(scope, person) if e["tx_id"] == body.tx_id), None)
    return {"ok": True, "entry": entry,
            "person": next((p for p in third_party.people(scope) if p["person"] == person), None)}


@router.delete("/{tx_id}")
def unmark(tx_id: str, user=Depends(require_owner)):
    conn = get_production()
    try:
        prev = conn.execute("SELECT * FROM zm_third_party WHERE tx_id = ?", (tx_id,)).fetchone()
        if not prev:
            raise HTTPException(404, "пометки нет")
        conn.execute("DELETE FROM zm_third_party WHERE tx_id = ?", (tx_id,))
        audit(conn, "zm_third_party", tx_id, "delete", f"Снята пометка «чужие деньги»: {prev['person']}", prev)
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}
