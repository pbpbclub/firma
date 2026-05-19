import { useQuery } from "@tanstack/react-query";
import { financeApi, taxApi, ordersApi } from "../api";

function fmt(n: number) {
  if (!n && n !== 0) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function CircleProgress({ pct, size = 64 }: { pct: number; size?: number }) {
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
        stroke="#E8592A" strokeWidth={stroke}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cx})`}
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
      <text x={cx} y={cx + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#1A1A1A">
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

function ThinBar({ pct, color = "#E8592A" }: { pct: number; color?: string }) {
  return (
    <div style={{ height: 2, background: "#EDEBE6" }}>
      <div style={{ height: 2, background: color, width: `${Math.min(100, pct)}%`, transition: "width 0.4s" }} />
    </div>
  );
}

export default function Dashboard() {
  const balance = useQuery({ queryKey: ["balance"], queryFn: financeApi.balance });
  const taxes = useQuery({ queryKey: ["taxes"], queryFn: taxApi.summary });
  const debtors = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors });
  const dds = useQuery({ queryKey: ["dds-summary"], queryFn: financeApi.summary });
  const orders = useQuery({
    queryKey: ["orders-active"],
    queryFn: () => ordersApi.list({ status: "in_production" }),
  });

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

      {/* Header */}
      <div style={{ padding: "24px 28px 20px", borderBottom: "1px solid #EDEBE6" }}>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>
          {new Date().toLocaleDateString("ru-RU", { month: "short", year: "numeric" }).toUpperCase().replace(" ", "'")}
        </div>
        <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
          {new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
        </div>
      </div>

      {/* 4 stat columns */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderBottom: "1px solid #EDEBE6" }}>
        {[
          { label: "НА СЧЕТАХ", value: fmt(balanceTotal), color: balanceTotal > 0 ? "#4A7C59" : "#8B3A3A", pct: 100 },
          { label: "ДЕБИТОРКА", value: fmt(debtTotal), color: "#E8592A", pct: debtPct },
          { label: "НАЛОГ К УПЛАТЕ", value: fmt(taxToPay), color: taxToPay > 0 ? "#E8592A" : "#4A7C59", pct: taxPaidPct },
          { label: "В ПРОИЗВОДСТВЕ", value: `${activeOrders.length} заказов`, color: "#1A1A1A", pct: Math.min(100, activeOrders.length * 10) },
        ].map((item, i) => (
          <div key={item.label} style={{
            padding: "20px 24px",
            borderRight: i < 3 ? "1px solid #EDEBE6" : "none",
          }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>{item.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: item.color, marginBottom: 14 }}>{item.value}</div>
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
              <div style={{ fontSize: 17, fontWeight: 700, color: item.color, marginBottom: 10 }}>{item.value}</div>
              <ThinBar pct={item.pct} color={item.color} />
            </div>
          ))}
        </div>
      </div>

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

      {/* Debtors */}
      {(debtors.data?.items?.length ?? 0) > 0 && (
        <div style={section}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", marginBottom: 16 }}>ДОЛЖНИКИ</div>
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
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#E8592A" }}>{fmt(d.debt)}</div>
                {d.deadline && (
                  <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>
                    до {new Date(d.deadline).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                  </div>
                )}
              </div>
            </div>
          ))}
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
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{fmt(plan)}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1 }}><ThinBar pct={p} /></div>
                  <div style={{ fontSize: 10, color: "#A89070", minWidth: 28, textAlign: "right" }}>{Math.round(p)}%</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
