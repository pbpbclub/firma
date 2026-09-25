import { fmtMoney as fmt } from "../components/ui/format";
import { QueryError } from "../components/ui/QueryError";
import { SkeletonRows } from "../components/ui/Loading";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { financeApi, taxApi, ordersApi, reportsApi, estimatesApi, ledgerApi } from "../api";
import { MONO } from "../components/ui/Num";
import { DeadlinePill } from "../components/ui/Pill";
import { POLARITY, debtColor } from "../components/ui/type";
import { CardButton } from "../components/CardButton";
import { OrderLink } from "../components/ui/links";
import { useIsMobile, M } from "../components/ui/responsive";
import { WeekPanel } from "../components/dashboard/WeekPanel";
import { HeroPanel } from "../components/dashboard/HeroPanel";


function ThinBar({ pct, color = "#E8592A" }: { pct: number; color?: string }) {
  return (
    <div style={{ height: 2, background: "#EDEBE6" }}>
      <div style={{ height: 2, background: color, width: `${Math.min(100, pct)}%`, transition: "width 0.4s" }} />
    </div>
  );
}

// Главная висит на мониторе днём — цифры обновляются сами, без F5.
const LIVE = { refetchInterval: 5 * 60_000 };

export default function Dashboard() {
  const navigate = useNavigate();
  const freeCash = useQuery({ queryKey: ["free-cash"], queryFn: financeApi.freeCash, ...LIVE });
  const balance = useQuery({ queryKey: ["balance"], queryFn: financeApi.balance, ...LIVE });
  const taxes = useQuery({ queryKey: ["taxes"], queryFn: taxApi.summary, ...LIVE });
  const debtors = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors, ...LIVE });
  const dds = useQuery({ queryKey: ["dds-summary"], queryFn: financeApi.summary, ...LIVE });
  const orders = useQuery({
    queryKey: ["orders-active"],
    queryFn: () => ordersApi.list({ status: "in_production" }),
    ...LIVE,
  });
  const byBrand = useQuery({ queryKey: ["finance-by-brand"], queryFn: financeApi.byBrand });
  // «Что делать» — бэкенд считал это давно, а лежало оно за двумя кликами внутри Заказов.
  const silent = useQuery({ queryKey: ["orders-silent"], queryFn: ordersApi.silent, ...LIVE });
  const readiness = useQuery({ queryKey: ["estimates-readiness"], queryFn: estimatesApi.readiness });
  const pfSummary = useQuery({ queryKey: ["orders-plan-fact-summary", "active"],
                               queryFn: () => ordersApi.planFactSummary("active") });
  const creditors = useQuery({ queryKey: ["creditors"], queryFn: () => financeApi.creditors() });
  // «Мы должны» — сальдо лицевых счетов, одно число на человека (ТЗ 03.09.2026).
  const ledger = useQuery({ queryKey: ["ledger-balances"], queryFn: () => ledgerApi.balances() });
  // A8: накладные месяца (аренда, расходники) и как они ложатся на заказы в работе
  const overhead = useQuery({ queryKey: ["overhead-summary"], queryFn: ordersApi.overheadSummary });

  // Любой упавший денежный запрос → баннер: раньше блоки просто исчезали
  // по одному и дашборд выглядел как «всё по нулям».
  const failed = [freeCash, balance, taxes, debtors, dds, orders].find(q => q.isError);

  const debtTotal = debtors.data?.total ?? 0;
  const activeOrders: any[] = orders.data ?? [];


  // Телефон: гаттер 16, подписи секций («ЭТОТ МЕСЯЦ», «ПО БРЕНДАМ») стопкой над
  // содержимым вместо колонки width:80 + gap:48 — из 358px они съедали 128.
  const isMobile = useIsMobile();
  const section = { padding: isMobile ? "16px 16px" : "20px 28px", borderBottom: "1px solid #EDEBE6" };
  const labeled = { ...section, display: "flex", gap: 48, alignItems: "flex-start", ...(isMobile ? M.labeled : null) } as const;
  const labelStyle = { fontSize: 11, color: "#A89070", letterSpacing: "0.04em", width: isMobile ? "auto" : 80, paddingTop: 2 } as const;

  // ── Что горит: цифры уже посчитаны бэком, здесь только собраны в строку ──
  const rs = readiness.data?.summary ?? {};
  const holes = (rs.orders_with_duplicates ?? 0) + (rs.invoice_drift ?? 0)
              + (rs.transit_as_bank ?? 0) + (rs.tx_overspread ?? 0) + (rs.stub_items ?? 0);
  const overspent = ((pfSummary.data?.orders ?? []) as any[]).filter(o => o.overspent).length;
  const todo = [
    { label: "Молчат", value: silent.data?.total ?? 0,
      hint: (silent.data?.archive_candidates ?? 0) > 0 ? `${silent.data.archive_candidates} — кандидаты в архив` : "просчёты без движения",
      to: "/orders?mode=silent", tone: "#E8592A" },
    { label: "Дыры в сметах", value: holes,
      hint: "дубли, расхождение со счётом, заглушки", to: "/orders?mode=ready", tone: "#8B3A3A" },
    { label: "Перерасход", value: overspent,
      hint: "факт выше плана сметы", to: "/orders?mode=summary", tone: "#8B3A3A" },
    { label: "Можно закрыть", value: creditors.data?.closable_count ?? 0,
      hint: creditors.data?.closable_total ? `обязательств на ${fmt(creditors.data.closable_total)}` : "обязательств по завершённым",
      to: "/debtors", tone: "#4A7C59" },
  ].filter(t => t.value > 0);

  // Дашборд грузится восемью параллельными запросами, и каждый блок появлялся
  // сам по себе — экран прыгал 5–8 раз. Пока не пришли денежные ответы, держим
  // скелет: SkeletonRows был написан и не вызывался ни разу.
  const coreLoading = [freeCash, balance, taxes, debtors, dds, orders].some(q => q.isLoading);

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Любой упавший денежный запрос → баннер: раньше блоки просто исчезали
          по одному, и дашборд выглядел как «всё по нулям» */}
      {failed && <QueryError error={(failed as any).error} what="часть сводки" />}

      {/* Header */}
      <div style={{ padding: isMobile ? "16px 16px 14px" : "24px 28px 20px", borderBottom: "1px solid #EDEBE6" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: isMobile ? "wrap" : undefined }}>
          <div style={{ fontSize: isMobile ? 22 : 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
            {new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
            {freeCash.dataUpdatedAt > 0 && (
              <span style={{ fontSize: 11, fontWeight: 400, color: "#A89070", letterSpacing: 0, marginLeft: 14 }}>
                обновлено {new Date(freeCash.dataUpdatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
          {/* Тот же срез, что финагент присылает в Telegram: деньги месяца, заказы, долги. */}
          <CardButton label="Срез за месяц"
            filename={`Срез — ${new Date().toLocaleDateString("ru-RU", { month: "long", year: "numeric" })}.pdf`}
            fetcher={() => reportsApi.monthCard()} />
        </div>
      </div>

      {coreLoading && <SkeletonRows rows={9} cols={4} padding="18px 28px" />}

      {/* Шапка: свободные деньги, деньги по месяцам, пульс, плитки-двери */}
      {!coreLoading && (
        <HeroPanel freeCash={freeCash.data} balance={balance.data} taxes={taxes.data}
                   debtors={debtors.data} dds={dds.data} orders={activeOrders} isMobile={isMobile} />
      )}

      {/* Неделя — блоки недельного отчёта фин-агента: спидометры маржи, план/факт,
          «Молчат» с порогами, приход по неделям и кварталам */}
      <WeekPanel silent={silent.data} isMobile={isMobile} />

      {/* Что горит: то, что требует решения. Ни одна из этих цифр не новая —
          они лежали за двумя кликами внутри Заказов и на главную не попадали. */}
      {todo.length > 0 && (
        <div style={labeled}>
          <div style={labelStyle}>ЧТО ДЕЛАТЬ</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", flex: 1 }}>
            {todo.map(t => (
              <button type="button" key={t.label} onClick={() => navigate(t.to)}
                style={{ border: "1px solid #EDEBE6", background: "#fff", padding: isMobile ? "10px 14px" : "8px 14px",
                         cursor: "pointer", textAlign: "left", fontFamily: "inherit", minWidth: 150,
                         flex: isMobile ? "1 1 150px" : undefined }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = t.tone)}
                onMouseLeave={e => (e.currentTarget.style.borderColor = "#EDEBE6")}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 18, fontWeight: 700, color: t.tone, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{t.value}</span>
                  <span style={{ fontSize: 12, color: "#1A1A1A", fontWeight: 500 }}>{t.label}</span>
                </div>
                <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>{t.hint}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* По брендам */}
      {(() => {
        const rows = ((byBrand.data ?? []) as any[]).filter(b => b.income || b.expense || b.price_plan);
        if (rows.length === 0) return null;
        return (
          <div style={labeled}>
            <div style={labelStyle}>ПО БРЕНДАМ</div>
            <div style={{ display: "flex", gap: isMobile ? 20 : 36, flex: 1, flexWrap: "wrap" }}>
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

      {/* Мы должны — зеркало «Нам должны»: сальдо лицевых счетов, одна строка на
          человека (ТЗ 03.09.2026). Остаток плана смет рядом золотым: это НЕ долг
          (ещё не заказано), путать их дорого. */}
      {((ledger.data?.we_owe ?? 0) > 0 || (creditors.data?.plan_rest_total ?? 0) > 0) && (
        <div style={{ ...section, borderLeft: `3px solid ${POLARITY.out.rail}`, cursor: "pointer" }}
          onClick={() => navigate("/debtors")}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: POLARITY.out.color, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>Мы должны</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: debtColor(ledger.data?.we_owe ?? 0, "out"), fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
              {fmt(ledger.data?.we_owe ?? 0)}
            </div>
          </div>
          {(ledger.data?.items ?? []).filter((m: any) => m.balance > 0).slice(0, 4).map((m: any, i: number, arr: any[]) => (
            <div key={m.master_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                                            padding: "8px 0", borderBottom: i < arr.length - 1 ? "1px solid #F2EFE9" : "none" }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{m.name}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: debtColor(m.balance, "out"), fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(m.balance)}</div>
            </div>
          ))}
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginTop: 12 }}>
            {(creditors.data?.plan_rest_total ?? 0) > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "#A89070" }}>ОСТАЛОСЬ ПОТРАТИТЬ · НЕ ДОЛГ</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#B8860B", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(creditors.data.plan_rest_total)}</div>
              </div>
            )}
            {(creditors.data?.closable_total ?? 0) > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "#A89070" }}>МОЖНО ЗАКРЫТЬ</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(creditors.data.closable_total)}</div>
              </div>
            )}
          </div>
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
                <div style={{ fontSize: 12, color: "#1A1A1A", flex: 1 }}>
                  <OrderLink id={r.order_id}>{r.title}</OrderLink>
                </div>
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
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", marginBottom: 16, cursor: "pointer" }}
            onClick={() => navigate("/orders")}>В ПРОИЗВОДСТВЕ</div>
          {activeOrders.slice(0, 5).map((o: any, i: number) => {
            const paid = o.paid_total ?? 0;
            const plan = o.price_plan ?? 0;
            const p = plan > 0 ? Math.min(100, (paid / plan) * 100) : 0;
            return (
              <div key={o.id}
                onClick={() => navigate(`/orders/${o.id}`)}
                style={{
                paddingBottom: 14, marginBottom: i < Math.min(4, activeOrders.length - 1) ? 14 : 0,
                borderBottom: i < Math.min(4, activeOrders.length - 1) ? "1px solid #F2EFE9" : "none",
                cursor: "pointer",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{o.title}</div>
                    <div style={{ fontSize: 11, color: "#A89070" }}>{o.customer_name || "—"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {/* Дедлайн приходил с бэка и не показывался ни здесь, ни в списке заказов. */}
                    <DeadlinePill date={o.deadline} />
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(plan)}</div>
                  </div>
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
