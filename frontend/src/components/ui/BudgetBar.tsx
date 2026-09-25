// План/факт себестоимости одной полосой — как `budget_bar` недельного отчёта
// фин-агента, в стиле Фирмы: факт до плана оранжевым, перерасход красным хвостом,
// засечка плана чёрной чертой. Шкала — max(факт, план), поэтому перерасход виден
// как выход за засечку, а не как «полоса длиннее ста процентов».
import { MONO } from "./Num";
import { fmtMoney } from "./format";

export function BudgetBar({ fact, plan, factLabel = "факт" }: {
  fact: number; plan: number;
  factLabel?: string;                 // у транзита — «мастеру»
}) {
  const top = Math.max(fact, plan);
  const fill = top > 0 ? Math.min(fact, plan) / top * 100 : 0;
  const over = top > 0 ? Math.max(0, fact - plan) / top * 100 : 0;
  const mark = top > 0 ? plan / top * 100 : 0;
  return (
    <div>
      <div style={{ position: "relative", height: 4, background: "#EDEBE6", margin: "6px 0" }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: 4, width: `${fill}%`, background: "#E8592A" }} />
        {over > 0 && (
          <div style={{ position: "absolute", left: `${fill}%`, top: 0, height: 4, width: `${over}%`, background: "#8B3A3A" }} />
        )}
        {plan > 0 && (
          <div title="план" style={{ position: "absolute", left: `calc(${mark}% - 1px)`, top: -3, width: 1, height: 10, background: "#1A1A1A" }} />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#A89070", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
        <span>{factLabel} <b style={{ color: fact > plan ? "#8B3A3A" : "#1A1A1A" }}>{fmtMoney(fact)}</b></span>
        <span>план <b style={{ color: "#1A1A1A" }}>{fmtMoney(plan)}</b></span>
      </div>
    </div>
  );
}
