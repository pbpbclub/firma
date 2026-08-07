"""Медиатека изделий — картинки в КП, чертежи в спецификацию (спека Юры 07.08.2026).

Единственная точка входа для агентов (блендер-конструктор, вендор, фин-агент):
прямой записи в таблицу `media` в обход этого роутера быть не должно — здесь
живут ресайз, раскладка файлов по диску и правило «главный в роли один».

Роли: studio/photo/viz/render идут наружу (КП — в этом порядке), draft/ref
только внутрь. Привязка ровно одна: карточка каталога (базовая картинка) либо
позиция сметы (переопределение для конкретного заказа) — см. db.ensure_media_schema.
"""
from fastapi import APIRouter, Depends, File, Form, HTTPException, Header, Query, UploadFile
from fastapi.responses import FileResponse
from typing import Optional
from pathlib import Path
from datetime import datetime
import io
import sqlite3
import uuid

from jose import JWTError, jwt
from PIL import Image, UnidentifiedImageError

from auth import ALGORITHM, SECRET_KEY, get_current_user
from db import MEDIA_KINDS, MEDIA_ROOT, get_production

router = APIRouter()

# Порядок подстановки в документ. КП — заказчику, спецификация — мастеру:
# интерьерные визуализации в спецификации мешают читать размеры (спека).
KIND_ORDER = {
    "kp": ("studio", "photo", "viz", "render"),
    "spec": ("draft", "render"),
}

MAX_SIDE = 2000      # длинная сторона оригинала после приёма
THUMB_SIDE = 400     # длинная сторона превью
MAX_UPLOAD = 40 * 1024 * 1024

# Формат храним как есть только для тех, что браузер покажет без плясок;
# всё прочее (tiff, bmp, heic-через-плагин) укладываем в JPEG.
KEEP_FORMATS = {"JPEG": ("jpg", "image/jpeg"), "PNG": ("png", "image/png"), "WEBP": ("webp", "image/webp")}


def _row(r) -> dict:
    d = dict(r)
    d["url"] = f"/api/media/{d['id']}/file"
    d["thumb_url"] = f"/api/media/{d['id']}/thumb" if d.get("thumb_path") else d["url"]
    return d


def _binding(catalog_item_id: Optional[str], estimate_item_id: Optional[str]):
    """Ровно одна привязка — иначе непонятно, чья это картинка."""
    cat = (catalog_item_id or "").strip() or None
    est = (estimate_item_id or "").strip() or None
    if bool(cat) == bool(est):
        raise HTTPException(status_code=400, detail="нужна ровно одна привязка: catalog_item_id либо estimate_item_id")
    return cat, est


def _check_kind(kind: str) -> str:
    kind = (kind or "").strip().lower()
    if kind not in MEDIA_KINDS:
        raise HTTPException(status_code=400, detail=f"kind должен быть одним из {', '.join(MEDIA_KINDS)}")
    return kind


def _order_of_estimate_item(conn, estimate_item_id: str) -> Optional[str]:
    row = conn.execute("""
        SELECT s.order_id FROM estimate_items i
        JOIN estimate_sets s ON s.id = i.set_id
        WHERE i.id = ?
    """, (estimate_item_id,)).fetchone()
    return row["order_id"] if row else None


def _clear_primary(conn, cat: Optional[str], est: Optional[str], kind: str, keep_id: Optional[str] = None):
    """Снять «главного» с остальных файлов роли — до вставки нового.

    Частичный уникальный индекс не даст двум главным ужиться, поэтому чистим
    руками в той же транзакции, а не полагаемся на UPSERT."""
    if cat:
        conn.execute(
            "UPDATE media SET is_primary = 0 WHERE catalog_item_id = ? AND kind = ? AND is_primary = 1 AND id IS NOT ?",
            (cat, kind, keep_id))
    else:
        conn.execute(
            "UPDATE media SET is_primary = 0 WHERE estimate_item_id = ? AND kind = ? AND is_primary = 1 AND id IS NOT ?",
            (est, kind, keep_id))


def _has_primary(conn, cat: Optional[str], est: Optional[str], kind: str) -> bool:
    if cat:
        q = "SELECT 1 FROM media WHERE catalog_item_id = ? AND kind = ? AND is_primary = 1"
        key = cat
    else:
        q = "SELECT 1 FROM media WHERE estimate_item_id = ? AND kind = ? AND is_primary = 1"
        key = est
    return conn.execute(q, (key, kind)).fetchone() is not None


