// Круговой SVG-индикатор прогресса (канон дизайн-системы: r≈26, stroke 3.5,
// dasharray). Вынесен из Dashboard, чтобы карточка заказа (покрытие план-факта)
// и сводка рисовали одно и то же.
import { MONO } from "./Num";

export function CircleProgress({ pct, size = 64, color = "#E8592A" }: {
  pct: number; size?: number; color?: string;
}) {
  const stroke = 3.5;
  const r = (size - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(1, pct / 100));
  const cx = size / 2;
  return (
    <svg width={size} height={size} style={{ display: "block" }}>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="#EDEBE6" strokeWidth={stroke} />
      <circle
        cx={cx} cy={cx} r={r} fill="none"
        stroke={color} strokeWidth={stroke}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cx})`}
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
      <text x={cx} y={cx + 4} textAnchor="middle" fontSize={size >= 56 ? 11 : 10} fontWeight={700} fill="#1A1A1A" fontFamily={MONO}>
        {Math.round(pct)}%
      </text>
    </svg>
  );
}
