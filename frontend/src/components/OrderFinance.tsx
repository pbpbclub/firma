import { fmtMoneyDash as fmt } from "./ui/format";
import { MONO } from "./ui/Num";
import { CircleProgress } from "./ui/CircleProgress";

// Общие финансовые блоки заказа: панель списка и монитор заказа рисуют их одинаково.
// ВАЖНО: лестница и прогноз считаются на бэке (_margin / _plan_fact). Здесь ничего
// не досчитываем — иначе на нал попадёт фантомный УСН, а прогноз завысит маржу.


// ── Лестница прибыли: Стоимость · Оплачено · Долг · Валовая · [УСН] · Чистая ──
export function ProfitLadder({ order, paidTotal }: { order: any; paidTotal: number }) {
  const gross = order.gross_profit ?? order.margin ?? 0;
  const tax = order.tax ?? 0;
  const net = order.net_profit ?? gross;
  // УСН показываем и у транзита: деньги клиента тоже проходят через р/с,
  // налог берётся со всей суммы счёта, а не с удержания.
  const taxed = order.payment_type === "bank" || order.payment_type === "transit";
  // Выручка из план-факта: для draft-смет бэк берёт её из сета, а поле заказа устарело.
  const revenue = order.plan_fact?.revenue ?? order.price_plan;
  // Скидка — договорённость в конце сделки: показываем цену до неё и саму скидку,
  // «Стоимость» дальше по лестнице — уже к оплате (revenue после скидки).
  const hasDiscount = (order.discount ?? 0) > 0;
  // УСН при смешанной оплате берётся только с банковской части (tax_base с бэка)
  const mixedTax = taxed && order.tax_base != null && Math.abs(order.tax_base - revenue) > 0.5;
  const items = [
    ...(hasDiscount ? [
      { label: "По смете", value: fmt(order.price_before_discount), color: "#6B6355" },
      { label: "Скидка", value: `−${fmt(order.discount)}`, color: "#B8860B" },
    ] : []),
    { label: hasDiscount ? "К оплате" : "Стоимость", value: fmt(revenue), color: "#1A1A1A" },
    { label: "Оплачено",  value: fmt(paidTotal),        color: "#4A7C59" },
    { label: "Долг",      value: order.debt > 0 ? fmt(order.debt) : "Оплачено", color: order.debt > 0 ? "#E8592A" : "#4A7C59" },
    { label: "Валовая",   value: fmt(gross),            color: "#1A1A1A" },
    ...(taxed ? [{ label: `УСН ${order.tax_pct ?? 6}%${mixedTax ? " · с безнал. части" : ""}`, value: `−${fmt(tax)}`, color: "#8B3A3A" }] : []),
    { label: "Чистая",    value: fmt(net),              color: net > 0 ? "#4A7C59" : "#8B3A3A" },
    // A8: второй уровень маржи — доля накладных месяца (аренда, расходники),
    // делённых по заказам в работе пропорционально их себестоимости. Бэк отдаёт
    // блок только у in_production — сметы и завершённые этим не обрастают.
    ...(order.overhead ? [
      { label: `Накладные ${order.overhead.period} · ${Math.round(order.overhead.share * 100)}% цеха`,
        value: `−${fmt(order.overhead.amount)}`, color: "#B8860B" },
      { label: "Маржа с накладными",
        value: fmt(order.net_with_overhead),
        color: (order.net_with_overhead ?? 0) > 0 ? "#4A7C59" : "#8B3A3A" },
    ] : []),
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

// ── План ⇄ Факт: «дуэль» — табло себестоимости для правой колонки карточки ──
// Соревнование: факт против плана. Счёт по центру (экономия зелёным, перерасход
// красным), парные бары по категориям (шкала = max(plan,fact), риска = план,
// факт-заливка выигрывает/проигрывает цветом), кольцо покрытия плана фактом.
export function PlanFactDuel({ planFact }: { planFact: any }) {
  const pf = planFact;
  if (!pf?.has_estimate) return null;

  const coveragePct = pf.cost_coverage != null ? Math.round(pf.cost_coverage * 100) : null;
  const delta = pf.cost_delta || 0;            // fact − plan; <0 = факт бьёт план
  const winning = delta < 0;
  // Допработы — отдельной строкой, не подмешаны в категории сметы (ТЗ extra_works
  // 01.08.2026): иначе транспорт на доработку читался бы как перерасход по заказу.
  // Без неё сумма строк не сходилась бы с cost_plan/cost_fact панели.
  const ex = pf.extras;
  const cats = [
    ...(pf.categories || []).filter((c: any) => c.plan > 0 || c.fact > 0),
    ...(ex?.count && (ex.cost_plan > 0 || ex.cost_fact > 0)
      ? [{ category: "Допработы", plan: ex.cost_plan, fact: ex.cost_fact,
           delta: Math.round((ex.cost_fact - ex.cost_plan) * 100) / 100 }]
      : []),
  ];

  // Строка категории: имя + числа, под ними парный бар 7px.
  const CatRow = ({ c }: { c: any }) => {
    const base = Math.max(c.plan, c.fact, 1);
    const planPct = Math.min(100, (c.plan / base) * 100);
    const factPct = Math.min(100, (c.fact / base) * 100);
    const over = c.fact > c.plan;
    const factColor = !pf.has_facts || c.fact === 0 ? "#C8C0B0" : over ? "#8B3A3A" : "#4A7C59";
    return (
      <div style={{ marginBottom: 13 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
          <span style={{ fontSize: 12, color: "#1A1A1A", flex: 1 }}>{c.category}</span>
          <span style={{ fontSize: 11, color: "#A89070", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(c.plan)}</span>
          <span style={{ fontSize: 11, color: "#C8C0B0" }}>→</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: factColor, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{c.fact ? fmt(c.fact) : "—"}</span>
          <span style={{ fontSize: 11, fontWeight: 600, minWidth: 58, textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums",
            color: c.delta === 0 || c.fact === 0 ? "#D0C8C0" : c.delta > 0 ? "#8B3A3A" : "#4A7C59" }}>
            {c.delta === 0 || c.fact === 0 ? "" : (c.delta > 0 ? "+" : "−") + fmt(Math.abs(c.delta))}
          </span>
        </div>
        <div style={{ height: 7, background: "#EDEBE6", position: "relative" }}>
          {/* план — приглушённая заливка до риски */}
          <div style={{ position: "absolute", inset: 0, width: `${planPct}%`, background: "#DDD6C8" }} />
          {/* факт — цветная заливка поверх */}
          <div style={{ position: "absolute", inset: 0, width: `${factPct}%`, background: factColor, transition: "width 0.4s" }} />
          {/* риска плана */}
          {c.plan > 0 && <div style={{ position: "absolute", top: -2, bottom: -2, width: 2, background: "#1A1A1A", left: `calc(${planPct}% - 1px)` }} />}
        </div>
      </div>
    );
  };

  return (
    <div style={{ background: "#FAF8F5", borderLeft: "3px solid #E8592A", padding: "16px 16px 14px" }}>
      {/* Шапка: заголовок + кольцо покрытия */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.08em" }}>ПЛАН ⇄ ФАКТ</div>
          {(pf.plan_unbroken ?? 0) > 0 && (
            <div style={{ fontSize: 10, color: "#A89070", marginTop: 3 }}>
              {fmt(pf.plan_unbroken)} в смете {pf.detailed ? "не разбиты" : "не разбито"} по категориям — {pf.detailed ? "они" : "весь план"} в «Прочее»
            </div>
          )}
        </div>
        {coveragePct != null && pf.has_facts && (
          <div style={{ textAlign: "center" }} title="Сколько плановых затрат уже закрыто фактом">
            <CircleProgress pct={coveragePct} size={46} color={pf.cost_fact > pf.cost_plan ? "#8B3A3A" : "#4A7C59"} />
            <div style={{ fontSize: 9, color: "#A89070", marginTop: 2 }}>факт внесён</div>
          </div>
        )}
      </div>

      {/* Счёт */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em" }}>ПЛАН</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#6B6355", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(pf.cost_plan)}</div>
          <div style={{ fontSize: 9, color: "#A89070" }}>себестоимость по смете</div>
        </div>
        <div style={{ textAlign: "center", flex: 1 }}>
          {pf.has_facts ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em",
                color: delta === 0 ? "#6B6355" : winning ? "#4A7C59" : "#8B3A3A" }}>
                {delta === 0 ? "0 ₽" : (winning ? "−" : "+") + fmt(Math.abs(delta))}
              </div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.04em" }}>
                {delta === 0 ? "ровно по плану" : winning ? "факт ниже плана" : "сверх плана"}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: "#A89070" }}>счёт откроется с первым расходом</div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em" }}>ФАКТ</div>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: "tabular-nums",
            color: !pf.has_facts ? "#C8C0B0" : pf.cost_fact > pf.cost_plan ? "#8B3A3A" : "#1A1A1A" }}>
            {pf.has_facts ? fmt(pf.cost_fact) : "—"}
          </div>
          <div style={{ fontSize: 9, color: "#A89070" }}>внесённые расходы</div>
        </div>
      </div>

      {/* Категории */}
      {cats.map((c: any) => <CatRow key={c.category} c={c} />)}

      {/* Финал: маржа */}
      <div style={{ borderTop: "1px solid #EDEBE6", paddingTop: 10, marginTop: 2 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 11, color: "#6B6355" }}
            title="Выручка − себестоимость − УСН. Прогноз берёт большее из плана и факта, поэтому не завышает, пока расходы внесены не все.">
            Чистая: план → прогноз{pf.tax > 0 ? " · после УСН" : ""}</span>
          <span style={{ fontSize: 13, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
            <span style={{ color: "#A89070" }}>{fmt(pf.net_plan)}</span>
            <span style={{ color: "#C8C0B0" }}> → </span>
            <span style={{ fontWeight: 700, color: (pf.net_forecast ?? 0) >= (pf.net_plan ?? 0) && (pf.net_forecast ?? 0) >= 0 ? "#4A7C59" : "#8B3A3A" }}>{fmt(pf.net_forecast)}</span>
          </span>
        </div>
        <div style={{ fontSize: 10, color: "#A89070", lineHeight: 1.5, marginTop: 6 }}>
          {pf.has_facts
            ? <>Внесено {coveragePct}% плановых затрат. Прогноз держится большего из плана и факта — экономия зачтётся, когда факт внесён полностью.</>
            : <>Факта ещё нет — вноси расходы и выигрывай у плана.</>}
          {pf.tax > 0 && <> УСН {fmt(pf.tax)} уже вычтен.</>}
        </div>
      </div>
    </div>
  );
}
