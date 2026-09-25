// Шапка главной: свободные деньги, деньги по месяцам, пульс и четыре плитки-двери
// (на счетах, дебиторка, налог, производство) — у каждой своя инфографика вместо
// одинаковой 2px-полоски. Главная висит на мониторе: полосы растут, стрелки доезжают,
// данные обновляются сами (refetchInterval в Dashboard). Своей денежной арифметики
// тут нет — только доли от готовых сумм ручек.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { reportsApi, zenmoneyApi } from "../../api";
import { MONO } from "../ui/Num";
import { fmtMoney as fmt } from "../ui/format";
import { debtColor } from "../ui/type";
import { Gauge, type GaugeTone } from "../ui/Gauge";
import { SegBar, useGrow } from "../ui/SegBar";

const NUM = { fontFamily: MONO, fontVariantNumeric: "tabular-nums" } as const;
const LABEL = { fontSize: 11, color: "#A89070", letterSpacing: "0.06em" } as const;
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
// Оттенки одного сегмента-ряда: различают части, не кодируют «хорошо/плохо».
const SHADES_GREEN = ["#4A7C59", "#6E9A7B", "#98B8A1", "#C3D5C8"];
const SHADES_NEUTRAL = ["#1A1A1A", "#6B6355", "#A89070", "#C8C0B0"];

