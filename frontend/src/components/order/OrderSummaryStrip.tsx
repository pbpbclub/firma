// Сводка заказа одной строкой — карточка открывается деньгами, не формой.
// Все числа считает бэкенд (_margin/_plan_fact): revenue у draft-смет берётся
// из самого сета, поэтому здесь только отображение.
import { MONO } from "../ui/Num";
import { debtColor } from "../ui/type";
import { fmtMoney } from "../ui/format";
import { PLAN_SOURCE_LABEL } from "../domain";

function Cell({ label, value, color, sub }: {
  label: string; value: string; color: string; sub?: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color, fontFamily: MONO, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10, color: "#A89070", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export function OrderSummaryStrip({ order, paidTotal, compact }: { order: any; paidTotal: number; compact?: boolean }) {
  const pf = order?.plan_fact || {};
  const revenue = pf.revenue ?? order?.price_plan ?? 0;
  const debt = order?.debt ?? 0;
  const src = order?.plan_source || "manual";
  const coverage = pf.cost_coverage != null ? Math.round(pf.cost_coverage * 100) : null;
  const overCost = (pf.cost_fact ?? 0) > (pf.cost_plan ?? 0);

  return (
    <div style={{ marginBottom: compact ? 20 : 28 }}>
      {/* compact — узкая правая колонка карточки: 2×2 вместо одной строки */}
      <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: compact ? "16px 20px" : "0 24px" }}>
        <Cell
          label="ЦЕНА"
          value={fmtMoney(revenue)}
          color="#1A1A1A"
          sub={
            <span style={{ color: src === "draft" ? "#E8592A" : "#A89070", fontWeight: src === "draft" ? 600 : 400 }}>
              {PLAN_SOURCE_LABEL[src] ?? src}
            </span>
          }
        />
        <Cell
          label="ОПЛАЧЕНО"
          value={fmtMoney(paidTotal)}
          color="#4A7C59"
          sub={debt > 0
            ? <span style={{ color: debtColor(debt, "in"), fontFamily: MONO }}>долг {fmtMoney(debt)}</span>
            : <span style={{ color: debtColor(0, "in") }}>долга нет</span>}
        />
        <Cell
          label="СЕБЕСТОИМОСТЬ"
          value={pf.has_facts ? fmtMoney(pf.cost_fact) : fmtMoney(pf.cost_plan)}
          color={pf.has_facts ? (overCost ? "#8B3A3A" : "#1A1A1A") : "#6B6355"}
          sub={pf.has_facts
            ? <span>план <span style={{ fontFamily: MONO }}>{fmtMoney(pf.cost_plan)}</span>{coverage != null ? ` · внесено ${coverage}%` : ""}</span>
            : <span>план — факта ещё нет</span>}
        />
        <Cell
          label="ЧИСТАЯ · ПРОГНОЗ"
          value={fmtMoney(pf.net_forecast ?? order?.net_profit)}
          color={(pf.net_forecast ?? order?.net_profit ?? 0) >= 0 ? "#4A7C59" : "#8B3A3A"}
          sub={<span>план <span style={{ fontFamily: MONO }}>{fmtMoney(pf.net_plan ?? order?.net_profit)}</span></span>}
        />
      </div>
      {/* Тонкая полоса оплаты: сколько цены уже пришло деньгами */}
      {revenue > 0 && (
        <div style={{ height: 2, background: "#EDEBE6", marginTop: 16 }}>
          <div style={{ height: 2, background: "#4A7C59", width: `${Math.min(100, (paidTotal / revenue) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
