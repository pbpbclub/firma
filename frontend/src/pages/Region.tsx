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
import { fxApi, financeApi, zenmoneyApi } from "../api";
import { useMe } from "../auth";
import { Loading } from "../components/ui/Loading";
import { MONO } from "../components/ui/Num";
import { fmtAmount, currencySign } from "../components/ui/format";
import { useIsMobile, M } from "../components/ui/responsive";

const LABEL: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em" };

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
              <span style={{ fontSize: 9, color: "#A89070" }}>{m.period.slice(5)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