def _store(raw: bytes, media_id: str) -> dict:
    """Приём файла: оригинал ≤ MAX_SIDE по длинной стороне + превью THUMB_SIDE.

    Пишем ПОСЛЕ распаковки Pillow'ом — то, что не открылось как картинка, в
    медиатеку не попадает (400), и на диске мусора не остаётся."""
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="файл не распознан как изображение")

    fmt = (img.format or "").upper()
    ext, mime = KEEP_FORMATS.get(fmt, ("jpg", "image/jpeg"))
    if ext == "jpg" and img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)

    now = datetime.now()
    folder = MEDIA_ROOT / f"{now:%Y}" / f"{now:%m}"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{media_id}.{ext}"
    save_kw = {"quality": 88, "optimize": True} if ext == "jpg" else {}
    img.save(path, **save_kw)

    thumb = img.copy()
    thumb.thumbnail((THUMB_SIDE, THUMB_SIDE), Image.LANCZOS)
    thumb_path = folder / f"{media_id}_thumb.{ext}"
    thumb.save(thumb_path, **save_kw)

    return {
        "path": str(path), "thumb_path": str(thumb_path), "mime": mime,
        "width": img.width, "height": img.height, "bytes": path.stat().st_size,
    }


def file_auth(token: Optional[str] = Query(None), authorization: Optional[str] = Header(None)):
    """Токен из query — для `<img src>`.

    Браузер не пошлёт Authorization в теге картинки, а раздавать файлы всем
    подряд нельзя: это чертежи и рендеры заказов. Тот же JWT, что и везде."""
    raw = token
    if not raw and authorization and authorization.lower().startswith("bearer "):
        raw = authorization.split(" ", 1)[1]
    if not raw:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        jwt.decode(raw, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


@router.get("", dependencies=[Depends(get_current_user)])
def list_media(
    catalog_item_id: Optional[str] = None,
    estimate_item_id: Optional[str] = None,
    order_id: Optional[str] = None,
    kind: Optional[str] = None,
):
    where, params = [], []
    if catalog_item_id:
        where.append("catalog_item_id = ?"); params.append(catalog_item_id)
    if estimate_item_id:
        where.append("estimate_item_id = ?"); params.append(estimate_item_id)
    if order_id:
        where.append("order_id = ?"); params.append(order_id)
    if kind:
        where.append("kind = ?"); params.append(_check_kind(kind))
    sql = "SELECT * FROM media"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY is_primary DESC, created_at"
    conn = get_production()
    try:
        return [_row(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


@router.get("/pick", dependencies=[Depends(get_current_user)])
def pick(
    purpose: str = Query("kp"),
    estimate_item_id: Optional[str] = None,
    catalog_item_id: Optional[str] = None,
):
    """Картинка для документа: сначала файлы позиции сметы, нет — карточки каталога.

    Порядок ролей задаёт purpose (kp — заказчику, spec — мастеру). Внутри роли
    берётся главный, при отсутствии отметки — самый ранний. Ничего не нашлось —
    `{"media": null}`: КП в этом случае рисуется без колонки с картинкой."""
    order = KIND_ORDER.get(purpose)
    if not order:
        raise HTTPException(status_code=400, detail="purpose: kp либо spec")
    if not estimate_item_id and not catalog_item_id:
        raise HTTPException(status_code=400, detail="нужен estimate_item_id либо catalog_item_id")
    conn = get_production()
    try:
        cat = catalog_item_id
        if estimate_item_id and not cat:
            row = conn.execute("SELECT catalog_item_id FROM estimate_items WHERE id = ?", (estimate_item_id,)).fetchone()
            cat = row["catalog_item_id"] if row else None
        for field, key in (("estimate_item_id", estimate_item_id), ("catalog_item_id", cat)):
            if not key:
                continue
            for kind in order:
                row = conn.execute(
                    f"SELECT * FROM media WHERE {field} = ? AND kind = ? ORDER BY is_primary DESC, created_at LIMIT 1",
                    (key, kind)).fetchone()
                if row:
                    return {"media": _row(row)}
        return {"media": None}
    finally:
        conn.close()


@router.post("", dependencies=[Depends(get_current_user)])
async def upload_media(
    file: UploadFile = File(...),
    kind: str = Form(...),
    catalog_item_id: Optional[str] = Form(None),
    estimate_item_id: Optional[str] = Form(None),
    title: Optional[str] = Form(None),
    ral: Optional[str] = Form(None),
    source: Optional[str] = Form(None),
    note: Optional[str] = Form(None),
    is_primary: Optional[bool] = Form(None),
):
    kind = _check_kind(kind)
    cat, est = _binding(catalog_item_id, estimate_item_id)
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="пустой файл")
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="файл больше 40 МБ")

    media_id = str(uuid.uuid4())
    conn = get_production()
    try:
        target = cat or est
        table = "catalog_items" if cat else "estimate_items"
        if not conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (target,)).fetchone():
            raise HTTPException(status_code=404, detail=f"{table}: {target} не найден")
        order_id = _order_of_estimate_item(conn, est) if est else None

        stored = _store(raw, media_id)
        # Первый файл роли становится главным сам: иначе документ не найдёт ничего.
        primary = 1 if (is_primary or not _has_primary(conn, cat, est, kind)) else 0
        if primary:
            _clear_primary(conn, cat, est, kind)
        try:
            conn.execute("""
                INSERT INTO media (id, kind, path, thumb_path, mime, width, height, bytes,
                                   title, catalog_item_id, estimate_item_id, order_id,
                                   is_primary, ral, source, note, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
            """, (media_id, kind, stored["path"], stored["thumb_path"], stored["mime"],
                  stored["width"], stored["height"], stored["bytes"],
                  (title or "").strip() or None, cat, est, order_id, primary,
                  (ral or "").strip() or None, (source or "").strip() or None,
                  (note or "").strip() or None))
            conn.commit()
        except sqlite3.IntegrityError as e:
            for p in (stored["path"], stored["thumb_path"]):
                Path(p).unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=f"медиатека: {e}")
        return _row(conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone())
    finally:
        conn.close()


