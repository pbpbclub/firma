import { MONO } from "./Num";

// Таблица-список (используется в P1: Orders/Finance/ZenMoney/Debtors).
// Без карточек-обёрток, прямо на белой поверхности. Hover #FAF8F5, выбран #FFF8F5,
// делитель #F2EFE9. Числа — вправо, tabular-nums. Фильтр-заголовок передаётся
// колонкой через `filter` (готовые ColumnFilter/AmountFilter/PeriodFilter из TableFilters).

export interface Column<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  width?: string;            // часть grid-template (напр. "2fr", "120px")
  filter?: React.ReactNode;  // триггер-заголовок фильтра (опционально)
  render: (row: T) => React.ReactNode;
}

export function DataTable<T>({
  columns, rows, getRowKey, onRowClick,
  selectable, selectedKeys, onToggle,
  emptyText = "Нет данных",
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onToggle?: (key: string) => void;
  emptyText?: string;
}) {
  const template = (selectable ? "28px " : "") + columns.map(c => c.width ?? "1fr").join(" ");
  const labelStyle: React.CSSProperties = { fontSize: 11, color: "#A89070", letterSpacing: "0.06em", textTransform: "uppercase" };

  return (
    <div>
      {/* header */}
      <div style={{ display: "grid", gridTemplateColumns: template, gap: 12, padding: "8px 16px", borderBottom: "1px solid #EDEBE6" }}>
        {selectable && <div />}
        {columns.map(c => (
          <div key={c.key} style={{ ...labelStyle, textAlign: c.align ?? "left" }}>
            {c.filter ?? c.label}
          </div>
        ))}
      </div>

      {/* rows */}
      {rows.length === 0 ? (
        <div style={{ padding: "28px 16px", textAlign: "center", color: "#C8C0B0", fontSize: 12 }}>{emptyText}</div>
      ) : (
        rows.map(row => {
          const key = getRowKey(row);
          const selected = !!selectedKeys?.has(key);
          return (
            <div
              key={key}
              onClick={() => onRowClick?.(row)}
              style={{
                display: "grid", gridTemplateColumns: template, gap: 12, padding: "10px 16px",
                borderBottom: "1px solid #F2EFE9", alignItems: "center",
                cursor: onRowClick ? "pointer" : "default",
                background: selected ? "#FFF8F5" : "transparent",
              }}
              onMouseEnter={e => { if (!selected) e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={e => { if (!selected) e.currentTarget.style.background = "transparent"; }}
            >
              {selectable && (
                <div onClick={e => { e.stopPropagation(); onToggle?.(key); }} style={{ cursor: "pointer" }}>
                  <div style={{
                    width: 14, height: 14, border: `1.5px solid ${selected ? "#E8592A" : "#D0C8C0"}`,
                    background: selected ? "#E8592A" : "transparent", display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {selected && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3L3 5.5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  </div>
                </div>
              )}
              {columns.map(c => (
                <div key={c.key} style={{ textAlign: c.align ?? "left", fontFamily: c.align === "right" ? MONO : undefined, fontVariantNumeric: c.align === "right" ? "tabular-nums" : undefined, minWidth: 0 }}>
                  {c.render(row)}
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
