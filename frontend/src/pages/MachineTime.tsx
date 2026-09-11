// «Машинное время» — сессии агентов по заказам: часы, токены, модели (решение Юры
// 11.09.2026). Рублей за токены нет — никто их не платил: деньги на странице только
// реальные (цена, оплачено, выплаты людям), а машинное время — у.е. (токены) и часы,
// по моделям, чтобы найти корреляцию и вывести ценник. $ по тарифу API — справочно.
// Вид прибыли (справочник activities) — фильтр, не ограничение: производственный
// заказ с сессиями конструктора виден так же, как проектный.
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

// Токены — заголовок величины: «14,1 млн», «343 млн», «12 тыс.»
export function fmtTok(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: n >= 1e8 ? 0 : 1 })} млн`;
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString("ru-RU")} тыс.`;
  return String(n);
}
function fmtHours(h: number | null | undefined): string {
  if (!h) return "—";
  return `${h.toLocaleString("ru-RU", { maximumFractionDigits: h < 1 ? 2 : 1 })} ч`;
}
function fmtUsd(u: number | null | undefined): string {
  return u ? `$${u.toLocaleString("ru-RU", { maximumFractionDigits: u >= 100 ? 0 : 1 })}` : "—";
}
// «claude-fable-5-1» → «fable-5-1»: префикс вендора в чипе — шум
const shortModel = (m: string) => (m || "").replace(/^claude-/, "");
const num = { fontFamily: MONO, fontVariantNumeric: "tabular-nums" as const };
const lbl = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em" };
const th = { fontSize: 11, color: "#A89070", letterSpacing: "0.06em", fontWeight: 400, padding: "10px 12px", textAlign: "left" as const, whiteSpace: "nowrap" as const };
const td = { padding: "11px 12px", fontSize: 13, color: "#1A1A1A", borderTop: "1px solid #F2EFE9", verticalAlign: "top" as const };

function ModelChips({ models, max = 3 }: { models: any[]; max?: number }) {
  if (!models?.length) return <span style={{ color: "#C8C0B0" }}>—</span>;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {models.slice(0, max).map((m: any) => (
        <span key={m.model} title={`${m.model}: ${fmtTok(m.tokens_total)} токенов, ${fmtHours(m.hours)}, ${fmtUsd(m.usd_est)} по тарифу`}
          style={{ ...num, fontSize: 10.5, background: "#F2EFE9", color: "#1A1A1A", padding: "2px 6px", whiteSpace: "nowrap" }}>
          {shortModel(m.model)} · {fmtTok(m.tokens_total)}
        </span>
      ))}
      {models.length > max && <span style={{ fontSize: 10.5, color: "#A89070" }}>+{models.length - max}</span>}
    </span>
  );
}

function ActivityPill({ name, color }: { name?: string; color?: string }) {
  if (!name) return null;
  return <span style={{ fontSize: 10.5, fontWeight: 600, color: color || "#6B6355", border: `1px solid ${color || "#EDEBE6"}`, padding: "1px 6px", whiteSpace: "nowrap" }}>{name}</span>;
}

