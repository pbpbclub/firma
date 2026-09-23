// Полукруглый «спидометр» — как в недельном отчёте фин-агента (дуга R=40, стрелка,
// подпись под ней), но в дизайне Фирмы: тонкий штрих, трек #EDEBE6, без скруглений.
// Цвет кодирует только порог (норма / выше / ниже), не величину — как и у него:
// величину показывает стрелка, а цвет отвечает на один вопрос «всё в порядке?».
import { MONO } from "./Num";

export type GaugeTone = "accent" | "good" | "bad" | "muted";
const TONES: Record<GaugeTone, string> = {
  accent: "#E8592A", good: "#4A7C59", bad: "#8B3A3A", muted: "#C8C0B0",
};

export function Gauge({ frac, label, tone = "accent", size = 120 }: {
  frac: number | null | undefined;     // 0..1, null — «нет данных»: пустая дуга без стрелки
  label: string;                        // подпись под стрелкой («91%», «$101»)
  tone?: GaugeTone;
  size?: number;                        // ширина в px; высота — 0.62 от неё
}) {
  const f = frac == null ? null : Math.max(0, Math.min(1, frac));
  const th = Math.PI * (1 - (f ?? 0));
  const ex = 50 + 40 * Math.cos(th), ey = 50 - 40 * Math.sin(th);
  const nx = 50 + 30 * Math.cos(th), ny = 50 - 30 * Math.sin(th);
  const color = TONES[tone];
  // Дуга больше полукруга не бывает; large-arc не нужен — заливка идёт от левого края.
  return (
    <svg viewBox="0 0 100 64" width={size} height={size * 0.64} style={{ display: "block", overflow: "visible" }}>
      <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="#EDEBE6" strokeWidth={4} />
      {f != null && f > 0.005 && (
        <path d={`M10 50 A40 40 0 0 1 ${ex.toFixed(1)} ${ey.toFixed(1)}`}
              fill="none" stroke={color} strokeWidth={4} />
      )}
      {f != null && (
        <>
          <line x1={50} y1={50} x2={nx.toFixed(1)} y2={ny.toFixed(1)} stroke="#1A1A1A" strokeWidth={1.5} />
          <circle cx={50} cy={50} r={2.5} fill="#1A1A1A" />
        </>
      )}
      <text x={50} y={62} textAnchor="middle"
            style={{ fontSize: 11, fontWeight: 700, fontFamily: MONO, fill: f == null ? "#A89070" : "#1A1A1A" }}>
        {label}
      </text>
    </svg>
  );
}
