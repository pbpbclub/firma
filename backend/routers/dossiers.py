"""Комплекты конструктора: финальные чертежи и ведомости изделия заказа.

ТЗ YOS 06.10.2026 (/opt/ai-os/docs/firma_tz_dossier.md) по решениям Юры:
- единица версионирования — изделие внутри заказа, версия — снимок ВСЕГО комплекта
  (файлы + ведомость строками), неизменяема и не удаляется: ошибка — withdraw;
- последняя опубликованная версия становится текущей сама; кнопки — только ручное
  переопределение (закрепить, снять закрепление, отозвать);
- фину ничего не уходит без явного request-costing (флаг `costing` при публикации).

Единственный вход — `POST /publish`. Файл, совпавший по sha256 с файлом прежней версии
того же комплекта, — жёсткая ссылка: место не растёт, версия остаётся полным снимком.
Клиент со стороны YOS — /opt/ai-os/tools/dossier.py.

След — только audit_log (сущности `dossier` / `dossier_version`), его читает история
заказа (`orders.order_timeline`). В `events` не пишем, хотя ТЗ п.7 просит: таблица из
MES мёртвая, ленту по ней никто не строит.
"""
import difflib
import hashlib
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from audit import audit
from auth import get_current_user
from db import DOSSIER_ROOT, get_production
from routers.media import file_auth

log = logging.getLogger(__name__)

router = APIRouter()          # /api/dossiers — авторизация на каждом маршруте (файлы — file_auth)
orders_router = APIRouter()   # /api/orders/{id}/dossiers — под общим JWT
_jwt = [Depends(get_current_user)]

MAX_FILE = 100 * 1024 * 1024
MAX_VERSION = 200 * 1024 * 1024
ROLE_BY_EXT = {
    "pdf": "drawing", "dxf": "drawing", "dwg": "drawing", "svg": "drawing",
    "md": "bom", "csv": "bom", "xlsx": "bom", "json": "bom",
    "blend": "model", "step": "model", "stp": "model", "glb": "model", "dae": "model",
    "png": "render", "jpg": "render", "jpeg": "render",
}
ROLES = ("drawing", "bom", "model", "render", "other")
PUBLISHERS = ("blender", "yos", "yura", "firma")
SIMILAR_RATIO = 0.8
AGENT_MSG = "/opt/ai-os/tools/agent_msg.py"

