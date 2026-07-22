// Пилл срочности/статуса. Прямые углы, CAPS, тонированная подложка. Заменяет
// «цвет текста как единственный сигнал» на заметный бейдж (дедлайны, статусы).
import type { CSSProperties } from "react";

type Tone = "overdue" | "soon" | "ok" | "neutral" | "in" | "out";

const TONES: Record<Tone, { fg: string; bg: string }> = {
  overdue: { fg: "#8B3A3A", bg: "#FBE9E7" }, // просрочено
  soon:    { fg: "#E8592A", bg: "#FDECE4" }, // горит (<7 дней)
  ok:      { fg: "#4A7C59", bg: "#EEF7F0" }, // в срок
  neutral: { fg: "#6B6355", bg: "#F2EFE9" },
  in:      { fg: "#4A7C59", bg: "#EEF7F0" }, // деньги входят
  out:     { fg: "#8B3A3A", bg: "#FBE9E7" }, // деньги выходят
};

export function Pill({ tone = "neutral", children, style }: {
  tone?: Tone; children: React.ReactNode; style?: CSSProperties;
}) {
  const t = TONES[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 7px", fontSize: 10, fontWeight: 600, letterSpacing: "0.02em",
      color: t.fg, background: t.bg, whiteSpace: "nowrap", ...style,
    }}>
      {children}
    </span>
  );
}

// Дедлайн как пилл: считает дни до срока и подбирает тон/текст.
// null-дата → ничего (пустой дедлайн — не сигнал).
export function DeadlinePill({ date }: { date?: string | null }) {
  if (!date) return <span style={{ color: "#C8C0B0", fontSize: 12 }}>—</span>;
  const d = new Date(date);
  if (isNaN(+d)) return <span style={{ color: "#C8C0B0", fontSize: 12 }}>—</span>;
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  const label = d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  if (days < 0) return <Pill tone="overdue">просрочено {Math.abs(days)} дн.</Pill>;
  if (days === 0) return <Pill tone="soon">сегодня</Pill>;
  if (days <= 7) return <Pill tone="soon">{label} · {days} дн.</Pill>;
  return <span style={{ color: "#6B6355", fontSize: 12 }}>{label}</span>;
}
