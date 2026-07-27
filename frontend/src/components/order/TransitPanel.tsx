// Транзит: деньги клиента проходят через р/с, бóльшая часть уходит контрагенту,
// Юра удерживает процент. Себестоимость такого заказа = выплата, маржа = удержание.
//
// Этот блок заменяет «ПЛАН ⇄ ФАКТ» у транзитных заказов: разбивки по материалам,
// работам и доставке у транзита нет и быть не должно — себестоимость там одно число.
// Все суммы приходят с бэка (_margin.transit), здесь ничего не досчитывается.
import { MONO } from "../ui/Num";

const fmt = (n: number | null | undefined) =>
  !n ? "0 ₽" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";

// Состояние выплаты. Расхождение план/факт — сигнал, а не ошибка ввода: заплатил
// другую сумму, частями или часть с расчётного счёта. Молча подменять план фактом
// нельзя, поэтому состояние всегда подписано словами.
const STATE: Record<string, { label: string; color: string; hint: string }> = {
  no_fact: {
    label: "выплаты ещё нет",
    color: "#A89070",
    hint: "Себестоимость плановая — счёт минус удержание. Появится привязанный перевод — станет фактической.",
  },
  matched: {
    label: "сошлось с планом",
    color: "#4A7C59",
    hint: "Фактическая выплата совпала с планом.",
  },
  mismatch: {
    label: "разошлось с планом",
    color: "#8B3A3A",
    hint: "Факт отличается от плана: заплачено другой суммой, частями или часть с расчётного счёта. Себестоимость взята по факту.",
  },
};

export function TransitPanel({ transit, tax, taxPct, netProfit }: {
  transit: any; tax: number; taxPct: number; netProfit: number;
}) {
  if (!transit) return null;
  const st = STATE[transit.state] ?? STATE.no_fact;
  const hasFact = transit.state !== "no_fact";
  const payout = hasFact ? transit.fact : transit.plan;

  const Row = ({ label, value, color = "#1A1A1A", note, strong }: {
    label: string; value: string; color?: string; note?: string; strong?: boolean;
  }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
                  gap: 12, padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
      <span style={{ fontSize: 12, color: "#6B6355" }}>
        {label}
        {note && <span style={{ color: "#A89070", fontSize: 11 }}> · {note}</span>}
      </span>
      <span style={{ fontSize: strong ? 15 : 13, fontWeight: strong ? 700 : 600, color,
                     fontFamily: MONO, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        {value}
      </span>
    </div>
  );

  return (
    <div style={{ border: "1px solid #EDEBE6", borderLeft: "3px solid #E8592A", padding: "14px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
                    gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>ТРАНЗИТ</span>
        <span style={{ fontSize: 11, color: transit.contractor ? "#1A1A1A" : "#C8C0B0",
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {transit.contractor ?? "контрагент не указан"}
        </span>
      </div>

      <Row label="Счёт клиенту" value={fmt(transit.invoice)} note="приходит на р/с" />
      <Row label="Выплата контрагенту" value={fmt(payout)}
           note={hasFact ? "по факту" : "план"} color={hasFact ? "#1A1A1A" : "#6B6355"} />

      {/* План и факт рядом — расхождение видно, а не спрятано за одной цифрой */}
      <div style={{ display: "flex", gap: 18, padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
        {[["план", transit.plan], ["факт", transit.fact]].map(([l, v]: any) => (
          <div key={l}>
            <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em" }}>{String(l).toUpperCase()}</div>
            <div style={{ fontSize: 12, fontWeight: 600, fontFamily: MONO,
                          color: l === "факт" && !hasFact ? "#C8C0B0" : "#1A1A1A" }}>
              {l === "факт" && !hasFact ? "—" : fmt(v)}
            </div>
          </div>
        ))}
        <div style={{ marginLeft: "auto", textAlign: "right", maxWidth: 260 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: st.color }}>{st.label}</div>
          {transit.state === "mismatch" && (
            <div style={{ fontSize: 11, color: "#8B3A3A", fontFamily: MONO }}>
              {transit.rest > 0 ? "недоплачено " : "переплачено "}{fmt(Math.abs(transit.rest))}
            </div>
          )}
        </div>
      </div>

      <Row label="Удержание" value={fmt(transit.hold)} note={`${transit.hold_pct}% от счёта`} color="#4A7C59" />
      <Row label={`УСН ${taxPct ?? 6}%`} value={`−${fmt(tax)}`} note="со всей суммы счёта" color="#8B3A3A" />
      <Row label="Доход" value={fmt(netProfit)} color={netProfit > 0 ? "#4A7C59" : "#8B3A3A"} strong />

      <div style={{ fontSize: 11, color: "#A89070", marginTop: 8, lineHeight: 1.45 }}>{st.hint}</div>

      {!!transit.sources?.length && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>
            ЧЕМ ПОДТВЕРЖДЕНО
          </div>
          {transit.sources.map((s: any, i: number) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10,
                                  fontSize: 11, color: "#6B6355", padding: "3px 0" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.date ? `${s.date} · ` : ""}{s.payee || s.title || "без описания"}
                {s.kind === "zm_link" && <span style={{ color: "#A89070" }}> · личная карта</span>}
              </span>
              <span style={{ fontFamily: MONO, whiteSpace: "nowrap" }}>{fmt(s.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
