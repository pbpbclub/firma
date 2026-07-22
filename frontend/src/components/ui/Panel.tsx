// Контейнер-зона с цветным акцентом-рельсом слева. Даёт блоку визуальную
// идентичность (нам должны = зелёный, мы должны = бордовый), не трогая палитру.
// Прямые углы, тонкий рельс 3px, опц. тонированный заголовок.
import type { CSSProperties } from "react";
import { POLARITY } from "./type";

type Accent = keyof typeof POLARITY;

export function Panel({ accent = "neutral", title, right, tinted = false, children, style }: {
  accent?: Accent;
  title?: React.ReactNode;
  right?: React.ReactNode;
  tinted?: boolean;          // тонировать всю подложку зоны (лёгкий фон полярности)
  children: React.ReactNode;
  style?: CSSProperties;
}) {
  const p = POLARITY[accent];
  return (
    <div style={{
      borderLeft: `3px solid ${p.rail}`,
      background: tinted ? p.tint : "transparent",
      ...style,
    }}>
      {title != null && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px", borderBottom: "1px solid #EDEBE6",
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: p.color, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            {title}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}