@router.patch("/{media_id}", dependencies=[Depends(get_current_user)])
def update_media(media_id: str, body: dict):
    """Роль, подпись, «главный», RAL, примечание — и перепривязка файла.

    Перепривязка (картинку положили не туда) меняет пару полей целиком: снимать
    обе привязки нельзя, поэтому итог прогоняется через ту же проверку `_binding`."""
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="файл не найден")
        cur = dict(row)

        kind = _check_kind(body["kind"]) if "kind" in body else cur["kind"]
        cat, est = cur["catalog_item_id"], cur["estimate_item_id"]
        if "catalog_item_id" in body or "estimate_item_id" in body:
            # Прислали новую привязку — старая снимается целиком, обе разом жить не могут.
            cat, est = _binding(body.get("catalog_item_id"), body.get("estimate_item_id"))
        order_id = _order_of_estimate_item(conn, est) if est else None

        sets = {"kind": kind, "catalog_item_id": cat, "estimate_item_id": est, "order_id": order_id}
        for f in ("title", "ral", "source", "note"):
            if f in body:
                sets[f] = (body[f] or "").strip() or None
        if body.get("is_primary"):
            _clear_primary(conn, cat, est, kind, keep_id=media_id)
            sets["is_primary"] = 1
        elif "is_primary" in body:
            sets["is_primary"] = 0
        elif (kind, cat, est) != (cur["kind"], cur["catalog_item_id"], cur["estimate_item_id"]) and cur["is_primary"]:
            # Переехал в другую роль/привязку — там главный может быть уже занят.
            if _has_primary(conn, cat, est, kind):
                sets["is_primary"] = 0

        cols = ", ".join(f"{k} = ?" for k in sets)
        try:
            conn.execute(f"UPDATE media SET {cols} WHERE id = ?", (*sets.values(), media_id))
            conn.commit()
        except sqlite3.IntegrityError as e:
            raise HTTPException(status_code=400, detail=f"медиатека: {e}")
        return _row(conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/{media_id}", dependencies=[Depends(get_current_user)])
def delete_media(media_id: str):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="файл не найден")
        conn.execute("DELETE FROM media WHERE id = ?", (media_id,))
        conn.commit()
    finally:
        conn.close()
    # Файлы сносим после коммита: осиротевшая запись хуже осиротевшего файла.
    for p in (row["path"], row["thumb_path"]):
        if p:
            Path(p).unlink(missing_ok=True)
    return {"ok": True}


def _serve(media_id: str, thumb: bool):
    conn = get_production()
    try:
        row = conn.execute("SELECT path, thumb_path, mime FROM media WHERE id = ?", (media_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="файл не найден")
    path = Path((row["thumb_path"] if thumb and row["thumb_path"] else row["path"]))
    if not path.exists():
        raise HTTPException(status_code=404, detail="файл потерян на диске")
    return FileResponse(path, media_type=row["mime"] or "application/octet-stream")


@router.get("/{media_id}/file", dependencies=[Depends(file_auth)])
def get_file(media_id: str):
    return _serve(media_id, thumb=False)


@router.get("/{media_id}/thumb", dependencies=[Depends(file_auth)])
def get_thumb(media_id: str):
    return _serve(media_id, thumb=True)
