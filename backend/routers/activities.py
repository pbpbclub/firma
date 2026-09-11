"""Виды прибыли — справочник-ярлык (решение Юры 11.09.2026).

Производство / транзит / проектные работы / … — как бренды: список ведёт Юра в вики,
заказ ссылается кодом (orders.activity). Модели затрат у вида нет: это фильтр для
списка заказов, сводки П/Ф и машинного времени, а не правило расчёта."""
import re
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from audit import audit
from db import get_production

router = APIRouter()

_TRANSLIT = {"а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i",
             "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
             "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "",
             "э": "e", "ю": "yu", "я": "ya"}


def slug(name: str) -> str:
    s = "".join(_TRANSLIT.get(ch, ch) for ch in (name or "").lower())
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s or "activity"


class ActivityCreate(BaseModel):
    name: str
    code: Optional[str] = None
    color: Optional[str] = None
    description: Optional[str] = None


class ActivityUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    description: Optional[str] = None
    sort_order: Optional[int] = None


_SQL = """SELECT a.*, (SELECT COUNT(*) FROM orders o WHERE o.activity = a.code AND COALESCE(o.archived, 0) = 0) AS orders_count
            FROM activities a"""


def codes(conn) -> set:
    return {r["code"] for r in conn.execute("SELECT code FROM activities").fetchall()}


@router.get("")
def list_activities():
    conn = get_production()
    try:
        return [dict(r) for r in conn.execute(_SQL + " ORDER BY a.sort_order, a.name").fetchall()]
    finally:
        conn.close()


@router.post("", status_code=201)
def create_activity(body: ActivityCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    conn = get_production()
    try:
        existing = conn.execute("SELECT * FROM activities WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if existing:
            return dict(existing)
        code = slug(body.code or name)
        if conn.execute("SELECT 1 FROM activities WHERE code = ?", (code,)).fetchone():
            raise HTTPException(status_code=409, detail=f"Код «{code}» уже занят")
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM activities").fetchone()[0]
        aid = str(uuid.uuid4())
        conn.execute("INSERT INTO activities (id, code, name, color, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
                     (aid, code, name, body.color, body.description, max_order + 1))
        audit(conn, "activity", aid, "create", f"Вид прибыли «{name}» ({code})")
        conn.commit()
        return dict(conn.execute(_SQL + " WHERE a.id = ?", (aid,)).fetchone())
    finally:
        conn.close()


@router.patch("/{activity_id}")
def update_activity(activity_id: str, body: ActivityUpdate):
    """Код не меняется: на нём висят заказы; имя, цвет, описание, порядок — свободно."""
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        fields = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
        if "name" in fields:
            fields["name"] = (fields["name"] or "").strip()
            if not fields["name"]:
                raise HTTPException(status_code=400, detail="name required")
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields) + ", updated_at = datetime('now')"
            conn.execute(f"UPDATE activities SET {sets} WHERE id = ?", list(fields.values()) + [activity_id])
            audit(conn, "activity", activity_id, "update", f"Вид прибыли «{row['name']}»: правка {', '.join(fields)}", before_row=row)
            conn.commit()
        return dict(conn.execute(_SQL + " WHERE a.id = ?", (activity_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/{activity_id}")
def delete_activity(activity_id: str):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        if row["is_default"]:
            raise HTTPException(status_code=409, detail="Вид по умолчанию не удаляется")
        n = conn.execute("SELECT COUNT(*) FROM orders WHERE activity = ?", (row["code"],)).fetchone()[0]
        if n:
            raise HTTPException(status_code=409, detail=f"У вида «{row['name']}» {n} заказов — сначала перевесь их")
        conn.execute("DELETE FROM activities WHERE id = ?", (activity_id,))
        audit(conn, "activity", activity_id, "delete", f"Вид прибыли «{row['name']}» удалён", before_row=row)
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
