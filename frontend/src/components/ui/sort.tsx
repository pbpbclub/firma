/**
 * Сортировка колонок таблицы. До этого её не было нигде в системе — порядок
 * жёстко задавал бэк (заказы: новые сверху).
 *
 * Клик по заголовку занят фильтром (ColumnFilter/AmountFilter открывают поповер),
 * поэтому сортировка — отдельная стрелка рядом с label: пусто → ↓ (по убыванию,
 * для денег это «сначала крупное») → ↑ → снова порядок бэка.
 */
import { useState } from "react";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir } | null;

export function useTableSort(onSortChange?: () => void) {
  const [sort, setSort] = useState<SortState>(null);
  const toggle = (key: string) => {
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null; // третий клик — обратно к порядку бэка
    });
    onSortChange?.();
  };
  /** Отсортировать строки по геттерам колонок; sort=null — вернуть как есть. */
  const apply = <T,>(rows: T[], getters: Record<string, (r: T) => any>): T[] => {
    if (!sort || !getters[sort.key]) return rows;
    const get = getters[sort.key];
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a), vb = get(b);
      // null/undefined всегда в конце, независимо от направления
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
      return String(va).localeCompare(String(vb), "ru") * mul;
    });
  };
  return { sort, toggle, apply };
}

/** Стрелка сортировки рядом с заголовком колонки. */
export function SortMark({ colKey, sort, onToggle }: {
  colKey: string;
  sort: SortState;
  onToggle: (key: string) => void;
}) {
  const active = sort?.key === colKey ? sort.dir : null;
  const Icon = active === "asc" ? ArrowUp : ArrowDown;
  return (
    <button type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(colKey); }}
      title={active === null ? "Сортировать" : active === "desc" ? "По убыванию — нажми для «по возрастанию»" : "По возрастанию — нажми для сброса"}
      style={{ background: "none", border: "none", cursor: "pointer", padding: "0 0 0 3px",
               display: "inline-flex", alignItems: "center",
               color: active ? "#E8592A" : "#D8D2C6" }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = "#A89070"; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = "#D8D2C6"; }}
    >
      <Icon size={10} weight="bold" />
    </button>
  );
}

/** Заголовок без фильтра, но с сортировкой (СЕБ. ПЛАН, Δ). */
export function SortHeader({ label, colKey, sort, onToggle, align, title }: {
  label: string;
  colKey: string;
  sort: SortState;
  onToggle: (key: string) => void;
  align?: "left" | "right";
  title?: string;
}) {
  return (
    <span title={title} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em",
      display: "inline-flex", alignItems: "center", justifyContent: align === "right" ? "flex-end" : "flex-start", width: "100%" }}>
      {label}
      <SortMark colKey={colKey} sort={sort} onToggle={onToggle} />
    </span>
  );
}
