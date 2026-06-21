// Метрика-карточка (используется в P2: Dashboard/OrderDetail/Brands/Funds/Taxes).
// Метка CAPS 11px → значение 24/700 tabular-nums → опц. тонкий прогресс/дельта/подпись.
import { MONO } from "./Num";

const TONES = { pos: "#4A7C59", neg: "#8B3A3A", neutral: "#1A1A1A" } as const;

export function MetricCard({ label, value, tone = "neutral", progress, delta, sub, onClick }: {
  label: string;
  value: React.ReactNode;
  tone?: keyof typeof TONES;
  progress?: number;        // 0..1
  delta?: React.ReactNode;
  sub?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{ display: "flex", flexDirection: "column", gap: 6, cursor: onClick ? "pointer" : "default" }}
    >
      <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: TONES[tone], fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{value}</span>
        {delta != null && <span style={{ fontSize: 12, fontWeight: 600, color: TONES[tone], fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{delta}</span>}
      </div>
      {progress != null && (
        <div style={{ height: 2, background: "#EDEBE6" }}>
          <div style={{ height: 2, width: `${Math.max(0, Math.min(1, progress)) * 100}%`, background: TONES[tone] }} />
        </div>
      )}
      {sub != null && <div style={{ fontSize: 11, color: "#6B6355" }}>{sub}</div>}
    </div>
  );
}