function Legend({ items }: { items: { color: string; label: string; value: number }[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 8 }}>
      {items.map(i => (
        <span key={i.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#6B6355", minWidth: 0 }}>
          <span style={{ width: 8, height: 8, background: i.color, flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>{i.label}</span>
          <b style={{ color: "#1A1A1A", fontWeight: 600, whiteSpace: "nowrap", ...NUM }}>{fmt(i.value)}</b>
        </span>
      ))}
    </div>
  );
}

/** Top-N сегментов + «прочие» — чтобы полоса не рассыпалась на крошки. */
function topSegments(rows: { label: string; value: number }[], shades: string[], n = 3) {
  const sorted = [...rows].filter(r => r.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, n);
  const rest = sorted.slice(n).reduce((a, r) => a + r.value, 0);
  const out = head.map((r, i) => ({ ...r, color: shades[i] }));
  if (rest > 0) out.push({ label: "прочие", value: rest, color: shades[n] ?? shades[shades.length - 1] });
  return out;
}

// Парные столбики «поступило / выбыло» по месяцам ДДС; текущий месяц — яркий.
// Столбик — две части: снизу р/с ИП (насыщенный), сверху личные счета (светлый).
const MONTH_PARTS = {
  income: [["ip_income", "#4A7C59"], ["cards_income", "#98B8A1"]],
  expense: [["ip_expense", "#8B3A3A"], ["cards_expense", "#C99A9A"]],
} as const;

function MonthBars({ rows, height }: { rows: any[]; height: number }) {
  const grow = useGrow();
  const max = Math.max(1, ...rows.flatMap(r => [r.income || 0, r.expense || 0]));
  const last = rows.length - 1;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height }}>
        {rows.map((r, i) => (
          <div key={r.month} title={`${r.month}\nпоступило ${fmt(r.income || 0)} (р/с ${fmt(r.ip_income || 0)} · личные ${fmt(r.cards_income || 0)})\nпотрачено ${fmt(r.expense || 0)} (р/с ${fmt(r.ip_expense || 0)} · личные ${fmt(r.cards_expense || 0)})`}
               style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "flex-end", gap: 2, height, opacity: i === last ? 1 : 0.45 }}>
            {(["income", "expense"] as const).map(k => (
              <div key={k} style={{ flex: 1, display: "flex", flexDirection: "column-reverse", gap: 1,
                                    height: grow ? Math.max((r[k] || 0) > 0 ? 2 : 0, (r[k] || 0) / max * height) : 0,
                                    transition: `height 0.7s cubic-bezier(.2,.7,.2,1) ${i * 40}ms`, overflow: "hidden" }}>
                {MONTH_PARTS[k].map(([part, c]) => (
                  <div key={part} style={{ flexGrow: r[part] || 0, flexBasis: 0, background: c }} />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, borderTop: "1px solid #EDEBE6", paddingTop: 4 }}>
        {rows.map((r, i) => (
          <div key={r.month} style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 10, ...NUM,
                                      color: i === last ? "#1A1A1A" : "#A89070", fontWeight: i === last ? 600 : 400 }}>
            {MONTHS[Number(String(r.month).slice(5, 7)) - 1] ?? r.month}
          </div>
        ))}
      </div>
    </div>
  );
}

function daysBetween(a: Date, b: Date) {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function HeroPanel({ freeCash, balance, taxes, creditors, debtors, dds, orders, isMobile }: {
  freeCash: any; balance: any; taxes: any; creditors: any; debtors: any; dds: any; orders: any[]; isMobile: boolean;
}) {
  const navigate = useNavigate();
  const [reservesOpen, setReservesOpen] = useState(false);
  // Личные карты — итог домашнего рублёвого контура; скоуп бухгалтера ручка режет сама.
  const cardsQ = useQuery({ queryKey: ["zm-accounts-summary"], queryFn: () => zenmoneyApi.accountsSummary(),
                           refetchInterval: 5 * 60_000 });
  const cardsRub = ((cardsQ.data?.totals ?? []) as any[]).find(t => t.currency === "RUB")?.total ?? null;

  const pad = isMobile ? "16px 16px" : "22px 28px";
  const fc = freeCash;
  const bal = balance?.total ?? 0;
  // Свободные деньги — ИП и личные счета вместе, без заграничного контура (решение
  // Юры 25.09.2026: «свободные деньги у меня на счетах ИП и на личных, кроме Грузии»).
  // Личные — домашний рублёвый контур `/zenmoney/accounts-summary` (Грузия туда не
  // входит по построению). Резервы и фонды вычитаются сначала из р/с ИП — это деньги
  // дела; что не покрыл р/с, ложится на личные.
  const cards = cardsRub ?? 0;
  const ipBal = fc?.balance ?? 0;
  const held = (fc?.reserved_total ?? 0) + (fc?.funds_total ?? 0);
  const totalMoney = ipBal + cards;
  const freeAll = totalMoney - held;
  const freeIp = Math.max(0, ipBal - held);
  const freeCards = Math.max(0, freeAll - freeIp);
  const freeNeg = freeAll < 0;
  // Деньги по месяцам — ИП и личные счета вместе, как «Свободные деньги» (решение Юры
  // 25.09.2026): с р/с деньги в основном уходят себе на карту, а тратятся с карт, и
  // «выбыло» по одному р/с показывало 17 тыс. при реальных ~370.
  const mm = useQuery({ queryKey: ["money-months"], queryFn: () => reportsApi.moneyMonths(7),
                        refetchInterval: 5 * 60_000 });
  const monthly: any[] = mm.data?.months ?? [];
  const cur = monthly[monthly.length - 1];
  const monthIncome = cur?.income ?? dds?.current_month?.income ?? 0;
  const monthExpense = cur?.expense ?? dds?.current_month?.expense ?? 0;

  // Производство: собрано / ждём — по заказам в работе
  const prodPlan = orders.reduce((a, o) => a + (o.price_plan || 0), 0);
  const prodPaid = orders.reduce((a, o) => a + Math.min(o.paid_total || 0, o.price_plan || 0), 0);
  const prodFrac = prodPlan > 0 ? prodPaid / prodPlan : null;

  // Налог: сколько прошло от начала квартала до срока уплаты
  const taxToPay = taxes?.tax_to_pay ?? 0;
  const q = taxes?.quarter ?? 1;
  const qStart = new Date(taxes?.year ?? new Date().getFullYear(), (q - 1) * 3, 1);
  const deadline = taxes?.deadline ? new Date(taxes.deadline) : null;
  const today = new Date();
  const daysLeft = deadline ? Math.max(0, daysBetween(today, deadline)) : null;
  const taxFrac = deadline ? Math.min(1, Math.max(0, daysBetween(qStart, today) / Math.max(1, daysBetween(qStart, deadline)))) : null;
  const taxTone: GaugeTone = taxToPay <= 0 ? "good" : daysLeft != null && daysLeft < 14 ? "bad" : "accent";

  // Расходы к приходу месяца: > 1 — тратим больше, чем пришло
  const burn = monthIncome > 0 ? monthExpense / monthIncome : null;
  const burnTone: GaugeTone = burn == null ? "muted" : burn > 1 ? "bad" : burn < 0.5 ? "good" : "accent";

  const debtItems: any[] = debtors?.items ?? [];
  const debtTotal = debtors?.total ?? 0;
  const debtSegs = topSegments(debtItems.map(d => ({ label: d.customer_name || d.title || "—", value: d.debt || 0 })), SHADES_GREEN);
  const accSegs = topSegments([
    ...((balance?.accounts ?? []) as any[]).map(a => ({ label: `${a.name} · ИП`, value: Math.max(0, a.balance || 0) })),
    ...(cardsRub != null ? [{ label: "личные счета", value: Math.max(0, cardsRub) }] : []),
  ], SHADES_NEUTRAL);

  const tileBase = {
    padding: isMobile ? "14px 16px" : "20px 24px", cursor: "pointer", minWidth: 0,
    display: "flex", flexDirection: "column", gap: 10,
  } as const;
  const hover = {
    onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.background = "#FAF8F5"),
    onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.background = "transparent"),
  };
  const big = (color: string, size = 22) => ({ fontSize: size, fontWeight: 700, color, letterSpacing: "-0.02em", ...NUM });

  const tiles = [
    {
      key: "acc", label: "НА СЧЕТАХ · ИП + ЛИЧНЫЕ", to: "/finance",
      body: (
        <>
          <div style={big(bal + cards > 0 ? "#1A1A1A" : "#8B3A3A")}>{fmt(bal + cards)}</div>
          <SegBar segments={accSegs.map(s => ({ ...s, label: `${s.label}: ${fmt(s.value)}` }))} />
          <Legend items={accSegs} />
        </>
      ),
    },
    {
      key: "debt", label: "ДЕБИТОРКА", to: "/debtors",
      body: (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={big(debtColor(debtTotal, "in"))}>{fmt(debtTotal)}</span>
            <span style={{ fontSize: 11, color: "#A89070" }}>{debtItems.length} зак.</span>
          </div>
          <SegBar segments={debtSegs.map(s => ({ ...s, label: `${s.label}: ${fmt(s.value)}` }))} />
          <Legend items={debtSegs} />
          {(debtors?.potential_total ?? 0) > 0 && (
            <div style={{ fontSize: 11, color: "#6B6355" }}>
              ждут оплаты · не долг <b style={{ color: "#B8860B", ...NUM }}>{fmt(debtors.potential_total)}</b>
            </div>
          )}
        </>
      ),
    },
    {
      key: "tax", label: "НАЛОГ К УПЛАТЕ", to: "/taxes",
      body: (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={big(debtColor(taxToPay, "out"))}>{fmt(taxToPay)}</span>
            <span style={{ fontSize: 11, color: "#A89070" }}>Q{q}</span>
          </div>
          {/* Полоса — время квартала до срока уплаты, засечка — сегодня */}
          <SegBar segments={[{ value: taxFrac ?? 0, color: taxTone === "bad" ? "#8B3A3A" : "#E8592A", label: "прошло квартала" },
                             { value: 1 - (taxFrac ?? 0), color: "#EDEBE6", label: "осталось" }]} total={1} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6B6355", ...NUM }}>
            <span>{deadline ? `срок ${deadline.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}` : "—"}</span>
            <b style={{ color: taxTone === "bad" ? "#8B3A3A" : "#1A1A1A" }}>{daysLeft != null ? `${daysLeft} дн.` : ""}</b>
          </div>
          <div style={{ fontSize: 11, color: "#A89070", ...NUM }}>
            доход квартала <b style={{ color: "#1A1A1A", fontWeight: 600 }}>{fmt(taxes?.income_quarter ?? 0)}</b>
          </div>
        </>
      ),
    },
    {
      key: "prod", label: "В ПРОИЗВОДСТВЕ", to: "/orders",
      body: (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={big("#1A1A1A")}>{fmt(prodPlan)}</span>
            <span style={{ fontSize: 11, color: "#A89070" }}>{orders.length} зак.</span>
          </div>
          <SegBar segments={[{ value: prodPaid, color: "#4A7C59", label: `собрано ${fmt(prodPaid)}` },
                             { value: Math.max(0, prodPlan - prodPaid), color: "#E8E4DA", label: `ждём ${fmt(prodPlan - prodPaid)}` }]} />
          <Legend items={[{ color: "#4A7C59", label: "собрано", value: prodPaid },
                          { color: "#E8E4DA", label: "ждём", value: Math.max(0, prodPlan - prodPaid) }]} />
        </>
      ),
    },
  ];

  return (
    <div>
      {/* Ряд 1: свободные деньги · деньги по месяцам · пульс */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1.15fr 1fr 1fr", borderBottom: "1px solid #EDEBE6" }}>
        {/* Свободные деньги — ключевая цифра (остаток − резервы − фонды) */}
        <div style={{ padding: pad, borderRight: isMobile ? "none" : "1px solid #EDEBE6",
                      borderBottom: isMobile ? "1px solid #F2EFE9" : "none",
                      background: freeNeg ? "#FFF4EE" : "transparent", minWidth: 0 }}>
          <div style={{ ...LABEL, marginBottom: 8 }}>
            СВОБОДНЫЕ ДЕНЬГИ
            <span style={{ letterSpacing: 0, marginLeft: 8, color: "#A89070" }}>· ИП и личные, без Грузии</span>
            {freeNeg && <span style={{ color: "#8B3A3A", marginLeft: 8, letterSpacing: 0 }}>· тратится больше, чем свободно</span>}
          </div>
          <div style={big(freeNeg ? "#8B3A3A" : "#4A7C59", isMobile ? 30 : 36)}>{fmt(freeAll)}</div>
          <div style={{ marginTop: 14 }}>
            <SegBar height={8} total={Math.max(totalMoney, held)}
              segments={[
                { value: freeIp, color: "#4A7C59", label: `свободно на р/с ИП ${fmt(freeIp)}` },
                { value: freeCards, color: "#98B8A1", label: `свободно на личных ${fmt(freeCards)}` },
                { value: fc?.reserved_total ?? 0, color: "#E8592A", label: `резервы ${fmt(fc?.reserved_total ?? 0)}` },
                { value: fc?.funds_total ?? 0, color: "#B8860B", label: `фонды ${fmt(fc?.funds_total ?? 0)}` },
              ]} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 8, fontSize: 11, color: "#6B6355", ...NUM }}>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, background: "#4A7C59", marginRight: 6 }} />
              р/с ИП <b style={{ color: "#1A1A1A" }}>{fmt(ipBal)}</b>
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, background: "#98B8A1", marginRight: 6 }} />
              личные <b style={{ color: "#1A1A1A" }}>{cardsRub == null ? "—" : fmt(cardsRub)}</b>
            </span>
            <span onClick={() => fc?.reserves?.length && setReservesOpen(v => !v)}
                  style={{ cursor: fc?.reserves?.length ? "pointer" : "default" }}>
              <span style={{ display: "inline-block", width: 8, height: 8, background: "#E8592A", marginRight: 6 }} />
              − резервы <b style={{ color: "#1A1A1A", borderBottom: fc?.reserves?.length ? "1px dashed #C8C0B0" : "none" }}>{fmt(fc?.reserved_total ?? 0)}</b>
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, background: "#B8860B", marginRight: 6 }} />
              − фонды <b style={{ color: "#1A1A1A" }}>{fmt(fc?.funds_total ?? 0)}</b>
            </span>
          </div>
          {/* Баланс: что имеем + что нам должны − что осталось потратить по сметам заказов
              в работе (решение Юры 25.09.2026). «Осталось потратить» — plan_rest, план, а
              не долг; сальдо «Мы должны» сюда НЕ прибавляется: начисления лицевого счёта
              строятся из тех же строк обязательств, сумма посчитала бы один долг дважды. */}
          {(() => {
            const debt = debtors?.total ?? 0;
            const rest = creditors?.plan_rest_total ?? 0;
            const result = freeAll + debt - rest;
            const scale = Math.max(Math.max(0, freeAll) + debt, rest, 1);
            return (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #F2EFE9" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
                  <span style={LABEL}>БАЛАНС</span>
                  <span style={big(result < 0 ? "#8B3A3A" : "#1A1A1A", 20)}>{result < 0 ? "−" : ""}{fmt(Math.abs(result))}</span>
                </div>
                <SegBar height={6} total={scale} segments={[
                  { value: Math.max(0, freeAll), color: "#4A7C59", label: `имеем ${fmt(freeAll)}` },
                  { value: debt, color: "#98B8A1", label: `нам должны ${fmt(debt)}` },
                ]} />
                {/* Расход — той же шкалой от правого края «плюса»: где кончается красное,
                    там и баланс */}
                <div style={{ position: "relative", height: 6, marginTop: 3 }}>
                  <div title={`осталось потратить ${fmt(rest)}`}
                       style={{ position: "absolute", top: 0, height: 6, background: "#8B3A3A",
                                right: `${(1 - (Math.max(0, freeAll) + debt) / scale) * 100}%`,
                                width: `${rest / scale * 100}%`, transition: "width 0.7s" }} />
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 8, fontSize: 11, color: "#6B6355", ...NUM }}>
                  <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#4A7C59", marginRight: 6 }} />
                    имеем <b style={{ color: "#1A1A1A" }}>{fmt(freeAll)}</b></span>
                  <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#98B8A1", marginRight: 6 }} />
                    + нам должны <b style={{ color: "#1A1A1A" }}>{fmt(debt)}</b></span>
                  <span onClick={() => navigate("/debtors")} style={{ cursor: "pointer" }}>
                    <span style={{ display: "inline-block", width: 8, height: 8, background: "#8B3A3A", marginRight: 6 }} />
                    − осталось потратить по заказам <b style={{ color: "#1A1A1A" }}>{fmt(rest)}</b></span>
                </div>
              </div>
            );
          })()}
          {cardsQ.isError && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#8B3A3A" }}>личные счета не загрузились — в сумме только р/с ИП</div>
          )}
          {reservesOpen && (fc?.reserves?.length ?? 0) > 0 && (
            <div style={{ marginTop: 10, borderTop: "1px solid #EDEBE6", paddingTop: 6 }}>
              {fc.reserves.map((r: any) => (
                <div key={r.order_id} onClick={() => navigate(`/orders/${r.order_id}`)} {...hover}
                     style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", cursor: "pointer", fontSize: 12, borderBottom: "1px solid #F2EFE9" }}>
                  <span style={{ color: "#1A1A1A" }}>{r.title}</span>
                  <span style={{ color: "#E8592A", ...NUM }}>{fmt(r.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Деньги по месяцам (р/с) — заменяет блок «Этот месяц» */}
        <div style={{ padding: pad, borderRight: isMobile ? "none" : "1px solid #EDEBE6",
                      borderBottom: isMobile ? "1px solid #F2EFE9" : "none", minWidth: 0, cursor: "pointer" }}
             onClick={() => navigate("/finance")}>
          <div style={{ ...LABEL, marginBottom: 10 }}>ЭТОТ МЕСЯЦ · ИП + ЛИЧНЫЕ</div>
          <div style={{ display: "flex", gap: 18, marginBottom: 14, flexWrap: "wrap" }}>
            {[
              { label: "поступило", v: monthIncome, c: "#4A7C59",
                sub: cur ? `р/с ${fmt(cur.ip_income)} · личные ${fmt(cur.cards_income)}` : null },
              { label: "потрачено", v: monthExpense, c: "#8B3A3A",
                sub: cur ? `р/с ${fmt(cur.ip_expense)} · личные ${fmt(cur.cards_expense)}` : null },
              { label: "итого", v: monthIncome - monthExpense, c: monthIncome - monthExpense >= 0 ? "#1A1A1A" : "#8B3A3A", sub: null },
            ].map(x => (
              <div key={x.label}>
                <div style={{ fontSize: 10, color: "#A89070" }}>{x.label}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: x.c, ...NUM }}>{fmt(x.v)}</div>
                {x.sub && <div style={{ fontSize: 10, color: "#A89070", marginTop: 2, ...NUM }}>{x.sub}</div>}
              </div>
            ))}
          </div>
          <MonthBars rows={monthly} height={isMobile ? 56 : 64} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: 8, fontSize: 10, color: "#A89070" }}>
            <span style={{ display: "inline-flex", alignItems: "center" }}><span style={{ width: 8, height: 8, background: "#4A7C59", marginRight: 5 }} />
              <span style={{ width: 8, height: 8, background: "#8B3A3A", marginRight: 5 }} />р/с ИП</span>
            <span style={{ display: "inline-flex", alignItems: "center" }}><span style={{ width: 8, height: 8, background: "#98B8A1", marginRight: 5 }} />
              <span style={{ width: 8, height: 8, background: "#C99A9A", marginRight: 5 }} />личные</span>
            <span>без переводов себе и вывода в Тбилиси</span>
          </div>
          {mm.data && (!mm.data.bank_ok || !mm.data.cards_ok) && (
            <div style={{ fontSize: 11, color: "#8B3A3A", marginTop: 6 }}>
              {!mm.data.bank_ok ? "выписка р/с не загрузилась" : "личные счета не загрузились"} — сумма неполная
            </div>
          )}
        </div>

        {/* Пульс — три спидометра вместо колец «Показатели» */}
        <div style={{ padding: pad, minWidth: 0 }}>
          <div style={{ ...LABEL, marginBottom: 10 }}>ПУЛЬС</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {[
              { title: "собрано по производству", frac: prodFrac, tone: (prodFrac ?? 0) >= 0.5 ? "good" : "accent",
                label: prodFrac == null ? "—" : `${Math.round(prodFrac * 100)}%`, to: "/orders" },
              { title: `квартал до срока УСН`, frac: taxFrac, tone: taxTone,
                label: daysLeft == null ? "—" : `${daysLeft} дн.`, to: "/taxes" },
              { title: "расходы к приходу месяца", frac: burn, tone: burnTone,
                label: burn == null ? "—" : `${Math.round(burn * 100)}%`, to: "/finance" },
            ].map(g => (
              <div key={g.title} onClick={() => navigate(g.to)} style={{ cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0 }}>
                <Gauge frac={g.frac} tone={g.tone as GaugeTone} label={g.label} size={isMobile ? 84 : 96} animate />
                <div style={{ fontSize: 10, color: "#A89070", textAlign: "center", marginTop: 6, lineHeight: 1.3 }}>{g.title}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Ряд 2: четыре плитки-двери со своей инфографикой */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", borderBottom: "1px solid #EDEBE6" }}>
        {tiles.map((t, i) => (
          <div key={t.key} onClick={() => navigate(t.to)} {...hover}
               style={{ ...tileBase,
                        borderRight: (isMobile ? i % 2 === 0 : i < 3) ? "1px solid #EDEBE6" : "none",
                        borderBottom: isMobile && i < 2 ? "1px solid #EDEBE6" : "none" }}>
            <div style={LABEL}>{t.label}</div>
            {t.body}
          </div>
        ))}
      </div>
    </div>
  );
}
