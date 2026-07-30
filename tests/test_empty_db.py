"""Развёртывание с нуля: пустая production.db переживает startup и первый INSERT.

На боевой базе дефекты схемы не видны — недостающие колонки давно доехали
ALTER-ами. Выстреливают они при восстановлении из бэкапа или развёртывании
с нуля: ленивый `CREATE TABLE IF NOT EXISTS` в роутере создаёт таблицу по
старой схеме, а INSERT перечисляет колонки из миграции; миграция же на
отсутствующей таблице падает `no such table` прямо в startup.

Боевую базу тест не открывает вообще: работает во временном файле.
"""
import re
import sqlite3
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent / "backend"
MAIN = BACKEND / "main.py"


def _startup_migrations() -> list[str]:
    """Список миграций читаем из main.py::startup, а не дублируем в тесте:
    новая миграция попадает под проверку сама, без правки этого файла."""
    body = MAIN.read_text().split("def startup():", 1)[1]
    return [n for n in re.findall(r"^\s{4}(\w+)\(\)", body, re.M) if n != "init_admin"]


@pytest.fixture
def empty_db(tmp_path, monkeypatch):
    """Пустые файлы БД (ни одной таблицы) вместо боевых.

    finance.db подменяем тоже: ensure_receivable_tx_link_schema ходит в неё, а
    открывать чужую боевую базу на запись из теста нельзя."""
    import db
    prod, fin = tmp_path / "production.db", tmp_path / "finance.db"
    for p in (prod, fin):
        sqlite3.connect(p).close()
    monkeypatch.setattr(db, "PRODUCTION_DB", prod)
    monkeypatch.setattr(db, "FINANCE_DB", fin)
    return prod


def test_startup_migrations_survive_empty_db(empty_db):
    import db
    names = _startup_migrations()
    assert names, "не разобрал список миграций из main.py::startup"
    for name in names:
        getattr(db, name)()   # падение здесь = приложение не поднимется с нуля


def test_first_catalog_item_with_costing_links(empty_db):
    """Первая карточка с рецептурой: колонки costing и brand должны быть
    в ленивом CREATE TABLE, иначе INSERT ловит `no such column`."""
    import db
    from routers.catalog import ItemIn, LineIn, create_item

    for name in _startup_migrations():
        getattr(db, name)()

    item = create_item(ItemIn(
        title="Стол «Проверка»",
        brand="PBPB",
        lines=[
            LineIn(type="material", title="Фанера 18", qty=2, unit="лист", unit_price=3000,
                   material_code="PLY18", sort_order=0),
            LineIn(type="labor", title="Сборка", qty=1, unit="шт", unit_price=5000,
                   work_type_id="wt-1", master_id="m-1", sort_order=1),
        ],
    ))
    assert item["brand"] == "PBPB"
    assert [l["material_code"] for l in item["lines"]] == ["PLY18", None]
    assert item["lines"][1]["work_type_id"] == "wt-1"
    assert item["lines"][1]["master_id"] == "m-1"

    # Миграция идемпотентна и после того, как таблицу создал роутер
    db.ensure_catalog_lines_costing_schema()


def test_second_startup_after_router_created_tables(empty_db):
    """Второй старт на развёрнутой с нуля базе.

    Первый старт проходит вхолостую (таблиц нет), таблицы создаёт роутер — и
    только СЛЕДУЮЩИЙ рестарт натыкается на них: ensure_catalog_material_fk
    пересоздавала catalog_item_lines позиционным `SELECT *` и падала
    «10 columns but 13 values», унося сервис в рестарт-луп. Данные при этом
    обязаны пережить любое пересоздание."""
    import db
    from routers.catalog import ItemIn, LineIn, create_item

    names = _startup_migrations()
    for name in names:
        getattr(db, name)()
    create_item(ItemIn(title="Стол «Рестарт»", lines=[
        LineIn(type="labor", title="Сборка", qty=1, unit="шт", unit_price=5000,
               material_code="PLY18", work_type_id="wt-1", master_id="m-1"),
    ]))

    for name in names:
        getattr(db, name)()   # падение здесь = сервис не переживает рестарт

    # ... и после рестарта карточки продолжают заводиться: миграция не должна
    # оставить за собой FK на materials, которой на чистой базе ещё нет.
    create_item(ItemIn(title="Стол «После рестарта»", lines=[
        LineIn(type="material", title="Фанера", qty=1, unit="лист", unit_price=3000),
    ]))

    conn = db.get_production()
    try:
        row = conn.execute(
            "SELECT title, material_code, work_type_id, master_id FROM catalog_item_lines"
            " WHERE title = 'Сборка'"
        ).fetchone()
    finally:
        conn.close()
    assert row["title"] == "Сборка"
    assert (row["material_code"], row["work_type_id"], row["master_id"]) == ("PLY18", "wt-1", "m-1")


