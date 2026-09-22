"""Курсы и сигнал обмена для личного заграничного контура (22.09.2026).

Разделение доступа: сам курс Нацбанка — открытая справка, её видит любой
залогиненный; сигнал «сколько свободно менять» завязан на остатки заграничных
счетов и поэтому закрыт владельцем (`privacy.require_owner`).
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import fx
from auth import get_current_user
from db import get_production
from privacy import require_owner
from zm_scope import scope_for

router = APIRouter()

RESERVE_KEY = "fx_usd_reserve"


def _reserve(conn) -> float:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (RESERVE_KEY,)).fetchone()
    try:
        return float((row["value"] if row else "") or 0)
    except (TypeError, ValueError):
        return 0.0


def _refresh_status() -> dict:
    """Ленивая подтяжка курса + её исход для экрана.

    🔒 Результат `fx.refresh()` нельзя выбрасывать: сбой сети (`ok: False`) — это
    «курс на вчера», и человек обязан это видеть, иначе вчерашнее число читается
    как сегодняшнее. Ключи одинаковы в обеих ветках (правило 2026-09-07)."""
    r = fx.refresh() or {}
    return {"ok": bool(r.get("ok", False)), "error": r.get("error"),
            "skipped": r.get("skipped"), "stored": r.get("stored", 0)}


@router.get("/series")
def get_series(base: str = "USD", quote: str = "GEL", days: int = Query(90, le=365),
               user=Depends(get_current_user)):
    """Официальный курс по дням. Сеть дёргаем лениво — раз в сутки."""
    return {"base": base.upper(), "quote": quote.upper(),
            "rows": fx.series(base.upper(), quote.upper(), days),
            "fx_refresh": _refresh_status()}


@router.post("/refresh")
def post_refresh(force: bool = False, user=Depends(require_owner)):
    return fx.refresh(force=force)


class ReserveUpdate(BaseModel):
    usd_reserve: float


@router.put("/reserve")
def set_reserve(body: ReserveUpdate, user=Depends(require_owner)):
    """Неснижаемый остаток в долларах: ниже него менять не предлагаем."""
    if body.usd_reserve < 0:
        raise HTTPException(status_code=400, detail="Запас не может быть отрицательным")
    conn = get_production()
    try:
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
            (RESERVE_KEY, str(body.usd_reserve)))
        conn.commit()
        return {"usd_reserve": body.usd_reserve}
    finally:
        conn.close()


@router.get("/signal")
def get_signal(user=Depends(require_owner)):
    """«Сегодня менять или подождать» + сколько долларов свободно.

    Свободно = остаток доллара − неснижаемый запас. Остаток берём через линзу:
    счёт без назначенной валюты (или с неоднозначным названием) в расчёт не
    идёт — лучше промолчать, чем посоветовать менять несуществующие деньги."""
    refresh = _refresh_status()
    scope = scope_for(user)
    conn = get_production()
    try:
        reserve = _reserve(conn)
    finally:
        conn.close()

    balances = {}
    unconfigured = []   # валюта не назначена — в расчёт не берём
    ambiguous = []      # остаток считается, но строки не разнести (одинаковые имена)
    for a in scope.accounts(include_cash=True):
        if a.region != "ge":
            continue
        if a.ambiguous:
            ambiguous.append({"id": a.id, "title": a.title, "currency": a.currency})
        if not a.configured:
            unconfigured.append({"id": a.id, "title": a.title, "ambiguous": a.ambiguous})
            continue
        balances[a.currency] = round(balances.get(a.currency, 0) + (a.balance or 0), 2)

    usd = balances.get("USD", 0.0)
    free = round(max(usd - reserve, 0), 2)
    sig = fx.signal("USD", "GEL")
    sig.update({
        "balances": balances,
        "usd_reserve": reserve,
        "usd_free": free,
        "gel_if_converted": round(free * sig["rate"], 2) if sig.get("rate") else None,
        "unconfigured": unconfigured,
        "ambiguous": ambiguous,
        "fx_refresh": refresh,
    })
    return sig
