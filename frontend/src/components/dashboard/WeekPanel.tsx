// «Неделя» на главной — те же блоки и сравнения, что недельный отчёт фин-агента
// (`/opt/fin-agent/tools/weekly_report.py --news`), но числами Фирмы и в её стиле:
// деньги недели против прошлой, приход по 12 неделям, направления со спидометром
// маржи, план/факт себестоимости, «Молчат» с порогами 14/30/60, доход по кварталам.
// Цифры — `GET /api/reports/week` и `GET /api/orders/silent`; своей арифметики тут нет.
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { reportsApi } from "../../api";
import { MONO } from "../ui/Num";
import { fmtMoney as fmt } from "../ui/format";
import { Gauge, type GaugeTone } from "../ui/Gauge";
import { BudgetBar } from "../ui/BudgetBar";
import { TickBar } from "../ui/TickBar";
import { Columns } from "../ui/Columns";
import { OrderLink } from "../ui/links";

const NUM = { fontFamily: MONO, fontVariantNumeric: "tabular-nums" } as const;
const SUB = { fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 12 } as const;
const STEP: Record<string, string> = { remind: "напомнить", refresh: "актуализировать цену", archive: "пора в архив" };

function dm(iso: string) {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

function plural(n: number) {
  const a = n % 100, b = n % 10;
  if (a >= 11 && a <= 14) return "заказов";
  return b === 1 ? "заказ" : b >= 2 && b <= 4 ? "заказа" : "заказов";
}

function signed(v: number) {
  if (Math.abs(v) <= 1) return "в ноль";
  return (v > 0 ? "+" : "−") + fmt(Math.abs(v));
}

// Полоса «Деньги»: общая шкала на три строки + засечка прошлой недели той же длины.
function MoneyBar({ label, value, prev, max, color }: {
  label: string; value: number | null; prev: number | null; max: number; color: string;
}) {
  const w = max > 0 && value ? Math.max(1, value / max * 100) : 0;
  const p = max > 0 && prev != null ? prev / max * 100 : null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: "#1A1A1A" }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color, ...NUM }}>{value == null ? "—" : fmt(value)}</span>
      </div>
      <div style={{ position: "relative", height: 4, background: "#EDEBE6" }}>
        <div style={{ height: 4, width: `${w}%`, background: color, transition: "width 0.4s" }} />
        {p != null && (
          <div title={`прошлая неделя: ${fmt(prev ?? 0)}`}
               style={{ position: "absolute", left: `calc(${Math.min(100, p)}% - 1px)`, top: -3, width: 1, height: 10, background: "#1A1A1A" }} />
        )}
      </div>
      <div style={{ fontSize: 10, color: "#A89070", marginTop: 4, ...NUM }}>
        прошлая неделя {prev == null ? "—" : fmt(prev)}
      </div>
    </div>
  );
}

