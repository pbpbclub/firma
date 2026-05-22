from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import get_production
import uuid
from datetime import date

router = APIRouter()

INITIAL_FUNDS = [
    ("Налоговый",    "УСН 6% и другие налоги",           "#E8592A"),
    ("Зарплатный",   "Выплаты сотрудникам и подрядчикам", "#4A7C59"),
    ("Фонд pbpb",    "Развитие и операционные расходы",    "#1A1A1A"),
    ("Долгосрочный", "Резерв и долгосрочные вложения",    "#A89070"),
]


def _ensure_tables():
    conn = get_production()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS funds (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                description TEXT,
                color       TEXT DEFAULT '#E8592A',
                created_at  TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS fund_transactions (
                id        TEXT PRIMARY KEY,
                fund_id   TEXT NOT NULL REFERENCES funds(id),
                direction TEXT NOT NULL,
                amount    REAL NOT NULL,
                note      TEXT,
                date      TEXT DEFAULT (date('now')),
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        # Seed initial funds if empty
        existing = conn.execute("SELECT COUNT(*) FROM funds").fetchone()[0]
        if existing == 0:
            for name, desc, color in INITIAL_FUNDS:
                conn.execute(
                    "INSERT INTO funds (id, name, description, color) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), name, desc, color)
                )
        conn.commit()
    finally:
        conn.close()


_ensure_tables()


class FundCreate(BaseModel):
    name: str
    description: Optional[str] = None
    color: str = "#E8592A"


class TxCreate(BaseModel):
    amount: float
    note: Optional[str] = None
    date: Optional[str] = None


@router.post("")
def create_fund(body: FundCreate):
    conn = get_production()
    try:
        fund_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO funds (id, name, description, color) VALUES (?, ?, ?, ?)",
            (fund_id, body.name.strip(), body.description, body.color)
        )
        conn.commit()
        row = dict(conn.execute("SELECT * FROM funds WHERE id = ?", (fund_id,)).fetchone())
        row["balance"] = 0.0
        return row
    finally:
        conn.close()


@router.get("")
def list_funds():
    conn = get_production()
    try:
        funds = conn.execute("SELECT * FROM funds ORDER BY created_at").fetchall()
        result = []
        for f in funds:
            row = dict(f)
            bal = conn.execute(
                """SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
                   FROM fund_transactions WHERE fund_id = ?""",
                (f["id"],)
            ).fetchone()[0]
            row["balance"] = round(bal, 2)
            result.append(row)
        return result
    finally:
        conn.close()


@router.get("/{fund_id}/transactions")
def get_transactions(fund_id: str, limit: int = 50):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM funds WHERE id = ?", (fund_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Fund not found")
        rows = conn.execute(
            "SELECT * FROM fund_transactions WHERE fund_id = ? ORDER BY date DESC, created_at DESC LIMIT ?",
            (fund_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/{fund_id}/deposit")
def deposit(fund_id: str, body: TxCreate):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM funds WHERE id = ?", (fund_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Fund not found")
        if body.amount <= 0:
            raise HTTPException(status_code=400, detail="Amount must be positive")
        tx_id = str(uuid.uuid4())
        tx_date = body.date or date.today().isoformat()
        conn.execute(
            "INSERT INTO fund_transactions (id, fund_id, direction, amount, note, date) VALUES (?, ?, 'in', ?, ?, ?)",
            (tx_id, fund_id, body.amount, body.note, tx_date)
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM fund_transactions WHERE id = ?", (tx_id,)).fetchone())
    finally:
        conn.close()


@router.post("/{fund_id}/withdraw")
def withdraw(fund_id: str, body: TxCreate):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM funds WHERE id = ?", (fund_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Fund not found")
        if body.amount <= 0:
            raise HTTPException(status_code=400, detail="Amount must be positive")
        tx_id = str(uuid.uuid4())
        tx_date = body.date or date.today().isoformat()
        conn.execute(
            "INSERT INTO fund_transactions (id, fund_id, direction, amount, note, date) VALUES (?, ?, 'out', ?, ?, ?)",
            (tx_id, fund_id, body.amount, body.note, tx_date)
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM fund_transactions WHERE id = ?", (tx_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/transactions/{tx_id}")
def delete_transaction(tx_id: str):
    conn = get_production()
    try:
        if not conn.execute("SELECT id FROM fund_transactions WHERE id = ?", (tx_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("DELETE FROM fund_transactions WHERE id = ?", (tx_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
