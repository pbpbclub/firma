import { MONO } from "./ui/Num";

// Общие финансовые блоки заказа: панель списка и монитор заказа рисуют их одинаково.
// ВАЖНО: лестница и прогноз считаются на бэке (_margin / _plan_fact). Здесь ничего
// не досчитываем — иначе на нал попадёт фантомный УСН, а прогноз завысит маржу.

function fmt(n: number | null | undefined) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

// ── Лестница прибыли: Стоимость · Оплачено · Долг · Валовая · [УСН] · Чистая ──
export function ProfitLadder({ order, paidTotal }: { order: any; paidTotal: number }) {
  const gross = order.gross_profit ?? order.margin ?? 0;
  const tax = order.tax ?? 0;
  const net = order.net_profit ?? gross;
  const isBank = order.payment_type === "bank";
  // Выручка из план-факта: для draft-смет бэк берёт её из сета, а поле заказа устарело.
  const revenue = order.plan_fact?.revenue ?? order.price_plan;
  const items = [
    { label: "Стоимость", value: fmt(revenue), color: "#1A1A1A" },
    { label: "Оплачено",  value: fmt(paidTotal),        color: "#4A7C59" },
    { label: "Долг",      value: order.debt > 0 ? fmt(order.debt) : "Оплачено", color: order.debt > 0 ? "#E8592A" : "#4A7C59" },
    { label: "Валовая",   value: fmt(gross),            color: "#1A1A1A" },
    ...(isBank ? [{ label: `УСН ${order.tax_pct ?? 6}%`, value: `−${fmt(tax)}`, color: "#8B3A3A" }] : []),
    { label: "Чистая",    value: fmt(net),              color: net > 0 ? "#4A7C59" : "#8B3A3A" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "16px 32px" }}>
      {items.map((item) => (
        <div key={item.label}>
          <div style={{ fontSize: 10, color: "#A89070", marginBottom: 4 }}>{item.label}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: item.color, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── План-Факт: бары себестоимости и чистой, пояснение, таблица категорий ──
export function PlanFactBlock({ planFact }: { planFact: any }) {
  const pf = planFact;
  if (!pf?.has_estimate) return null;

  const barPct = (fact: number, plan: number) => {
    const base = Math.max(plan, fact, 1);
    return { f: Math.min(100, (fact / base) * 100), p: Math.min(100, (plan / base) * 100) };
  };
  const overCost = pf.cost_fact > pf.cost_plan;
  const netPlan = pf.net_plan;
  const netForecast = pf.net_forecast;
  const coveragePct = pf.cost_coverage != null ? Math.round(pf.cost_coverage * 100) : null;

  const Metric = ({ label, fact, plan, barColor, factColor }: any) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: "#6B6355" }}>{label}</span>
        <span style={{ fontSize: 13 }}>
          <span style={{ fontWeight: 700, color: factColor, fontVariantNumeric: "tabular-nums" }}>{fmt(fact)}</span>
          {plan != null && <span style={{ color: "#A89070", fontVariantNumeric: "tabular-nums" }}> / {fmt(plan)}</span>}
        </span>
      </div>
      <div style={{ height: 2, background: "#EDEBE6", position: "relative" }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: 2, background: barColor, width: `${barPct(fact, plan ?? fact).f}%` }} />
        {plan != null && plan > 0 && (
          <div style={{ position: "absolute", top: -2, height: 6, width: 1, background: "#A89070", left: `${barPct(fact, plan).p}%` }} />
        )}
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 16, textTransform: "uppercase" }}>
        План-Факт
        {!pf.detailed && (
          <span style={{ marginLeft: 8, textTransform: "none", letterSpacing: 0, color: "#A89070", fontSize: 10 }}>
            · смета без детализации, план в «Прочее»
          </span>
        )}
      </div>

      <Metric label="Себестоимость" fact={pf.cost_fact} plan={pf.cost_plan}
        barColor="#E8592A" factColor={overCost ? "#8B3A3A" : "#1A1A1A"} />
      <Metric label="Чистая: прогноз / план" fact={netForecast} plan={netPlan}
        barColor={netForecast >= 0 ? "#4A7C59" : "#8B3A3A"}
        factColor={netForecast < netPlan ? "#8B3A3A" : netForecast >= 0 ? "#4A7C59" : "#8B3A3A"} />

      <div style={{ fontSize: 10, color: "#A89070", lineHeight: 1.5, marginBottom: 12 }}>
        {pf.has_facts
          ? <>Внесено {coveragePct}% плановых затрат. Прогноз считается от большего из плана и факта — пока расходы внесены не полностью, он держится плана и растёт только перерасход.</>
          : <>Фактические траты ещё не внесены — прогноз равен плану.</>}
        {pf.tax > 0 && <> Налог УСН {fmt(pf.tax)} уже вычтен.</>}
      </div>

      {pf.categories.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "0 16px",
            fontSize: 10, color: "#A89070", letterSpacing: "0.04em", paddingBottom: 6, borderBottom: "1px solid #EDEBE6" }}>
            <span>КАТЕГОРИЯ</span>
            <span style={{ textAlign: "right" }}>ПЛАН</span>
            <span style={{ textAlign: "right" }}>ФАКТ</span>
            <span style={{ textAlign: "right", minWidth: 70 }}>Δ</span>
          </div>
          {pf.categories.map((c: any) => {
            const over = c.delta > 0;
            return (
              <div key={c.category} style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "0 16px",
                fontSize: 12, padding: "7px 0", borderBottom: "1px solid #F2EFE9", fontVariantNumeric: "tabular-nums" }}>
                <span style={{ color: "#1A1A1A" }}>{c.category}</span>
                <span style={{ textAlign: "right", color: "#6B6355" }}>{fmt(c.plan)}</span>
                <span style={{ textAlign: "right", color: "#1A1A1A" }}>{fmt(c.fact)}</span>
                <span style={{ textAlign: "right", minWidth: 70, fontWeight: 600,
                  color: c.delta === 0 ? "#A89070" : over ? "#8B3A3A" : "#4A7C59" }}>
                  {c.delta === 0 ? "—" : (over ? "+" : "") + fmt(c.delta)}
                </span>
              </div>
            );
          })}
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "0 16px",
            fontSize: 12, padding: "8px 0", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            <span>Итого</span>
            <span style={{ textAlign: "right", color: "#6B6355" }}>{fmt(pf.cost_plan)}</span>
            <span style={{ textAlign: "right", color: "#1A1A1A" }}>{fmt(pf.cost_fact)}</span>
            <span style={{ textAlign: "right", minWidth: 70,
              color: pf.cost_delta === 0 ? "#A89070" : pf.cost_delta > 0 ? "#8B3A3A" : "#4A7C59" }}>
              {pf.cost_delta === 0 ? "—" : (pf.cost_delta > 0 ? "+" : "") + fmt(pf.cost_delta)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
