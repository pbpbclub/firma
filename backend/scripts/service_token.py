#!/usr/bin/env python3
"""Сервисные токены агентов: выпуск, список, отзыв (через API Фирмы).

    python3 scripts/service_token.py issue --agent fin --sub <email> [--days N] [--note ...]
    python3 scripts/service_token.py list
    python3 scripts/service_token.py revoke <jti>

auth.db принадлежит root и пишется только сервисом, поэтому скрипт ходит в
http://127.0.0.1:8001/api/auth/service-tokens. Админский JWT — из FIRMA_ADMIN_TOKEN,
иначе минтится на 5 минут из FIRMA_SECRET_KEY (/opt/firma/backend/.env).
Без --days токен бессрочный и живёт до отзыва.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = os.environ.get("FIRMA_API", "http://127.0.0.1:8001/api/auth/service-tokens")
ADMIN = "yuranek@pbpb.club"


def _admin_token() -> str:
    tok = os.environ.get("FIRMA_ADMIN_TOKEN")
    if tok:
        return tok
    from dotenv import dotenv_values
    from jose import jwt
    secret = dotenv_values(Path("/opt/firma/backend/.env")).get("FIRMA_SECRET_KEY")
    if not secret:
        sys.exit("Нет FIRMA_ADMIN_TOKEN и не читается FIRMA_SECRET_KEY")
    exp = datetime.now(timezone.utc) + timedelta(minutes=5)
    return jwt.encode({"sub": ADMIN, "exp": exp}, secret, algorithm="HS256")


def _call(method: str, url: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {_admin_token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode()}")


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    i = sp.add_parser("issue")
    i.add_argument("--agent", required=True)
    i.add_argument("--sub", required=True)
    i.add_argument("--days", type=int)
    i.add_argument("--note")
    sp.add_parser("list")
    r = sp.add_parser("revoke")
    r.add_argument("jti")
    a = ap.parse_args()

    if a.cmd == "issue":
        res = _call("POST", API, {"agent": a.agent, "sub": a.sub, "days": a.days, "note": a.note})
        print(f"jti: {res['jti']}  срок: {res['expires_at'] or 'бессрочный'}", file=sys.stderr)
        print(res["token"])
    elif a.cmd == "list":
        for t in _call("GET", API):
            # Состояние считает API (одна точка правды), CLI только подписывает.
            st = t.get("state")
            if st == "revoked":
                state = f"отозван {t['revoked_at']}"
            elif st == "expired":
                state = "истёк"
            elif st == "live":
                state = "живой"
            else:
                state = "состояние неизвестно (старый API)"
            print(f"{t['jti']}  {t['agent']:<7} {t['sub']:<24} до {t['expires_at'] or '∞'}  "
                  f"{state}  {t['note'] or ''}")
    else:
        print(_call("DELETE", f"{API}/{a.jti}"))


if __name__ == "__main__":
    main()
