"""Кто видит личный заграничный контур (22.09.2026).

Граница приватности — НЕ роль. `routers/users.py` позволяет любому admin завести
пользователя с любой ролью и войти под ним, а бухгалтер у нас admin: роль `owner`
в auth.db она выдала бы себе за два клика. Поэтому список владельцев лежит вне
управляемого из интерфейса контура — в переменной окружения, которую правит только
root, и API для её изменения нет и не будет.

Фолбэк при отсутствии переменной — захардкоженный владелец, а не «все»: fail-closed.
Боевой /opt/firma/backend/.env правится только root (у нас на него ACL лишь на чтение),
поэтому сегодня работает именно фолбэк, а переменная — точка расширения.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, HTTPException

from auth import get_current_user

load_dotenv(Path("/opt/firma/backend/.env"))

# Не «все» и не пустое множество: потеря переменной не должна открывать личное.
FALLBACK_OWNERS = frozenset({"yuranek@pbpb.club"})


def _parse(raw: str | None) -> frozenset[str]:
    return frozenset(p.strip().lower() for p in (raw or "").split(",") if p.strip())


def private_owners() -> frozenset[str]:
    """Читается на каждый вызов: root правит .env и перезапускает сервис, а тесты
    подменяют переменную без перезагрузки модуля."""
    return _parse(os.environ.get("FIRMA_PRIVATE_OWNERS")) or FALLBACK_OWNERS


def user_email(user) -> str:
    if user is None:
        return ""
    if isinstance(user, str):
        return user.strip().lower()
    try:
        return (user["email"] or "").strip().lower()
    except (TypeError, KeyError, IndexError):
        return (getattr(user, "email", "") or "").strip().lower()


def is_owner(user) -> bool:
    """Владелец личного контура. Пустой пользователь — не владелец (fail-closed)."""
    email = user_email(user)
    return bool(email) and email in private_owners()


async def require_owner(user=Depends(get_current_user)):
    """Гейт ручек личного контура. 403, а не 404: скрывать сам факт раздела
    не нужно — Юра работает в системе вместе с бухгалтером и это не секрет."""
    if not is_owner(user):
        raise HTTPException(status_code=403, detail="Раздел личных финансов доступен только владельцу")
    return user
