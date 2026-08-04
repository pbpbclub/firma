import os
import sqlite3
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from passlib.context import CryptContext

AUTH_DB = Path("/opt/firma/data/auth.db")
AUTH_DB.parent.mkdir(parents=True, exist_ok=True)

# Секрет только в /opt/firma/backend/.env (вне git); ротация = новое значение + рестарт,
# все выданные токены при этом слетают.
load_dotenv(Path("/opt/firma/backend/.env"))
SECRET_KEY = os.environ.get("FIRMA_SECRET_KEY") or ""
if not SECRET_KEY:
    raise RuntimeError("FIRMA_SECRET_KEY отсутствует в /opt/firma/backend/.env")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 30

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
    conn.commit()
    return conn


def create_token(email: str) -> str:
    expire = datetime.utcnow() + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": email, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if not email:
            raise HTTPException(status_code=401, detail="Invalid token")
        return email
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def get_current_user(email: str = Depends(verify_token)):
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        # Актор для журнала изменений (audit.py): dependency дёргается на каждом
        # запросе — write-ручкам не нужно таскать пользователя параметром.
        from audit import current_actor
        current_actor.set(email)
        return dict(user)
    finally:
        conn.close()


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
