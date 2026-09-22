// Личный заграничный контур: один файл на все страны (/region/:code).
// Новая страна — строка в справочнике на сервере, не новый экран.
//
// Главный вопрос Юры (22.09.2026): «в какие дни выгодно менять доллары на лари».
// Отвечаем ТОЛЬКО фактом — сегодняшний официальный курс против собственного
// разброса за месяц и квартал. Прогнозов не делаем и «курса рынка» не обещаем:
// официальный курс Нацбанка ≠ курс, по которому меняет банк, и это здесь сказано
// прямо, а не спрятано в мелкий шрифт.
import { useState } from "react";
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

const LABEL: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em" };

const MONTH_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
// «2026-03» → «мар»; у января добавляем год, иначе граница лет не читается.
function monthLabel(period: string): string {
  const [y, m] = (period || "").split("-");
  const idx = Number(m) - 1;
  if (idx < 0 || idx > 11) return period;
  return idx === 0 ? `${MONTH_RU[idx]} ${String(y).slice(2)}` : MONTH_RU[idx];
}

const VERDICT: Record<string, { text: string; color: string }> = {
  good:    { text: "Сегодня менять выгодно", color: "#4A7C59" },
  normal:  { text: "Курс средний",           color: "#1A1A1A" },
  wait:    { text: "Сегодня лучше подождать", color: "#8B3A3A" },
  unknown: { text: "Мало данных",            color: "#6B6355" },
  no_data: { text: "Курсы не загружены",     color: "#6B6355" },
};

