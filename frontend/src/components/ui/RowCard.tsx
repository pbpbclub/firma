/**
 * Мобильная строка таблицы. Тринадцать таблиц системы — один и тот же грид с
 * фиксированными колонками; на 390px они не помещаются в принципе. Вместо
 * перекладки колонок каждый экран на телефоне рисует строку карточкой:
 * главное слева, деньги справа, статусы и действия ниже.
 *
 * Hover-обработчиков нет намеренно: iOS после тапа оставляет «залипший» hover.
 */
import type { ReactNode } from "react";
import { MONO } from "./Num";

export function RowCard({ title, sub, right, rightSub, badge, meta, actions, trailing, onClick, rail, tint, muted }: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  rightSub?: ReactNode;
  badge?: ReactNode;      // строка пилюль/статусов
  meta?: ReactNode;       // произвольная строка 11px (полоса, «план → факт», подпись)
  actions?: ReactNode;    // кнопки: IconButton ≥36 / Button sm — отдельной строкой
  trailing?: ReactNode;   // одна кнопка справа от суммы, в строке (иначе пустая строка под карточкой)
  onClick?: () => void;
  rail?: string;          // borderLeft 3px (POLARITY.in/out.rail)
  tint?: string;          // фон (выбрана/раскрыта)
  muted?: boolean;
}) {
  return (
    <div onClick={onClick}
      style={{
        padding: "12px 16px", borderBottom: "1px solid #F2EFE9", minHeight: 44,
        display: "grid", gridTemplateColumns: trailing ? "minmax(0, 1fr) auto auto" : "minmax(0, 1fr) auto", columnGap: 12, rowGap: 2,
        alignItems: "start", background: tint ?? "transparent",
        borderLeft: rail ? `3px solid ${rail}` : undefined,
        cursor: onClick ? "pointer" : "default", opacity: muted ? 0.55 : 1,
      }}>
      <div style={{ minWidth: 0, fontSize: 14, fontWeight: 500, color: "#1A1A1A", lineHeight: 1.35,
                    overflow: "hidden", textOverflow: "ellipsis", overflowWrap: "anywhere" }}>{title}</div>
      {right !== undefined && (
        <div style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums", fontSize: 14, fontWeight: 600,
                      color: "#1A1A1A", textAlign: "right", whiteSpace: "nowrap" }}>{right}</div>
      )}
      {trailing && (
        <div onClick={e => e.stopPropagation()}
          style={{ gridColumn: 3, gridRow: "1 / span 2", alignSelf: "center", display: "flex", marginRight: -8 }}>{trailing}</div>
      )}
      {sub && <div style={{ minWidth: 0, fontSize: 11, color: "#A89070", lineHeight: 1.4, gridColumn: right !== undefined ? "1" : "1 / -1", gridRow: 2 }}>{sub}</div>}
      {/* rightSub переносится и ограничен по ширине: nowrap-подпись «Привязано: длинное
          название» растягивала правую колонку и выдавливала левую в ноль. */}
      {rightSub && <div style={{ fontSize: 11, color: "#A89070", textAlign: "right", maxWidth: 180, marginLeft: "auto", lineHeight: 1.35, gridColumn: sub ? "2" : "1 / -1", gridRow: 2 }}>{rightSub}</div>}
      {badge && <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4, alignItems: "center" }}>{badge}</div>}
      {meta && <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "#6B6355", marginTop: 2, lineHeight: 1.4 }}>{meta}</div>}
      {actions && (
        <div onClick={e => e.stopPropagation()}
          style={{ gridColumn: "1 / -1", display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          {actions}
        </div>
      )}
    </div>
  );
}
