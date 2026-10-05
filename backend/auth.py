import os
import sqlite3
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import ExpiredSignatureError, JWTError, jwt
from passlib.context import CryptContext
from starlette.concurrency import run_in_threadpool

AUTH_DB = Path("/opt/firma/data/auth.db")
AUTH_DB.parent.mkdir(parents=True, exist_ok=True)

# Секрет только в /opt/firma/backend/.env (вне git); ротация = новое значение + рестарт,
# все выданные токены при этом слетают.
load_dotenv(Path("/opt/firma/backend/.env"))
SECRET_KEY = os.environ.get("FIRMA_SECRET_KEY") or ""
if not SECRET_KEY:
    raise RuntimeError("FIRMA_SECRET_KEY отсутствует в /opt/firma/backend/.env")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 30  # пользовательские сессии; сервисные токены агентов — ниже

# Сервисные токены агентов (ТЗ Юры 05.10.2026): 01.10 истёк 30-дневный FIRMA_TOKEN
# фин-агента и 4 дня firma.py получал 401. Свой вид токена (typ=svc) — долгий или
# бессрочный, каждый с jti в auth.db.service_tokens: отзыв точечный, без ротации
# FIRMA_SECRET_KEY. Права — права пользователя sub, отдельной роли у токена нет.
SERVICE_AGENTS = ("fin", "yos", "vendor", "mac", "sales")

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer()


def get_db():
    conn = sqlite3.connect(AUTH_DB)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'viewer',
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS service_tokens (
            jti TEXT PRIMARY KEY,
            agent TEXT NOT NULL,
            sub TEXT NOT NULL,
            note TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            created_by TEXT,
            expires_at TEXT,
            revoked_at TEXT,
            revoked_by TEXT
        )
    """)
    conn.commit()
    return conn


def create_token(email: str) -> str:
    expire = datetime.utcnow() + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": email, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def create_service_token(agent: str, sub: str, days: Optional[int] = None,
                         note: Optional[str] = None, created_by: Optional[str] = None) -> dict:
    """Выпуск токена агента. days=None — бессрочный (живёт до отзыва)."""
    jti = secrets.token_urlsafe(16)
    claims = {"sub": sub, "typ": "svc", "agent": agent, "jti": jti}
    expires_at = None
    if days:
        exp = datetime.utcnow() + timedelta(days=days)
        claims["exp"] = exp
        expires_at = exp.strftime("%Y-%m-%d %H:%M:%S")
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO service_tokens (jti, agent, sub, note, created_by, expires_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (jti, agent, sub, note, created_by, expires_at),
        )
        conn.commit()
    finally:
        conn.close()
    return {"jti": jti, "agent": agent, "sub": sub, "expires_at": expires_at,
            "token": jwt.encode(claims, SECRET_KEY, algorithm=ALGORITHM)}


def _service_token_live(jti: str) -> bool:
    conn = get_db()
    try:
        row = conn.execute("SELECT revoked_at FROM service_tokens WHERE jti = ?",
                           (jti,)).fetchone()
        return bool(row) and row["revoked_at"] is None
    finally:
        conn.close()


def decode_token(raw: str) -> dict:
    """Единая проверка JWT. detail различает причины — агенты по нему решают,
    перевыпускать токен ('token expired') или звать человека (ротация секрета,
    отзыв): 'token expired' | 'token revoked' | 'Invalid token'."""
    try:
        payload = jwt.decode(raw, SECRET_KEY, algorithms=[ALGORITHM])
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="token expired")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    if not payload.get("sub"):
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("typ") == "svc":
        jti = payload.get("jti")
        if not jti or not _service_token_live(jti):
            raise HTTPException(status_code=401, detail="token revoked")
    return payload


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    return decode_token(credentials.credentials)["sub"]


def _load_user(email: str):
    conn = get_db()
    try:
        return conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    finally:
        conn.close()


async def get_current_user(email: str = Depends(verify_token)):
    """Пользователь запроса + актор журнала изменений (audit.py).

    Зависимость async НАМЕРЕННО: синхронную FastAPI исполняет в threadpool с
    КОПИЕЙ контекста, и current_actor.set() до обработчика не доезжает — журнал
    писал бы 'system' вместо человека (code_rules 04.08). Обращение к auth.db
    уводим в threadpool сами, чтобы не блокировать цикл событий."""
    user = await run_in_threadpool(_load_user, email)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    # dependency дёргается на каждом запросе — write-ручкам не нужно таскать
    # пользователя параметром.
    from audit import current_actor
    current_actor.set(email)
    return dict(user)


def create_user(email: str, name: str, password: str, role: str = "viewer"):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)",
            (email, name, pwd_ctx.hash(password), role),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()


def init_admin():
    """Создаёт admin если пользователей нет."""
    conn = get_db()
    try:
        count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if count == 0:
            password = secrets.token_urlsafe(12)
            conn.execute(
                "INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)",
                ("yuranek@pbpb.club", "Юра", pwd_ctx.hash(password), "admin"),
            )
            conn.commit()
            print(f"[firma] Admin created: yuranek@pbpb.club / {password}")
    finally:
        conn.close()
