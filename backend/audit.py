"""Журнал изменений через веб (A1, спека ЛЕСКОВО 04.08.2026).

Одна обёртка на весь бэкенд — иначе половина эндпоинтов журнал забудет.
НЕ коммитит: запись уходит в транзакцию вызывающего и откатывается вместе
с ней — журнал не может разойтись с данными.

Актора кладёт auth.get_current_user в contextvar на каждом запросе; фоновые
вызовы без запроса (миграции, скрипты) пишутся как 'system'. Журнал агентов
(tools/audit.py, отдельная база) этим не заменяется: он про их действия,
этот — про правки людей через веб.
"""
import json
import uuid
from contextvars import ContextVar

current_actor: ContextVar[str] = ContextVar("current_actor", default="system")


def audit(conn, entity_type: str, entity_id, action: str, summary: str,
          before_row=None) -> None:
    """Записать событие в audit_log на переданном соединении.

    action: create | update | delete | status | link | unlink | approve.
    before_row — sqlite3.Row или dict строки ДО изменения (полный снимок, не
    diff: проще код, надёжнее восстановление); для create — None.
    """
    changes = None
    if before_row is not None:
        changes = json.dumps(dict(before_row), ensure_ascii=False, default=str)
    conn.execute(
        """INSERT INTO audit_log (id, actor, entity_type, entity_id, action, summary, changes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
        (str(uuid.uuid4()), current_actor.get(), entity_type,
         str(entity_id) if entity_id is not None else None, action, summary, changes),
    )
