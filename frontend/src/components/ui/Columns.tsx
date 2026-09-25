// Столбики по периодам — как `columns_svg` недельного отчёта (приход по неделям,
// доход по кварталам): текущий период оранжевым, прошлые — бежевым; подпись
// значения только у текущего и у максимума, чтобы ряд не превращался в таблицу.
import { MONO } from "./Num";

/** 1 940 000 → «1,9 млн», 512 300 → «512 тыс.» — короткая подпись над столбиком. */
export function shortMoney(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`;
  if (a >= 1_000) return `${Math.round(v / 1_000)} тыс.`;
  return `${Math.round(v)}`;
}

export function Columns({ values, labels, hot, height = 72 }: {
  values: number[]; labels: string[];
  hot?: number;                         // индекс текущего периода
  height?: number;
}) {
  const max = Math.max(0, ...values);
  const iMax = values.indexOf(max);
  const n = values.length || 1;
  // Подписи значений — отдельным слоем над столбиками: в узкой колонке (12 недель
  // на телефоне) «644 тыс.» шире самого столбика. Крайние прижаты к краю, а не
  // центрованы, чтобы не вылезать за ширину графика.
  const tags = values.map((v, i) => ({ v, i })).filter(({ v, i }) => v > 0 && (i === hot || i === iMax));
  return (
    <div>
      <div style={{ position: "relative", height: height + 16 }}>
        {tags.map(({ v, i }) => {
          const center = (i + 0.5) / n * 100;
          const edge = i === 0 ? { left: 0 } : i === n - 1 ? { right: 0 }
                     : { left: `${center}%`, transform: "translateX(-50%)" };
          return (
            <div key={i} style={{ position: "absolute", bottom: (max > 0 ? v / max * height : 0) + 3, ...edge,
                                  fontSize: 10, fontFamily: MONO, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
                                  color: i === hot ? "#E8592A" : "#6B6355" }}>{shortMoney(v)}</div>
          );
        })}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "flex-end", gap: 2, height }}>
        {values.map((v, i) => {
          const h = max > 0 ? v / max * height : 0;
          const isHot = i === hot;
          return (
            <div key={i} title={`${labels[i]}: ${v.toLocaleString("ru-RU")} ₽`}
                 style={{ flex: 1, minWidth: 0, height: Math.max(isHot ? 3 : 0, h), background: isHot ? "#E8592A" : "#E8E4DA" }} />
          );
        })}
        </div>
      </div>
      <div style={{ display: "flex", gap: 2, borderTop: "1px solid #EDEBE6", paddingTop: 4 }}>
        {labels.map((l, i) => (
          <div key={i} style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 9, fontFamily: MONO,
                                color: i === hot ? "#E8592A" : "#A89070", overflow: "hidden", whiteSpace: "nowrap" }}>{l}</div>
        ))}
      </div>
    </div>
  );
}
