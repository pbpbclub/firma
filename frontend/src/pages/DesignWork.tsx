// «Проектные работы» — направление чертежей и моделей (Профи.ру, бренд pbpb).
// Себестоимость тут — машинное время агентов: часы и токены. Деньги считает токен
// (тариф модели × курс), час — вторая координата, ставки часа нет: страница копит
// показатели, из которых Юра выведет свой ценник (решения 09.09 и 11.09.2026).
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Trash, CaretDown, CaretRight, FloppyDisk } from "@phosphor-icons/react";
import { machineUsageApi, ordersApi } from "../api";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { QueryError } from "../components/ui/QueryError";
import { OrderLink } from "../components/ui/links";
import { MONO } from "../components/ui/Num";
import { fmtMoneyDash as fmt, fmtDate } from "../components/ui/format";
import { PeriodFilter } from "../components/TableFilters";
import { useTableSort, SortHeader } from "../components/ui/sort";
import { useIsMobile, HScroll } from "../components/ui/responsive";
import { RowCard } from "../components/ui/RowCard";
import { IconButton } from "../components/ui/IconButton";
import { Button } from "../components/ui/Button";

const STATUS_RU: Record<string, string> = {
  draft: "Черновик", estimate: "Смета", project: "Проект", in_production: "В работе",
  awaiting_payment: "Ждёт оплаты", completed: "Завершён", cancelled: "Отменён",
};

// Токены — заголовок величины (решение 09.09.2026): «14,1 млн», «343 млн», «12 тыс.»
function fmtTok(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: n >= 1e8 ? 0 : 1 })} млн`;
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString("ru-RU")} тыс.`;
  return String(n);
}
function fmtHours(h: number | null | undefined): string {
  if (!h) return "—";
  return `${h.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч`;
}
function fmtPct(p: number | null | undefined): string {
  return p == null ? "—" : `${p.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} %`;
}
const num = { fontFamily: MONO, fontVariantNumeric: "tabular-nums" as const };
const lbl = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em" };
const th = { fontSize: 11, color: "#A89070", letterSpacing: "0.06em", fontWeight: 400, padding: "10px 12px", textAlign: "left" as const, whiteSpace: "nowrap" as const };
const td = { padding: "11px 12px", fontSize: 13, color: "#1A1A1A", borderTop: "1px solid #F2EFE9", verticalAlign: "top" as const };

