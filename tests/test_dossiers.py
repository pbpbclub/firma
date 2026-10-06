"""Комплекты конструктора (ТЗ YOS 06.10.2026): версии, указатель, дедуп файлов."""
import importlib
import io
import json
import os

import pytest
from fastapi import HTTPException, UploadFile


@pytest.fixture
def dz(migrated, tmp_path, monkeypatch):
    from routers import dossiers
    mod = importlib.reload(dossiers)
    monkeypatch.setattr(mod, "DOSSIER_ROOT", tmp_path / "dossier")
    migrated.execute("INSERT INTO orders (id, number, title, status) VALUES ('o1', 'ORD-061', 'Стол-волна', 'draft')")
    migrated.execute("INSERT INTO order_project_dirs (dir, order_id) VALUES ('стол_волна', 'o1')")
    migrated.commit()
    return mod


def _f(name, data: bytes):
    return UploadFile(file=io.BytesIO(data), filename=name)


def pub(mod, files, **meta):
    meta.setdefault("item", "Стол волна")
    r = mod.publish(meta=json.dumps(meta, ensure_ascii=False), files=files)
    return r.status_code, json.loads(r.body)


def test_versions_pointer_dedup(dz, migrated):
    s, r = pub(dz, [_f("сборка.pdf", b"A"), _f("bom.md", b"B")], project_dir="стол_волна",
               bom={"lines": [{"type": "material", "title": "фанера", "qty": 2}]}, ext_key="k1")
    assert s == 201 and r["number"] == 1 and r["is_current"] and r["created_dossier"]
    assert r["order"]["number"] == "ORD-061" and r["files"] == 2
    # тот же ext_key — та же версия, ничего не пишется
    s, r2 = pub(dz, [_f("x.pdf", b"Z")], order="ORD-061", ext_key="k1")
    assert s == 200 and r2["replayed"] and r2["version_id"] == r["version_id"]
    # ничего не изменилось
    s, r3 = pub(dz, [_f("bom.md", b"B"), _f("сборка.pdf", b"A")], order="ORD-061",
                bom={"lines": [{"qty": 2, "title": "фанера", "type": "material"}]})
    assert s == 409 and r3["code"] == "unchanged"
    # похожее название — 409, с new_item — новый комплект
    s, r4 = pub(dz, [_f("a.pdf", b"A")], order="ORD-061", item="Стол волны")
    assert s == 409 and r4["code"] == "similar_item" and r4["similar"] == ["Стол волна"]
    # v2: один файл тот же — жёсткая ссылка
    s, r5 = pub(dz, [_f("сборка.pdf", b"A"), _f("узел.dxf", b"C")], order="Стол-волна", item="стол  ВОЛНА")
    assert s == 201 and r5["number"] == 2 and r5["is_current"] and not r5["created_dossier"]
    paths = [x[0] for x in migrated.execute("SELECT path FROM dossier_files WHERE filename='сборка.pdf'")]
    assert len(paths) == 2 and os.stat(paths[0]).st_ino == os.stat(paths[1]).st_ino
    assert paths[1].endswith("ORD-061/stol-volna/v02/сборка.pdf") or paths[0].endswith("v02/сборка.pdf")
    did = r["dossier_id"]
    # закрепили v1 — v3 уходит в историю
    dz.pin(did, {"version_id": r["version_id"]})
    s, r6 = pub(dz, [_f("сборка.pdf", b"D")], order="ORD-061")
    assert s == 201 and not r6["is_current"] and r6["warnings"]
    with pytest.raises(HTTPException) as e:
        dz.withdraw(r["version_id"], {"note": "x"})
    assert e.value.status_code == 409
    dz.unpin(did)
    d = dz.get_dossier(did, all=0)
    assert d["current_version_id"] == r6["version_id"] and d["pinned"] == 0
    # отозвали текущую v3 — указатель на v2
    dz.withdraw(r6["version_id"], {"note": "ошибка"})
    d = dz.get_dossier(did, all=0)
    assert d["current_version_id"] == r5["version_id"] and len(d["versions"]) == 2
    assert len(dz.get_dossier(did, all=1)["versions"]) == 3
    lst = dz.list_order_dossiers("ORD-061")
    assert lst[0]["current"]["number"] == 2 and lst[0]["versions_total"] == 3 and lst[0]["withdrawn_total"] == 1
    assert dz.get_version(r["version_id"])["bom_json"]["lines"][0]["title"] == "фанера"
    assert dz.dossiers_summary(migrated, "o1").startswith("Стол волна v2 · ")


def test_rejects_bad_input_and_cleans_up(dz, tmp_path):
    with pytest.raises(HTTPException) as e:
        pub(dz, [_f("a.exe", b"A")], order="ORD-061")
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        pub(dz, [_f("a.pdf", b"A"), _f("A.PDF", b"B")], order="ORD-061")
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        pub(dz, [_f("a.pdf", b"A")], order="ORD-999")
    assert e.value.status_code == 400
    incoming = tmp_path / "dossier" / ".incoming"
    assert not incoming.exists() or not any(incoming.iterdir())


def test_slug_and_filename():
    from routers.dossiers import safe_filename, slugify
    assert slugify("Стол волна") == "stol-volna"
    assert safe_filename("../../.ssh/key.pdf") == "key.pdf"
    assert safe_filename("..hidden.pdf") == "hidden.pdf"
