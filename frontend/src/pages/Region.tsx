// Личный заграничный контур: один файл на все страны (/region/:code).
// Новая страна — строка в справочнике на сервере, не новый экран.
//
// Главный вопрос Юры (22.09.2026): «в какие дни выгодно менять доллары на лари».
// Отвечаем ТОЛЬКО фактом — сегодняшний официальный курс против собственного
// разброса за месяц и квартал. Прогнозов не делаем и «курса рынка» не обещаем:
// официальный курс Нацбанка ≠ курс, по которому меняет банк, и это здесь сказано
// прямо, а не спрятано в мелкий шрифт.
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { fxApi, financeApi, regionsApi, zenmoneyApi } from "../api";
import { useMe } from "../auth";
import { Loading } from "../components/ui/Loading";
import { MONO } from "../components/ui/Num";
import { fmtAmount, currencySign } from "../components/ui/format";
import { useIsMobile, M } from "../components/ui/responsive";
import { RowCard } from "../components/ui/RowCard";
import { ColumnFilter, PeriodFilter, AmountFilter } from "../components/TableFilters";
import { Modal } from "../components/ui/Modal";
import { Gauge, type GaugeTone } from "../components/ui/Gauge";

const LABEL: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em" };

// Предупреждение сворачивается в строку: на телефоне развёрнутый текст занимал
// половину экрана и отодвигал сам раздел вниз.
function Note({ tone, head, children }: { tone: string; head: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 16, padding: "9px 12px", borderLeft: `2px solid ${tone}`,
                  background: "#FAF8F5", fontSize: 12, color: "#6B6355", lineHeight: 1.6, maxWidth: 820 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", justifyContent: "space-between" }}>
        <span><b style={{ color: tone }}>{head}</b></span>
        <button type="button" onClick={() => setOpen(v => !v)}
          style={{ background: "none", border: "none", padding: 0, fontFamily: "inherit", fontSize: 11,
                   color: "#E8592A", cursor: "pointer", flexShrink: 0 }}>
          {open ? "свернуть" : "подробнее"}
        </button>
      </div>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

const MONTH_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
// «2026-03» → «мар»; у января добавляем год, иначе граница лет не читается.
function monthLabel(period: string): string {
  const [y, m] = (period || "").split("-");
  const idx = Number(m) - 1;
  if (idx < 0 || idx > 11) return period;
  return idx === 0 ? `${MONTH_RU[idx]} ${String(y).slice(2)}` : MONTH_RU[idx];
}


// График курса: тонкая линия по дизайн-системе (без карточек и скруглений).
// Подписи min/max вынесены на ось СПРАВА, а не поверх линии: раньше «макс 2.648»
// лежало прямо на графике и читалось как часть кривой.
function RateChart({ rows, days, title, width }: { rows: any[]; days: number; title?: string; width?: number }) {
  const isMobile = useIsMobile();
  const H = 112;
  const TOP = 8;                         // поля, иначе верхняя подпись обрезается краем svg
  const AXIS = 58;                       // колонка под подписи значений
  const W = width ?? (isMobile ? 300 : 520);   // ширина самой кривой
  if (rows.length < 2) return <div style={{ fontSize: 12, color: "#6B6355" }}>Мало точек для графика</div>;
  const vals = rows.map(r => r.rate);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const mid = (lo + hi) / 2;
  const span = hi - lo || 1;
  const x = (i: number) => (i / (rows.length - 1)) * W;
  const y = (v: number) => TOP + (H - ((v - lo) / span) * H);
  const path = rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.rate).toFixed(1)}`).join(" ");
  const last = rows[rows.length - 1];
  const tick = (v: number, label: string) => (
    <g key={label}>
      <line x1={0} y1={y(v)} x2={W} y2={y(v)} stroke="#F2EFE9" strokeWidth={1} />
      <text x={W + 8} y={y(v) + 3} style={{ fontSize: 10, fill: "#A89070" }}>{label}</text>
    </g>
  );
  return (
    <div>
      <div style={{ ...LABEL, marginBottom: 10 }}>{title ?? `КУРС ЗА ${days} ДНЕЙ · НАЦБАНК ГРУЗИИ`}</div>
      <div style={{ overflowX: "auto" }}>
        <svg width={W + AXIS} height={H + TOP + 24} style={{ display: "block" }}>
          {tick(hi, String(hi))}
          {tick(mid, mid.toFixed(3))}
          {tick(lo, String(lo))}
          <path d={path} fill="none" stroke="#E8592A" strokeWidth={1.5} />
          <circle cx={x(rows.length - 1)} cy={y(last.rate)} r={3} fill="#E8592A" />
          <text x={0} y={H + TOP + 20} style={{ fontSize: 10, fill: "#A89070" }}>{rows[0].date}</text>
          <text x={W} y={H + TOP + 20} textAnchor="end" style={{ fontSize: 10, fill: "#A89070" }}>{last.date}</text>
        </svg>
      </div>
    </div>
  );
}

export default function Region() {
  const { code = "ge" } = useParams();
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const { data: user, isFetching: meFetching } = useMe();
  // Пока сервер не ответил, кто смотрит, ничего не утверждаем: сохранённый
  // объект может быть старым, без is_owner, и владелец увидел бы «не твой раздел».
  const ownerKnown = !!user && "is_owner" in (user as any);
  const who = user?.email || "";
  const isOwner = !!user?.is_owner;
  const [reserve, setReserve] = useState<string>("");
  // Взаимоисключающие режимы экрана — одно состояние, а не три булевых:
  // иначе вкладка меняет свой фильтр, но не гасит чужой режим.
  const [tab, setTab] = useState<"fx" | "tx" | "stats">("fx");
  // Все хуки — до условных return ниже, иначе React меняет их число между
  // рендерами (ошибка #310 — поймана на живом экране 23.09.2026).
  const reserveRef = useRef<HTMLDivElement>(null);

  const { data: signal, isLoading } = useQuery({
    queryKey: ["fx-signal", who], queryFn: fxApi.signal,
    enabled: isOwner,
  });
  const { data: abroad } = useQuery({
    queryKey: ["abroad-summary", who], queryFn: () => financeApi.abroadSummary(12),
    enabled: isOwner,
  });
  // Счета страны берём с явным region: в «Личных» их больше нет (там домашний контур).
  const { data: accounts = [] } = useQuery({
    queryKey: ["zm-accounts", code, who], queryFn: () => zenmoneyApi.accounts(code),
    enabled: isOwner,
  });

  const saveReserve = useMutation({
    mutationFn: (v: number) => fxApi.setReserve(v),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fx-signal", who] }); setReserve(""); },
  });

  if (!ownerKnown && meFetching) return <Loading />;

  // Сервер и так отвечает 403 — но показывать пустую оболочку с нулями нечестно:
  // человек решит, что данных нет, а не что раздел не его.
  if (!isOwner) {
    return (
      <div style={{ padding: isMobile ? `24px ${M.pageX}px` : "40px" }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", margin: 0 }}>Грузия</h1>
        <div style={{ marginTop: 12, fontSize: 13, color: "#6B6355", maxWidth: 520, lineHeight: 1.6 }}>
          Раздел личных финансов владельца. Сколько за месяц уходит себе за границу — видно
          на экране ДДС и в «Личных»: это движение по рублёвому счёту.
        </div>
      </div>
    );
  }

  if (isLoading) return <Loading />;

  const regionAccounts = accounts as any[];

  const gotoReserve = () => {
    setTab("fx");
    setTimeout(() => reserveRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const title = code === "ge" ? "Грузия" : code.toUpperCase();
  const tabs = (
    <div style={{ display: "flex", gap: 0, marginTop: 20, borderBottom: "1px solid #EDEBE6",
                  ...(isMobile ? M.tabStrip : null) }}>
      {([["fx", "Обмен"], ["tx", "Операции"], ["stats", "Аналитика"]] as const).map(([key, label]) => (
        <button key={key} type="button" onClick={() => setTab(key)}
          style={{
            padding: "10px 16px", fontSize: 13, fontFamily: "inherit", cursor: "pointer",
            background: "none", border: "none", flexShrink: 0,
            color: tab === key ? "#1A1A1A" : "#A89070",
            fontWeight: tab === key ? 600 : 400,
            borderBottom: tab === key ? "2px solid #E8592A" : "2px solid transparent",
          }}>
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", height: "100%", minHeight: 0 }}>
      {/* Левая панель — состояние: спидометры, счета, курс дня. На телефоне —
          раскрывающаяся полоса сверху, как сводка в «Личных». */}
      <SidePanel code={code} who={who} accounts={regionAccounts} onGotoReserve={gotoReserve} />

      <div style={{ flex: "1 1 0", minWidth: 0, minHeight: 0, overflowY: "auto",
                    padding: isMobile ? `20px ${M.pageX}px 32px` : "32px 40px 40px" }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", margin: 0 }}>{title}</h1>

        {/* Курс не обновился: показываем последний загруженный, а не выдаём его за сегодняшний */}
        {signal?.fx_refresh && signal.fx_refresh.ok === false && (
          <Note tone="#8B3A3A" head={`Курс сегодня не загрузился — показан за ${signal?.date || "—"}`}>
            Нацбанк не ответил ({signal.fx_refresh.error || "сеть недоступна"}). Это последний
            сохранённый курс, сегодняшним он не является.
          </Note>
        )}

        {/* Одинаковые названия счетов: что именно не работает и что сделать */}
        {!!signal?.ambiguous?.length && (
          <Note tone="#B8860B"
                head={`${signal.ambiguous.length} счёта делят одно название — валюта операций не разделена`}>
            В ZenMoney все три зовутся «{signal.ambiguous[0].title}». Остатки считаются — валюта у счёта
            известна. А вот отдельные операции к ним привязать нечем: в транзакциях нога хранится
            НАЗВАНИЕМ счёта. Что сделать:
            <ol style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
              <li>ZenMoney → <b>Счета</b>. У каждого «Universal Account» там показана его валюта:
                ₾, $ или €.</li>
              <li>Переименовать по валюте: «Сола ₾», «Сола $», «Сола €». Для сверки — наши
                остатки на 22.09: {regionAccounts.map((a: any) =>
                  `${currencySign(a.currency)} ${fmtAmount(a.balance, a.currency)}`).join(" · ")}.</li>
              <li>Написать мне — я запущу полный пересинк. История перепишется, операции
                разделятся по валютам, появятся твои реальные курсы обмена и спред банка.</li>
            </ol>
          </Note>
        )}

        {tabs}

        {tab === "tx" && <TxTab code={code} who={who} />}
        {tab === "stats" && <StatsTab code={code} who={who} />}
        {tab === "fx" && (
          <FxTab who={who} signal={signal} abroad={abroad}
                 reserve={reserve} setReserve={setReserve} saveReserve={saveReserve}
                 reserveRef={reserveRef} />
        )}
      </div>
    </div>
  );
}

// ── Левая панель: спидометры, счета, курс дня ────────────────────────────────
function SidePanel({ code, who, accounts, onGotoReserve }: {
  code: string; who: string; accounts: any[]; onGotoReserve: () => void;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const { data: sm } = useQuery({
    queryKey: ["region-summary", code, who], queryFn: () => regionsApi.summary(code),
  });

  // Траты месяца: тон — по темпу, а не по величине. Тратим быстрее, чем идёт
  // месяц, — красный; медленнее — зелёный; примерно вровень — акцент.
  const monthFrac = sm?.month_pct ?? null;
  const pace = sm?.pace_pct ?? 0;
  const monthTone: GaugeTone = monthFrac == null ? "muted"
    : monthFrac > pace + 0.15 ? "bad" : monthFrac < pace - 0.15 ? "good" : "accent";
  const monthLabelText = monthFrac == null ? "—" : `${Math.round(monthFrac * 100)}%`;

  const reserveFrac = sm?.reserve_pct ?? null;
  const reserveTone: GaugeTone = reserveFrac == null ? "muted" : reserveFrac < 1 ? "bad" : "good";

  const ARROW: Record<string, string> = { good: "▲", wait: "▼", normal: "—", unknown: "·" };
  const sumCur = sm?.currency ?? null;

  const body = (
    <>
      <div style={LABEL}>ТРАТЫ МЕСЯЦА</div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10 }}>
        <Gauge frac={monthFrac} label={monthLabelText} tone={monthTone} size={104} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO }}>
            {fmtAmount(sm?.spent_mtd ?? 0, sumCur)}
          </div>
          <div style={{ fontSize: 11, color: "#6B6355", marginTop: 2, lineHeight: 1.5 }}>
            {sm?.avg_month ? <>из ~{fmtAmount(sm.avg_month, sumCur)} обычных</> : "нормы пока нет"}
            <br />прошло {Math.round(pace * 100)}% месяца
          </div>
        </div>
      </div>

      <div style={{ ...LABEL, marginTop: 26 }}>ЗАПАС В ДОЛЛАРАХ</div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10 }}>
        <Gauge frac={reserveFrac} tone={reserveTone} size={104}
               label={reserveFrac == null ? "—" : `${Math.round(reserveFrac * 100)}%`} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO }}>
            {fmtAmount(sm?.usd_balance ?? 0, "USD")}
          </div>
          <div style={{ fontSize: 11, color: "#6B6355", marginTop: 2, lineHeight: 1.5 }}>
            {sm?.usd_reserve ? <>из {fmtAmount(sm.usd_reserve, "USD")} запаса</> : (
              <button type="button" onClick={onGotoReserve}
                style={{ background: "none", border: "none", padding: 0, fontFamily: "inherit",
                         fontSize: 11, color: "#E8592A", cursor: "pointer" }}>задать запас</button>
            )}
            <br />
            {sm?.runway_months != null
              ? (sm.runway_months >= 1
                  ? <>хватит на ~{sm.runway_months} мес</>
                  // Меньше месяца — считаем в днях: «~0 мес» правдиво, но нечитаемо
                  : <>остатка хватит на ~{Math.max(1, Math.round(sm.runway_months * 30))} дн.</>)
              : <span style={{ color: "#A89070" }}>«на сколько хватит» — после разделения валют</span>}
          </div>
        </div>
      </div>

      <div style={{ ...LABEL, marginTop: 26 }}>СЧЕТА</div>
      <div style={{ marginTop: 6 }}>
        {accounts.length === 0 && <div style={{ fontSize: 12, color: "#6B6355" }}>Не настроены</div>}
        {accounts.map((a: any) => (
          <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
                                   gap: 10, padding: "8px 0", borderBottom: "1px solid #F2EFE9" }}>
            <span style={{ fontSize: 12, color: "#6B6355", overflow: "hidden", textOverflow: "ellipsis",
                           whiteSpace: "nowrap" }}>
              {a.title} <span style={{ color: "#A89070" }}>{currencySign(a.currency)}</span>
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, fontFamily: MONO, whiteSpace: "nowrap" }}>
              {fmtAmount(a.balance, a.currency)}
            </span>
          </div>
        ))}
      </div>

      <div style={{ ...LABEL, marginTop: 26 }}>КУРС СЕГОДНЯ</div>
      <div style={{ marginTop: 6 }}>
        {(sm?.rates ?? []).map((r: any) => {
          const buy = r.directions?.[0], sell = r.directions?.[1];
          const tone = (v?: string) => v === "good" ? "#4A7C59" : v === "wait" ? "#8B3A3A" : "#A89070";
          return (
            <div key={r.key} style={{ padding: "8px 0", borderBottom: "1px solid #F2EFE9" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: 12, color: "#6B6355" }}>
                  {currencySign(r.in)} за {currencySign(r.price_of)}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, fontFamily: MONO }}>{r.rate}</span>
              </div>
              <div style={{ fontSize: 10, marginTop: 3, display: "flex", gap: 10 }}>
                <span style={{ color: tone(buy?.verdict) }}>
                  {ARROW[buy?.verdict] ?? "·"} {currencySign(buy?.from)}→{currencySign(buy?.to)}
                </span>
                <span style={{ color: tone(sell?.verdict) }}>
                  {ARROW[sell?.verdict] ?? "·"} {currencySign(sell?.from)}→{currencySign(sell?.to)}
                </span>
              </div>
            </div>
          );
        })}
        <div style={{ fontSize: 10, color: "#A89070", marginTop: 6, lineHeight: 1.5 }}>
          ▲ выгодно менять · ▼ подождать · — около обычного
        </div>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <>
        <button type="button" onClick={() => setOpen(v => !v)}
          style={{ order: -1, display: "flex", justifyContent: "space-between", alignItems: "center",
                   padding: "12px 16px", background: "#FAF8F5", border: "none",
                   borderBottom: "1px solid #EDEBE6", fontFamily: "inherit", cursor: "pointer", flexShrink: 0 }}>
          <span style={LABEL}>МЕСЯЦ {monthLabelText} · ЗАПАС {reserveFrac == null ? "—" : `${Math.round(reserveFrac * 100)}%`}
            {" · "}{open ? "свернуть" : "сводка"}</span>
          <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO }}>
            {fmtAmount(sm?.spent_mtd ?? 0, sumCur)}
          </span>
        </button>
        {open && (
          <div style={{ order: -1, padding: `16px ${M.pageX}px`, borderBottom: "1px solid #EDEBE6",
                        maxHeight: "60dvh", overflowY: "auto", flexShrink: 0 }}>{body}</div>
        )}
      </>
    );
  }
  return (
    <div style={{ width: 300, minWidth: 300, overflowY: "auto", padding: "32px 24px 24px",
                  borderRight: "1px solid #EDEBE6" }}>
      {body}
    </div>
  );
}

// ── Вкладка «Обмен»: три пары в обе стороны ──────────────────────────────────
const DIR_RU: Record<string, { text: string; color: string }> = {
  good:    { text: "менять выгодно",   color: "#4A7C59" },
  normal:  { text: "около обычного",   color: "#6B6355" },
  wait:    { text: "подождать",        color: "#8B3A3A" },
  unknown: { text: "мало данных",      color: "#A89070" },
};

function FxTab({ who, signal, abroad, reserve, setReserve, saveReserve, reserveRef }: any) {
  const isMobile = useIsMobile();
  const { data: pairs, isLoading } = useQuery({
    queryKey: ["fx-pairs", who], queryFn: () => fxApi.pairs(90),
  });
  if (isLoading) return <Loading />;

  const months = abroad?.months ?? [];
  const maxMonth = Math.max(...months.map((m: any) => m.amount_rub), 1);
  // Три колонки по ~300px: кривая + ось (58) обязаны влезть, иначе подписи
  // оси режутся краем колонки.
  const chartW = isMobile ? 300 : 215;

  return (
    <div style={{ marginTop: 24 }}>
      {/* Три пары. Один перцентиль на пару, прочитанный с двух концов: покупать валюту
          выгодно, когда она дёшева, продавать — когда дорога. */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))",
                    gap: isMobile ? 28 : 32 }}>
        {(pairs?.pairs ?? []).map((p: any) => (
          <div key={p.key} style={{ minWidth: 0 }}>
            <div style={LABEL}>{String(p.title).toUpperCase()}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", fontFamily: MONO, lineHeight: 1 }}>
                {p.rate ?? "—"}
              </span>
              <span style={{ fontSize: 12, color: "#6B6355" }}>
                {currencySign(p.in)} за {currencySign(p.price_of)}
              </span>
              <span style={{ fontSize: 11, color: "#A89070" }}>· {p.date}</span>
            </div>

            <div style={{ marginTop: 12, borderTop: "1px solid #EDEBE6" }}>
              {(p.directions ?? []).map((d: any) => {
                const v = DIR_RU[d.verdict] ?? DIR_RU.unknown;
                return (
                  <div key={`${d.from}-${d.to}`} style={{ padding: "9px 0", borderBottom: "1px solid #F2EFE9" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>
                        {currencySign(d.from)} → {currencySign(d.to)}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: v.color, whiteSpace: "nowrap" }}>{v.text}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#6B6355", marginTop: 3, lineHeight: 1.45 }}>{d.note}</div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", marginTop: 12,
                          borderBottom: "1px solid #EDEBE6" }}>
              {[["дешевле всего", p.worst_30], ["обычно", p.median_30], ["дороже всего", p.best_30]]
                .map(([l, val]: any, i: number) => (
                <div key={l} style={{ padding: "8px 10px 10px", borderLeft: i ? "1px solid #EDEBE6" : "none" }}>
                  <div style={{ ...LABEL, fontSize: 9 }}>{String(l).toUpperCase()}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: MONO, marginTop: 4 }}>{val ?? "—"}</div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 16 }}>
              <RateChart rows={p.series ?? []} days={90} width={chartW}
                         title={`${currencySign(p.in)} ЗА ${currencySign(p.price_of)} · 90 ДНЕЙ`} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18, fontSize: 11, color: "#A89070", lineHeight: 1.6, maxWidth: 760 }}>
        Курсы официальные, от Нацбанка Грузии — ориентир динамики, не цена сделки: рубль в Грузию
        идёт через Золотую корону и Avosend по их курсам, банк меняет доллары по своему. Когда операции
        станут разборными, рядом с каждой парой появится твой реальный спред к этой линии.
      </div>

      {/* ── Сколько свободно менять + вывод за границу ─────────────────── */}
      <div ref={reserveRef} style={{ display: "grid", marginTop: 36,
                    gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)",
                    gap: isMobile ? 28 : 48, alignItems: "start", maxWidth: 900 }}>
        <div>
          <div style={LABEL}>СКОЛЬКО МОЖНО ПОМЕНЯТЬ ($ → ₾)</div>
          <div style={{ marginTop: 10 }}>
            {[
              ["на долларовом счёте", fmtAmount(signal?.balances?.USD ?? 0, "USD"), "#1A1A1A"],
              ["держу про запас", fmtAmount(signal?.usd_reserve ?? 0, "USD"), "#6B6355"],
              ["свободно", fmtAmount(signal?.usd_free ?? 0, "USD"), "#4A7C59"],
              ...(signal?.gel_if_converted
                ? [["по сегодняшнему курсу", fmtAmount(signal.gel_if_converted, "GEL"), "#6B6355"]]
                : []),
            ].map(([label, value, color]: any) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
                                        gap: 12, padding: "9px 2px 9px 0", borderBottom: "1px solid #F2EFE9" }}>
                <span style={{ fontSize: 12, color: "#6B6355" }}>{label}</span>
                <span style={{ fontSize: 17, fontWeight: 700, fontFamily: MONO, color, whiteSpace: "nowrap" }}>{value}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: "#6B6355", marginBottom: 6 }}>Неснижаемый запас в долларах</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={reserve} onChange={(e: any) => setReserve(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder={String(signal?.usd_reserve ?? 0)}
                style={{ flex: 1, minWidth: 0, padding: "7px 10px", border: "1px solid #EDEBE6",
                         fontFamily: MONO, fontSize: 13 }} />
              <button type="button" disabled={!reserve || saveReserve.isPending}
                onClick={() => saveReserve.mutate(Number(reserve))}
                style={{ padding: "7px 14px", fontSize: 12, fontFamily: "inherit", cursor: "pointer",
                         border: "1px solid #E8592A", background: "#E8592A", color: "#FFFFFF", flexShrink: 0 }}>
                Сохранить
              </button>
            </div>
            <div style={{ fontSize: 11, color: "#A89070", marginTop: 6 }}>ниже этой суммы менять не предлагаем</div>
          </div>
        </div>

        <div>
          <div style={LABEL}>ВЫВЕДЕНО СЕБЕ ЗА ГРАНИЦУ</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: MONO, marginTop: 8 }}>
            {fmtAmount(abroad?.total ?? 0, "RUB")}
          </div>
          <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{abroad?.count ?? 0} переводов за год</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 5, marginTop: 16, height: 56 }}>
            {months.map((m: any) => (
              <div key={m.period} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                <div title={`${m.period}: ${fmtAmount(m.amount_rub, "RUB")} · ${m.count}`}
                  style={{ width: 20, background: "#E8592A",
                           height: Math.max(Math.round((m.amount_rub / maxMonth) * 44), 2) }} />
                <span style={{ fontSize: 9, color: "#A89070" }}>{monthLabel(m.period)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Операции по карте региона ────────────────────────────────────────────────
// Категория не хранится в строке, а выводится на чтении из правил «получатель →
// категория». Поэтому разметка одного получателя перекрашивает сразу все его
// операции, включая прошлогодние, — перебирать ленту руками не нужно.
const TX_GRID = "84px minmax(0, 1fr) 150px 170px 120px";   // дата · получатель · счёт · категория · сумма

function TxTab({ code, who }: { code: string; who: string }) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [assign, setAssign] = useState<{ payee: string; current: string | null } | null>(null);

  const { data: cats = [] } = useQuery({
    queryKey: ["region-cats", code, who], queryFn: () => regionsApi.categories(code, 12),
  });
  const { data, isLoading } = useQuery({
    queryKey: ["region-tx", code, who, search, category, kind, dateFrom, dateTo, amountMin, amountMax],
    queryFn: () => regionsApi.transactions(code, {
      months: 12, limit: 400,
      ...(search ? { search } : {}),
      ...(category ? { category } : {}),
      ...(kind ? { kind } : {}),
      ...(dateFrom ? { date_from: dateFrom } : {}),
      ...(dateTo ? { date_to: dateTo } : {}),
      ...(amountMin ? { amount_min: Number(amountMin) } : {}),
      ...(amountMax ? { amount_max: Number(amountMax) } : {}),
    }),
  });

  const addRule = useMutation({
    mutationFn: (body: { payee: string; category: string }) => regionsApi.addRule(code, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["region-tx", code] });
      qc.invalidateQueries({ queryKey: ["region-cats", code] });
      qc.invalidateQueries({ queryKey: ["region-stats", code] });
      setAssign(null);
    },
  });

  const items: any[] = data?.items ?? [];
  const catTitles = ["Все", ...cats.map((c: any) => c.title)];
  const titleToCode = Object.fromEntries(cats.map((c: any) => [c.title, c.code]));
  const hasFilters = !!(search || category || kind || dateFrom || dateTo || amountMin || amountMax);

  const KIND_RU: Record<string, string> = { expense: "трата", income: "приход", transfer: "перевод" };

  return (
    <div style={{ marginTop: 18, maxWidth: 1000 }}>
      {/* Подвкладки направления */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, ...(isMobile ? M.tabStrip : null) }}>
        {[["", "Все"], ["expense", "Траты"], ["income", "Приходы"], ["transfer", "Переводы"]].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setKind(k)}
            style={{ padding: "4px 10px", fontSize: 11, fontFamily: "inherit", cursor: "pointer", flexShrink: 0,
                     border: `1px solid ${kind === k ? "#E8592A" : "#EDEBE6"}`,
                     background: kind === k ? "#E8592A" : "none",
                     color: kind === k ? "#FFFFFF" : "#A89070" }}>{l}</button>
        ))}
        {!isMobile && (
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по получателю…"
            style={{ marginLeft: 8, padding: "4px 8px", fontSize: 12, fontFamily: "inherit",
                     border: "1px solid #EDEBE6", minWidth: 180, flexShrink: 0 }} />
        )}
      </div>

      {/* На телефоне поиск — своей строкой: в ряду чипов он уезжал за край экрана */}
      {isMobile && (
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по получателю…"
          style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: 13,
                   fontFamily: "inherit", border: "1px solid #EDEBE6", marginBottom: 12 }} />
      )}

      {/* Шапка-фильтры: на телефоне — ряд чипов вместо грида */}
      <div style={isMobile ? M.filterRow : {
        display: "grid", gridTemplateColumns: TX_GRID, alignItems: "center",
        padding: "14px 0 8px", borderBottom: "1px solid #EDEBE6",
      }}>
        <PeriodFilter label="ДАТА" from={dateFrom} to={dateTo}
          onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
        <div style={{ ...LABEL }}>{isMobile ? "" : "ПОЛУЧАТЕЛЬ"}</div>
        <div style={{ ...LABEL }}>{isMobile ? "" : "СЧЁТ"}</div>
        <ColumnFilter label="КАТЕГОРИЯ" options={catTitles}
          value={cats.find((c: any) => c.code === category)?.title || ""}
          onChange={(v) => setCategory(v === "Все" ? "" : (titleToCode[v] || ""))} />
        <AmountFilter label="СУММА" min={amountMin} max={amountMax}
          onChange={(mn, mx) => { setAmountMin(mn); setAmountMax(mx); }} align="right" />
      </div>

      <div style={{ padding: "10px 0", fontSize: 11, color: "#6B6355", display: "flex",
                    justifyContent: "space-between", gap: 12, borderBottom: "1px solid #F2EFE9" }}>
        <span>
          {data?.total_found ?? 0} операций{data?.truncated ? " · показаны первые 400" : ""}
          {/* Обрезание на уровне SQL: период показан не целиком, и счётчик слева —
              только по последним строкам. Молчать об этом нельзя. */}
          {data?.capped && (
            <span style={{ color: "#B8860B" }}>
              {" "}· период обрезан: взяты последние {data.row_cap} операций
            </span>
          )}
        </span>
        {hasFilters && (
          <button type="button" onClick={() => {
            setSearch(""); setCategory(""); setKind(""); setDateFrom(""); setDateTo("");
            setAmountMin(""); setAmountMax("");
          }} style={{ background: "none", border: "none", fontFamily: "inherit", fontSize: 10,
                      color: "#E8592A", cursor: "pointer" }}>✕ Сбросить</button>
        )}
      </div>

      {isLoading && <Loading />}
      {!isLoading && items.length === 0 && (
        <div style={{ padding: "24px 0", fontSize: 13, color: "#6B6355" }}>Операций не нашлось</div>
      )}

      {items.map((t: any) => {
        const sign = t.kind === "income" ? "+" : "−";
        const color = t.kind === "income" ? "#4A7C59" : t.kind === "transfer" ? "#6B6355" : "#1A1A1A";
        const catCell = t.kind === "expense" ? (
          <button type="button" onClick={() => setAssign({ payee: (t.payee || "").trim(), current: t.category })}
            style={{ background: "none", border: "none", padding: 0, fontFamily: "inherit", fontSize: 10,
                     cursor: "pointer", textAlign: "left",
                     color: t.category === "other" ? "#B8860B" : "#A89070" }}>
            {t.category_title || "назначить"}
          </button>
        ) : <span style={{ fontSize: 10, color: "#A89070" }}>{KIND_RU[t.kind]}</span>;

        const accCell = (
          <span style={{ fontSize: 10, color: "#6B6355", overflow: "hidden", textOverflow: "ellipsis",
                         whiteSpace: "nowrap", display: "block" }}>
            {t.account || "—"}
            {t.currency
              ? <span style={{ color: "#A89070" }}> {currencySign(t.currency)}</span>
              : t.account_ambiguous
                ? <span style={{ color: "#B8860B" }}> · валюта?</span>
                : null}
          </span>
        );

        return isMobile ? (
          <RowCard key={t.id}
            title={t.payee || t.comment || "—"}
            sub={<>{String(t.date || "").slice(5)} · {t.account || "—"}
              {t.currency ? ` ${currencySign(t.currency)}` : t.account_ambiguous ? " · валюта?" : ""}
              {t.comment && t.payee ? <> · {t.comment}</> : null}</>}
            right={<span style={{ color }}>{sign}{fmtAmount(t.amount, t.currency)}</span>}
            meta={catCell}
          />
        ) : (
          <div key={t.id} style={{ display: "grid", gridTemplateColumns: TX_GRID, padding: "10px 0",
                                   borderBottom: "1px solid #F2EFE9", alignItems: "baseline", gap: 12 }}>
            <div style={{ fontSize: 11, color: "#6B6355", fontFamily: MONO }}>{String(t.date || "").slice(5)}</div>
            <div>
              <div style={{ fontSize: 12, color: "#1A1A1A" }}>{t.payee || "—"}</div>
              {t.comment && <div style={{ fontSize: 10, color: "#A89070" }}>{t.comment}</div>}
            </div>
            <div style={{ minWidth: 0 }}>{accCell}</div>
            <div>{catCell}</div>
            <div style={{ fontSize: 12, fontWeight: 500, fontFamily: MONO, textAlign: "right", color }}>
              {sign}{fmtAmount(t.amount, t.currency)}
            </div>
          </div>
        );
      })}

      {assign && (
        <Modal size="sm" eyebrow={`КАТЕГОРИЯ · ${(assign.payee || "без получателя").toUpperCase()}`}
               onClose={() => setAssign(null)}>
          <div style={{ fontSize: 12, color: "#6B6355", marginBottom: 12, lineHeight: 1.5 }}>
            Правило запомнится и перекрасит ВСЕ операции этого получателя — прошлые тоже.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {cats.map((c: any) => (
              <button key={c.code} type="button" disabled={addRule.isPending}
                onClick={() => addRule.mutate({ payee: assign.payee, category: c.code })}
                style={{ padding: "8px 10px", fontSize: 12, fontFamily: "inherit", cursor: "pointer",
                         textAlign: "left",
                         border: `1px solid ${assign.current === c.code ? "#E8592A" : "#EDEBE6"}`,
                         background: assign.current === c.code ? "#FFF8F5" : "#FFFFFF",
                         color: "#1A1A1A" }}>
                {c.title}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Аналитика трат ───────────────────────────────────────────────────────────
// Окно — от недели, скользящее до сегодня, либо свой период через PeriodFilter
// (у него уже есть пресеты и даты). Рядом с каждым числом — дельта к предыдущему
// окну ТОЙ ЖЕ длины впритык: неделя сравнивается с прошлой неделей, месяц — с
// прошлым месяцем. Одно состояние периода: чип ставит даты, ручные даты гасят чип.
const PRESETS: Array<[string, string, number]> = [
  ["week", "Неделя", 7], ["month", "Месяц", 30], ["quarter", "Квартал", 90],
  ["half", "Полгода", 182], ["year", "Год", 365],
];

function isoDaysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function bucketLabel(kind: string, period: string): string {
  if (kind === "month") return monthLabel(period);
  if (kind === "week") return `${period.slice(8, 10)}.${period.slice(5, 7)}`;
  return period.slice(8, 10);
}

function Delta({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return null;
  // Расходы: рост — плохо (красный), снижение — хорошо (зелёный). Это не долг,
  // правило debtColor сюда не относится.
  const color = pct > 0 ? "#8B3A3A" : pct < 0 ? "#4A7C59" : "#A89070";
  return (
    <span style={{ color, fontSize: 10, fontWeight: 500, marginLeft: 6, whiteSpace: "nowrap" }}>
      {pct > 0 ? "▲" : pct < 0 ? "▼" : "="} {Math.abs(pct)}%
    </span>
  );
}

function StatsTab({ code, who }: { code: string; who: string }) {
  const isMobile = useIsMobile();
  const [period, setPeriod] = useState<{ preset: string | null; from: string; to: string }>({
    preset: "month", from: isoDaysAgo(29), to: isoDaysAgo(0),
  });
  const pick = (key: string, days: number) => setPeriod({ preset: key, from: isoDaysAgo(days - 1), to: isoDaysAgo(0) });
  // Валюта считается отдельно: складывать лари с долларами нельзя, поэтому
  // сводка всегда про ОДНУ валюту, а переключатель показывает, какие есть.
  const [curFilter, setCurFilter] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["region-stats", code, who, period.from, period.to, curFilter],
    queryFn: () => regionsApi.spending(code, { date_from: period.from, date_to: period.to,
                                               compare: true, currency: curFilter }),
    enabled: !!period.from && !!period.to,
  });

  const mixed = !data?.currency_split;
  const cur = data?.currency ?? null;
  const buckets: any[] = data?.buckets ?? [];
  const maxBucket = Math.max(...buckets.map((b: any) => b.total), 1);
  const spent = data?.spent ?? 0;
  const days = data?.days ?? 0;
  const periodTitle = period.preset
    ? (PRESETS.find(p => p[0] === period.preset)?.[1] ?? "").toUpperCase()
    : `${period.from} — ${period.to}`;

  const Row = ({ title, total, count, extra, pct, currency, delta }: any) => (
    <div style={{ padding: "9px 0", borderBottom: "1px solid #F2EFE9" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 12 }}>
        <span style={{ fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis",
                       whiteSpace: "nowrap" }}>{title}</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: "#8B3A3A", fontFamily: MONO, whiteSpace: "nowrap" }}>
          {fmtAmount(total, currency ?? cur)}
          {count != null && <span style={{ color: "#A89070", fontWeight: 400 }}> · {count}</span>}
          {extra}
          <Delta pct={delta} />
        </span>
      </div>
      {pct != null && (
        <div style={{ height: 2, background: "#F2EFE9" }}>
          <div style={{ height: 2, width: `${Math.max(pct, 1)}%`, background: "#E8592A" }} />
        </div>
      )}
    </div>
  );

  return (
    <div style={{ marginTop: 18, maxWidth: 1000 }}>
      {/* Окно: чипы + свой период */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, alignItems: "center", flexWrap: "wrap",
                    ...(isMobile ? M.tabStrip : null) }}>
        {PRESETS.map(([key, label, n]) => (
          <button key={key} type="button" onClick={() => pick(key, n)}
            style={{ padding: "4px 10px", fontSize: 11, fontFamily: "inherit", cursor: "pointer", flexShrink: 0,
                     border: `1px solid ${period.preset === key ? "#E8592A" : "#EDEBE6"}`,
                     background: period.preset === key ? "#E8592A" : "none",
                     color: period.preset === key ? "#FFFFFF" : "#A89070" }}>{label}</button>
        ))}
        <span style={{ flexShrink: 0, marginLeft: isMobile ? 0 : 6 }}>
          <PeriodFilter label={period.preset ? "СВОЙ ПЕРИОД" : `${period.from} — ${period.to}`}
            from={period.preset ? "" : period.from} to={period.preset ? "" : period.to}
            onChange={(f, t) => {
              if (!f && !t) { pick("month", 30); return; }
              setPeriod({ preset: null, from: f || isoDaysAgo(29), to: t || isoDaysAgo(0) });
            }} />
        </span>
      </div>

      {/* Валюты периода: итог всегда по одной из них */}
      {(data?.by_currency ?? []).length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, alignItems: "center", flexWrap: "wrap",
                      ...(isMobile ? M.tabStrip : null) }}>
          {(data?.by_currency ?? []).map((g: any) => {
            const on = (data?.currency_filter ?? null) === g.key;
            return (
              <button key={g.key} type="button" onClick={() => setCurFilter(g.key)}
                style={{ padding: "4px 10px", fontSize: 11, fontFamily: "inherit", cursor: "pointer", flexShrink: 0,
                         border: `1px solid ${on ? "#E8592A" : "#EDEBE6"}`,
                         background: on ? "#FFF8F5" : "none", color: on ? "#1A1A1A" : "#A89070" }}>
                {g.currency ?? "без валюты"} · {g.count}
              </button>
            );
          })}
        </div>
      )}

      {isLoading && <Loading />}
      {!isLoading && (<>
      <div style={LABEL}>ПОТРАЧЕНО · {periodTitle} · {data?.count ?? 0} ОПЕРАЦИЙ · {days} ДН.</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 4, flexWrap: "wrap" }}>
        <span style={{ fontSize: 26, fontWeight: 700, fontFamily: MONO, letterSpacing: "-0.03em" }}>
          {fmtAmount(spent, cur)}
        </span>
        {data?.prev && (
          <span style={{ fontSize: 12, color: "#6B6355" }}>
            прошлый период {fmtAmount(data.prev.spent, cur)}
            <Delta pct={data.spent_delta_pct} />
          </span>
        )}
      </div>
      {(data?.by_currency ?? []).length > 1 && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#6B6355", lineHeight: 1.5, maxWidth: 620 }}>
          Итог, столбики и получатели — только по выбранной валюте: суммы разных валют
          не складываются. Остальные валюты — переключателем выше.
        </div>
      )}
      {data?.capped && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#B8860B", lineHeight: 1.5, maxWidth: 620 }}>
          Период обрезан: в расчёт взяты последние {data.row_cap} операций, а не всё окно —
          итог и столбики неполные. Сузь период.
        </div>
      )}
      {mixed && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#B8860B", lineHeight: 1.5, maxWidth: 620 }}>
          Валюта операций пока не разделена: в суммах смешаны лари и доллары. Знак валюты
          поэтому не ставим — станет точно после переименования счетов и пересинка.
        </div>
      )}

      {/* Столбики по масштабу окна: дни / недели / месяцы */}
      <div style={{ marginTop: 34, maxWidth: 640 }}>
        <div style={LABEL}>
          {data?.bucket_kind === "day" ? "ПО ДНЯМ" : data?.bucket_kind === "week" ? "ПО НЕДЕЛЯМ" : "ПО МЕСЯЦАМ"}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: buckets.length > 14 ? 3 : isMobile ? 6 : 10,
                      marginTop: 16, height: 96, overflowX: "auto" }}>
          {buckets.map((b: any, i: number) => {
            const w = buckets.length > 14 ? (isMobile ? 8 : 14) : isMobile ? 22 : 36;
            const showVal = buckets.length <= 14 || b.total === maxBucket;
            const showLbl = buckets.length <= 14 || i % Math.ceil(buckets.length / 8) === 0;
            return (
              <div key={b.period} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                                           flexShrink: 0, width: w }}>
                <span style={{ fontSize: 9, color: "#6B6355", fontFamily: MONO, height: 12 }}>
                  {showVal && b.total > 0 ? Math.round(b.total) : ""}
                </span>
                <div title={`${b.period}: ${fmtAmount(b.total, cur)} · ${b.count}`}
                  style={{ width: w, background: b.total > 0 ? "#E8592A" : "#EDEBE6",
                           height: Math.max(Math.round((b.total / maxBucket) * 64), 2) }} />
                <span style={{ fontSize: 9, color: "#A89070", height: 12, whiteSpace: "nowrap" }}>
                  {showLbl ? bucketLabel(data?.bucket_kind, b.period) : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Категории и получатели — двумя колонками */}
      <div style={{ display: "grid", marginTop: 34,
                    gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 28 : 48,
                    alignItems: "start" }}>
        <div>
          <div style={{ ...LABEL, marginBottom: 10 }}>НА ЧТО УХОДЯТ ДЕНЬГИ</div>
          {(data?.categories ?? []).map((c: any) => (
            <Row key={c.category} title={c.title} total={c.total} count={c.count} currency={c.currency}
              delta={c.delta_pct} pct={Math.round((c.total / (spent || 1)) * 100)} />
          ))}
        </div>
        <div>
          <div style={{ ...LABEL, marginBottom: 10 }}>ТОП ПОЛУЧАТЕЛЕЙ</div>
          {(data?.top_payees ?? []).map((p: any) => (
            <Row key={p.payee} title={p.title} total={p.total} count={p.count} currency={p.currency}
              extra={<span style={{ color: "#A89070", fontWeight: 400 }}> · ср. {Math.round(p.avg)}</span>} />
          ))}
        </div>
      </div>

      {/* Регулярные списания */}
      <div style={{ marginTop: 34, marginBottom: 28, maxWidth: 560 }}>
        <div style={{ ...LABEL, marginBottom: 10 }}>РЕГУЛЯРНЫЕ СПИСАНИЯ</div>
        <div style={{ fontSize: 11, color: "#A89070", marginBottom: 8 }}>
          получатели, которым платишь три месяца подряд и чаще (в окне выбранного периода)
        </div>
        {(data?.recurring ?? []).length === 0 && (
          <div style={{ fontSize: 12, color: "#6B6355" }}>В этом окне не набралось — расширь период</div>
        )}
        {(data?.recurring ?? []).map((r: any) => (
          <Row key={r.payee} title={`${r.payee}${r.category_title ? ` · ${r.category_title}` : ""}`}
            total={r.per_month} currency={r.currency}
            extra={<span style={{ color: "#A89070", fontWeight: 400 }}>/мес · {r.months} мес</span>} />
        ))}
      </div>
      </>)}
    </div>
  );
}