export default function DesignWork() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showRates, setShowRates] = useState(false);

  const q = useQuery({
    queryKey: ["machine-usage", "summary", from, to],
    queryFn: () => machineUsageApi.summary({ date_from: from || undefined, date_to: to || undefined }),
  });
  const { sort, toggle, apply } = useTableSort();
  const items = useMemo(() => apply((q.data?.items ?? []) as any[], {
    title: r => r.title, customer: r => r.customer_name, status: r => r.status,
    revenue: r => r.revenue, paid: r => r.paid_total, machine: r => r.machine_cost, executor: r => r.executor_paid,
    hours: r => r.hours, tokens: r => r.tokens_total, rph: r => r.rub_per_hour, rpm: r => r.rub_per_mtok,
    share: r => r.cost_share, tph: r => r.tok_per_hour,
  }), [q.data, sort]);
  const t = q.data?.totals;

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["machine-usage"] }); qc.invalidateQueries({ queryKey: ["orders"] }); };
  const remove = useMutation({
    mutationFn: (id: string) => machineUsageApi.remove(id),
    onSuccess: invalidate,
    onError: (e: any) => alert(e?.response?.data?.detail?.message || e?.response?.data?.detail || "Не удалилось"),
  });

  const toggleOpen = (id: string) => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Показатели направления. Порядок — как Юра их назвал: выручка на час, на 1 млн
  // токенов + доля себестоимости, у.е. на час; деньги отдельно машинные и людям.
  const metrics = t ? [
    { label: "ЗАКАЗОВ", value: String(t.orders), color: "#1A1A1A" },
    { label: "ВЫРУЧКА", value: fmt(t.revenue), color: "#4A7C59", sub: `оплачено ${fmt(t.paid_total)}` },
    { label: "МАШИННЫЕ ЗАТРАТЫ", value: fmt(t.machine_cost), color: "#8B3A3A", sub: `$${t.usd.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}` },
    { label: "ИСПОЛНИТЕЛЯМ", value: fmt(t.executor_paid), color: "#8B3A3A" },
    { label: "ЧАСЫ", value: fmtHours(t.hours), color: "#1A1A1A", sub: `${t.sessions} сес.` },
    { label: "ТОКЕНЫ", value: fmtTok(t.tokens_total), color: "#1A1A1A" },
    { label: "₽ / ЧАС", value: t.rub_per_hour != null ? fmt(t.rub_per_hour) : "—", color: "#E8592A", sub: "выручка на час работы" },
    { label: "₽ / 1 МЛН ТОКЕНОВ", value: t.rub_per_mtok != null ? fmt(t.rub_per_mtok) : "—", color: "#E8592A" },
    { label: "ДОЛЯ СЕБЕСТОИМОСТИ", value: fmtPct(t.cost_share), color: t.cost_share != null && t.cost_share > 100 ? "#8B3A3A" : "#1A1A1A", sub: "затраты ÷ выручка" },
    { label: "ТОКЕНОВ / ЧАС", value: fmtTok(t.tok_per_hour), color: "#1A1A1A", sub: "у.е. на час" },
  ] : [];

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ padding: isMobile ? "16px 16px 14px" : "24px 28px 20px", borderBottom: "1px solid #EDEBE6" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: isMobile ? 22 : 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Проектные работы</div>
            <div style={{ fontSize: 12, color: "#6B6355", marginTop: 4 }}>
              Сессии агентов по заказам: часы, токены, деньги. Сюда попадает всё, что пришло по API от мака и фин-агента.
            </div>
          </div>
          <PeriodFilter label="ПЕРИОД СЕССИЙ" from={from} to={to} onChange={(f, tt) => { setFrom(f); setTo(tt); }} align="right" />
        </div>
      </div>

      {q.isError && <QueryError error={q.error} what="сводку проектных работ" />}
      {q.isLoading && <Loading />}

      {t && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5, 1fr)", borderBottom: "1px solid #EDEBE6" }}>
          {metrics.map((m, i) => (
            <div key={m.label} style={{ padding: isMobile ? "12px 16px" : "16px 24px",
              borderRight: (isMobile ? i % 2 === 0 : i % 5 !== 4) ? "1px solid #EDEBE6" : "none",
              borderBottom: (isMobile ? i < metrics.length - 2 : i < 5) ? "1px solid #EDEBE6" : "none" }}>
              <div style={{ ...lbl, marginBottom: 8 }}>{m.label}</div>
              <div style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, color: m.color, ...num }}>{m.value}</div>
              {m.sub && <div style={{ fontSize: 11, color: "#6B6355", marginTop: 4 }}>{m.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Строки без заказа: папка на маке не привязана — назначить здесь, папку запомнить */}
      {q.data && q.data.unassigned.items.length > 0 && (
        <UnassignedBlock items={q.data.unassigned.items} totals={q.data.unassigned} onDone={invalidate} />
      )}

      {/* Заказы */}
      {q.data && items.length === 0 && (
        <EmptyState title="Пока нет проектных заказов с сессиями"
          hint="Записи приходят по API (POST /api/machine-usage) от мака и фин-агента; заказ с видом «Проектные работы» появится здесь сразу." />
      )}
      {items.length > 0 && !isMobile && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 28 }} />
              <th style={th}><SortHeader label="ЗАКАЗ" colKey="title" sort={sort} onToggle={toggle} /></th>
              <th style={th}><SortHeader label="КЛИЕНТ" colKey="customer" sort={sort} onToggle={toggle} /></th>
              <th style={th}><SortHeader label="СТАТУС" colKey="status" sort={sort} onToggle={toggle} /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ЦЕНА" colKey="revenue" sort={sort} onToggle={toggle} align="right" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="МАШИННЫЕ" colKey="machine" sort={sort} onToggle={toggle} align="right" title="Сессии агентов по тарифу × курс" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ИСПОЛНИТЕЛЮ" colKey="executor" sort={sort} onToggle={toggle} align="right" title="Расходы на работу по заказу, кроме машинных" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ЧАСЫ" colKey="hours" sort={sort} onToggle={toggle} align="right" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ТОКЕНЫ" colKey="tokens" sort={sort} onToggle={toggle} align="right" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="₽/Ч" colKey="rph" sort={sort} onToggle={toggle} align="right" title="Выручка на час" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="₽/1M" colKey="rpm" sort={sort} onToggle={toggle} align="right" title="Выручка на 1 млн токенов" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ДОЛЯ" colKey="share" sort={sort} onToggle={toggle} align="right" title="Себестоимость ÷ цена" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ТОК/Ч" colKey="tph" sort={sort} onToggle={toggle} align="right" title="Токенов на час работы" /></th>
            </tr>
          </thead>
          <tbody>
            {items.map((o: any) => {
              const isOpen = open.has(o.id);
              const over = o.cost_share != null && o.cost_share > 100;
              return [
                <tr key={o.id} onClick={() => toggleOpen(o.id)} style={{ cursor: "pointer", background: isOpen ? "#FAF8F5" : undefined }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                  onMouseLeave={e => (e.currentTarget.style.background = isOpen ? "#FAF8F5" : "transparent")}>
                  <td style={{ ...td, color: "#A89070" }}>{isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}</td>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }} onClick={e => e.stopPropagation()}><OrderLink id={o.id}>{o.title}</OrderLink></div>
                    <div style={{ fontSize: 11, color: "#A89070", ...num }}>{o.number}{o.usage.length ? ` · ${o.usage.length} зап.` : ""}</div>
                  </td>
                  <td style={{ ...td, color: "#6B6355" }}>{o.customer_name || "—"}</td>
                  <td style={{ ...td, color: "#6B6355", fontSize: 12 }}>{STATUS_RU[o.status] || o.status}</td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", ...num }}>{fmt(o.revenue)}<div style={{ fontSize: 10, color: "#A89070" }}>опл. {fmt(o.paid_total)}</div></td>
                  <td style={{ ...td, textAlign: "right", ...num, color: "#8B3A3A" }}>{fmt(o.machine_cost)}</td>
                  <td style={{ ...td, textAlign: "right", ...num, color: o.executor_paid ? "#8B3A3A" : "#A89070" }}>{fmt(o.executor_paid)}</td>
                  <td style={{ ...td, textAlign: "right", ...num }}>{fmtHours(o.hours)}</td>
                  <td style={{ ...td, textAlign: "right", ...num }}>{fmtTok(o.tokens_total)}</td>
                  <td style={{ ...td, textAlign: "right", ...num, color: "#E8592A" }}>{o.rub_per_hour != null ? fmt(o.rub_per_hour) : "—"}</td>
                  <td style={{ ...td, textAlign: "right", ...num, color: "#E8592A" }}>{o.rub_per_mtok != null ? fmt(o.rub_per_mtok) : "—"}</td>
                  <td style={{ ...td, textAlign: "right", ...num, color: over ? "#8B3A3A" : "#1A1A1A" }}>{fmtPct(o.cost_share)}</td>
                  <td style={{ ...td, textAlign: "right", ...num, color: "#6B6355" }}>{fmtTok(o.tok_per_hour)}</td>
                </tr>,
                isOpen && (
                  <tr key={o.id + "-u"}>
                    <td colSpan={13} style={{ padding: "0 12px 14px 40px", background: "#FAF8F5", borderTop: "1px solid #F2EFE9" }}>
                      <UsageRows rows={o.usage} onRemove={id => { if (confirm("Удалить запись вместе с её расходом по заказу?")) remove.mutate(id); }} />
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}
      {items.length > 0 && isMobile && (
        <div>
          {items.map((o: any) => {
            const isOpen = open.has(o.id);
            return (
              <div key={o.id}>
                <RowCard title={o.title} sub={`${o.number} · ${o.customer_name || "—"} · ${STATUS_RU[o.status] || o.status}`}
                  right={fmt(o.revenue)} rightSub={<span style={{ color: "#8B3A3A" }}>−{fmt(o.machine_cost + o.executor_paid)}</span>}
                  meta={<span style={num}>{fmtHours(o.hours)} · {fmtTok(o.tokens_total)} · {o.rub_per_hour != null ? `${fmt(o.rub_per_hour)}/ч` : "—"} · доля {fmtPct(o.cost_share)}</span>}
                  onClick={() => toggleOpen(o.id)} tint={isOpen ? "#FAF8F5" : undefined} />
                {isOpen && (
                  <div style={{ padding: "0 16px 12px", background: "#FAF8F5" }}>
                    <UsageRows rows={o.usage} onRemove={id => { if (confirm("Удалить запись вместе с её расходом по заказу?")) remove.mutate(id); }} />
                    <Button size="sm" onClick={() => navigate(`/orders/${o.id}`)} style={{ marginTop: 8 }}>Карточка заказа</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Разрез по агентам */}
      {q.data && q.data.by_agent.length > 0 && (
        <div style={{ padding: isMobile ? "14px 16px" : "18px 28px", borderTop: "1px solid #EDEBE6" }}>
          <div style={{ ...lbl, marginBottom: 10 }}>ПО АГЕНТАМ ЗА ПЕРИОД (включая строки без заказа)</div>
          <div style={{ display: "flex", gap: isMobile ? 16 : 40, flexWrap: "wrap" }}>
            {q.data.by_agent.map((a: any) => (
              <div key={a.agent}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{a.label}</div>
                <div style={{ fontSize: 12, color: "#6B6355", ...num, marginTop: 2 }}>
                  {fmtHours(a.hours)} · {fmtTok(a.tokens_total)} · {fmt(a.amount)} · {a.sessions} сес.
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Тарифы и курс — снимок берётся при записи, правка прошлого не трогает */}
      <div style={{ padding: isMobile ? "14px 16px" : "18px 28px", borderTop: "1px solid #EDEBE6" }}>
        <div onClick={() => setShowRates(v => !v)} style={{ ...lbl, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
          {showRates ? <CaretDown size={11} /> : <CaretRight size={11} />} ТАРИФЫ МОДЕЛЕЙ И КУРС
          {q.data && <span style={{ color: "#6B6355", letterSpacing: 0, textTransform: "none" }}>· {q.data.usd_rate} ₽/$</span>}
        </div>
        {showRates && <RatesBlock />}
      </div>
    </div>
  );
}

// Сессии одного заказа: дата, кто, модель, часы, токены по видам, деньги
function UsageRows({ rows, onRemove }: { rows: any[]; onRemove: (id: string) => void }) {
  const isMobile = useIsMobile();
  if (!rows.length) return <div style={{ fontSize: 12, color: "#A89070", padding: "8px 0" }}>Сессий по заказу ещё не записано.</div>;
  return (
    <div>
      {rows.map((r: any) => (
        <div key={r.id} style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "7px 0", borderBottom: "1px solid #F2EFE9", flexWrap: isMobile ? "wrap" : undefined }}>
          <span style={{ ...num, fontSize: 11, color: "#A89070", minWidth: 74 }}>{fmtDate(r.work_date)}</span>
          <span style={{ fontSize: 12, color: "#1A1A1A", minWidth: 110 }}>{r.agent_label}{r.platform ? <span style={{ color: "#A89070" }}> · {r.platform}</span> : null}</span>
          <span style={{ ...num, fontSize: 11, color: "#6B6355", minWidth: 150 }}>{r.model || "без модели"}</span>
          <span style={{ ...num, fontSize: 12, minWidth: 60 }}>{fmtHours(r.hours)}</span>
          <span style={{ ...num, fontSize: 12, minWidth: 90 }}>{fmtTok(r.tokens_total)}</span>
          <span style={{ ...num, fontSize: 10, color: "#A89070", flex: 1 }}
            title="вход / выход / запись кэша / чтение кэша">
            {fmtTok(r.tokens_in)} / {fmtTok(r.tokens_out)} / {fmtTok(r.cache_write)} / {fmtTok(r.cache_read)}
            {r.note ? ` · ${r.note}` : ""}
          </span>
          <span style={{ ...num, fontSize: 12, color: "#8B3A3A", minWidth: 80, textAlign: "right" }}>{fmt(r.amount)}</span>
          <span style={{ ...num, fontSize: 10, color: "#A89070", minWidth: 60, textAlign: "right" }}>${(r.usd || 0).toFixed(2)}</span>
          <IconButton icon={Trash} title="Удалить запись" tone="danger" size={24} onClick={e => { e.stopPropagation(); onRemove(r.id); }} />
        </div>
      ))}
    </div>
  );
}

// Строки без заказа: папка мака не в карте. Назначить заказ — и запомнить папку.
function UnassignedBlock({ items, totals, onDone }: { items: any[]; totals: any; onDone: () => void }) {
  const isMobile = useIsMobile();
  const { data: orders = [] } = useQuery({ queryKey: ["orders", "for-usage"], queryFn: () => ordersApi.list({}) });
  const [pick, setPick] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const assign = useMutation({
    mutationFn: async (r: any) => {
      const oid = pick[r.id];
      await machineUsageApi.patch(r.id, { order_id: oid });
      if (remember[r.id] !== false && r.project_dir) {
        const o = (orders as any[]).find((x: any) => x.id === oid);
        const dirs = new Set<string>(o?.project_dirs ?? []);
        dirs.add(r.project_dir);
        await ordersApi.setProjectDirs(oid, [...dirs]);
      }
    },
    onSuccess: onDone,
    onError: (e: any) => alert(e?.response?.data?.detail?.message || JSON.stringify(e?.response?.data?.detail) || "Не назначилось"),
  });
  return (
    <div style={{ margin: isMobile ? "10px 16px 0" : "12px 28px 0", padding: "11px 14px", background: "#FBF7EF", borderLeft: "3px solid #B8860B" }}>
      <div style={{ fontSize: 12, color: "#6B6355", lineHeight: 1.5 }}>
        <b style={{ color: "#1A1A1A" }}>Без заказа:</b> {items.length} зап. · {fmtHours(totals.hours)} · {fmtTok(totals.tokens_total)} ·{" "}
        <span style={num}>{fmt(totals.amount)}</span>. Папка на маке не привязана к заказу — назначь, папка запомнится.
      </div>
      {items.map((r: any) => (
        <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <span style={{ ...num, fontSize: 11, color: "#A89070" }}>{fmtDate(r.work_date)}</span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{r.project_dir || r.note || "—"}</span>
          <span style={{ ...num, fontSize: 12, color: "#6B6355" }}>{fmtHours(r.hours)} · {fmtTok(r.tokens_total)} · {fmt(r.amount)}</span>
          <select value={pick[r.id] || ""} onChange={e => setPick({ ...pick, [r.id]: e.target.value })}
            style={{ border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, background: "#fff", maxWidth: 320 }}>
            <option value="">— заказ —</option>
            {(orders as any[]).map((o: any) => <option key={o.id} value={o.id}>{o.number} · {o.title}</option>)}
          </select>
          {r.project_dir && (
            <label style={{ fontSize: 11, color: "#6B6355", display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={remember[r.id] !== false} onChange={e => setRemember({ ...remember, [r.id]: e.target.checked })} />
              запомнить папку
            </label>
          )}
          <Button size="sm" variant="primary" disabled={!pick[r.id] || assign.isPending} onClick={() => assign.mutate(r)}>Назначить</Button>
        </div>
      ))}
    </div>
  );
}

// Тарифы моделей ($ за 1M по четырём видам токенов) и курс ₽/$
function RatesBlock() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["machine-usage", "models"], queryFn: machineUsageApi.models });
  const [rate, setRate] = useState<string>("");
  const [draft, setDraft] = useState<Record<string, any>>({});
  const saveRate = useMutation({
    mutationFn: () => machineUsageApi.putSettings({ usd_rate: parseFloat(rate.replace(",", ".")) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["machine-usage"] }); setRate(""); },
  });
  const saveModel = useMutation({
    mutationFn: (m: any) => machineUsageApi.putModel(m),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["machine-usage", "models"] }); setDraft({}); },
    onError: (e: any) => alert(e?.response?.data?.detail || "Не сохранилось"),
  });
  const inp = { border: "1px solid #EDEBE6", padding: "4px 6px", fontSize: 12, width: 70, ...num, textAlign: "right" as const };
  const cols = ["price_in", "price_out", "price_cache_write", "price_cache_read"] as const;
  const row = (m: any) => {
    const d = draft.model === m.model ? draft : m;
    return (
      <tr key={m.model}>
        <td style={{ ...td, ...num, fontSize: 12 }}>{m.model}</td>
        {cols.map(c => (
          <td key={c} style={{ ...td, textAlign: "right" }}>
            <input value={d[c]} style={inp} onChange={e => setDraft({ ...m, ...(draft.model === m.model ? draft : {}), model: m.model, [c]: e.target.value })} />
          </td>
        ))}
        <td style={{ ...td, textAlign: "right" }}>
          {draft.model === m.model && (
            <IconButton icon={FloppyDisk} title="Сохранить тариф" size={24}
              onClick={() => saveModel.mutate({ model: m.model, note: m.note, ...Object.fromEntries(cols.map(c => [c, parseFloat(String(draft[c]).replace(",", "."))])) })} />
          )}
        </td>
      </tr>
    );
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 12, color: "#6B6355" }}>
        Курс ₽/$ для новых записей:
        <input value={rate} placeholder={String(data?.usd_rate ?? "")} onChange={e => setRate(e.target.value)} style={inp} />
        <Button size="sm" disabled={!rate || saveRate.isPending} onClick={() => saveRate.mutate()}>Сохранить</Button>
        <span style={{ color: "#A89070" }}>— уже записанные сессии не пересчитываются: у каждой свой снимок тарифа и курса.</span>
      </div>
      <HScroll minWidth={620}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}>МОДЕЛЬ</th><th style={{ ...th, textAlign: "right" }}>ВХОД $/1M</th><th style={{ ...th, textAlign: "right" }}>ВЫХОД</th>
            <th style={{ ...th, textAlign: "right" }}>ЗАПИСЬ КЭША</th><th style={{ ...th, textAlign: "right" }}>ЧТЕНИЕ КЭША</th><th style={th} />
          </tr></thead>
          <tbody>{(data?.items ?? []).map(row)}</tbody>
        </table>
      </HScroll>
      <div style={{ fontSize: 11, color: "#A89070", marginTop: 8 }}>
        Неизвестная модель в записи — отказ (400), а не расчёт «по похожей»: тихое занижение себестоимости хуже её отсутствия. Новую модель — добавит фин-агент или инженер.
      </div>
    </div>
  );
}
