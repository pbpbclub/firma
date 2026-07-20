from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import get_production, get_analytics, get_analytics_ro

router = APIRouter()

PAY_SCHEME_LABELS = {
    "percent":  "% от счёта клиенту",
    "fixed":    "Фиксированная ставка",
    "per_unit": "За единицу",
    "other":    "Другое",
}


def _pay_label(r: dict) -> Optional[str]:
    scheme, rate, note = r.get("pay_scheme"), r.get("pay_rate"), r.get("pay_note") or ""
    if scheme == "percent" and rate:
        return f"{int(rate)}% от счёта клиенту"
    if scheme == "fixed" and rate:
        return f"Фиксированно {rate:,.0f} ₽".replace(",", " ")
    if scheme == "per_unit" and rate:
        return f"{rate:,.0f} ₽ за единицу".replace(",", " ")
    return note or None


def _wiki_fields(r: dict) -> dict:
    """Разложить строку analytics.contractors в поля вики."""
    return {
        "wiki_notes":  r.get("notes"),
        "wiki_spec":   r.get("specialization"),
        "pay_scheme":  r.get("pay_scheme"),
        "pay_rate":    r.get("pay_rate"),
        "pay_note":    r.get("pay_note") or None,
        "pay_label":   _pay_label(r),
        "prepay_pct":  r.get("prepay_pct"),
        "wiki_status": r.get("status"),
        "contractor_id": r.get("id"),
    }


def _wiki(name: str, master_id: Optional[str]) -> dict:
    """Вики подрядчика из analytics.db.

    ВАЖНО: analytics.contractors.mes_master_id хранит production masters.id
    (проверено: 10/10 совпадений), а НЕ masters.mes_id — раньше сюда передавали
    mes_id, из-за чего ветка по id никогда не срабатывала и всё держалось
    на совпадении имён."""
    try:
        conn = get_analytics_ro()
        try:
            row = None
            if master_id:
                row = conn.execute(
                    "SELECT * FROM contractors WHERE mes_master_id = ?", (master_id,)
                ).fetchone()
            if not row:
                row = conn.execute(
                    "SELECT * FROM contractors WHERE name = ?", (name,)
                ).fetchone()
            if not row:
                return {}
            r = dict(row)
            return _wiki_fields(r)
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


def _load_wiki_map() -> tuple[dict, dict]:
    """Все контрагенты вики разом: (по mes_master_id, по имени). Без N+1."""
    by_id, by_name = {}, {}
    try:
        ac = get_analytics_ro()
        try:
            for row in ac.execute("SELECT * FROM contractors").fetchall():
                r = dict(row)
                if r.get("mes_master_id"):
                    by_id[str(r["mes_master_id"])] = r
                by_name[(r.get("name") or "").strip()] = r
        finally:
            ac.close()
    except Exception:
        pass
    return by_id, by_name


@router.get("")
def list_masters():
    conn = get_production()
    try:
        rows = [dict(r) for r in conn.execute("SELECT * FROM masters ORDER BY name").fetchall()]

        # Агрегаты пакетно: по одному запросу на источник, не по запросу на мастера
        # (code_rules: N+1 в списочных эндпоинтах запрещён).
        debt_by_name, paid_by_name = {}, {}
        for r in conn.execute(
            """SELECT name,
                      COALESCE(SUM(CASE WHEN status = 'open' THEN total - paid ELSE 0 END), 0) AS debt,
                      COALESCE(SUM(paid), 0) AS paid
               FROM creditors GROUP BY name"""):
            debt_by_name[(r["name"] or "").strip()] = round(r["debt"] or 0, 2)
            paid_by_name[(r["name"] or "").strip()] = round(r["paid"] or 0, 2)

        # Расходы: точная связь по master_id, для старых строк — fallback по supplier.
        exp_by_master, exp_by_supplier = {}, {}
        for r in conn.execute(
            "SELECT master_id, COALESCE(SUM(amount),0) AS s FROM expenses WHERE master_id IS NOT NULL AND master_id != '' GROUP BY master_id"):
            exp_by_master[str(r["master_id"])] = round(r["s"] or 0, 2)
        for r in conn.execute(
            "SELECT supplier, COALESCE(SUM(amount),0) AS s FROM expenses WHERE (master_id IS NULL OR master_id = '') AND supplier IS NOT NULL AND supplier != '' GROUP BY supplier"):
            exp_by_supplier[(r["supplier"] or "").strip()] = round(r["s"] or 0, 2)

        wt_by_master: dict = {}
        try:
            for r in conn.execute("SELECT master_id, work_type_id FROM master_work_types"):
                wt_by_master.setdefault(str(r["master_id"]), []).append(r["work_type_id"])
        except Exception:
            pass

        wiki_by_id, wiki_by_name = _load_wiki_map()

        result = []
        for m in rows:
            name = (m["name"] or "").strip()
            w = wiki_by_id.get(str(m["id"])) or wiki_by_name.get(name) or {}
            wf = _wiki_fields(w) if w else {}
            # «Выплачено» = оплаченные обязательства + фактические расходы.
            # contractor_events сюда НЕ входят: одна выплата бывает и там, и там.
            paid = paid_by_name.get(name, 0) + exp_by_master.get(str(m["id"]), 0) + exp_by_supplier.get(name, 0)
            result.append({
                **m,
                "work_type_ids": wt_by_master.get(str(m["id"]), []),
                "debt": debt_by_name.get(name, 0),
                "paid_total": round(paid, 2),
                "pay_label": wf.get("pay_label"),
                "pay_scheme": wf.get("pay_scheme"),
                "wiki_status": wf.get("wiki_status"),
            })

        # Формат ответа — массив, как раньше: mastersApi.list() используется
        # в сметах, разноске, ZenMoney и админке. Ломать их не будем,
        # список «только в вики» отдаётся отдельным эндпоинтом.
        return result
    finally:
        conn.close()


