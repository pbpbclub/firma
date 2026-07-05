import os
import sqlite3
import secrets
import string
import time
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter()

DB_PATH = "/opt/ai-os/data/download_tokens.db"
FILES_PATH = "/opt/ai-os/static/downloads"
CODE_TTL = 900  # 15 минут

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
OWNER_CHAT_ID = os.getenv("OWNER_CHAT_ID", "")

FILE_LABELS = {
    "template": "Универсальный шаблон (agent-template.md)",
    "example": "Живой пример (yos-example.md)",
    "guide": "Гайд — агент с нуля (vps-agent-guide.md)",
}
FILE_NAMES = {
    "template": "agent-template.md",
    "example": "yos-example.md",
    "guide": "vps-agent-guide.md",
}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS download_tokens (
            code TEXT PRIMARY KEY,
            file TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            used INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.commit()
    return conn


def generate_code(length=6):
    alphabet = string.ascii_uppercase + string.digits
    alphabet = alphabet.replace("O", "").replace("0", "").replace("I", "").replace("1", "")
    return "".join(secrets.choice(alphabet) for _ in range(length))


def send_telegram(text: str):
    if not BOT_TOKEN or not OWNER_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    httpx.post(url, json={
        "chat_id": OWNER_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
    }, timeout=5)


class RequestDownloadBody(BaseModel):
    file: str
    name: str = ""


@router.post("/request-download")
def request_download(body: RequestDownloadBody):
    file_key = body.file
    if file_key not in FILE_NAMES:
        raise HTTPException(400, "Unknown file")

    code = generate_code()
    now = int(time.time())

    db = get_db()
    db.execute(
        "INSERT INTO download_tokens (code, file, created_at, used) VALUES (?, ?, ?, 0)",
        (code, file_key, now)
    )
    db.commit()
    db.close()

    label = FILE_LABELS[file_key]
    name_line = f"Имя: <b>{body.name}</b>\n" if body.name else ""
    send_telegram(
        f"🔑 <b>Запрос на скачивание</b>\n"
        f"{name_line}"
        f"Файл: {label}\n\n"
        f"Одноразовый пароль:\n"
        f"<code>{code}</code>\n\n"
        f"Действует 15 минут."
    )

    return {"ok": True}


@router.get("/verify-download")
def verify_download(code: str, file: str):
    if file not in FILE_NAMES:
        raise HTTPException(400, "Unknown file")

    code = code.upper().strip()
    now = int(time.time())

    db = get_db()
    row = db.execute(
        "SELECT code, file, created_at, used FROM download_tokens WHERE code = ? AND file = ?",
        (code, file)
    ).fetchone()

    if not row:
        db.close()
        raise HTTPException(403, "Неверный пароль")

    _, _, created_at, used = row

    if used:
        db.close()
        raise HTTPException(403, "Пароль уже использован")

    if now - created_at > CODE_TTL:
        db.close()
        raise HTTPException(403, "Пароль истёк — запросите новый")

    db.execute("UPDATE download_tokens SET used = 1 WHERE code = ?", (code,))
    db.commit()
    db.close()

    filepath = os.path.join(FILES_PATH, FILE_NAMES[file])
    return FileResponse(
        filepath,
        media_type="text/markdown",
        filename=FILE_NAMES[file],
        headers={"Content-Disposition": f'attachment; filename="{FILE_NAMES[file]}"'}
    )
