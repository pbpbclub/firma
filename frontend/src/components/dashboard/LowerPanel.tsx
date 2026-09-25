// Нижняя часть главной в стиле шапки и «Недели»: что делать, заказы в производстве
// (оплата и себестоимость полосами), бренды (доход = расходы + прибыль), нам должны /
// мы должны рядом, накладные сегментной полосой. Цифры — готовые ответы ручек,
// своей денежной арифметики здесь нет: только доли для ширины полос.
import { useNavigate } from "react-router-dom";
import { MONO } from "../ui/Num";
import { fmtMoney as fmt } from "../ui/format";
import { POLARITY, debtColor } from "../ui/type";
import { DeadlinePill } from "../ui/Pill";
import { OrderLink } from "../ui/links";
import { SegBar } from "../ui/SegBar";
import { BudgetBar } from "../ui/BudgetBar";

const NUM = { fontFamily: MONO, fontVariantNumeric: "tabular-nums" } as const;
const LABEL = { fontSize: 11, color: "#A89070", letterSpacing: "0.06em" } as const;
const OVERHEAD_SHADES = ["#B8860B", "#CFA64A", "#E0C58A", "#EDDDB8"];

export type Todo = { label: string; value: number; hint: string; to: string; tone: string };

function Head({ title, right, onClick }: { title: string; right?: React.ReactNode; onClick?: () => void }) {
  return (
    <div onClick={onClick} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
                                    marginBottom: 14, cursor: onClick ? "pointer" : "default" }}>
      <span style={LABEL}>{title}</span>
      {right}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return <span style={{ display: "inline-block", width: 8, height: 8, background: color, marginRight: 6, flexShrink: 0 }} />;
}