@router.get("/wiki-only")
def list_wiki_only():
    """Контрагенты вики фин-агента без пары в картотеке. Read-only, не мигрируем."""
    conn = get_production()
    try:
        names = {(r["name"] or "").strip() for r in conn.execute("SELECT name FROM masters")}
        ids = {str(r["id"]) for r in conn.execute("SELECT id FROM masters")}
    finally:
        conn.close()
    wiki_by_id, wiki_by_name = _load_wiki_map()
    out = []
    for w in wiki_by_name.values():
        paired = (w.get("mes_master_id") and str(w["mes_master_id"]) in ids) or (w.get("name") or "").strip() in names
        if paired:
            continue
        out.append({
            "contractor_id": w.get("id"), "name": w.get("name"), "type": w.get("type"),
            "specialization": w.get("specialization"), "status": w.get("status"),
            "pay_label": _pay_label(w), "notes": w.get("notes"),
        })
    return sorted(out, key=lambda x: x["name"] or "")


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
        created = dict(conn.execute("SELECT * FROM masters WHERE id = ?", (mid,)).fetchone())
    finally:
        conn.close()

    # Завести пару в вики фин-агента — иначе схему оплаты потом некуда писать.
    # Best-effort: analytics.db пишут двое, падать из-за неё нельзя.
    try:
        ac = get_analytics()
        try:
            ac.execute(
                """INSERT INTO contractors (name, type, specialization, mes_master_id, created_at, updated_at)
                   VALUES (?, 'contractor', ?, ?, datetime('now'), datetime('now'))
                   ON CONFLICT(name) DO UPDATE SET mes_master_id = excluded.mes_master_id,
                                                   updated_at = datetime('now')""",
                (name, body.specialization, mid)
            )
            ac.commit()
        finally:
            ac.close()
    except Exception:
        pass
    return created


@router.get("/{master_id}")
def get_master(master_id: str):
    conn = get_production()
    try:
        master = conn.execute("SELECT * FROM masters WHERE id = ?", (master_id,)).fetchone()
        if not master:
            raise HTTPException(status_code=404, detail="Not found")
        master = dict(master)

        creditors = [dict(r) for r in conn.execute(
            "SELECT * FROM creditors WHERE name = ? ORDER BY status, created_at DESC",
            (master["name"],)
        ).fetchall()]
        for c in creditors:
            c["debt"] = round(c["total"] - c["paid"], 2)

        # Расходы по заказам: точная связь по master_id + старые строки по supplier.
        expenses = [dict(r) for r in conn.execute(
            """SELECT e.id, e.title, e.amount, e.category, e.expense_date, e.supplier, e.group_id,
                      o.number AS order_number, o.title AS order_title, o.id AS order_id
               FROM expenses e LEFT JOIN orders o ON o.id = e.order_id
               WHERE e.master_id = ? OR (COALESCE(e.master_id,'') = '' AND e.supplier = ?)
               ORDER BY e.expense_date DESC""",
            (master_id, master["name"])
        ).fetchall()]
    finally:
        conn.close()

    wiki = _wiki(master["name"], master["id"])

    # История из вики фин-агента. НЕ суммируется с расходами: одна выплата
    # нередко записана и там, и там — сложение задвоит.
    events = []
    cid = wiki.get("contractor_id")
    if cid:
        try:
            ac = get_analytics_ro()
            try:
                events = [dict(r) for r in ac.execute(
                    """SELECT id, event_type, order_number, amount, description, rating, happened_at
                       FROM contractor_events WHERE contractor_id = ?
                       ORDER BY happened_at DESC LIMIT 50""", (cid,)
                ).fetchall()]
            finally:
                ac.close()
        except Exception:
            events = []

    paid_total = round(sum(c["paid"] or 0 for c in creditors) + sum(e["amount"] or 0 for e in expenses), 2)

    return {
        "master": master,
        "creditors": creditors,
        "expenses": expenses,
        "events": events,
        "paid_total": paid_total,
        "total_debt": round(sum(c["debt"] for c in creditors if c["status"] == "open"), 2),
        "wiki": wiki,
    }


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
                    # Искать пару по mes_master_id, а не по имени: при переименовании
                    # в этом же PATCH имя ещё не существует в вики и апдейт молча
                    # обновлял бы ноль строк.
                    row = ac.execute("SELECT id FROM contractors WHERE mes_master_id = ?", (master_id,)).fetchone()
                    if not row:
                        row = ac.execute("SELECT id FROM contractors WHERE name = ?", (master["name"],)).fetchone()
                    if row:
                        ac.execute(f"UPDATE contractors SET {', '.join(afields)} WHERE id = ?", aparams + [row["id"]])
                    else:
                        # Пары нет — завести, иначе схема оплаты просто потеряется.
                        ac.execute(
                            "INSERT INTO contractors (name, type, mes_master_id, created_at, updated_at) VALUES (?, 'contractor', ?, datetime('now'), datetime('now'))",
                            (data.get("name", master["name"]), master_id)
                        )
                        new_id = ac.execute("SELECT id FROM contractors WHERE mes_master_id = ?", (master_id,)).fetchone()["id"]
                        ac.execute(f"UPDATE contractors SET {', '.join(afields)} WHERE id = ?", aparams + [new_id])
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
