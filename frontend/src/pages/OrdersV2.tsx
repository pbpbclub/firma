import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ordersApi } from "../api";
import { Search, X, MoreHorizontal } from "lucide-react";

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  draft:         { label: "Черновик",       color: "#A89070" },
  estimate:      { label: "Смета",          color: "#E8592A" },
  project:       { label: "Проект",         color: "#E8592A" },
  in_production: { label: "В производстве", color: "#1A1A1A" },
  completed:     { label: "Завершён",       color: "#4A7C59" },
  cancelled:     { label: "Отменён",        color: "#8B3A3A" },
};

const STATUSES = [
  { value: "", label: "Все" },
  { value: "estimate", label: "Смета" },
  { value: "in_production", label: "В работе" },
  { value: "completed", label: "Завершён" },
];

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

function initials(name: string | undefined) {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function OrdersV2() {
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<any>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ["orders-v2", status, search],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      if (search) params.search = search;
      return ordersApi.list(params);
    },
  });

  const { data: detail } = useQuery({
    queryKey: ["order-detail-v2", selected?.id],
    queryFn: () => ordersApi.get(selected.id),
    enabled: !!selected,
  });

  const paidTotal = detail?.payments?.reduce((s: number, p: any) => s + p.amount, 0) ?? 0;
  const pct = detail?.price_plan > 0 ? Math.min(100, (paidTotal / detail.price_plan) * 100) : 0;

  const cols = selected
    ? "2fr 1.2fr 100px 120px 40px"
    : "2fr 1.5fr 120px 130px 120px 40px";

  const headers = selected
    ? ["Название", "Клиент", "Статус", "Сумма", ""]
    : ["Название", "Клиент", "Статус", "Сумма", "К получению", ""];

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>

      {/* ── Left: table panel ───────────────────────────── */}
      <div style={{
        flex: selected ? "0 0 58%" : "1 1 0",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        borderRight: selected ? "1px solid #EDEBE6" : "none",
        transition: "flex 0.2s ease",
      }}>

        {/* Panel header */}
        <div style={{ padding: "24px 28px 0" }}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>
            {new Date().toLocaleDateString("ru-RU", { month: "short", year: "numeric" }).toUpperCase().replace(" ", "'")}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
              Заказы
            </div>
            {/* Actions */}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ position: "relative" }}>
                <Search size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
                <input
                  style={{
                    paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
                    border: "1px solid #EDEBE6",
                    background: "transparent",
                    fontSize: 12, color: "#1A1A1A",
                    outline: "none", width: 160,
                    borderRadius: 0,
                  }}
                  placeholder="Поиск..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Status tabs */}
          <div style={{ display: "flex", gap: 24, borderBottom: "1px solid #EDEBE6" }}>
            {STATUSES.map((s) => (
              <button
                key={s.value}
                onClick={() => setStatus(s.value)}
                style={{
                  fontSize: 13, padding: "0 0 12px",
                  border: "none", background: "none", cursor: "pointer",
                  color: status === s.value ? "#1A1A1A" : "#A89070",
                  fontWeight: status === s.value ? 600 : 400,
                  borderBottom: status === s.value ? "2px solid #E8592A" : "2px solid transparent",
                  marginBottom: -1,
                  transition: "all 0.15s",
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Column headers */}
        <div style={{
          display: "grid",
          gridTemplateColumns: cols,
          padding: "8px 28px",
          borderBottom: "1px solid #F7F5F1",
        }}>
          {headers.map((h, i) => (
            <div key={i} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>{h}</div>
          ))}
        </div>

        {/* Rows */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>
              Загружаем...
            </div>
          ) : (data as any[]).length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>
              Заказов нет
            </div>
          ) : (
            (data as any[]).map((o: any) => {
              const st = STATUS_MAP[o.status] || { label: o.status, color: "#A89070" };
              const isActive = selected?.id === o.id;
              return (
                <div
                  key={o.id}
                  onClick={() => setSelected(isActive ? null : o)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: cols,
                    padding: "10px 28px",
                    borderBottom: "1px solid #F7F5F1",
                    cursor: "pointer",
                    background: isActive ? "#FDF0EC" : "transparent",
                    alignItems: "center",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#FAF8F5"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                >
                  <div style={{ fontSize: 11, fontWeight: 500, color: "#1A1A1A", lineHeight: 1.4 }}>
                    {o.title}
                  </div>
                  <div style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "#F2EFE9",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#1A1A1A",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}>
                    {initials(o.customer_name)}
                  </div>
                  <div style={{ fontSize: 10, color: st.color, fontWeight: 500, lineHeight: 1.4 }}>
                    {st.label}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#1A1A1A", lineHeight: 1.4 }}>
                    {fmt(o.price_plan)}
                  </div>
                  {!selected && (
                    <div style={{ fontSize: 11, fontWeight: 600, color: o.debt > 0 ? "#E8592A" : "#C8C0B0", lineHeight: 1.4 }}>
                      {o.debt > 0 ? fmt(o.debt) : "—"}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <MoreHorizontal size={14} style={{ color: "#C8C0B0" }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "10px 28px",
          borderTop: "1px solid #F7F5F1",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <div style={{ fontSize: 10, color: "#A89070" }}>
            {(data as any[]).length} заказов
          </div>
          <div style={{ fontSize: 10, color: "#A89070" }}>
            Итого: <span style={{ color: "#1A1A1A", fontWeight: 600 }}>
              {fmt((data as any[]).reduce((s: number, o: any) => s + (o.price_plan || 0), 0))}
            </span>
          </div>
        </div>
      </div>

      {/* ── Right: detail panel ─────────────────────────── */}
      {selected && (
        <div style={{
          flex: "0 0 42%",
          display: "flex",
          flexDirection: "column",
          animation: "slideIn 0.18s ease",
          minWidth: 0,
        }}>
          <div style={{
            padding: "22px 24px 18px",
            borderBottom: "1px solid #EDEBE6",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8 }}>
                Сводка заказа
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.02em", maxWidth: 320 }}>
                {selected.title}
              </div>
              <div style={{ fontSize: 11, color: "#A89070", marginTop: 8 }}>
                {selected.number ? `№ ${selected.number}` : ""}
              </div>
              {selected.customer_id && (
                <button
                  onClick={() => navigate(`/customers/${selected.customer_id}`)}
                  style={{
                    marginTop: 10,
                    padding: "8px 12px",
                    border: "1px solid #EDEBE6",
                    background: "transparent",
                    color: "#1A1A1A",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  Карточка клиента
                </button>
              )}
            </div>
            <button
              onClick={() => setSelected(null)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 4 }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#1A1A1A")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#C8C0B0")}
            >
              <X size={16} />
            </button>
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: "24px 24px 20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Стоимость", value: fmt(selected.price_plan), color: "#1A1A1A" },
                { label: "Оплачено", value: fmt(paidTotal), color: "#4A7C59" },
                { label: "Долг", value: selected.debt > 0 ? fmt(selected.debt) : "Оплачено", color: selected.debt > 0 ? "#E8592A" : "#4A7C59" },
                { label: "Маржа", value: fmt(selected.margin), color: "#1A1A1A" },
              ].map((item) => (
                <div key={item.label} style={{ padding: "14px 16px", minHeight: 86, background: "#FAF8F4" }}>
                  <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>{item.label}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: item.color }}>{item.value}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Статус", value: (STATUS_MAP[selected.status] || {}).label, color: STATUS_MAP[selected.status]?.color || "#1A1A1A" },
                { label: "Приоритет", value: selected.priority_label || "—" },
                { label: "Платежи", value: detail?.payments?.length ?? 0 },
                { label: "Сметы", value: detail?.estimate_sets?.length ?? 0 },
              ].map((item) => (
                <div key={item.label} style={{ padding: "14px 16px", background: "#FAF8F4" }}>
                  <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>{item.label}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: item.color ?? "#1A1A1A" }}>{item.value}</div>
                </div>
              ))}
            </div>

            <div style={{ padding: "16px 16px", background: "#FAF8F4", marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 10, color: "#A89070" }}>
                <span>Прогресс оплаты</span>
                <span style={{ color: "#1A1A1A", fontWeight: 600 }}>{Math.round(pct)}%</span>
              </div>
              <div style={{ height: 2, background: "#F7F5F1", marginBottom: 8 }}>
                <div style={{ height: 2, background: "#E8592A", width: `${pct}%`, transition: "width 0.4s" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#A89070" }}>
                <span>{fmt(paidTotal)} оплачено</span>
                <span>{fmt(selected.price_plan)} всего</span>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              <div style={{ padding: "16px 16px", background: "#FAF8F4" }}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8 }}>
                  Клиент
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{selected.customer_name || "—"}</div>
                {selected.deadline && (
                  <div style={{ fontSize: 10, color: "#A89070", marginTop: 6 }}>
                    Дедлайн: {fmtDate(selected.deadline)}
                  </div>
                )}
              </div>
              <div style={{ padding: "16px 16px", background: "#FAF8F4" }}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8 }}>
                  Последний платёж
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>
                  {detail?.payments?.[0]?.amount ? fmt(detail.payments[0].amount) : "Нет"}
                </div>
                {detail?.payments?.[0]?.paid_at && (
                  <div style={{ fontSize: 10, color: "#A89070", marginTop: 6 }}>
                    {fmtDate(detail.payments[0].paid_at)}
                  </div>
                )}
              </div>
            </div>

            {detail?.payments?.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", marginBottom: 10 }}>
                  Последние платежи
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {detail.payments.slice(0, 3).map((p: any, i: number) => (
                    <div key={i} style={{ padding: "12px 14px", background: "#FAF8F4" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{fmt(p.amount)}</div>
                        <div style={{ fontSize: 10, color: "#A89070" }}>{fmtDate(p.paid_at)}</div>
                      </div>
                      <div style={{ fontSize: 10, color: "#A89070" }}>{p.note || "оплата"}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(10px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
