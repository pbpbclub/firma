from fastapi import APIRouter, HTTPException, Body
from db import get_production

router = APIRouter()


def _all_rules(conn):
    rows = conn.execute(
        "SELECT * FROM payee_rules ORDER BY match_type, pattern"
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("")
def list_rules(entity_type: str = None, entity_id: str = None):
    conn = get_production()
    try:
        sql = "SELECT * FROM payee_rules"
        params = []
        conditions = []
        if entity_type:
            conditions.append("entity_type = ?")
            params.append(entity_type)
        if entity_id:
            conditions.append("entity_id = ?")
            params.append(entity_id)
        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        sql += " ORDER BY match_type, pattern"
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("")
def create_rule(body: dict = Body(...)):
    pattern = (body.get("pattern") or "").strip()
    if not pattern:
        raise HTTPException(status_code=400, detail="pattern required")
    match_type = body.get("match_type", "exact")
    if match_type not in ("exact", "contains", "prefix"):
        raise HTTPException(status_code=400, detail="invalid match_type")

    display_name = (body.get("display_name") or "").strip() or None
    entity_type = body.get("entity_type") or None
    entity_id = body.get("entity_id") or None
    entity_name = (body.get("entity_name") or "").strip() or None

    conn = get_production()
    try:
        existing = conn.execute(
            "SELECT id FROM payee_rules WHERE pattern = ? AND match_type = ?",
            (pattern.lower(), match_type),
        ).fetchone()
        if existing:
            # Upsert: обновляем существующее правило вместо ошибки
            conn.execute(
                """UPDATE payee_rules SET display_name=?, entity_type=?, entity_id=?, entity_name=?,
                   updated_at=datetime('now') WHERE id=?""",
                (display_name, entity_type, entity_id, entity_name, existing["id"]),
            )
            conn.commit()
            return dict(conn.execute("SELECT * FROM payee_rules WHERE id = ?", (existing["id"],)).fetchone())

        conn.execute(
            """INSERT INTO payee_rules
               (pattern, match_type, display_name, entity_type, entity_id, entity_name)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (pattern.lower(), match_type, display_name, entity_type, entity_id, entity_name),
        )
        conn.commit()
        rule_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()["id"]
        return dict(conn.execute("SELECT * FROM payee_rules WHERE id = ?", (rule_id,)).fetchone())
    finally:
        conn.close()


@router.patch("/{rule_id}")
def update_rule(rule_id: int, body: dict = Body(...)):
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM payee_rules WHERE id = ?", (rule_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="not found")

        fields = []
        params = []
        for key in ("pattern", "match_type", "display_name", "entity_type", "entity_id", "entity_name"):
            if key in body:
                val = body[key]
                if key == "pattern" and val:
                    val = val.strip().lower()
                fields.append(f"{key} = ?")
                params.append(val or None)
        if not fields:
            raise HTTPException(status_code=400, detail="nothing to update")
        fields.append("updated_at = datetime('now')")
        params.append(rule_id)
        conn.execute(f"UPDATE payee_rules SET {', '.join(fields)} WHERE id = ?", params)
        conn.commit()
        return dict(conn.execute("SELECT * FROM payee_rules WHERE id = ?", (rule_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/{rule_id}")
def delete_rule(rule_id: int):
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM payee_rules WHERE id = ?", (rule_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="not found")
        conn.execute("DELETE FROM payee_rules WHERE id = ?", (rule_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
