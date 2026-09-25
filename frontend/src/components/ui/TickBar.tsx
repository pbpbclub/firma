// Шкала с засечками-порогами — как `silence_bar` недельного отчёта («Молчат»:
// 0–90 дн., деления 14 / 30 / 60). Цвет заливки порог не меняет: где стоит
// значение относительно засечек — видно по самой шкале.
export function TickBar({ value, scale, ticks = [], color = "#E8592A" }: {
  value: number; scale: number; ticks?: number[]; color?: string;
}) {
  const w = Math.max(0, Math.min(1, value / scale)) * 100;
  return (
    <div style={{ position: "relative", height: 4, background: "#EDEBE6" }}>
      <div style={{ height: 4, width: `${w}%`, background: color }} />
      {ticks.map(t => (
        <div key={t} title={`${t}`} style={{ position: "absolute", left: `${t / scale * 100}%`, top: -2, width: 1, height: 8, background: "#A89070" }} />
      ))}
    </div>
  );
}