export default function MachineTime() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Замеряем только проектные работы, сделанные и оплаченные (Юра 11.09.2026):
  // другие виды прибыли и неоплаченные заказы на странице не показываются.
  const activity = "design";
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showRates, setShowRates] = useState(false);

  const q = useQuery({
    queryKey: ["machine-usage", "summary", from, to, activity],
    queryFn: () => machineUsageApi.summary({ date_from: from || undefined, date_to: to || undefined, activity, paid_only: true }),
  });
  const { sort, toggle, apply } = useTableSort();
  const items = useMemo(() => apply((q.data?.items ?? []) as any[], {
    title: r => r.title, activity: r => r.activity_name, customer: r => r.customer_name, status: r => r.status,
    revenue: r => r.revenue, people: r => r.people_paid, hours: r => r.hours, tokens: r => r.tokens_total,
    rph: r => r.rub_per_hour, rpm: r => r.rub_per_mtok, tph: r => r.tok_per_hour, usd: r => r.usd_est,
  }), [q.data, sort]);
  const t = q.data?.totals;

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["machine-usage"] }); qc.invalidateQueries({ queryKey: ["orders"] }); };
  const remove = useMutation({
    mutationFn: (id: string) => machineUsageApi.remove(id),
    onSuccess: invalidate,
    onError: (e: any) => alert(e?.response?.data?.detail?.message || e?.response?.data?.detail || "Не удалилось"),
  });
  const toggleOpen = (id: string) => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const onRemove = (id: string) => { if (confirm("Удалить запись машинного времени?")) remove.mutate(id); };

  // Порядок — как Юра назвал показатели: ₽ на час, ₽ на 1 млн токенов, токенов на час.
  // Деньги — только реальные; $ по тарифу — серым, справочно.
  const metrics = t ? [
    { label: "ЗАКАЗОВ", value: String(t.orders), color: "#1A1A1A" },
    { label: "ВЫРУЧКА", value: fmt(t.revenue), color: "#4A7C59", sub: `оплачено ${fmt(t.paid_total)}` },
    { label: "ЧАСЫ", value: fmtHours(t.hours), color: "#1A1A1A", sub: `${t.sessions} сес.` },
    { label: "ТОКЕНЫ", value: fmtTok(t.tokens_total), color: "#1A1A1A", sub: "у.е. машинного времени" },
    { label: "₽ / ЧАС", value: t.rub_per_hour != null ? fmt(t.rub_per_hour) : "—", color: "#E8592A", sub: "выручка на час работы" },
    { label: "₽ / 1 МЛН ТОКЕНОВ", value: t.rub_per_mtok != null ? fmt(t.rub_per_mtok) : "—", color: "#E8592A" },
    { label: "ТОКЕНОВ / ЧАС", value: fmtTok(t.tok_per_hour), color: "#1A1A1A", sub: "связь часов и у.е." },
    { label: "$ ПО ТАРИФУ API", value: fmtUsd(t.usd_est), color: "#A89070", sub: "справочно, не деньги" },
    { label: "ВЫПЛАЧЕНО ЛЮДЯМ", value: fmt(t.people_paid), color: t.people_paid ? "#8B3A3A" : "#A89070", sub: t.people_share != null ? `${t.people_share} % от выручки` : "расходов на работу нет" },
  ] : [];
  const cols = isMobile ? 2 : 3;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ padding: isMobile ? "16px 16px 14px" : "24px 28px 20px", borderBottom: "1px solid #EDEBE6" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: isMobile ? 22 : 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Машинное время</div>
            <div style={{ fontSize: 12, color: "#6B6355", marginTop: 4 }}>
              Проектные работы, сделанные и оплаченные: сколько часов и токенов конструктора ушло на каждый рубль.
              Сессии приходят по API от мака и фин-агента; рублями не считаются.
              {q.data?.skipped_unpaid ? <span style={{ color: "#A89070" }}> Не оплачено и скрыто: {q.data.skipped_unpaid}.</span> : null}
            </div>
          </div>
          <PeriodFilter label="ПЕРИОД СЕССИЙ" from={from} to={to} onChange={(f, tt) => { setFrom(f); setTo(tt); }} align="right" />
        </div>
      </div>

      {q.isError && <QueryError error={q.error} what="сводку машинного времени" />}
      {q.isLoading && <Loading />}

      {t && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, borderBottom: "1px solid #EDEBE6" }}>
          {metrics.map((m, i) => (
            <div key={m.label} style={{ padding: isMobile ? "12px 16px" : "16px 24px",
              borderRight: i % cols !== cols - 1 ? "1px solid #EDEBE6" : "none",
              borderBottom: i < metrics.length - cols + ((metrics.length % cols) === 0 ? 0 : (cols - metrics.length % cols)) ? "1px solid #EDEBE6" : "none" }}>
              <div style={{ ...lbl, marginBottom: 8 }}>{m.label}</div>
              <div style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, color: m.color, ...num }}>{m.value}</div>
              {m.sub && <div style={{ fontSize: 11, color: "#6B6355", marginTop: 4 }}>{m.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {q.data && q.data.unassigned.items.length > 0 && (
        <UnassignedBlock items={q.data.unassigned.items} totals={q.data.unassigned} onDone={invalidate} />
      )}

      {q.data && items.length === 0 && (
        <EmptyState title="Сессий агентов пока нет"
          hint="Оплаченных проектных заказов с сессиями за период нет. Записи приходят по API от мака и фин-агента." />
      )}
      {items.length > 0 && !isMobile && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 28 }} />
              <th style={th}><SortHeader label="ЗАКАЗ" colKey="title" sort={sort} onToggle={toggle} /></th>
              <th style={th}><SortHeader label="ВИД" colKey="activity" sort={sort} onToggle={toggle} /></th>
              <th style={th}><SortHeader label="КЛИЕНТ" colKey="customer" sort={sort} onToggle={toggle} /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ЦЕНА" colKey="revenue" sort={sort} onToggle={toggle} align="right" /></th>
              <th style={th}>МОДЕЛИ</th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ЧАСЫ" colKey="hours" sort={sort} onToggle={toggle} align="right" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ТОКЕНЫ" colKey="tokens" sort={sort} onToggle={toggle} align="right" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="₽/Ч" colKey="rph" sort={sort} onToggle={toggle} align="right" title="Выручка на час" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="₽/1M" colKey="rpm" sort={sort} onToggle={toggle} align="right" title="Выручка на 1 млн токенов" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ТОК/Ч" colKey="tph" sort={sort} onToggle={toggle} align="right" title="Токенов на час работы" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="$ ТАРИФ" colKey="usd" sort={sort} onToggle={toggle} align="right" title="Оценка по тарифу API — справочно" /></th>
              <th style={{ ...th, textAlign: "right" }}><SortHeader label="ЛЮДЯМ" colKey="people" sort={sort} onToggle={toggle} align="right" title="Расходы на работу по заказу — реальные деньги" /></th>
            </tr>
          </thead>
          <tbody>
            {items.map((o: any) => {
              const isOpen = open.has(o.id);
              return [
                <tr key={o.id} onClick={() => toggleOpen(o.id)} style={{ cursor: "pointer", background: isOpen ? "#FAF8F5" : undefined }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                  onMouseLeave={e => (e.currentTarget.style.background = isOpen ? "#FAF8F5" : "transparent")}>
                  <td style={{ ...td, color: "#A89070" }}>{isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}</td>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }} onClick={e => e.stopPropagation()}><OrderLink id={o.id}>{o.title}</OrderLink></div>
                    <div style={{ fontSize: 11, color: "#A89070", ...num }}>{o.number} · {STATUS_RU[o.status] || o.status}{o.usage.length ? ` · ${o.usage.length} зап.` : ""}</div>
                  </td>
                  <td style={td}><ActivityPill name={o.activity_name} color={o.activity_color} /></td>
                  <td style={{ ...td, color: "#6B6355" }}>{o.customer_name || "—"}</td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", ...num }}>{fmt(o.revenue)}<div style={{ fontSize: 10, color: "#A89070" }}>опл. {fmt(o.paid_total)}</div></td>
                  <td style={td}><ModelChips models={o.models} /></td>
                  <td style={{ ...td, textAlign: "right", ...num }}>{fmtHours(o.hours)}</td>
                  <td style={{ ...td, textAlign: "right", ...num }}>{fmtTok(o.tokens_total)}</td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", ...num, color: "#E8592A" }}>{o.rub_per_hour != null ? fmt(o.rub_per_hour) : "—"}</td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", ...num, color: "#E8592A" }}>{o.rub_per_mtok != null ? fmt(o.rub_per_mtok) : "—"}</td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", ...num, color: "#6B6355" }}>{fmtTok(o.tok_per_hour)}</td>
                  <td style={{ ...td, textAlign: "right", ...num, color: "#A89070" }}>{fmtUsd(o.usd_est)}</td>
                  <td style={{ ...td, textAlign: "right", ...num, color: o.people_paid ? "#8B3A3A" : "#C8C0B0" }}>{fmt(o.people_paid)}</td>
                </tr>,
                isOpen && (
                  <tr key={o.id + "-u"}>
                    <td colSpan={13} style={{ padding: "0 12px 14px 40px", background: "#FAF8F5", borderTop: "1px solid #F2EFE9" }}>
                      <UsageRows rows={o.usage} onRemove={onRemove} />
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
                  badge={<ActivityPill name={o.activity_name} color={o.activity_color} />}
                  right={fmt(o.revenue)} rightSub={<span style={{ color: "#A89070" }}>{fmtUsd(o.usd_est)}</span>}
                  meta={<span style={num}>{fmtHours(o.hours)} · {fmtTok(o.tokens_total)} · {o.rub_per_hour != null ? `${fmt(o.rub_per_hour)}/ч` : "—"} · {o.models.map((m: any) => shortModel(m.model)).join(", ") || "—"}</span>}
                  onClick={() => toggleOpen(o.id)} tint={isOpen ? "#FAF8F5" : undefined} />
                {isOpen && (
                  <div style={{ padding: "0 16px 12px", background: "#FAF8F5" }}>
                    <UsageRows rows={o.usage} onRemove={onRemove} />
                    <Button size="sm" onClick={() => navigate(`/orders/${o.id}`)} style={{ marginTop: 8 }}>Карточка заказа</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {q.data && (q.data.by_model.length > 0 || q.data.by_agent.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", borderTop: "1px solid #EDEBE6" }}>
          <div style={{ padding: isMobile ? "14px 16px" : "18px 28px", borderRight: isMobile ? "none" : "1px solid #EDEBE6" }}>
            <div style={{ ...lbl, marginBottom: 10 }}>ПО МОДЕЛЯМ ЗА ПЕРИОД</div>
            {q.data.by_model.map((m: any) => (
              <div key={m.model} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #F2EFE9", fontSize: 12 }}>
                <span style={{ ...num, color: "#1A1A1A" }}>{m.model}</span>
                <span style={{ ...num, color: "#6B6355", whiteSpace: "nowrap" }}>{m.sessions} сес. · {fmtHours(m.hours)} · <b style={{ color: "#1A1A1A" }}>{fmtTok(m.tokens_total)}</b> · <span style={{ color: "#A89070" }}>{fmtUsd(m.usd_est)}</span></span>
              </div>
            ))}
          </div>
          <div style={{ padding: isMobile ? "14px 16px" : "18px 28px" }}>
            <div style={{ ...lbl, marginBottom: 10 }}>ПО АГЕНТАМ ЗА ПЕРИОД (включая строки без заказа)</div>
            {q.data.by_agent.map((a: any) => (
              <div key={a.agent} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #F2EFE9", fontSize: 12 }}>
                <span style={{ color: "#1A1A1A", fontWeight: 500 }}>{a.label}</span>
                <span style={{ ...num, color: "#6B6355", whiteSpace: "nowrap" }}>{a.sessions} сес. · {fmtHours(a.hours)} · <b style={{ color: "#1A1A1A" }}>{fmtTok(a.tokens_total)}</b> · <span style={{ color: "#A89070" }}>{fmtUsd(a.usd_est)}</span></span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: isMobile ? "14px 16px" : "18px 28px", borderTop: "1px solid #EDEBE6" }}>
        <div onClick={() => setShowRates(v => !v)} style={{ ...lbl, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
          {showRates ? <CaretDown size={11} /> : <CaretRight size={11} />} ТАРИФЫ МОДЕЛЕЙ ($ ЗА 1 МЛН ТОКЕНОВ — ДЛЯ СПРАВОЧНОЙ ОЦЕНКИ)
        </div>
        {showRates && <RatesBlock />}
      </div>
    </div>
  );
}

// Сессии одного заказа: дата, кто, модель, часы, токены по видам, $ справочно
function UsageRows({ rows, onRemove }: { rows: any[]; onRemove: (id: string) => void }) {
  const isMobile = useIsMobile();
  if (!rows.length) return <div style={{ fontSize: 12, color: "#A89070", padding: "8px 0" }}>Сессий по заказу ещё не записано.</div>;
  return (
    <div>
      {rows.map((r: any) => (
        <div key={r.id} style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "7px 0", borderBottom: "1px solid #F2EFE9", flexWrap: isMobile ? "wrap" : undefined }}>
          <span style={{ ...num, fontSize: 11, color: "#A89070", minWidth: 74 }}>{fmtDate(r.work_date)}</span>
          <span style={{ fontSize: 12, color: "#1A1A1A", minWidth: 110 }}>{r.agent_label}{r.platform ? <span style={{ color: "#A89070" }}> · {r.platform}</span> : null}</span>
          <span style={{ ...num, fontSize: 11, color: "#1A1A1A", minWidth: 120 }}>{shortModel(r.model) || "без модели"}</span>
          <span style={{ ...num, fontSize: 12, minWidth: 60 }}>{fmtHours(r.hours)}</span>
          <span style={{ ...num, fontSize: 12, minWidth: 90 }}>{fmtTok(r.tokens_total)}</span>
          <span style={{ ...num, fontSize: 10, color: "#A89070", flex: 1 }} title="вход / выход / запись кэша / чтение кэша">
            {fmtTok(r.tokens_in)} / {fmtTok(r.tokens_out)} / {fmtTok(r.cache_write)} / {fmtTok(r.cache_read)}
            {r.note ? <span style={{ color: "#B8860B" }}> · {r.note}</span> : ""}
          </span>
          <span style={{ ...num, fontSize: 11, color: "#A89070", minWidth: 60, textAlign: "right" }}>{fmtUsd(r.usd_est)}</span>
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
        <b style={{ color: "#1A1A1A" }}>Без заказа:</b> {items.length} зап. · {fmtHours(totals.hours)} · {fmtTok(totals.tokens_total)}.
        Папка на маке не привязана к заказу — назначь, папка запомнится.
      </div>
      {items.map((r: any) => (
        <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <span style={{ ...num, fontSize: 11, color: "#A89070" }}>{fmtDate(r.work_date)}</span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{r.project_dir || r.note || "—"}</span>
          <span style={{ ...num, fontSize: 12, color: "#6B6355" }}>{fmtHours(r.hours)} · {fmtTok(r.tokens_total)} · {shortModel(r.model)}</span>
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

// Тарифы моделей ($ за 1M по четырём видам токенов) — только для справочной оценки
function RatesBlock() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["machine-usage", "models"], queryFn: machineUsageApi.models });
  const [draft, setDraft] = useState<Record<string, any>>({});
  const saveModel = useMutation({
    mutationFn: (m: any) => machineUsageApi.putModel(m),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["machine-usage"] }); setDraft({}); },
    onError: (e: any) => alert(e?.response?.data?.detail || "Не сохранилось"),
  });
  const inp = { border: "1px solid #EDEBE6", padding: "4px 6px", fontSize: 12, width: 70, ...num, textAlign: "right" as const };
  const cols = ["price_in", "price_out", "price_cache_write", "price_cache_read"] as const;
  return (
    <div style={{ marginTop: 10 }}>
      <HScroll minWidth={620}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}>МОДЕЛЬ</th><th style={{ ...th, textAlign: "right" }}>ВХОД $/1M</th><th style={{ ...th, textAlign: "right" }}>ВЫХОД</th>
            <th style={{ ...th, textAlign: "right" }}>ЗАПИСЬ КЭША</th><th style={{ ...th, textAlign: "right" }}>ЧТЕНИЕ КЭША</th><th style={th} />
          </tr></thead>
          <tbody>{(data?.items ?? []).map((m: any) => {
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
          })}</tbody>
        </table>
      </HScroll>
      <div style={{ fontSize: 11, color: "#A89070", marginTop: 8 }}>
        Оценка «если бы платили за токены по API». Неизвестная модель в записи — отказ, а не расчёт «по похожей». Правка тарифа прошлые записи не пересчитывает.
      </div>
    </div>
  );
}