// График курса: тонкая линия по дизайн-системе (без карточек и скруглений).
function RateChart({ rows, days }: { rows: any[]; days: number }) {
  const isMobile = useIsMobile();
  const H = 120;
  const W = isMobile ? 340 : 720;
  if (rows.length < 2) return <div style={{ fontSize: 12, color: "#6B6355" }}>Мало точек для графика</div>;
  const vals = rows.map(r => r.rate);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (rows.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / span) * H;
  const path = rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.rate).toFixed(1)}`).join(" ");
  const last = rows[rows.length - 1];
  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={W} height={H + 18} style={{ display: "block" }}>
        {/* медиана — опорная линия, чтобы «выше/ниже обычного» читалось глазами */}
        <line x1={0} y1={y((lo + hi) / 2)} x2={W} y2={y((lo + hi) / 2)} stroke="#EDEBE6" strokeWidth={1} />
        <path d={path} fill="none" stroke="#E8592A" strokeWidth={1.5} />
        <circle cx={x(rows.length - 1)} cy={y(last.rate)} r={3} fill="#E8592A" />
        <text x={0} y={H + 14} style={{ fontSize: 10, fill: "#A89070" }}>{rows[0].date}</text>
        <text x={W} y={H + 14} textAnchor="end" style={{ fontSize: 10, fill: "#A89070" }}>{last.date}</text>
        <text x={0} y={12} style={{ fontSize: 10, fill: "#A89070" }}>макс {hi}</text>
        <text x={0} y={H - 2} style={{ fontSize: 10, fill: "#A89070" }}>мин {lo}</text>
      </svg>
      <div style={{ ...LABEL, marginTop: 2 }}>КУРС USD → GEL ЗА {days} ДНЕЙ · НАЦБАНК ГРУЗИИ</div>
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

  const { data: signal, isLoading } = useQuery({
    queryKey: ["fx-signal", who], queryFn: fxApi.signal,
    enabled: isOwner,
  });
  const { data: series } = useQuery({
    queryKey: ["fx-series", "USD", who], queryFn: () => fxApi.series("USD", "GEL", 90),
    enabled: isOwner,
  });
  const { data: abroad } = useQuery({
    queryKey: ["abroad-summary", who], queryFn: () => financeApi.abroadSummary(12),
    enabled: isOwner,
  });
  const { data: accounts = [] } = useQuery({
    queryKey: ["zm-accounts", who], queryFn: zenmoneyApi.accounts,
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

  const v = VERDICT[signal?.verdict || "no_data"];
  const regionAccounts = (accounts as any[]).filter((a: any) => a.region === code);
  const months = abroad?.months ?? [];
  const maxMonth = Math.max(...months.map((m: any) => m.amount_rub), 1);

  return (
    <div style={{ padding: isMobile ? `20px ${M.pageX}px 32px` : "32px 40px", overflowY: "auto", height: "100%" }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", margin: 0 }}>
        {code === "ge" ? "Грузия" : code.toUpperCase()}
      </h1>

      {/* Одинаковые названия счетов: честно говорим, что именно из-за этого не работает */}
      {!!signal?.ambiguous?.length && (
        <div style={{ marginTop: 14, padding: "10px 12px", border: "1px solid #EDEBE6", background: "#FAF8F5",
                      fontSize: 12, color: "#6B6355", lineHeight: 1.5, maxWidth: 760 }}>
          <b style={{ color: "#B8860B" }}>{signal.ambiguous.length} счёта делят одно название</b> в ZenMoney
          («{signal.ambiguous[0].title}»). Остатки считаются — валюта у счёта известна. А вот отдельные
          операции к ним привязать нечем: в транзакциях нога хранится НАЗВАНИЕМ счёта. Переименуй счета
          в ZenMoney (например «Сола ₾ / $ / €») и попроси фин-агента сделать полный пересинк — история
          перепишется, и появятся твои реальные курсы обмена, спред банка и разбор маршрутов.
        </div>
      )}

      {/* Вкладки: курс · операции · аналитика */}
      <div style={{ display: "flex", gap: 0, marginTop: 18, borderBottom: "1px solid #EDEBE6",
                    ...(isMobile ? M.tabStrip : null) }}>
        {([["fx", "Обмен"], ["tx", "Операции"], ["stats", "Аналитика"]] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key)}
            style={{
              padding: "8px 14px", fontSize: 13, fontFamily: "inherit", cursor: "pointer",
              background: "none", border: "none", flexShrink: 0,
              color: tab === key ? "#1A1A1A" : "#A89070",
              fontWeight: tab === key ? 600 : 400,
              borderBottom: tab === key ? "2px solid #E8592A" : "2px solid transparent",
            }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "tx" && <TxTab code={code} who={who} />}
      {tab === "stats" && <StatsTab code={code} who={who} />}

      {tab === "fx" && (<>
      {/* ── Обмен: главный блок ────────────────────────────────────────── */}
      <div style={{ marginTop: 26 }}>
        <div style={LABEL}>ОБМЕН ДОЛЛАРОВ НА ЛАРИ</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.03em", fontFamily: MONO, color: "#1A1A1A" }}>
            {signal?.rate ?? "—"} ₾
          </div>
          <div style={{ fontSize: 12, color: "#6B6355" }}>за $1 · {signal?.date}</div>
        </div>
        <div style={{ marginTop: 6, fontSize: 14, fontWeight: 600, color: v.color }}>{v.text}</div>
        <div style={{ marginTop: 2, fontSize: 12, color: "#6B6355" }}>{signal?.note}</div>

        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, max-content)",
                      gap: isMobile ? "10px 18px" : 28, marginTop: 16 }}>
          {[["худший за 30 дней", signal?.worst_30], ["обычный (медиана)", signal?.median_30],
            ["лучший за 30 дней", signal?.best_30], ["дней в расчёте", signal?.days_30]].map(([l, val]: any) => (
            <div key={l}>
              <div style={LABEL}>{String(l).toUpperCase()}</div>
              <div style={{ fontSize: 15, fontWeight: 600, fontFamily: MONO, marginTop: 3 }}>{val ?? "—"}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 10, fontSize: 11, color: "#A89070", lineHeight: 1.5, maxWidth: 640 }}>
          Курс официальный, от Нацбанка Грузии. Банк меняет по своему — обычно чуть хуже; когда операции
          обмена станут разборными, здесь появится твой реальный спред к этой линии.
        </div>
      </div>

      {/* ── Сколько свободно менять ───────────────────────────────────── */}
      <div style={{ marginTop: 28 }}>
        <div style={LABEL}>СКОЛЬКО МОЖНО ПОМЕНЯТЬ</div>
        <div style={{ display: "flex", gap: isMobile ? 18 : 32, marginTop: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 11, color: "#6B6355" }}>на долларовом счёте</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO }}>
              {fmtAmount(signal?.balances?.USD ?? 0, "USD")}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6B6355" }}>держу про запас</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, color: "#6B6355" }}>
              {fmtAmount(signal?.usd_reserve ?? 0, "USD")}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6B6355" }}>свободно</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, color: "#4A7C59" }}>
              {fmtAmount(signal?.usd_free ?? 0, "USD")}
            </div>
          </div>
          {!!signal?.gel_if_converted && (
            <div>
              <div style={{ fontSize: 11, color: "#6B6355" }}>это по сегодняшнему курсу</div>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO }}>
                {fmtAmount(signal.gel_if_converted, "GEL")}
              </div>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#6B6355" }}>Неснижаемый запас в долларах:</span>
          <input value={reserve} onChange={e => setReserve(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder={String(signal?.usd_reserve ?? 0)}
            style={{ width: 90, padding: "5px 8px", border: "1px solid #EDEBE6", fontFamily: MONO, fontSize: 13 }} />
          <button type="button" disabled={!reserve || saveReserve.isPending}
            onClick={() => saveReserve.mutate(Number(reserve))}
            style={{ padding: "5px 12px", fontSize: 12, fontFamily: "inherit", cursor: "pointer",
                     border: "1px solid #E8592A", background: "#E8592A", color: "#FFFFFF" }}>
            Сохранить
          </button>
          <span style={{ fontSize: 11, color: "#A89070" }}>ниже этой суммы менять не предлагаем</span>
        </div>
      </div>

      {/* ── График ────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 30 }}>
        <RateChart rows={series?.rows ?? []} days={90} />
      </div>

      {/* ── Остатки ───────────────────────────────────────────────────── */}
      <div style={{ marginTop: 30 }}>
        <div style={LABEL}>СЧЕТА</div>
        <div style={{ marginTop: 8 }}>
          {regionAccounts.length === 0 && (
            <div style={{ fontSize: 12, color: "#6B6355" }}>Счета региона не настроены</div>
          )}
          {regionAccounts.map((a: any) => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0",
                                     borderBottom: "1px solid #F2EFE9", maxWidth: 480 }}>
              <span style={{ fontSize: 12, color: "#6B6355" }}>
                {a.title} <span style={{ color: "#A89070" }}>{currencySign(a.currency)}</span>
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, fontFamily: MONO }}>
                {fmtAmount(a.balance, a.currency)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Выведено себе за границу ──────────────────────────────────── */}
      <div style={{ marginTop: 30, marginBottom: 20 }}>
        <div style={LABEL}>ВЫВЕДЕНО СЕБЕ ЗА ГРАНИЦУ · {abroad?.count ?? 0} ПЕРЕВОДОВ</div>
        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: MONO, marginTop: 6 }}>
          {fmtAmount(abroad?.total ?? 0, "RUB")}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, marginTop: 14, height: 60 }}>
          {months.map((m: any) => (
            <div key={m.period} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div title={`${m.period}: ${fmtAmount(m.amount_rub, "RUB")} · ${m.count}`}
                style={{ width: isMobile ? 18 : 26, background: "#E8592A",
                         height: Math.max(Math.round((m.amount_rub / maxMonth) * 50), 2) }} />
              <span style={{ fontSize: 9, color: "#A89070" }}>{monthLabel(m.period)}</span>
            </div>
          ))}
        </div>
      </div>
      </>)}
    </div>
  );
}

// ── Операции по карте региона ────────────────────────────────────────────────
// Категория не хранится в строке, а выводится на чтении из правил «получатель →
// категория». Поэтому разметка одного получателя перекрашивает сразу все его
// операции, включая прошлогодние, — перебирать ленту руками не нужно.
const TX_GRID = "74px 1fr 150px 110px";

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
      <div style={{ display: "flex", gap: 6, marginBottom: 12, ...(isMobile ? M.tabStrip : null) }}>
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
        padding: "10px 0 6px", borderBottom: "1px solid #EDEBE6",
      }}>
        <PeriodFilter label="ДАТА" from={dateFrom} to={dateTo}
          onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
        <div style={{ ...LABEL }}>{isMobile ? "" : "ПОЛУЧАТЕЛЬ"}</div>
        <ColumnFilter label="КАТЕГОРИЯ" options={catTitles}
          value={cats.find((c: any) => c.code === category)?.title || ""}
          onChange={(v) => setCategory(v === "Все" ? "" : (titleToCode[v] || ""))} />
        <AmountFilter label="СУММА" min={amountMin} max={amountMax}
          onChange={(mn, mx) => { setAmountMin(mn); setAmountMax(mx); }} align="right" />
      </div>

      <div style={{ padding: "8px 0", fontSize: 11, color: "#6B6355", display: "flex",
                    justifyContent: "space-between", borderBottom: "1px solid #F2EFE9" }}>
        <span>{data?.total_found ?? 0} операций{data?.truncated ? " · показаны первые 400" : ""}</span>
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

        return isMobile ? (
          <RowCard key={t.id}
            title={t.payee || t.comment || "—"}
            sub={<>{String(t.date || "").slice(5)}{t.comment && t.payee ? <> · {t.comment}</> : null}</>}
            right={<span style={{ color }}>{sign}{fmtAmount(t.amount, t.currency)}</span>}
            meta={catCell}
          />
        ) : (
          <div key={t.id} style={{ display: "grid", gridTemplateColumns: TX_GRID, padding: "7px 0",
                                   borderBottom: "1px solid #F2EFE9", alignItems: "start" }}>
            <div style={{ fontSize: 11, color: "#6B6355", fontFamily: MONO }}>{String(t.date || "").slice(5)}</div>
            <div>
              <div style={{ fontSize: 12, color: "#1A1A1A" }}>{t.payee || "—"}</div>
              {t.comment && <div style={{ fontSize: 10, color: "#A89070" }}>{t.comment}</div>}
            </div>
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
function StatsTab({ code, who }: { code: string; who: string }) {
  const isMobile = useIsMobile();
  const [months, setMonths] = useState(6);
  const { data, isLoading } = useQuery({
    queryKey: ["region-stats", code, who, months], queryFn: () => regionsApi.spending(code, months),
  });
  if (isLoading) return <Loading />;

  const mixed = !data?.currency_split;
  const cur = data?.currency ?? null;
  const maxMonth = Math.max(...(data?.months ?? []).map((m: any) => m.total), 1);
  const spent = data?.spent ?? 0;

  const Row = ({ title, total, count, extra, pct, currency }: any) => (
    <div style={{ padding: "6px 0", borderBottom: "1px solid #F2EFE9" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 10 }}>
        <span style={{ fontSize: 11, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis",
                       whiteSpace: "nowrap" }}>{title}</span>
        <span style={{ fontSize: 11, fontWeight: 500, color: "#8B3A3A", fontFamily: MONO, whiteSpace: "nowrap" }}>
          {fmtAmount(total, currency ?? cur)}
          {count != null && <span style={{ color: "#A89070", fontWeight: 400 }}> · {count}</span>}
          {extra}
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
      <div style={{ display: "flex", gap: 6, marginBottom: 16, ...(isMobile ? M.tabStrip : null) }}>
        {[3, 6, 12].map(m => (
          <button key={m} type="button" onClick={() => setMonths(m)}
            style={{ padding: "4px 10px", fontSize: 11, fontFamily: "inherit", cursor: "pointer", flexShrink: 0,
                     border: `1px solid ${months === m ? "#E8592A" : "#EDEBE6"}`,
                     background: months === m ? "#E8592A" : "none",
                     color: months === m ? "#FFFFFF" : "#A89070" }}>{m} мес</button>
        ))}
      </div>

      <div style={LABEL}>ПОТРАЧЕНО ЗА {months} МЕС · {data?.count ?? 0} ОПЕРАЦИЙ</div>
      <div style={{ fontSize: 26, fontWeight: 700, fontFamily: MONO, letterSpacing: "-0.03em", marginTop: 4 }}>
        {fmtAmount(spent, cur)}
      </div>
      {mixed && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#B8860B", lineHeight: 1.5, maxWidth: 620 }}>
          Валюта операций пока не разделена: в суммах смешаны лари и доллары. Знак валюты
          поэтому не ставим — станет точно после переименования счетов и пересинка.
        </div>
      )}

      {/* Месяц к месяцу */}
      <div style={{ marginTop: 24 }}>
        <div style={LABEL}>МЕСЯЦ К МЕСЯЦУ</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: isMobile ? 6 : 10, marginTop: 12, height: 80 }}>
          {(data?.months ?? []).map((m: any) => (
            <div key={m.period} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 9, color: "#6B6355", fontFamily: MONO }}>{Math.round(m.total)}</span>
              <div title={`${m.period}: ${fmtAmount(m.total, m.currency ?? cur)} · ${m.count}`}
                style={{ width: isMobile ? 22 : 34, background: "#E8592A",
                         height: Math.max(Math.round((m.total / maxMonth) * 56), 2) }} />
              <span style={{ fontSize: 9, color: "#A89070" }}>{monthLabel(m.period)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Категории */}
      <div style={{ marginTop: 26 }}>
        <div style={{ ...LABEL, marginBottom: 8 }}>НА ЧТО УХОДЯТ ДЕНЬГИ</div>
        {(data?.categories ?? []).map((c: any) => (
          <Row key={c.category} title={c.title} total={c.total} count={c.count} currency={c.currency}
            pct={Math.round((c.total / (spent || 1)) * 100)} />
        ))}
      </div>

      {/* Топ получателей */}
      <div style={{ marginTop: 26 }}>
        <div style={{ ...LABEL, marginBottom: 8 }}>ТОП ПОЛУЧАТЕЛЕЙ</div>
        {(data?.top_payees ?? []).map((p: any) => (
          <Row key={p.payee} title={p.title} total={p.total} count={p.count} currency={p.currency}
            extra={<span style={{ color: "#A89070", fontWeight: 400 }}> · ср. {Math.round(p.avg)}</span>} />
        ))}
      </div>

      {/* Регулярные списания */}
      <div style={{ marginTop: 26, marginBottom: 24 }}>
        <div style={{ ...LABEL, marginBottom: 8 }}>РЕГУЛЯРНЫЕ СПИСАНИЯ</div>
        <div style={{ fontSize: 11, color: "#A89070", marginBottom: 8 }}>
          получатели, которым платишь три месяца подряд и чаще
        </div>
        {(data?.recurring ?? []).length === 0 && (
          <div style={{ fontSize: 12, color: "#6B6355" }}>Пока не набралось</div>
        )}
        {(data?.recurring ?? []).map((r: any) => (
          <Row key={r.payee} title={`${r.payee}${r.category_title ? ` · ${r.category_title}` : ""}`}
            total={r.per_month} currency={r.currency}
            extra={<span style={{ color: "#A89070", fontWeight: 400 }}>/мес · {r.months} мес</span>} />
        ))}
      </div>
    </div>
  );
}
