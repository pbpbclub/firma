from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import get_production, get_analytics

router = APIRouter()

PAY_SCHEME_LABELS = {
    "percent":  "% от счёта клиенту",
    "fixed":    "Фиксированная ставка",
    "per_unit": "За единицу",
    "other":    "Другое",
}


def _wiki(name: str, mes_id: Optional[str]) -> dict:
    """Fetch contractor wiki from analytics.db."""
    try:
        conn = get_analytics()
        try:
            row = None
            if mes_id:
                row = conn.execute(
                    "SELECT * FROM contractors WHERE mes_master_id = ?", (mes_id,)
                ).fetchone()
            if not row:
                row = conn.execute(
                    "SELECT * FROM contractors WHERE name = ?", (name,)
                ).fetchone()
            if not row:
                return {}
            r = dict(row)
            scheme = r.get("pay_scheme")
            rate   = r.get("pay_rate")
            note   = r.get("pay_note") or ""
            if scheme == "percent" and rate:
                pay_label = f"{int(rate)}% от счёта клиенту"
            elif scheme == "fixed" and rate:
                pay_label = f"Фиксированно {rate:,.0f} ₽".replace(",", " ")
            elif scheme == "per_unit" and rate:
                pay_label = f"{rate:,.0f} ₽ за единицу".replace(",", " ")
            elif note:
                pay_label = note
            else:
                pay_label = None
            return {
                "wiki_notes":       r.get("notes"),
                "wiki_spec":        r.get("specialization"),
                "pay_scheme":       scheme,
                "pay_rate":         rate,
                "pay_note":         note or None,
                "pay_label":        pay_label,
                "prepay_pct":       r.get("prepay_pct"),
                "wiki_status":      r.get("status"),
            }
        finally:
            conn.close()
    except Exception:
        return {}


class MasterUpdate(BaseModel):
    name:           Optional[str] = None
    role:           Optional[str] = None
    phone:          Optional[str] = None
    telegram:       Optional[str] = None
    email:          Optional[str] = None
    specialization: Optional[str] = None
    notes:          Optional[str] = None
    status:         Optional[str] = None
    # wiki fields — written back to analytics.db
    pay_scheme:     Optional[str] = None
    pay_rate:       Optional[float] = None
    pay_note:       Optional[str] = None
    prepay_pct:     Optional[int] = None
    wiki_notes:     Optional[str] = None


@router.get("")
def list_masters():
    conn = get_production()
    try:
        rows = conn.execute("SELECT * FROM masters ORDER BY name").fetchall()
        result = []
        for r in rows:
            m = dict(r)
            debt = conn.execute(
                "SELECT COALESCE(SUM(total - paid), 0) FROM creditors WHERE name = ? AND status = 'open'",
                (m["name"],)
            ).fetchone()[0]
            m["debt"] = round(debt, 2)
            try:
                m["work_type_ids"] = [
                    row["work_type_id"] for row in conn.execute(
                        "SELECT work_type_id FROM master_work_types WHERE master_id = ?", (m["id"],)
                    ).fetchall()
                ]
            except Exception:
                m["work_type_ids"] = []
            result.append(m)
        return result
    finally:
        conn.close()


class MasterCreate(BaseModel):
    name: str
    role: Optional[str] = "Мастер"
    specialization: Optional[str] = None
    work_type_id: Optional[str] = None


@router.post("")
def create_master(body: MasterCreate):
    import uuid
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    conn = get_production()
    try:
        existing = conn.execute("SELECT * FROM masters WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if existing:
            mid = existing["id"]
        else:
            mid = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO masters (id, name, role, specialization, status, created_at) VALUES (?, ?, ?, ?, 'active', datetime('now'))",
                (mid, name, body.role, body.specialization)
            )
        if body.work_type_id:
            conn.execute(
                "INSERT OR IGNORE INTO master_work_types (master_id, work_type_id) VALUES (?, ?)",
                (mid, body.work_type_id)
            )
        conn.commit()
        return dict(conn.execute("SELECT * FROM masters WHERE id = ?", (mid,)).fetchone())
    finally:
        conn.close()


@router.get("/{master_id}")
def get_master(master_id: str):
    conn = get_production()
    try:
        master = conn.execute("SELECT * FROM masters WHERE id = ?", (master_id,)).fetchone()
        if not master:
            raise HTTPException(status_code=404, detail="Not found")
        master = dict(master)

        creditors = conn.execute(
            "SELECT * FROM creditors WHERE name = ? ORDER BY status, created_at DESC",
            (master["name"],)
        ).fetchall()
        creditors = [dict(r) for r in creditors]
        for c in creditors:
            c["debt"] = round(c["total"] - c["paid"], 2)

        wiki = _wiki(master["name"], master.get("mes_id"))

        return {
            "master": master,
            "creditors": creditors,
            "total_debt": round(sum(c["debt"] for c in creditors if c["status"] == "open"), 2),
            "wiki": wiki,
        }
    finally:
        conn.close()


@router.delete("/{master_id}")
def delete_master(master_id: str):
    conn = get_production()
    try:
        existing = conn.execute("SELECT id FROM masters WHERE id = ?", (master_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Master not found")
        conn.execute("DELETE FROM masters WHERE id = ?", (master_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.patch("/{master_id}")
def update_master(master_id: str, body: MasterUpdate):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM masters WHERE id = ?", (master_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        master = dict(row)

        # Update production.db fields
        prod_fields = ["name", "role", "phone", "telegram", "email", "specialization", "notes", "status"]
        fields, params = [], []
        data = body.model_dump(exclude_none=True)
        for f in prod_fields:
            if f in data:
                fields.append(f"{f} = ?")
                params.append(data[f])
        if fields:
            params.append(master_id)
            conn.execute(f"UPDATE masters SET {', '.join(fields)} WHERE id = ?", params)
            conn.commit()

        # Write wiki fields back to analytics.db
        wiki_fields = {k: data[k] for k in ("pay_scheme", "pay_rate", "pay_note", "prepay_pct", "wiki_notes") if k in data}
        if wiki_fields:
            try:
                ac = get_analytics()
                try:
                    afields, aparams = [], []
                    mapping = {"wiki_notes": "notes", "pay_scheme": "pay_scheme",
                               "pay_rate": "pay_rate", "pay_note": "pay_note", "prepay_pct": "prepay_pct"}
                    for k, v in wiki_fields.items():
                        afields.append(f"{mapping[k]} = ?")
                        aparams.append(v)
                    afields.append("updated_at = datetime('now')")
                    name = data.get("name", master["name"])
                    aparams.append(name)
                    ac.execute(f"UPDATE contractors SET {', '.join(afields)} WHERE name = ?", aparams)
                    ac.commit()
                finally:
                    ac.close()
            except Exception:
                pass  # analytics.db update is best-effort

        updated = dict(conn.execute("SELECT * FROM masters WHERE id = ?", (master_id,)).fetchone())
        wiki = _wiki(updated["name"], updated.get("mes_id"))
        return {**updated, "wiki": wiki}
    finally:
        conn.close()
