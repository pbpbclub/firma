// Хлебные крошки — единая навигация «где я и как выйти» (решение Юры 24.07.2026).
// Живут в топбарах экранов с реальной вложенностью (карточка заказа, редактор
// сметы, режимы-табы списка заказов) — общей шапки в Layout нет намеренно.
// Не-последние уровни кликабельны (to → navigate, либо onClick для стейт-режимов),
// последний — текущее место, некликабелен.
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { CaretRight } from "@phosphor-icons/react";

export type Crumb = { label: string; to?: string; onClick?: () => void };

export function Breadcrumbs({ items, tail }: { items: Crumb[]; tail?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            {i > 0 && <CaretRight size={11} style={{ color: "#C8C0B0", flexShrink: 0 }} />}
            {last ? (
              <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.label}
              </span>
            ) : (
              <button type="button"
                onClick={() => (c.onClick ? c.onClick() : c.to && navigate(c.to))}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 12, color: "#A89070", fontFamily: "inherit", whiteSpace: "nowrap" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
                onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
              >
                {c.label}
              </button>
            )}
          </span>
        );
      })}
      {tail && <span style={{ flexShrink: 0 }}>{tail}</span>}
    </div>
  );
}
