#!/usr/bin/env python3
"""Полный пересинк ZenMoney — чтобы история разделилась по валютам (22.09.2026).

Зачем. Три счёта Bank of Georgia называются в ZenMoney одинаково, а
`zm_transactions` хранит ногу НАЗВАНИЕМ счёта: в 2227 строках валюту не
определить. Переименование счетов в приложении лечит только будущие строки —
старые останутся со старым названием, потому что синк фин-агента забирает
только изменившиеся транзакции. Полный проход (`server_ts=0`) перезапишет
названия во ВСЕЙ истории: id транзакций стабильны, поэтому наши ссылки
(`expenses.zenmoney_tx_id`, разноска, обязательства) не пострадают.

🔒 Это единственная запись в чужую базу, и она разрешена Юрой точечно
(решение 22.09.2026). Правило «чужие базы — только чтение» в остальном в силе:
- меняем ровно одно поле `zm_meta.server_ts`, сам импорт делает их скрипт
  (`/opt/fin-agent/tools/zenmoney.py sync` — тот же, что дёргает кнопка
  «Синхронизировать» в интерфейсе);
- перед записью кладём копию базы рядом (родной `backup()`, а не копия файла:
  база в WAL, и `shutil.copy2` дал бы снимок без последних коммитов);
- отказываемся работать, если счета ещё не переименованы: пересинк тогда
  ничего не изменит, а полный проход по API незачем гонять впустую.

    python3 scripts/resync_zenmoney.py            # только проверка
    python3 scripts/resync_zenmoney.py --apply    # пересинк
"""
import sqlite3
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ZEN = Path("/opt/fin-agent/data/zenmoney.db")
SYNC = "/opt/fin-agent/tools/zenmoney.py"


def snapshot(conn) -> dict:
    titles = Counter(r[0] for r in conn.execute("SELECT title FROM zm_accounts"))
    return {
        "accounts": dict(titles),
        "n_accounts": sum(titles.values()),
        "dupes": {t: n for t, n in titles.items() if n > 1},
        "tx": conn.execute("SELECT COUNT(*) FROM zm_transactions").fetchone()[0],
        "by_leg": dict(Counter(
            r[0] for r in conn.execute(
                "SELECT outcome_account FROM zm_transactions WHERE outcome_account IS NOT NULL"))),
    }


def main() -> int:
    apply = "--apply" in sys.argv
    # WAL: читаем обычным mode=ro, БЕЗ immutable — иначе видно вчерашний снимок.
    conn = sqlite3.connect(f"file:{ZEN}?mode=ro", uri=True, timeout=15)
    try:
        before = snapshot(conn)
    finally:
        conn.close()

    print(f"Счетов: {before['n_accounts']} ({len(before['accounts'])} названий), "
          f"транзакций: {before['tx']}")
    if before["dupes"]:
        for title, n in before["dupes"].items():
            print(f"  ⚠ «{title}» — {n} счёта под одним названием, "
                  f"{before['by_leg'].get(title, 0)} строк на этом названии")
        print("\nСчета ещё не переименованы в ZenMoney. Пересинк ничего не изменит:")
        print("переименуй «Universal Account» в «Сола ₾ / Сола $ / Сола €» и запусти снова.")
        return 1

    print("Дублей названий нет — пересинк перепишет историю корректно.")
    if not apply:
        print("\nЭто проверка. Запусти с --apply, чтобы выполнить пересинк.")
        return 0

    backup = ZEN.with_name(f"zenmoney.before-resync-{datetime.now():%Y%m%d-%H%M}.db")
    # 🔒 База в WAL: часть коммитов живёт в `-wal`, и копирование одного файла
    # (shutil.copy2) даёт снимок без последних транзакций — страховку, которая
    # не восстановит. Копия делается родным backup() — он забирает и WAL.
    src = sqlite3.connect(f"file:{ZEN}?mode=ro", uri=True, timeout=15)
    dst = sqlite3.connect(backup)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    print(f"Копия: {backup}")

    w = sqlite3.connect(ZEN, timeout=30)
    try:
        w.execute("INSERT OR REPLACE INTO zm_meta (key, value) VALUES ('server_ts', '0')")
        w.commit()
    finally:
        w.close()
    print("Метка синхронизации сброшена, запускаю импорт фин-агента…")

    res = subprocess.run(["python3", SYNC, "sync"], capture_output=True, text=True, timeout=900)
    print(res.stdout.strip() or res.stderr.strip())
    if res.returncode != 0:
        print(f"\n✗ Импорт упал. База цела, копия рядом: {backup}")
        return 2

    conn = sqlite3.connect(f"file:{ZEN}?mode=ro", uri=True, timeout=15)
    try:
        after = snapshot(conn)
    finally:
        conn.close()

    print(f"\nТранзакций: {before['tx']} → {after['tx']}")
    if after["tx"] < before["tx"]:
        print(f"⚠ Строк стало МЕНЬШЕ. Копия: {backup}")
        return 2
    moved = {t: n for t, n in after["by_leg"].items() if t not in before["by_leg"]}
    if moved:
        print("Строки переехали на новые названия счетов:")
        for t, n in sorted(moved.items(), key=lambda kv: -kv[1]):
            print(f"  {n:5d}  {t}")
    left = {t: n for t, n in after["by_leg"].items() if t in before["dupes"]}
    print("Старых неоднозначных названий не осталось." if not left else f"⚠ Осталось: {left}")
    print("\nДальше: назначить валюты счетам (раздел «Грузия» → реестр) — и лента с "
          "аналитикой разделится по ₾ / $ / € сама.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
