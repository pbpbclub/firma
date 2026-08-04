from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from auth import get_current_user
from db import get_finance, get_production
import subprocess
import tempfile
import os

router = APIRouter()

# Path to fin-agent env file — provides SBER_ACCOUNT_ID and other vars to import scripts
_FIN_AGENT_ENV = "/opt/fin-agent/.env"


def require_admin(user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user


def _load_fin_env() -> dict:
    """Read /opt/fin-agent/.env and return as dict, merged with current os.environ."""
    env = os.environ.copy()
    if not os.path.exists(_FIN_AGENT_ENV):
        return env
    with open(_FIN_AGENT_ENV) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            env[key.strip()] = val.strip()
    return env


@router.get("/system")
def get_system_info(_=Depends(require_admin)):
    result = {}

    try:
        fin = get_finance()
        try:
            row = fin.execute(
                "SELECT COUNT(*) as cnt, MAX(date) as last_date FROM transactions"
            ).fetchone()
            result["tx_count"] = row["cnt"]
            result["tx_last_date"] = row["last_date"]

            log_row = fin.execute(
                """SELECT source, filename, date_from, date_to, rows_added, imported_at
                   FROM import_log ORDER BY imported_at DESC LIMIT 1"""
            ).fetchone()
            result["last_import"] = dict(log_row) if log_row else None
        finally:
            fin.close()
    except Exception as e:
        result["finance_error"] = str(e)

    try:
        prod = get_production()
        try:
            result["orders_count"] = prod.execute(
                "SELECT COUNT(*) FROM orders"
            ).fetchone()[0]
            result["customers_count"] = prod.execute(
                "SELECT COUNT(*) FROM customers"
            ).fetchone()[0]
        finally:
            prod.close()
    except Exception as e:
        result["production_error"] = str(e)

    return result


@router.get("/audit")
def list_audit(entity_type: str = None, entity_id: str = None, limit: int = 100,
               _=Depends(require_admin)):
    """Журнал изменений через веб (A1): кто, что и когда правил. changes —
    полный снимок строки до изменения (JSON)."""
    limit = max(1, min(int(limit or 100), 500))
    where, params = [], []
    if entity_type:
        where.append("entity_type = ?")
        params.append(entity_type)
    if entity_id:
        where.append("entity_id = ?")
        params.append(entity_id)
    sql = "SELECT * FROM audit_log"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    conn = get_production()
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


@router.get("/imports")
def list_imports(_=Depends(require_admin)):
    fin = get_finance()
    try:
        rows = fin.execute(
            "SELECT * FROM import_log WHERE rows_added > 0 ORDER BY imported_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        fin.close()


@router.delete("/imports/{import_id}")
def delete_import(import_id: int, _=Depends(require_admin)):
    fin = get_finance()
    try:
        row = fin.execute("SELECT * FROM import_log WHERE id=?", (import_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Import not found")

        imported_at = row["imported_at"]

        # Delete transactions that were inserted in this exact batch (same imported_at timestamp)
        deleted = fin.execute(
            "DELETE FROM transactions WHERE imported_at=?", (imported_at,)
        ).rowcount

        fin.execute("DELETE FROM import_log WHERE id=?", (import_id,))
        fin.commit()

        return {"ok": True, "deleted_transactions": deleted, "import_id": import_id}
    finally:
        fin.close()


@router.post("/upload/sber")
async def upload_sber(file: UploadFile = File(...), _=Depends(require_admin)):
    # Preserve original extension so sber.py can detect 1C (.txt) vs CSV format
    original_name = file.filename or "upload.csv"
    ext = os.path.splitext(original_name)[1].lower() or ".csv"

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            ["python3", "/opt/fin-agent/tools/sber.py", "import", tmp_path],
            capture_output=True,
            text=True,
            timeout=60,
            env=_load_fin_env(),  # pass SBER_ACCOUNT_ID so account field is never empty
        )
        output = (result.stdout + result.stderr).strip()
        ok = result.returncode == 0
        return {
            "ok": ok,
            "output": output,
            "filename": file.filename,
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Import script timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.unlink(tmp_path)