_TRANSLIT = dict(zip(
    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p",
     "r", "s", "t", "u", "f", "h", "ts", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya"]))


def _key(s: Optional[str]) -> str:
    # lower()/NOCASE SQLite не знают кириллицу — сравнение названий только здесь
    return re.sub(r"\s+", " ", (s or "").strip()).casefold()


def slugify(title: str) -> str:
    s = "".join(_TRANSLIT.get(ch, ch) for ch in title.strip().lower())
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "item"


def safe_filename(name: str) -> str:
    """secure_filename по-нашему: без каталогов, ведущих точек и служебных символов,
    кириллицу сохраняем — имя файла видит человек."""
    base = re.split(r"[\\/]", name or "")[-1]
    base = re.sub(r'[\x00-\x1f<>:"|?*]', "", base).strip().lstrip(".").strip()
    return base


def _path_part(s: str) -> str:
    return safe_filename(s).replace(" ", "_") or "order"


def files_hash(shas) -> str:
    """Отпечаток набора файлов — тот же, что считает dossier.py у YOS."""
    return hashlib.sha256("\n".join(sorted(shas)).encode()).hexdigest()


def bom_hash(bom) -> Optional[str]:
    if bom is None:
        return None
    norm = json.dumps(bom, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(norm.encode()).hexdigest()


def _vdir(n: int) -> str:
    return f"v{n:02d}"


def _err(status: int, code: str, detail: str, **extra) -> JSONResponse:
    # Тело плоское, как в ТЗ: {"code", "detail", ...} — клиент печатает detail
    return JSONResponse(status_code=status, content={"code": code, "detail": detail, **extra})


# ─── заказ ────────────────────────────────────────────────────────────────────

def resolve_order(conn, ident: Optional[str], project_dir: Optional[str] = None):
    """Номер → id → точное название (без регистра) → папка конструктора."""
    if ident:
        r = conn.execute("SELECT id, number, title FROM orders WHERE number = ? OR id = ? LIMIT 1",
                         (ident, ident)).fetchone()
        if r:
            return dict(r)
        want = _key(ident)
        for r in conn.execute("SELECT id, number, title FROM orders WHERE title IS NOT NULL"):
            if _key(r["title"]) == want:
                return dict(r)
    if project_dir:
        r = conn.execute("SELECT o.id, o.number, o.title FROM order_project_dirs d "
                         "JOIN orders o ON o.id = d.order_id WHERE d.dir = ?", (project_dir,)).fetchone()
        if r:
            return dict(r)
    return None


def _order_of(conn, order_id: str) -> dict:
    r = conn.execute("SELECT id, number, title FROM orders WHERE id = ?", (order_id,)).fetchone()
    return dict(r) if r else {"id": order_id, "number": None, "title": None}


# ─── чтение ───────────────────────────────────────────────────────────────────

def _files_of(conn, version_ids: List[str]) -> dict:
    out: dict = {vid: [] for vid in version_ids}
    if not version_ids:
        return out
    q = ",".join("?" * len(version_ids))
    for f in conn.execute(f"SELECT id, version_id, role, filename, mime, bytes, sha256 FROM dossier_files "
                          f"WHERE version_id IN ({q}) ORDER BY role, filename", version_ids):
        d = dict(f)
        out[d.pop("version_id")].append(d)
    return out


def _version_row(v, cur_id, files) -> dict:
    d = dict(v)
    d.pop("bom_json", None)
    d["is_current"] = d["id"] == cur_id
    d["has_bom"] = v["bom_hash"] is not None
    d["files"] = files
    return d


def dossiers_summary(conn, order_id: str) -> Optional[str]:
    """«Стол волна v3 · 06.10; Лавка v1 · 02.10» — для карточки заказа и production.py order."""
    # «Миграция ещё не прошла» определяем явной проверкой схемы: тем же
    # sqlite3.OperationalError приходит «database is locked» общей production.db, и
    # перехват превращал штатную блокировку в тихое «чертежей нет».
    have = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dossiers', 'dossier_versions')")}
    if len(have) < 2:
        return None
    # LEFT JOIN: у комплекта со всеми отозванными версиями current_version_id = NULL
    # (withdraw), и INNER JOIN убирал его из сводки целиком — карточка заказа читалась
    # как «конструктор ничего не сдавал». Формулировка — как у production.py YOS.
    rows = conn.execute(
        "SELECT d.title, v.number, v.published_at FROM dossiers d "
        "LEFT JOIN dossier_versions v ON v.id = d.current_version_id "
        "WHERE d.order_id = ? ORDER BY d.created_at", (order_id,)).fetchall()
    parts = []
    for r in rows:
        if r["number"] is None:
            parts.append(f"{r['title']} — активных версий нет")
            continue
        dt = (r["published_at"] or "")[:10]
        parts.append(f"{r['title']} v{r['number']}" + (f" · {dt[8:10]}.{dt[5:7]}" if len(dt) == 10 else ""))
    return "; ".join(parts) or None


@orders_router.get("/{order_id}/dossiers")
def list_order_dossiers(order_id: str):
    conn = get_production()
    try:
        o = resolve_order(conn, order_id)
        if not o:
            raise HTTPException(404, f"Заказ не найден: {order_id}")
        rows = conn.execute(
            """SELECT d.*,
                      (SELECT COUNT(*) FROM dossier_versions x WHERE x.dossier_id = d.id) AS versions_total,
                      (SELECT COUNT(*) FROM dossier_versions x WHERE x.dossier_id = d.id
                         AND x.status = 'withdrawn') AS withdrawn_total
               FROM dossiers d WHERE d.order_id = ? ORDER BY d.created_at""", (o["id"],)).fetchall()
        out = []
        for d in rows:
            cur = None
            if d["current_version_id"]:
                v = conn.execute(
                    "SELECT id, number, published_at, published_by, note, costing_status, "
                    "costing_requested_at, estimate_set_id, "
                    "(SELECT COUNT(*) FROM dossier_files f WHERE f.version_id = v.id) AS files_count "
                    "FROM dossier_versions v WHERE v.id = ?", (d["current_version_id"],)).fetchone()
                if v:
                    cur = dict(v)
                    cur["version_id"] = cur["id"]
            out.append({
                "dossier_id": d["id"], "id": d["id"], "title": d["title"], "slug": d["slug"],
                "pinned": d["pinned"], "catalog_item_id": d["catalog_item_id"],
                "estimate_item_id": d["estimate_item_id"], "current": cur,
                "versions_total": d["versions_total"], "withdrawn_total": d["withdrawn_total"],
            })
        return out
    finally:
        conn.close()


@router.get("/{dossier_id}", dependencies=_jwt)
def get_dossier(dossier_id: str, all: int = Query(0)):
    conn = get_production()
    try:
        d = conn.execute("SELECT * FROM dossiers WHERE id = ?", (dossier_id,)).fetchone()
        if not d:
            raise HTTPException(404, "комплект не найден")
        where = "" if all else " AND status = 'active'"
        vs = conn.execute(f"SELECT * FROM dossier_versions WHERE dossier_id = ?{where} ORDER BY number DESC",
                          (dossier_id,)).fetchall()
        files = _files_of(conn, [v["id"] for v in vs])
        return {
            **dict(d), "dossier_id": d["id"], "order": _order_of(conn, d["order_id"]),
            "withdrawn_total": conn.execute("SELECT COUNT(*) FROM dossier_versions WHERE dossier_id = ? "
                                            "AND status = 'withdrawn'", (dossier_id,)).fetchone()[0],
            "versions": [_version_row(v, d["current_version_id"], files[v["id"]]) for v in vs],
        }
    finally:
        conn.close()


@router.get("/versions/{vid}", dependencies=_jwt)
def get_version(vid: str):
    conn = get_production()
    try:
        v = conn.execute("SELECT * FROM dossier_versions WHERE id = ?", (vid,)).fetchone()
        if not v:
            raise HTTPException(404, "версия не найдена")
        d = conn.execute("SELECT * FROM dossiers WHERE id = ?", (v["dossier_id"],)).fetchone()
        out = _version_row(v, d["current_version_id"], _files_of(conn, [vid])[vid])
        out["bom_json"] = json.loads(v["bom_json"]) if v["bom_json"] else None
        out["dossier"] = {"id": d["id"], "title": d["title"], "slug": d["slug"], "pinned": d["pinned"]}
        out["order"] = _order_of(conn, d["order_id"])
        return out
    finally:
        conn.close()


@router.get("/files/{fid}", dependencies=[Depends(file_auth)])
def get_file(fid: str, download: int = Query(0)):
    conn = get_production()
    try:
        f = conn.execute("SELECT filename, path, mime FROM dossier_files WHERE id = ?", (fid,)).fetchone()
    finally:
        conn.close()
    if not f:
        raise HTTPException(404, "файл не найден")
    if not Path(f["path"]).exists():
        raise HTTPException(404, "файл потерян на диске")
    # inline — превью pdf/png во вкладке; ?download=1 — сохранить под исходным именем
    return FileResponse(f["path"], media_type=f["mime"] or "application/octet-stream",
                        filename=f["filename"],
                        content_disposition_type="attachment" if download else "inline")


# ─── публикация ───────────────────────────────────────────────────────────────

def _publish_response(conn, v, d, *, created=False, warnings=None, replayed=False, status=201):
    o = _order_of(conn, d["order_id"])
    n_files = conn.execute("SELECT COUNT(*) FROM dossier_files WHERE version_id = ?", (v["id"],)).fetchone()[0]
    body = {"dossier_id": d["id"], "version_id": v["id"], "number": v["number"],
            "is_current": d["current_version_id"] == v["id"], "created_dossier": created,
            "order": o, "files": n_files, "warnings": warnings or []}
    if replayed:
        body["replayed"] = True
    return JSONResponse(status_code=status, content=body)


def _replay(conn, ext_key, order_id: str, item: str, fh=None, bh=None, new_item: bool = False):
    """Повтор по клиентскому ключу — только в границах того же заказа и комплекта.

    `ext_key` в схеме глобально уникален, поэтому совпадение ключа у ДРУГОГО изделия
    вернуло бы 200 «replayed» с чужими dossier_id/version_id, а присланные файлы молча
    не опубликовались бы. Расхождение — явный отказ, а не повтор.

    🔒 Принадлежность сверяется по неизменяемым id (order_id комплекта и id самого
    комплекта), а НЕ по названию: `title` правится из интерфейса (PATCH), и штатный
    повтор публикации со старым `item` получал 409 — клиенту оставалось завести дубль
    под новым ключом.

    🔒 Повтор — это ТОТ ЖЕ комплект (отпечаток файлов и ведомости совпал). Ключ,
    присланный с ИЗМЕНЁННЫМ комплектом (конструктор правит чертёж, `key` в meta не
    сменил), повтором не считается: 200 «replayed» на него означал бы, что правка молча
    не опубликована. Поэтому `files_hash`/`bom_hash` сверяются ВСЕГДА, а до постановки
    файлов (`fh is None`) решать нечем — возвращаем None, вызывающий поставит файлы и
    спросит повторно уже с отпечатками.

    🔒 Присланное название, которого в заказе нет вовсе, названием не разводится: это
    либо переименованный комплект (штатный повтор), либо ключ, переиспользованный под
    НОВОЕ изделие. Отпечаток их не различает (копия того же набора файлов), поэтому
    решает явное намерение клиента: `new_item=true` — «это новое изделие», и ключ занят.
    """
    if not ext_key:
        return None
    v = conn.execute("SELECT * FROM dossier_versions WHERE ext_key = ?", (ext_key,)).fetchone()
    if not v:
        return None
    d = conn.execute("SELECT * FROM dossiers WHERE id = ?", (v["dossier_id"],)).fetchone()

    def taken():
        o = _order_of(conn, d["order_id"]) if d else {}
        return _err(409, "ext_key_taken",
                    f"ext_key «{ext_key}» уже занят комплектом «{d['title'] if d else '?'}» "
                    f"заказа {o.get('number') or o.get('id') or '?'} — возьми другой ключ",
                    dossier_id=d["id"] if d else None, version_id=v["id"])

    if not d or d["order_id"] != order_id:
        return taken()
    if _key(d["title"]) != _key(item):
        other, _ = _find_dossier(conn, order_id, item, True)
        if other is not None and other["id"] != d["id"]:
            return taken()
        if new_item:
            return taken()
    if fh is None:
        return None
    if v["files_hash"] != fh or v["bom_hash"] != bh:
        return taken()
    return _publish_response(conn, v, d, replayed=True, status=200)


def _stage(files: List[UploadFile], roles: dict, staging: Path) -> List[dict]:
    """Файлы во временный каталог с подсчётом sha256 и лимитами. 400 — до записи в БД."""
    staged, seen, total = [], set(), 0
    for uf in files:
        name = safe_filename(uf.filename or "")
        if not name:
            raise HTTPException(400, f"Недопустимое имя файла: «{uf.filename}»")
        if _key(name) in seen:
            raise HTTPException(400, f"Два файла с именем «{name}» в одной версии")
        seen.add(_key(name))
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in ROLE_BY_EXT:
            raise HTTPException(400, f"«{name}»: расширение не из допустимых "
                                     f"({' '.join(sorted(ROLE_BY_EXT))})")
        role = (roles or {}).get(uf.filename) or (roles or {}).get(name) or ROLE_BY_EXT[ext]
        if role not in ROLES:
            raise HTTPException(400, f"«{name}»: роль «{role}» не из {'|'.join(ROLES)}")
        h, size, tmp = hashlib.sha256(), 0, staging / uuid.uuid4().hex
        with open(tmp, "wb") as out:
            while True:
                chunk = uf.file.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                total += len(chunk)
                if size > MAX_FILE:
                    raise HTTPException(400, f"«{name}» больше 100 МБ")
                if total > MAX_VERSION:
                    raise HTTPException(400, "Версия больше 200 МБ")
                h.update(chunk)
                out.write(chunk)
        if size == 0:
            raise HTTPException(400, f"«{name}» пустой")
        mime = mimetypes.guess_type(name)[0] or uf.content_type or "application/octet-stream"
        staged.append({"filename": name, "role": role, "tmp": tmp, "bytes": size,
                       "sha256": h.hexdigest(), "mime": mime})
    return staged


def _same_files(conn, version_id: str, staged: List[dict]) -> bool:
    """Совпадают ли имена, роли и содержимое файлов версии с присланным набором."""
    prev = {(f["filename"], f["role"], f["sha256"]) for f in conn.execute(
        "SELECT filename, role, sha256 FROM dossier_files WHERE version_id = ?", (version_id,))}
    return prev == {(f["filename"], f["role"], f["sha256"]) for f in staged}


def _find_dossier(conn, order_id: str, item: str, new_item: bool):
    """(комплект | None, похожие названия). Похожие — только если точного нет."""
    rows = conn.execute("SELECT * FROM dossiers WHERE order_id = ?", (order_id,)).fetchall()
    want = _key(item)
    for r in rows:
        if _key(r["title"]) == want:
            return r, []
    if new_item:
        return None, []
    similar = [r["title"] for r in rows
               if difflib.SequenceMatcher(None, _key(r["title"]), want).ratio() >= SIMILAR_RATIO]
    return None, similar


def _unique_slug(conn, order_id: str, title: str) -> str:
    base = slugify(title)
    taken = {r[0] for r in conn.execute("SELECT slug FROM dossiers WHERE order_id = ?", (order_id,))}
    slug, i = base, 2
    while slug in taken:
        slug, i = f"{base}-{i}", i + 1
    return slug


@router.post("/publish", dependencies=_jwt)
def publish(meta: str = Form(...), files: List[UploadFile] = File(...)):
    try:
        m = json.loads(meta)
        assert isinstance(m, dict)
    except Exception:
        raise HTTPException(400, "meta — не JSON-объект")
    item = re.sub(r"\s+", " ", str(m.get("item") or "")).strip()
    if not item:
        raise HTTPException(400, "meta.item — название изделия — обязательно")
    by = m.get("published_by") or "blender"
    if by not in PUBLISHERS:
        raise HTTPException(400, f"published_by: {'|'.join(PUBLISHERS)}")
    bom = m.get("bom")
    if bom is not None and not (isinstance(bom, dict) and isinstance(bom.get("lines"), list)):
        raise HTTPException(400, "meta.bom — {\"lines\": [...]} по docs/bom-contract.md")
    roles = m.get("roles") or {}
    if not isinstance(roles, dict):
        raise HTTPException(400, "meta.roles — словарь {имя файла: роль}")
    ext_key = (str(m["ext_key"]).strip() or None) if m.get("ext_key") else None
    note = (m.get("note") or "").strip() or None
    if not files:
        raise HTTPException(400, "Нет файлов: версия — это весь комплект")

    conn = get_production()
    staging = None
    written: List[Path] = []
    try:
        o = resolve_order(conn, m.get("order"), m.get("project_dir"))
        if not o:
            raise HTTPException(400, f"Заказ не найден: {m.get('order') or m.get('project_dir') or '—'}")
        # До постановки файлов отпечатков нет — этот проход ловит только явно чужой ключ
        # (другой заказ, другой комплект заказа) и отказывает ещё до приёма файлов.
        hit = _replay(conn, ext_key, o["id"], item, new_item=bool(m.get("new_item")))
        if hit:
            return hit

        DOSSIER_ROOT.mkdir(parents=True, exist_ok=True)
        staging = DOSSIER_ROOT / ".incoming" / uuid.uuid4().hex
        staging.mkdir(parents=True)
        staged = _stage(files, roles, staging)
        fh, bh = files_hash(f["sha256"] for f in staged), bom_hash(bom)

        # Номер версии и выбор комплекта — под одной блокировкой: два публикатора
        # не возьмут один номер и не заведут два комплекта на одно изделие.
        conn.execute("BEGIN IMMEDIATE")
        hit = _replay(conn, ext_key, o["id"], item, fh, bh, bool(m.get("new_item")))
        if hit:
            conn.rollback()
            return hit
        d, similar = _find_dossier(conn, o["id"], item, bool(m.get("new_item")))
        if d is None and similar:
            conn.rollback()
            return _err(409, "similar_item",
                        f"В заказе есть «{similar[0]}» — это он? Повтори с точным названием или new_item=true",
                        similar=similar)
        created = d is None
        if created:
            did = str(uuid.uuid4())
            conn.execute("INSERT INTO dossiers (id, order_id, title, slug) VALUES (?, ?, ?, ?)",
                         (did, o["id"], item, _unique_slug(conn, o["id"], item)))
            d = conn.execute("SELECT * FROM dossiers WHERE id = ?", (did,)).fetchone()
        else:
            # Сверяем с ПОСЛЕДНЕЙ живой версией, а не с current_version_id: при pinned=1
            # указатель держит старую версию руками Юры, и сравнение с ним давало сразу
            # обе беды — молчаливый дубль поверх последней v3 и ложный 409 на совпадении
            # с закреплённой v1, которая от актуальной отличается.
            cur = conn.execute(
                "SELECT id, number, note, files_hash, bom_hash FROM dossier_versions "
                "WHERE dossier_id = ? AND status = 'active' ORDER BY number DESC LIMIT 1",
                (d["id"],)).fetchone()
            # «Ничего не изменилось» — только если совпало ВСЁ, что хранит версия и видит
            # человек: содержимое (files_hash), имена и роли файлов, ведомость, заметка.
            # Хэш по одному содержимому превращал переименование файла или новую роль
            # в молчаливый 409 без следа в журнале.
            if cur and cur["files_hash"] == fh and cur["bom_hash"] == bh \
                    and (cur["note"] or None) == note and _same_files(conn, cur["id"], staged):
                conn.rollback()
                return _err(409, "unchanged", f"Ничего не изменилось относительно v{cur['number']}",
                            number=cur["number"])

        number = conn.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM dossier_versions WHERE dossier_id = ?",
                              (d["id"],)).fetchone()[0]
        vid = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO dossier_versions (id, dossier_id, number, note, bom_json, bom_hash, files_hash,
                                             ext_key, published_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (vid, d["id"], number, note, json.dumps(bom, ensure_ascii=False) if bom is not None else None,
             bh, fh, ext_key, by))

        vdir = DOSSIER_ROOT / _path_part(o["number"] or o["id"][:8]) / d["slug"] / _vdir(number)
        vdir.mkdir(parents=True, exist_ok=True)
        for f in staged:
            target = vdir / f["filename"]
            if target.exists():          # хвост упавшей публикации: номер ещё никому не выдан
                target.unlink()
            prev = conn.execute(
                "SELECT f.path FROM dossier_files f JOIN dossier_versions v ON v.id = f.version_id "
                "WHERE v.dossier_id = ? AND f.sha256 = ? ORDER BY v.number DESC", (d["id"], f["sha256"])).fetchall()
            src = next((Path(p["path"]) for p in prev if Path(p["path"]).exists()), None)
            if src is not None:
                os.link(src, target)
            else:
                os.replace(f["tmp"], target)
            written.append(target)
            conn.execute("INSERT INTO dossier_files (id, version_id, role, filename, path, mime, bytes, sha256) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                         (str(uuid.uuid4()), vid, f["role"], f["filename"], str(target), f["mime"],
                          f["bytes"], f["sha256"]))

        warnings = []
        if d["pinned"]:
            pv = conn.execute("SELECT number FROM dossier_versions WHERE id = ?", (d["current_version_id"],)).fetchone()
            warnings.append(f"комплект закреплён на v{pv['number'] if pv else '?'} — новая версия ушла в историю")
        else:
            conn.execute("UPDATE dossiers SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?",
                         (vid, d["id"]))
        msg = f"{d['title']} v{number} опубликован" + (f": {note}" if note else "")
        audit(conn, "dossier_version", vid, "create", msg)
        conn.commit()
    except BaseException:
        conn.rollback()
        for p in written:
            try:
                p.unlink()
            except OSError:
                pass
        raise
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
        conn.close()

    if m.get("costing"):
        try:
            request_costing(vid, {"note": note})
        except HTTPException as e:
            warnings.append(f"поручение фину не ушло: {e.detail}")
    conn = get_production()
    try:
        v = conn.execute("SELECT * FROM dossier_versions WHERE id = ?", (vid,)).fetchone()
        d = conn.execute("SELECT * FROM dossiers WHERE id = ?", (v["dossier_id"],)).fetchone()
        return _publish_response(conn, v, d, created=created, warnings=warnings)
    finally:
        conn.close()


# ─── указатель: кнопки Юры ────────────────────────────────────────────────────

def _dossier(conn, did):
    d = conn.execute("SELECT * FROM dossiers WHERE id = ?", (did,)).fetchone()
    if not d:
        raise HTTPException(404, "комплект не найден")
    return d


def _version(conn, vid):
    v = conn.execute("SELECT * FROM dossier_versions WHERE id = ?", (vid,)).fetchone()
    if not v:
        raise HTTPException(404, "версия не найдена")
    return v


def _last_active(conn, did, below: Optional[int] = None):
    q = "SELECT id FROM dossier_versions WHERE dossier_id = ? AND status = 'active'"
    args: list = [did]
    if below is not None:
        q += " AND number < ?"
        args.append(below)
    r = conn.execute(q + " ORDER BY number DESC LIMIT 1", args).fetchone()
    return r["id"] if r else None


@router.post("/{dossier_id}/pin", dependencies=_jwt)
def pin(dossier_id: str, body: dict = Body(...)):
    conn = get_production()
    try:
        d = _dossier(conn, dossier_id)
        v = _version(conn, body.get("version_id") or "")
        if v["dossier_id"] != d["id"]:
            raise HTTPException(400, "версия из другого комплекта")
        if v["status"] != "active":
            raise HTTPException(409, "версия отозвана — закрепить нельзя")
        conn.execute("UPDATE dossiers SET current_version_id = ?, pinned = 1, updated_at = datetime('now') "
                     "WHERE id = ?", (v["id"], d["id"]))
        msg = f"{d['title']}: закреплена v{v['number']}"
        audit(conn, "dossier", d["id"], "update", msg, before_row=d)
        conn.commit()
        return {"ok": True, "current_version_id": v["id"], "number": v["number"], "pinned": 1}
    finally:
        conn.close()


@router.post("/{dossier_id}/unpin", dependencies=_jwt)
def unpin(dossier_id: str):
    conn = get_production()
    try:
        d = _dossier(conn, dossier_id)
        cur = _last_active(conn, d["id"])
        conn.execute("UPDATE dossiers SET pinned = 0, current_version_id = ?, updated_at = datetime('now') "
                     "WHERE id = ?", (cur, d["id"]))
        msg = f"{d['title']}: закрепление снято"
        audit(conn, "dossier", d["id"], "update", msg, before_row=d)
        conn.commit()
        return {"ok": True, "current_version_id": cur, "pinned": 0}
    finally:
        conn.close()


@router.post("/versions/{vid}/withdraw", dependencies=_jwt)
def withdraw(vid: str, body: dict = Body(default={})):
    conn = get_production()
    try:
        v = _version(conn, vid)
        d = _dossier(conn, v["dossier_id"])
        if v["status"] == "withdrawn":
            return {"ok": True, "already": True, "current_version_id": d["current_version_id"]}
        if d["pinned"] and d["current_version_id"] == vid:
            raise HTTPException(409, "Сначала сними закрепление")
        note = (body.get("note") or "").strip() or None
        conn.execute("UPDATE dossier_versions SET status = 'withdrawn', withdrawn_at = datetime('now'), "
                     "withdrawn_note = ? WHERE id = ?", (note, vid))
        cur = d["current_version_id"]
        if cur == vid:
            cur = _last_active(conn, d["id"], below=v["number"])
            conn.execute("UPDATE dossiers SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?",
                         (cur, d["id"]))
        msg = f"{d['title']} v{v['number']} отозван" + (f": {note}" if note else "")
        audit(conn, "dossier_version", vid, "status", msg, before_row=v)
        conn.commit()
        return {"ok": True, "current_version_id": cur}
    finally:
        conn.close()


@router.patch("/{dossier_id}", dependencies=_jwt)
def patch_dossier(dossier_id: str, body: dict = Body(...)):
    conn = get_production()
    try:
        d = _dossier(conn, dossier_id)
        sets, args = [], []
        if "title" in body:
            title = re.sub(r"\s+", " ", str(body["title"] or "")).strip()
            if not title:
                raise HTTPException(400, "пустое название")
            # Уникальность названия держится на python-сравнении (_key): COLLATE NOCASE
            # у ux_dossiers_order_title кириллицу не складывает. Поэтому проверка и
            # UPDATE — под одной блокировкой, как в publish, иначе два переименования
            # разойдутся в «Стол Волна» и «стол волна».
            conn.execute("BEGIN IMMEDIATE")
            for r in conn.execute("SELECT id, title FROM dossiers WHERE order_id = ? AND id != ?",
                                  (d["order_id"], d["id"])):
                if _key(r["title"]) == _key(title):
                    raise HTTPException(409, f"В заказе уже есть «{r['title']}»")
            sets.append("title = ?"); args.append(title)
        if "estimate_item_id" in body:
            eid = body["estimate_item_id"] or None
            if eid:
                r = conn.execute("SELECT s.order_id FROM estimate_items i JOIN estimate_sets s ON s.id = i.set_id "
                                 "WHERE i.id = ?", (eid,)).fetchone()
                if not r or r["order_id"] != d["order_id"]:
                    raise HTTPException(400, "позиция сметы не из этого заказа")
            sets.append("estimate_item_id = ?"); args.append(eid)
        if "catalog_item_id" in body:
            cid = body["catalog_item_id"] or None
            if cid and not conn.execute("SELECT 1 FROM catalog_items WHERE id = ?", (cid,)).fetchone():
                raise HTTPException(400, "карточка каталога не найдена")
            sets.append("catalog_item_id = ?"); args.append(cid)
        if not sets:
            raise HTTPException(400, "нечего менять: title | estimate_item_id | catalog_item_id")
        conn.execute(f"UPDATE dossiers SET {', '.join(sets)}, updated_at = datetime('now') WHERE id = ?",
                     (*args, d["id"]))
        audit(conn, "dossier", d["id"], "update", f"{d['title']}: правка комплекта", before_row=d)
        conn.commit()
        return dict(conn.execute("SELECT * FROM dossiers WHERE id = ?", (d["id"],)).fetchone())
    finally:
        if conn.in_transaction:
            conn.rollback()   # 409/400 после BEGIN IMMEDIATE не держат запись блокировкой
        conn.close()


# ─── просчёт фином и каталог ──────────────────────────────────────────────────

def costing_text(order: dict, title: str, number: int, version_id: str, note: Optional[str]) -> str:
    """Текст поручения фину — тот же, что у dossier.py (ТЗ п. 5.4)."""
    num = order.get("number") or order["id"]
    return (f"Просчитать «{title}» v{number} заказа {order.get('title') or '—'} ({num}).\n"
            f"Ведомость: python3 /opt/ai-os/tools/dossier.py show {num} \"{title}\" --version {number} --bom\n"
            f"Чертежи:   python3 /opt/ai-os/tools/dossier.py get {num} \"{title}\" --version {number} -o /tmp/dossier\n"
            f"Замечание конструктора: {note or '—'}\n"
            f"По готовности: python3 /opt/ai-os/tools/dossier.py costing-done {version_id} --set <estimate_set_id>\n"
            f"Ведомость читать только с сервера, прозу не ждать.")


@router.post("/versions/{vid}/request-costing", dependencies=_jwt)
def request_costing(vid: str, body: dict = Body(default={})):
    conn = get_production()
    try:
        v = _version(conn, vid)
        if v["status"] != "active":
            raise HTTPException(409, "версия отозвана — на просчёт не отправляется")
        d = _dossier(conn, v["dossier_id"])
        o = _order_of(conn, d["order_id"])
        note = (body or {}).get("note") or v["note"]
        text = costing_text(o, d["title"], v["number"], vid, note)
        try:
            r = subprocess.run(["python3", AGENT_MSG, "send", "--from", "firma", "--to", "fin", "--mode", "smart",
                                "--type", "task", "--text", text], capture_output=True, text=True, timeout=30)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"agent_msg.py не запустился: {e}")
        if r.returncode != 0:
            raise HTTPException(502, f"agent_msg.py: {(r.stderr or r.stdout).strip()[:300]}")
        conn.execute("UPDATE dossier_versions SET costing_status = 'requested', costing_requested_at = datetime('now') "
                     "WHERE id = ?", (vid,))
        msg = f"{d['title']} v{v['number']}: отправлен на просчёт фину"
        audit(conn, "dossier_version", vid, "status", msg, before_row=v)
        conn.commit()
        return {"ok": True, "costing_status": "requested", "sent": (r.stdout or "").strip()[:300]}
    finally:
        conn.close()


