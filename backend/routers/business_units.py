from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import get_production, get_finance, get_zenmoney
import uuid

router = APIRouter()


# ─── balance helpers ──────────────────────────────────────────────────────────

def _bank_balances() -> dict:
    """{account_number: balance} from finance.db."""
    conn = get_finance()
    try:
        rows = conn.execute(
            """SELECT account, SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) AS bal
               FROM transactions GROUP BY account"""
        ).fetchall()
        return {r["account"]: round(r["bal"] or 0, 2) for r in rows}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"finance.db недоступна: {e}")
    finally:
        conn.close()


def _zenmoney_total() -> float:
    conn = get_zenmoney()
    try:
        row = conn.execute("SELECT COALESCE(SUM(balance), 0) AS s FROM zm_accounts WHERE archive=0").fetchone()
        return round(row["s"] or 0, 2)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"zenmoney.db недоступна: {e}")
    finally:
        conn.close()


def _account_balance(acc: dict, bank_bal: dict, zen_total: float) -> float:
    src = acc.get("source")
    if src == "bank" and acc.get("number"):
        return bank_bal.get(acc["number"], 0.0)
    if src == "zenmoney":
        return zen_total
    return round(acc.get("manual_balance") or 0, 2)


# ─── Models ───────────────────────────────────────────────────────────────────

class UnitCreate(BaseModel):
    name: str
    kind: Optional[str] = None
    inn: Optional[str] = None
    full_name: Optional[str] = None
    notes: Optional[str] = None


class UnitUpdate(BaseModel):
    name: Optional[str] = None
    kind: Optional[str] = None
    inn: Optional[str] = None
    full_name: Optional[str] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None


class AccountCreate(BaseModel):
    business_unit_id: str
    name: str
    number: Optional[str] = None
    bank: Optional[str] = None
    source: str = "manual"
    manual_balance: Optional[float] = None


class AccountUpdate(BaseModel):
    name: Optional[str] = None
    number: Optional[str] = None
    bank: Optional[str] = None
    source: Optional[str] = None
    manual_balance: Optional[float] = None
    business_unit_id: Optional[str] = None
    sort_order: Optional[int] = None


# ─── Business units ─────────────────────────────────────────────────────────

@router.get("")
def list_units():
    conn = get_production()
    try:
        bank_bal = _bank_balances()
        zen_total = _zenmoney_total()
        units = [dict(r) for r in conn.execute("SELECT * FROM business_units ORDER BY sort_order, name").fetchall()]
        for u in units:
            accs = [dict(r) for r in conn.execute(
                "SELECT * FROM accounts WHERE business_unit_id = ? ORDER BY sort_order, name", (u["id"],)
            ).fetchall()]
            for a in accs:
                a["balance"] = _account_balance(a, bank_bal, zen_total)
            u["accounts"] = accs
            u["balance_total"] = round(sum(a["balance"] for a in accs), 2)
        return units
    finally:
        conn.close()


@router.post("")
def create_unit(body: UnitCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    conn = get_production()
    try:
        existing = conn.execute("SELECT * FROM business_units WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if existing:
            return dict(existing)
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM business_units").fetchone()[0]
        data = {k: v for k, v in body.model_dump().items() if v is not None}
        data["id"] = str(uuid.uuid4())
        data["name"] = name
        data["sort_order"] = max_order + 1
        cols = ", ".join(data.keys())
        ph = ", ".join("?" * len(data))
        conn.execute(f"INSERT INTO business_units ({cols}) VALUES ({ph})", tuple(data.values()))
        conn.commit()
        return dict(conn.execute("SELECT * FROM business_units WHERE id = ?", (data["id"],)).fetchone())
    finally:
        conn.close()


@router.patch("/{unit_id}")
def update_unit(unit_id: str, body: UnitUpdate):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM business_units WHERE id = ?", (unit_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Not found")
        fields = body.model_dump(exclude_unset=True)   # присланный null очищает поле
        if fields:
            sc = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE business_units SET {sc} WHERE id = ?", list(fields.values()) + [unit_id])
            conn.commit()
        return dict(conn.execute("SELECT * FROM business_units WHERE id = ?", (unit_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/{unit_id}")
def delete_unit(unit_id: str):
    conn = get_production()
    try:
        conn.execute("DELETE FROM accounts WHERE business_unit_id = ?", (unit_id,))
        conn.execute("DELETE FROM business_units WHERE id = ?", (unit_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ─── Accounts ─────────────────────────────────────────────────────────────────

@router.post("/accounts")
def create_account(body: AccountCreate):
    conn = get_production()
    try:
        max_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) FROM accounts WHERE business_unit_id = ?",
            (body.business_unit_id,)
        ).fetchone()[0]
        data = {k: v for k, v in body.model_dump().items() if v is not None}
        data["id"] = str(uuid.uuid4())
        data["sort_order"] = max_order + 1
        cols = ", ".join(data.keys())
        ph = ", ".join("?" * len(data))
        conn.execute(f"INSERT INTO accounts ({cols}) VALUES ({ph})", tuple(data.values()))
        conn.commit()
        return dict(conn.execute("SELECT * FROM accounts WHERE id = ?", (data["id"],)).fetchone())
    finally:
        conn.close()


@router.patch("/accounts/{account_id}")
def update_account(account_id: str, body: AccountUpdate):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM accounts WHERE id = ?", (account_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Not found")
        fields = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
        if fields:
            sc = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE accounts SET {sc} WHERE id = ?", list(fields.values()) + [account_id])
            conn.commit()
        return dict(conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/accounts/{account_id}")
def delete_account(account_id: str):
    conn = get_production()
    try:
        conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
