from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, EmailStr
from auth import (
    get_db, get_current_user, create_token, create_user, pwd_ctx
)

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


class CreateUserRequest(BaseModel):
    email: str
    name: str
    password: str
    role: str = "viewer"


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/login")
def login(body: LoginRequest):
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (body.email,)).fetchone()
        if not user or not pwd_ctx.verify(body.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Неверный email или пароль")
        token = create_token(user["email"])
        return {
            "token": token,
            "user": {"email": user["email"], "name": user["name"], "role": user["role"]},
        }
    finally:
        conn.close()


@router.get("/me")
def me(user=Depends(get_current_user)):
    return {"email": user["email"], "name": user["name"], "role": user["role"]}


@router.get("/users")
def list_users(current=Depends(get_current_user)):
    if current["role"] != "admin":
        raise HTTPException(status_code=403, detail="Только для администратора")
    conn = get_db()
    try:
        rows = conn.execute("SELECT id, email, name, role, created_at FROM users").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/users")
def add_user(body: CreateUserRequest, current=Depends(get_current_user)):
    if current["role"] != "admin":
        raise HTTPException(status_code=403, detail="Только для администратора")
    ok = create_user(body.email, body.name, body.password, body.role)
    if not ok:
        raise HTTPException(status_code=400, detail="Email уже занят")
    return {"ok": True}


@router.delete("/users/{user_id}")
def delete_user(user_id: int, current=Depends(get_current_user)):
    if current["role"] != "admin":
        raise HTTPException(status_code=403, detail="Только для администратора")
    conn = get_db()
    try:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/change-password")
def change_password(body: ChangePasswordRequest, current=Depends(get_current_user)):
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (current["email"],)).fetchone()
        if not pwd_ctx.verify(body.current_password, user["password_hash"]):
            raise HTTPException(status_code=400, detail="Неверный текущий пароль")
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE email = ?",
            (pwd_ctx.hash(body.new_password), current["email"]),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
