"""Визуальные карточки-выжимки: PDF кнопкой из веба.

Финагент присылает Юре такие карточки в Telegram, и каждая до сих пор собиралась
ОТДЕЛЬНЫМ питон-скриптом под конкретный заказ (data/uploads/ilyinsky_build.py и
родня). Здесь то же самое, но параметризованно и из интерфейса.

Движок не свой: HTML → headless Chrome → PDF делает /opt/fin-agent/tools/card.py —
тот же, которым уже пользуется кнопка «КП». Шрифты (Onest + Space Grotesk на
цифрах) подставляет он же из firma_fonts.css, поэтому карточка типографически
совпадает с вебом. Вёрстка — общий каркас card_detail.css оттуда же.

⚠️ Chrome и puppeteer лежат в /root — рендер работает только под сервисом (он от
root). Из сессии разработчика карточку не собрать, проверять только через HTTP.

⚠️ kp_doc.css (КП, счёт, доверенность — то, что уходит заказчику) здесь НЕ
трогается: карточки подключают свой card_detail.css.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import HTTPException
from jinja2 import Environment, FileSystemLoader, select_autoescape

CARD_TOOL = Path("/opt/fin-agent/tools/card.py")
CARDS_DIR = Path("/opt/fin-agent/data/cards")
TPL_DIR = Path(__file__).resolve().parent / "templates" / "cards"

_env = Environment(loader=FileSystemLoader(str(TPL_DIR)), autoescape=select_autoescape(["html"]))


def money(v) -> str:
    """12500.5 → «12 500». Разряды неразрывным пробелом — иначе число рвётся по строкам."""
    try:
        n = round(float(v or 0))
    except (TypeError, ValueError):
        return "0"
    return f"{n:,}".replace(",", " ")


def signed(v) -> str:
    n = round(float(v or 0))
    return ("+" if n > 0 else "−" if n < 0 else "") + money(abs(n))


def rusdate(v) -> str:
    """«2026-08-21» → «21.08». Год не пишем: карточка всегда про недавнее."""
    s = str(v or "")
    return f"{s[8:10]}.{s[5:7]}" if len(s) >= 10 else s


_env.filters["money"] = money
_env.filters["signed"] = signed
_env.filters["rusdate"] = rusdate


def _safe_stem(raw: str) -> str:
    """Имя файла: только то, что не сломает путь и не даст выйти из каталога."""
    s = re.sub(r"[^A-Za-z0-9_\-]+", "-", str(raw or "card")).strip("-")
    return (s or "card")[:60]


def render(template: str, stem: str, **ctx) -> Path:
    """Собрать карточку и вернуть путь к PDF."""
    if not CARD_TOOL.exists():
        raise HTTPException(status_code=503, detail="Рендер карточек недоступен: нет card.py")
    stem = _safe_stem(stem)
    html = _env.get_template(template).render(**ctx)
    # Исходник кладём во временный каталог: card.py пишет рядом .build.html, а
    # /*CSS:card_detail.css*/ он всё равно найдёт в своих templates.
    tmp = Path(tempfile.mkdtemp(prefix="firma-card-"))
    src = tmp / f"{stem}.src.html"
    src.write_text(html, encoding="utf-8")
    try:
        proc = subprocess.run(
            ["python3", str(CARD_TOOL), str(src), "--stem", stem],
            capture_output=True, text=True, timeout=120,
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)   # исходник и .build.html не копим
    out = CARDS_DIR / f"{stem}.pdf"
    if proc.returncode != 0 or not out.exists():
        detail = (proc.stderr or proc.stdout or "").strip()[:400]
        raise HTTPException(status_code=502, detail=f"Не удалось собрать карточку: {detail}")
    return out
