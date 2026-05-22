from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from auth import get_current_user
from db import get_finance, get_production
import subprocess
import tempfile
import os

router = APIRouter()


def require_admin(user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user


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


@router.post("/upload/sber")
async def upload_sber(file: UploadFile = File(...), _=Depends(require_admin)):
    suffix = ".xml" if (file.filename or "").lower().endswith(".xml") else ".csv"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            ["python3", "/opt/fin-agent/tools/sber.py", "import", tmp_path],
            capture_output=True,
            text=True,
            timeout=60,
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
