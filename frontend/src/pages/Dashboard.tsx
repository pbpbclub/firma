import { fmtMoney as fmt } from "../components/ui/format";
import { QueryError } from "../components/ui/QueryError";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { financeApi, taxApi, ordersApi } from "../api";
import { MONO } from "../components/ui/Num";
import { DeadlinePill } from "../components/ui/Pill";
import { POLARITY, debtColor } from "../components/ui/type";
import { CircleProgress } from "../components/ui/CircleProgress";


function ThinBar({ pct, color = "#E8592A" }: { pct: number; color?: string }) {
  return (
    <div style={{ height: 2, background: "#EDEBE6" }}>
      <div style={{ height: 2, background: color, width: `${Math.min(100, pct)}%`, transition: "width 0.4s" }} />
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [reservesOpen, setReservesOpen] = useState(false);
  const freeCash = useQuery({ queryKey: ["free-cash"], queryFn: financeApi.freeCash });
  const balance = useQuery({ queryKey: ["balance"], queryFn: financeApi.balance });
  const taxes = useQuery({ queryKey: ["taxes"], queryFn: taxApi.summary });
  const debtors = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors });
  const dds = useQuery({ queryKey: ["dds-summary"], queryFn: financeApi.summary });
  const orders = useQuery({
    queryKey: ["orders-active"],
    queryFn: () => ordersApi.list({ status: "in_production" }),
  });
  const byBrand = useQuery({ queryKey: ["finance-by-brand"], queryFn: financeApi.byBrand });
  // A8: накладные месяца (аренда, расходники) и как они ложатся на заказы в работе
  const overhead = useQuery({ queryKey: ["overhead-summary"], queryFn: ordersApi.overheadSummary });

  // Любой упавший денежный запрос → баннер: раньше блоки просто исчезали
  // по одному и дашборд выглядел как «всё по нулям».
  const failed = [freeCash, balance, taxes, debtors, dds, orders].find(q => q.isError);

  const balanceTotal = balance.data?.total ?? 0;
  const taxToPay = taxes.data?.tax_to_pay ?? 0;
  const debtTotal = debtors.data?.total ?? 0;
  const monthIncome = dds.data?.current_month?.income ?? 0;
  const monthExpense = dds.data?.current_month?.expense ?? 0;
  const activeOrders: any[] = orders.data ?? [];
  const incomeYear = taxes.data?.income_year ?? 0;

  const threshold300k = Math.min(100, (incomeYear / 300000) * 100);
  const debtPct = (debtTotal + balanceTotal) > 0
    ? Math.min(100, debtTotal / (debtTotal + balanceTotal) * 100) : 0;
  const taxQuarter = taxes.data?.tax_quarter ?? 1;
  const taxPaidPct = taxQuarter > 0 ? Math.min(100, ((taxQuarter - taxToPay) / taxQuarter) * 100) : 100;

  const section = { padding: "20px 28px", borderBottom: "1px solid #EDEBE6" };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Любой упавший денежный запрос → баннер: раньше блоки просто исчезали
          по одному, и дашборд выглядел как «всё по нулям» */}
      {failed && <QueryError error={(failed as any).error} what="часть сводки" />}

      {/* Header */}
      <div style={{ padding: "24px 28px 20px", borderBottom: "1px solid #EDEBE6" }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
          {new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
        </div>
      </div>

      {/* Свободные деньги — ключевая цифра (остаток − резервы − фонды) */}
      {(() => {
        const fc = freeCash.data;
        if (!fc) return null;
        const neg = fc.negative;
        return (
          <div style={{ padding: "18px 28px", borderBottom: "1px solid #EDEBE6", background: neg ? "#FFF4EE" : "transparent" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>
                  СВОБОДНЫЕ ДЕНЬГИ
                  {neg && <span style={{ color: "#8B3A3A", marginLeft: 8, textTransform: "none", letterSpacing: 0 }}>· тратится больше, чем свободно</span>}
                </div>
                <div style={{ fontSize: 30, fontWeight: 700, color: neg ? "#8B3A3A" : "#4A7C59", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                  {fmt(fc.free)}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "#6B6355", fontFamily: MONO, fontVariantNumeric: "tabular-nums", textAlign: "right", lineHeight: 1.7 }}>
                <div>остаток <b style={{ color: "#1A1A1A" }}>{fmt(fc.balance)}</b></div>
                <div>− резервы <span
                  onClick={() => fc.reserves.length && setReservesOpen(v => !v)}
                  style={{ color: fc.reserved_total > 0 ? "#E8592A" : "#A89070", cursor: fc.reserves.length ? "pointer" : "default", borderBottom: fc.reserves.length ? "1px dashed #C8C0B0" : "none" }}
                >{fmt(fc.reserved_total)}</span></div>
                <div>− фонды <span style={{ color: fc.funds_total > 0 ? "#E8592A" : "#A89070" }}>{fmt(fc.funds_total)}</span></div>
              </div>
            </div>
            {reservesOpen && fc.reserves.length > 0 && (
              <div style={{ marginTop: 12, borderTop: "1px solid #EDEBE6", paddingTop: 10 }}>
                {fc.reserves.map((r: any) => (
                  <div key={r.order_id}
                    onClick={() => navigate(`/orders/${r.order_id}`)}
                    style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", cursor: "pointer", fontSize: 12, borderBottom: "1px solid #F2EFE9" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                    <span style={{ color: "#1A1A1A" }}>{r.title}</span>
                    <span style={{ color: "#E8592A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(r.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* 4 stat columns */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderBottom: "1px solid #EDEBE6" }}>
        {[
          { label: "НА СЧЕТАХ", value: fmt(balanceTotal), color: balanceTotal > 0 ? "#4A7C59" : "#8B3A3A", pct: 100 },
          { label: "ДЕБИТОРКА", value: fmt(debtTotal), color: debtColor(debtTotal, "in"), pct: debtPct },
          { label: "НАЛОГ К УПЛАТЕ", value: fmt(taxToPay), color: debtColor(taxToPay, "out"), pct: taxPaidPct },
          { label: "В ПРОИЗВОДСТВЕ", value: `${activeOrders.length} заказов`, color: "#1A1A1A", pct: Math.min(100, activeOrders.length * 10) },
        ].map((item, i) => (
          <div key={item.label} style={{
            padding: "20px 24px",
            borderRight: i < 3 ? "1px solid #EDEBE6" : "none",
          }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>{item.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: item.color, marginBottom: 14, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{item.value}</div>
            <ThinBar pct={item.pct} color={item.color} />
          </div>
        ))}
      </div>

      {/* Month DDS */}
      <div style={{ ...section, display: "flex", gap: 48, alignItems: "flex-start" }}>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", width: 80, paddingTop: 2 }}>ЭТОТ МЕСЯЦ</div>
        <div style={{ display: "flex", gap: 48, flex: 1 }}>
          {[
            { label: "Поступило", value: fmt(monthIncome), color: "#4A7C59", pct: 100 },
            { label: "Выбыло", value: fmt(monthExpense), color: "#8B3A3A", pct: monthIncome > 0 ? (monthExpense / monthIncome) * 100 : 0 },
            {
              label: "Итого",
              value: fmt(monthIncome - monthExpense),
              color: monthIncome - monthExpense >= 0 ? "#1A1A1A" : "#8B3A3A",
              pct: monthIncome > 0 ? Math.abs(monthIncome - monthExpense) / monthIncome * 100 : 0,
            },
          ].map((item) => (
            <div key={item.label} style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#A89070", marginBottom: 6 }}>{item.label}</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: item.color, marginBottom: 10, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{item.value}</div>
              <ThinBar pct={item.pct} color={item.color} />
            </div>
          ))}
        </div>
      </div>

      {/* По брендам */}
      {(() => {
        const rows = ((byBrand.data ?? []) as any[]).filter(b => b.income || b.expense || b.price_plan);
        if (rows.length === 0) return null;
        return (
          <div style={{ ...section, display: "flex", gap: 48, alignItems: "flex-start" }}>
            <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", width: 80, paddingTop: 2 }}>ПО БРЕНДАМ</div>
            <div style={{ display: "flex", gap: 36, flex: 1, flexWrap: "wrap" }}>
              {rows.map((b: any) => (
                <div key={b.brand} style={{ minWidth: 150 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: b.color || "#A89070" }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{b.brand}</span>
                  </div>
                  <div style={{ display: "flex", gap: 16 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#A89070" }}>ДОХОД</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(b.income)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#A89070" }}>ПРИБЫЛЬ</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: b.profit >= 0 ? "#1A1A1A" : "#8B3A3A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(b.profit)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Circular indicators */}
      <div style={{ ...section, display: "flex", gap: 48, alignItems: "center" }}>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", width: 80 }}>ПОКАЗАТЕЛИ</div>
        <div style={{ display: "flex", gap: 40 }}>
          {[
            { label: "Порог 300к", pct: threshold300k, sub: fmt(incomeYear) },
            { label: `Q${taxes.data?.quarter ?? "?"} налог`, pct: taxPaidPct, sub: taxToPay > 0 ? fmt(taxToPay) : "Покрыт" },
            { label: "Долг/баланс", pct: debtPct, sub: fmt(debtTotal) },
          ].map((item) => (
            <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <CircleProgress pct={item.pct} />
              <div>
                <div style={{ fontSize: 11, color: "#A89070" }}>{item.label}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", marginTop: 2 }}>{item.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Debtors — деньги, которые нам должны (зелёная полярность) */}
      {(debtors.data?.items?.length ?? 0) > 0 && (
        <div style={{ ...section, borderLeft: `3px solid ${POLARITY.in.rail}`, cursor: "pointer" }}
          onClick={() => navigate("/debtors")}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: POLARITY.in.color, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>Нам должны</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: POLARITY.in.color, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(debtTotal)}</div>
          </div>
          {debtors.data.items.slice(0, 4).map((d: any, i: number) => (
            <div key={i} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "10px 0",
              borderBottom: i < debtors.data.items.slice(0, 4).length - 1 ? "1px solid #F2EFE9" : "none",
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{d.customer_name}</div>
                <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{d.title}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <DeadlinePill date={d.deadline} />
                <div style={{ fontSize: 13, fontWeight: 700, color: debtColor(d.debt, "in"), fontFamily: MONO, fontVariantNumeric: "tabular-nums", minWidth: 92, textAlign: "right" }}>{fmt(d.debt)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* A8: накладные месяца — как аренда/расходники ложатся на заказы в работе.
          Влияние на общую экономику: маржа заказов без накладных суммарно выше
          реальной ровно на эту сумму. */}
      {(overhead.data?.month?.total ?? 0) > 0 && (
        <div style={section}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", marginBottom: 12 }}>
            НАКЛАДНЫЕ {overhead.data.month.period}
            <span style={{ marginLeft: 10, color: "#B8860B", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(overhead.data.month.total)}</span>
          </div>
          {(overhead.data.orders || []).length === 0 ? (
            <div style={{ fontSize: 12, color: "#6B6355" }}>
              Заказов в производстве нет — накладные месяца не распределены и целиком уменьшают общую прибыль.
            </div>
          ) : (
            (overhead.data.orders || []).map((r: any, i: number, arr: any[]) => (
              <div key={r.order_id} style={{
                display: "flex", alignItems: "baseline", gap: 10, paddingBottom: 8,
                marginBottom: i < arr.length - 1 ? 8 : 0,
                borderBottom: i < arr.length - 1 ? "1px solid #F2EFE9" : "none",
              }}>
                <div style={{ fontSize: 12, color: "#1A1A1A", flex: 1 }}>{r.title}</div>
                <div style={{ fontSize: 10, color: "#A89070", fontFamily: MONO }}>{Math.round(r.share * 100)}%</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#B8860B", fontFamily: MONO, fontVariantNumeric: "tabular-nums", minWidth: 80, textAlign: "right" }}>−{fmt(r.amount)}</div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Active orders */}
      {activeOrders.length > 0 && (
        <div style={section}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", marginBottom: 16 }}>В ПРОИЗВОДСТВЕ</div>
          {activeOrders.slice(0, 5).map((o: any, i: number) => {
            const paid = o.paid_total ?? 0;
            const plan = o.price_plan ?? 0;
            const p = plan > 0 ? Math.min(100, (paid / plan) * 100) : 0;
            return (
              <div key={o.id} style={{
                paddingBottom: 14, marginBottom: i < Math.min(4, activeOrders.length - 1) ? 14 : 0,
                borderBottom: i < Math.min(4, activeOrders.length - 1) ? "1px solid #F2EFE9" : "none",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{o.title}</div>
                    <div style={{ fontSize: 11, color: "#A89070" }}>{o.customer_name || "—"}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(plan)}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1 }}><ThinBar pct={p} /></div>
                  <div style={{ fontSize: 10, color: "#A89070", minWidth: 28, textAlign: "right", fontFamily: MONO }}>{Math.round(p)}%</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