export function WeekPanel({ silent, isMobile }: { silent: any; isMobile: boolean }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["reports-week"], queryFn: reportsApi.week, refetchInterval: 5 * 60_000 });
  const w = q.data;
  if (!w) return null;

  const m = w.money;
  const max = Math.max(m.income ?? 0, m.spent_projects ?? 0, m.abroad ?? 0,
                       m.prev.income ?? 0, m.prev.spent_projects ?? 0, m.prev.abroad ?? 0);
  const dirs: any[] = w.directions ?? [];
  const topRev = Math.max(0, ...dirs.map(d => d.revenue));
  const pf: any[] = w.plan_fact ?? [];
  const sil: any[] = (silent?.orders ?? []).slice(0, 5);
  const th = silent?.thresholds ?? { ask: 14, refresh: 30, archive: 60 };
  const quarters: any[] = w.quarters?.items ?? [];

  const cell = { padding: isMobile ? "16px 16px" : "20px 28px", minWidth: 0 } as const;
  const grid = {
    display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
    borderBottom: "1px solid #EDEBE6",
  } as const;
  const leftCell = { ...cell, borderRight: isMobile ? "none" : "1px solid #EDEBE6",
                     borderBottom: isMobile ? "1px solid #F2EFE9" : "none" };

  return (
    <div>
      {/* Шапка раздела: окно недели и с чем сравниваем */}
      <div style={{ padding: isMobile ? "14px 16px 0" : "20px 28px 0", display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>НЕДЕЛЯ</span>
        <span style={{ fontSize: 12, color: "#1A1A1A", ...NUM }}>{dm(w.week.from)} – {dm(w.week.to)}</span>
        <span style={{ fontSize: 11, color: "#A89070", ...NUM }}>засечка — прошлая неделя {dm(w.prev.from)} – {dm(w.prev.to)}</span>
      </div>

      {/* Деньги недели | приход по 12 неделям */}
      <div style={grid}>
        <div style={leftCell}>
          <div style={{ ...SUB, display: "flex", justifyContent: "space-between" }}>
            <span>ДЕНЬГИ ЗА НЕДЕЛЮ</span>
            <span style={{ letterSpacing: 0, fontSize: 12, fontWeight: 700, color: m.balance < -1 ? "#8B3A3A" : "#1A1A1A", ...NUM }}>
              {signed(m.balance)}
            </span>
          </div>
          <MoneyBar label="Пришло" value={m.income} prev={m.prev.income} max={max} color="#4A7C59" />
          {m.income_unallocated > 1 && (
            <div style={{ fontSize: 11, color: "#6B6355", margin: "-6px 0 10px", ...NUM }}>
              · из них не разнесено по заказам {fmt(m.income_unallocated)}
            </div>
          )}
          <MoneyBar label="Потрачено по проектам" value={m.spent_projects} prev={m.prev.spent_projects} max={max} color="#8B3A3A" />
          {m.spent_cards > 1 && (
            <div style={{ fontSize: 11, color: "#6B6355", margin: "-6px 0 10px", ...NUM }}>
              · из них мастерам с личных карт {fmt(m.spent_cards)}
            </div>
          )}
          {/* Свои деньги переложены — ни плюс, ни минус недели, поэтому без полярности */}
          <MoneyBar label="Себе в Тбилиси" value={m.abroad} prev={m.prev.abroad} max={max} color="#6B6355" />
        </div>
        <div style={cell}>
          <div style={SUB}>ПРИХОД ПО НЕДЕЛЯМ · 12 НЕДЕЛЬ</div>
          <Columns values={(w.weeks ?? []).map((x: any) => x.income)}
                   labels={(w.weeks ?? []).map((x: any, i: number) => (isMobile && i % 2 ? "" : dm(x.week_start)))}
                   hot={(w.weeks ?? []).length - 1} height={isMobile ? 64 : 84} />
          <div style={{ fontSize: 10, color: "#A89070", marginTop: 8 }}>р/с, без переводов между своими счетами · текущая неделя неполная</div>
        </div>
      </div>

      {/* Направления со спидометром маржи | план/факт себестоимости */}
      {(dirs.length > 0 || pf.length > 0) && (
        <div style={grid}>
          <div style={leftCell}>
            <div style={{ ...SUB, display: "flex", justifyContent: "space-between" }}>
              <span>НАПРАВЛЕНИЯ</span>
              <span style={{ letterSpacing: 0, fontSize: 11, color: "#6B6355", ...NUM }}>
                в работе + закрытые за неделю
              </span>
            </div>
            {dirs.length === 0 && <div style={{ fontSize: 12, color: "#6B6355" }}>Заказов в работе нет.</div>}
            {dirs.map((d, i) => {
              const tone: GaugeTone = d.revenue <= 0 ? "muted" : d.net > 1 ? "good" : d.net < -1 ? "bad" : "accent";
              const share = topRev > 0 ? d.revenue / topRev * 100 : 0;
              return (
                <div key={d.code} style={{ display: "grid", gridTemplateColumns: `1fr ${isMobile ? 80 : 96}px`, gap: 16, alignItems: "center",
                                           padding: "10px 0", borderBottom: i < dirs.length - 1 ? "1px solid #F2EFE9" : "none" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{d.title}</span>
                      <span style={{ fontSize: 11, color: "#A89070", whiteSpace: "nowrap" }}>
                        {d.orders} {plural(d.orders)} · закрыто {d.closed}
                      </span>
                    </div>
                    <div style={{ height: 4, background: "#EDEBE6", marginBottom: 6 }}>
                      <div style={{ height: 4, width: `${Math.max(d.revenue > 0 ? 1 : 0, share)}%`, background: "#E8592A" }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: "#A89070", flexWrap: "wrap", ...NUM }}>
                      <span>выручка <b style={{ color: "#1A1A1A" }}>{fmt(d.revenue)}</b></span>
                      <span>{d.tax > 0 ? "прибыль после УСН" : "прибыль"}{" "}
                        <b style={{ color: d.net > 1 ? "#4A7C59" : d.net < -1 ? "#8B3A3A" : "#1A1A1A" }}>{signed(d.net)}</b>
                      </span>
                    </div>
                  </div>
                  <Gauge frac={d.margin} tone={tone} size={isMobile ? 80 : 96}
                         label={d.margin == null ? "—" : `${d.margin < 0 ? "−" : ""}${Math.round(Math.abs(d.margin) * 100)}%`} />
                </div>
              );
            })}
            <div style={{ fontSize: 10, color: "#A89070", marginTop: 8 }}>
              спидометр — маржа: прибыль / выручка · полоса — доля выручки от крупнейшего направления
            </div>
          </div>
          <div style={cell}>
            <div style={SUB}>ПЛАН / ФАКТ СЕБЕСТОИМОСТИ</div>
            {pf.length === 0 && <div style={{ fontSize: 12, color: "#6B6355" }}>Нет заказов с планом себестоимости.</div>}
            {pf.slice(0, 6).map((o, i, arr) => (
              <div key={o.id} style={{ padding: "8px 0", borderBottom: i < arr.length - 1 ? "1px solid #F2EFE9" : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                  <span style={{ color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    <OrderLink id={o.id}>{o.title}</OrderLink>
                  </span>
                  <span style={{ fontSize: 11, whiteSpace: "nowrap", color: o.over > 1 ? "#8B3A3A" : "#A89070", ...NUM }}>
                    {o.over > 1 ? `перерасход ${fmt(o.over)}` : o.done ? "закрыт" : `остаток ${fmt(Math.max(0, o.plan - o.fact))}`}
                  </span>
                </div>
                <BudgetBar fact={o.fact} plan={o.plan} factLabel={o.activity === "transit" ? "мастеру" : "факт"} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Молчат с порогами | доход по кварталам */}
      <div style={grid}>
        <div style={leftCell}>
          <div style={{ ...SUB, display: "flex", justifyContent: "space-between", cursor: "pointer" }}
               onClick={() => navigate("/orders?mode=silent")}>
            <span>МОЛЧАТ</span>
            <span style={{ letterSpacing: 0, fontSize: 11, color: "#6B6355", ...NUM }}>
              {silent?.total ?? 0} · деления {th.ask} / {th.refresh} / {th.archive} дн.
            </span>
          </div>
          {sil.length === 0 && <div style={{ fontSize: 12, color: "#6B6355" }}>Все просчёты в движении.</div>}
          {sil.map((o, i) => (
            <div key={o.id} style={{ padding: "8px 0", borderBottom: i < sil.length - 1 ? "1px solid #F2EFE9" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, marginBottom: 6 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  <OrderLink id={o.id}>{o.title}</OrderLink>
                </span>
                <span style={{ fontSize: 11, whiteSpace: "nowrap", color: o.step === "archive" ? "#8B3A3A" : "#6B6355", ...NUM }}>
                  {o.days} дн. · {STEP[o.step] ?? ""}
                </span>
              </div>
              <TickBar value={o.days} scale={90} ticks={[th.ask, th.refresh, th.archive]} />
            </div>
          ))}
        </div>
        <div style={cell}>
          <div style={SUB}>ДОХОД ПО Р/С ПО КВАРТАЛАМ · {w.quarters?.year}</div>
          <Columns values={quarters.map(x => x.income)} labels={quarters.map(x => `Q${x.quarter}`)}
                   hot={(w.quarters?.current ?? 1) - 1} height={isMobile ? 56 : 72} />
          <div style={{ fontSize: 10, color: "#A89070", marginTop: 8 }}>база УСН — все поступления на р/с</div>
        </div>
      </div>
    </div>
  );
}
