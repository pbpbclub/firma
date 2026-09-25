// Сегментированная полоса: одно целое, разложенное на части (остаток → свободно /
// резервы / фонды, деньги по счетам, долг по клиентам). Между сегментами — зазор 2px
// цвета поверхности, углы прямые. Ширины растут при появлении (`grow`) — главная
// висит на мониторе, и движение подсказывает, что цифры живые.
import { useEffect, useState } from "react";

export type Segment = { value: number; color: string; label?: string };

/** true со второго кадра после монтирования — для анимации «от нуля». */
export function useGrow(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(id); }, []);
  return on;
}

export function SegBar({ segments, total, height = 6, track = "#EDEBE6" }: {
  segments: Segment[];
  total?: number;                     // шкала; по умолчанию — сумма сегментов
  height?: number;
  track?: string;
}) {
  const grow = useGrow();
  const segs = segments.filter(s => s.value > 0);
  const sum = total ?? segs.reduce((a, s) => a + s.value, 0);
  return (
    <div style={{ display: "flex", gap: 2, height, background: track }}>
      {sum > 0 && segs.map((s, i) => (
        <div key={i} title={s.label}
             style={{ height, background: s.color, flexShrink: 0,
                      width: grow ? `calc(${s.value / sum * 100}% - ${i < segs.length - 1 ? 2 : 0}px)` : 0,
                      transition: "width 0.7s cubic-bezier(.2,.7,.2,1)" }} />
      ))}
    </div>
  );
}