@router.post("/versions/{vid}/costing-done", dependencies=_jwt)
def costing_done(vid: str, body: dict = Body(...)):
    conn = get_production()
    try:
        v = _version(conn, vid)
        d = _dossier(conn, v["dossier_id"])
        sid = body.get("estimate_set_id")
        s = conn.execute("SELECT order_id FROM estimate_sets WHERE id = ?", (sid or "",)).fetchone()
        if not s:
            raise HTTPException(404, "смета не найдена")
        if s["order_id"] != d["order_id"]:
            raise HTTPException(400, "смета другого заказа")
        conn.execute("UPDATE dossier_versions SET costing_status = 'done', estimate_set_id = ? WHERE id = ?",
                     (sid, vid))
        msg = f"{d['title']} v{v['number']}: просчитан"
        audit(conn, "dossier_version", vid, "status", msg, before_row=v)
        conn.commit()
        return {"ok": True, "costing_status": "done", "estimate_set_id": sid}
    finally:
        conn.close()


@router.post("/versions/{vid}/to-catalog", dependencies=_jwt)
def to_catalog(vid: str, body: dict = Body(default={})):
    from routers.catalog import BomIn, import_bom
    mode = (body or {}).get("mode") or "upsert"
    if mode not in ("upsert", "create"):
        raise HTTPException(400, "mode: upsert | create")
    conn = get_production()
    try:
        v = _version(conn, vid)
        d = _dossier(conn, v["dossier_id"])
    finally:
        conn.close()
    if not v["bom_json"]:
        raise HTTPException(400, "в версии нет ведомости")
    bom = json.loads(v["bom_json"])
    product = dict(bom.get("product") or {})
    product["title"] = d["title"]
    if d["catalog_item_id"]:
        product["catalog_item_id"] = d["catalog_item_id"]
    res = import_bom(BomIn(source="blender", version=v["number"], product=product, mode=mode,
                           lines=bom.get("lines") or []))
    cid = (res or {}).get("catalog_item_id")
    if cid and not d["catalog_item_id"]:
        conn = get_production()
        try:
            conn.execute("UPDATE dossiers SET catalog_item_id = ?, updated_at = datetime('now') WHERE id = ?",
                         (cid, d["id"]))
            audit(conn, "dossier", d["id"], "link", f"{d['title']}: карточка каталога", before_row=d)
            conn.commit()
        finally:
            conn.close()
    return res