def test_material_fk_rebuild_keeps_costing_columns(empty_db):
    """Пересоздание catalog_item_lines ради FK не должно терять привязки costing.

    Сценарий догоняющий: базу развернули с нуля (таблицу создал роутер, без FK),
    потом production-агент завёл materials — и на следующем старте миграция
    впервые реально пересоздаёт таблицу. Копия по именам обязана донести
    material_code/work_type_id/master_id, позиционная — теряет их и падает."""
    import db
    from routers.catalog import ItemIn, LineIn, create_item

    names = _startup_migrations()
    for name in names:
        getattr(db, name)()
    create_item(ItemIn(title="Стол «FK»", lines=[
        LineIn(type="labor", title="Сборка", qty=1, unit="шт", unit_price=5000,
               material_code="PLY18", work_type_id="wt-1", master_id="m-1"),
    ]))

    conn = db.get_production()
    try:
        conn.execute("CREATE TABLE materials (id TEXT PRIMARY KEY, title TEXT)")
        conn.commit()
    finally:
        conn.close()

    for name in names:
        getattr(db, name)()

    conn = db.get_production()
    try:
        schema = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name='catalog_item_lines'").fetchone()[0]
        row = conn.execute(
            "SELECT title, material_code, work_type_id, master_id FROM catalog_item_lines"
        ).fetchone()
    finally:
        conn.close()
    assert "REFERENCES materials" in schema, "FK так и не навесился"
    assert row["title"] == "Сборка"
    assert (row["material_code"], row["work_type_id"], row["master_id"]) == ("PLY18", "wt-1", "m-1")


def test_material_fk_rebuild_from_legacy_narrow_table(empty_db):
    """Восстановление из старого бэкапа: таблица узкая (10 колонок, без costing).

    Позиционный `SELECT *` тут падает с другой стороны — «13 columns but 10 values»:
    целевая схема шире исходной. Недостающие колонки должны просто остаться пустыми,
    а строки — доехать."""
    import db

    conn = db.get_production()
    try:
        conn.executescript("""
            CREATE TABLE materials (id TEXT PRIMARY KEY, title TEXT);
            CREATE TABLE catalog_items (id TEXT PRIMARY KEY, title TEXT);
            CREATE TABLE catalog_item_lines (
                id          TEXT PRIMARY KEY,
                item_id     TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
                type        TEXT NOT NULL,
                title       TEXT NOT NULL,
                qty         REAL DEFAULT 1,
                unit        TEXT DEFAULT 'шт',
                unit_price  REAL DEFAULT 0,
                line_total  REAL DEFAULT 0,
                material_id TEXT,
                sort_order  INTEGER DEFAULT 0
            );
            INSERT INTO catalog_items (id, title) VALUES ('it-1', 'Старый стол');
            INSERT INTO catalog_item_lines (id, item_id, type, title, qty, unit_price)
            VALUES ('l-1', 'it-1', 'labor', 'Сборка', 2, 1500);
        """)
        conn.commit()
    finally:
        conn.close()

    db.ensure_catalog_material_fk()
    db.ensure_catalog_lines_costing_schema()

    conn = db.get_production()
    try:
        schema = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name='catalog_item_lines'").fetchone()[0]
        row = conn.execute("SELECT * FROM catalog_item_lines").fetchone()
    finally:
        conn.close()
    assert "REFERENCES materials" in schema
    assert (row["title"], row["qty"], row["unit_price"]) == ("Сборка", 2, 1500)
    assert row["material_code"] is None