export function LowerPanel({ todo, byBrand, debtors, ledger, creditors, overhead, orders, isMobile }: {
  todo: Todo[]; byBrand: any[]; debtors: any; ledger: any; creditors: any; overhead: any; orders: any[]; isMobile: boolean;
}) {
  const navigate = useNavigate();
  const pad = isMobile ? "16px 16px" : "22px 28px";
  const grid = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", borderBottom: "1px solid #EDEBE6" } as const;
  const left = { padding: pad, minWidth: 0, borderRight: isMobile ? "none" : "1px solid #EDEBE6",
                 borderBottom: isMobile ? "1px solid #F2EFE9" : "none" } as const;
  const right = { padding: pad, minWidth: 0 } as const;
  const hover = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => (e.currentTarget.style.background = "#FAF8F5"),
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => (e.currentTarget.style.background = "transparent"),
  };

  // «Без бренда» на главной не показываем (Юра 25.09.2026: не актуально) — там
  // случайные заказы без бренда, а не направление.
  const brands = (byBrand ?? []).filter(b => b.brand !== "Без бренда" && (b.income || b.expense || b.price_plan));
  const brandMax = Math.max(1, ...brands.map(b => Math.max(b.income || 0, b.expense || 0)));

  const debtItems: any[] = debtors?.items ?? [];
  const debtMax = Math.max(1, ...debtItems.map(d => d.debt || 0));
  const owe: any[] = (ledger?.items ?? []).filter((m: any) => m.balance > 0);
  const oweMax = Math.max(1, ...owe.map(m => m.balance));
  const weOwe = ledger?.we_owe ?? 0;

  const ovTotal = overhead?.month?.total ?? 0;
  const ovOrders: any[] = (overhead?.orders ?? []).filter((r: any) => r.amount > 0);

  return (
    <div>
      {/* ЧТО ДЕЛАТЬ — карточки-двери с цветной планкой сверху */}
      <div style={{ padding: pad, borderBottom: "1px solid #EDEBE6" }}>
        <Head title="ЧТО ДЕЛАТЬ" right={todo.length === 0
          ? <span style={{ fontSize: 12, color: "#4A7C59" }}>ничего не горит</span> : undefined} />
        {todo.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : `repeat(${todo.length}, 1fr)`, gap: 10 }}>
            {todo.map(t => (
              <button type="button" key={t.label} onClick={() => navigate(t.to)} {...hover}
                style={{ border: "1px solid #EDEBE6", borderTop: `3px solid ${t.tone}`, background: "transparent",
                         padding: "12px 14px", cursor: "pointer", textAlign: "left", fontFamily: "inherit", minWidth: 0 }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: t.tone, lineHeight: 1, ...NUM }}>{t.value}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", marginTop: 8 }}>{t.label}</div>
                <div style={{ fontSize: 11, color: "#A89070", marginTop: 3, lineHeight: 1.35 }}>{t.hint}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* В ПРОИЗВОДСТВЕ | ПО БРЕНДАМ */}
      {(orders.length > 0 || brands.length > 0) && (
        <div style={grid}>
          <div style={left}>
            <Head title="В ПРОИЗВОДСТВЕ" onClick={() => navigate("/orders")}
                  right={<span style={{ fontSize: 11, color: "#6B6355", ...NUM }}>{orders.length} зак.</span>} />
            {orders.length === 0 && <div style={{ fontSize: 12, color: "#6B6355" }}>В производстве пусто.</div>}
            {orders.slice(0, 6).map((o, i, arr) => {
              const plan = o.price_plan ?? 0;
              const paid = Math.min(o.paid_total ?? 0, plan || Infinity);
              const pct = plan > 0 ? Math.round((o.paid_total ?? 0) / plan * 100) : 0;
              return (
                <div key={o.id} style={{ padding: "10px 0", borderBottom: i < arr.length - 1 ? "1px solid #F2EFE9" : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <OrderLink id={o.id}>{o.title}</OrderLink>
                      </div>
                      <div style={{ fontSize: 11, color: "#A89070" }}>{o.customer_name || "—"}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                      <DeadlinePill date={o.deadline} />
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", ...NUM }}>{fmt(plan)}</div>
                    </div>
                  </div>
                  {/* Оплата: получено зелёным (правило — зелёным только полученные деньги) */}
                  <div style={{ display: "grid", gridTemplateColumns: "88px 1fr 40px", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 10, color: "#A89070" }}>оплата</span>
                    <SegBar height={4} total={Math.max(plan, 1)}
                            segments={[{ value: paid, color: "#4A7C59", label: `оплачено ${fmt(o.paid_total ?? 0)}` }]} />
                    <span style={{ fontSize: 10, color: "#6B6355", textAlign: "right", ...NUM }}>{pct}%</span>
                  </div>
                  {(o.cost_plan > 0 || o.cost_fact > 0) && (
                    <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", alignItems: "start", gap: 10, marginTop: 6 }}>
                      <span style={{ fontSize: 10, color: "#A89070", paddingTop: 4 }}>себестоимость</span>
                      <BudgetBar fact={o.cost_fact ?? 0} plan={o.cost_plan ?? 0} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={right}>
            <Head title="ПО БРЕНДАМ И НАПРАВЛЕНИЯМ" right={
              <span style={{ fontSize: 10, color: "#A89070", display: "inline-flex", alignItems: "center", gap: 10 }}>
                <span style={{ display: "inline-flex", alignItems: "center" }}><Swatch color="#C8C0B0" />расходы</span>
                <span>цвет бренда — прибыль</span>
              </span>} />
            {brands.map((b, i) => {
              const margin = b.income > 0 ? Math.round(b.profit / b.income * 100) : null;
              return (
                <div key={b.brand} style={{ padding: "10px 0", borderBottom: i < brands.length - 1 ? "1px solid #F2EFE9" : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", fontSize: 13, fontWeight: 600, color: "#1A1A1A", minWidth: 0 }}>
                      <Swatch color={b.color || "#A89070"} />{b.brand}
                      <span style={{ fontSize: 11, fontWeight: 400, color: "#A89070", marginLeft: 8 }}>{b.orders_count} зак.</span>
                    </span>
                    <span style={{ fontSize: 11, color: "#A89070", whiteSpace: "nowrap", ...NUM }}>
                      доход <b style={{ color: "#4A7C59" }}>{fmt(b.income)}</b>
                    </span>
                  </div>
                  {/* Доход = расходы + прибыль; прибыль — цветом бренда (различает бренды,
                      не «хорошо/плохо»). Убыточный бренд — красная подпись ниже. */}
                  <SegBar height={6} total={brandMax} segments={[
                    { value: Math.min(b.expense || 0, b.income || 0), color: "#C8C0B0", label: `расходы ${fmt(b.expense)}` },
                    { value: Math.max(0, b.profit || 0), color: b.color || "#1A1A1A", label: `прибыль ${fmt(b.profit)}` },
                  ]} />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#A89070", marginTop: 6, ...NUM }}>
                    <span>расходы <b style={{ color: "#1A1A1A", fontWeight: 600 }}>{fmt(b.expense)}</b></span>
                    <span>прибыль <b style={{ color: b.profit < 0 ? "#8B3A3A" : "#1A1A1A" }}>{fmt(b.profit)}</b>
                      {margin != null && <span style={{ marginLeft: 6 }}>· {margin}%</span>}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* НАМ ДОЛЖНЫ | МЫ ДОЛЖНЫ — зеркально, зелёная и красная планки слева */}
      <div style={grid}>
        <div style={{ ...left, boxShadow: `inset 3px 0 0 ${POLARITY.in.rail}` }}>
          <Head title="НАМ ДОЛЖНЫ" onClick={() => navigate("/debtors")}
                right={<span style={{ fontSize: 16, fontWeight: 700, color: debtColor(debtors?.total ?? 0, "in"), ...NUM }}>{fmt(debtors?.total ?? 0)}</span>} />
          {debtItems.length === 0 && <div style={{ fontSize: 12, color: "#6B6355" }}>Клиенты ничего не должны.</div>}
          {debtItems.slice(0, 5).map((d, i, arr) => (
            <div key={i} style={{ padding: "8px 0", borderBottom: i < arr.length - 1 ? "1px solid #F2EFE9" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.customer_name}</div>
                  <div style={{ fontSize: 11, color: "#A89070", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                  <DeadlinePill date={d.deadline} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: debtColor(d.debt, "in"), ...NUM }}>{fmt(d.debt)}</span>
                </div>
              </div>
              <SegBar height={3} total={debtMax} segments={[{ value: d.debt, color: POLARITY.in.color }]} />
            </div>
          ))}
          {debtItems.length > 5 && (
            <div style={{ fontSize: 11, color: "#A89070", marginTop: 8 }}>ещё {debtItems.length - 5} — в «Обязательствах»</div>
          )}
        </div>
        <div style={{ ...right, boxShadow: `inset 3px 0 0 ${POLARITY.out.rail}` }}>
          {/* Сальдо лицевых счетов — одно число на человека (ТЗ 03.09.2026). Остаток плана
              смет — золотым: это НЕ долг (ещё не заказано), путать их дорого. */}
          <Head title="МЫ ДОЛЖНЫ" onClick={() => navigate("/debtors")}
                right={<span style={{ fontSize: 16, fontWeight: 700, color: debtColor(weOwe, "out"), ...NUM }}>{fmt(weOwe)}</span>} />
          {owe.length === 0 && <div style={{ fontSize: 12, color: "#6B6355" }}>Подрядчикам и поставщикам ничего не должны.</div>}
          {owe.slice(0, 5).map((m, i, arr) => (
            <div key={m.master_id} style={{ padding: "8px 0", borderBottom: i < arr.length - 1 ? "1px solid #F2EFE9" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: debtColor(m.balance, "out"), ...NUM }}>{fmt(m.balance)}</span>
              </div>
              <SegBar height={3} total={oweMax} segments={[{ value: m.balance, color: POLARITY.out.color }]} />
            </div>
          ))}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
            <div onClick={() => navigate("/debtors")} style={{ cursor: "pointer", borderTop: "2px solid #B8860B", paddingTop: 8 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>ОСТАЛОСЬ ПОТРАТИТЬ · НЕ ДОЛГ</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#B8860B", marginTop: 4, ...NUM }}>{fmt(creditors?.plan_rest_total ?? 0)}</div>
              <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>{creditors?.plan_rest_count ?? 0} строк смет в работе</div>
            </div>
            <div onClick={() => navigate("/debtors")} style={{ cursor: "pointer", borderTop: "2px solid #4A7C59", paddingTop: 8 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>МОЖНО ЗАКРЫТЬ</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: (creditors?.closable_total ?? 0) > 0 ? "#4A7C59" : "#6B6355", marginTop: 4, ...NUM }}>{fmt(creditors?.closable_total ?? 0)}</div>
              <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>{creditors?.closable_count ?? 0} обязательств</div>
            </div>
          </div>
        </div>
      </div>

      {/* НАКЛАДНЫЕ — как аренда/расходники месяца ложатся на заказы в работе (A8) */}
      {ovTotal > 0 && (
        <div style={{ padding: pad, borderBottom: "1px solid #EDEBE6" }}>
          <Head title={`НАКЛАДНЫЕ · ${overhead.month.period}`}
                right={<span style={{ fontSize: 16, fontWeight: 700, color: "#B8860B", ...NUM }}>{fmt(ovTotal)}</span>} />
          {ovOrders.length === 0 ? (
            <div style={{ fontSize: 12, color: "#6B6355" }}>
              Заказов в производстве нет — накладные месяца не распределены и целиком уменьшают общую прибыль.
            </div>
          ) : (
            <>
              <SegBar height={8} total={ovTotal} segments={ovOrders.map((r, i) => ({
                value: r.amount, color: OVERHEAD_SHADES[i % OVERHEAD_SHADES.length], label: `${r.title}: ${fmt(r.amount)}` }))} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", marginTop: 10 }}>
                {ovOrders.map((r, i) => (
                  <span key={r.order_id} style={{ display: "inline-flex", alignItems: "center", fontSize: 12, color: "#1A1A1A", minWidth: 0 }}>
                    <Swatch color={OVERHEAD_SHADES[i % OVERHEAD_SHADES.length]} />
                    <OrderLink id={r.order_id}>{r.title}</OrderLink>
                    <span style={{ fontSize: 11, color: "#A89070", margin: "0 6px", ...NUM }}>{Math.round(r.share * 100)}%</span>
                    <b style={{ color: "#B8860B", ...NUM }}>−{fmt(r.amount)}</b>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
