import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ordersApi } from "../api";
import { Search, MoreHorizontal } from "lucide-react";

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

const cols = "2fr 1.5fr 120px 130px 120px 120px 40px";
const headers = ["Название", "Клиент", "Статус", "Сумма", "Оплачено", "Долг", ""];

export default function Orders() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const navigate = useNavigate();

  const { data = [], isLoading } = useQuery({
    queryKey: ["orders", status, search],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      if (search) params.search = search;
      return ordersApi.list(params);
    },
  });

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ padding: "24px 28px 20px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>
            {new Date().toLocaleDateString("ru-RU", { month: "short", year: "numeric" }).toUpperCase().replace(" ", "'")}
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Заказы</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 12, color: "#A89070" }}>{(data as any[]).length} заказов</div>
          <div style={{ position: "relative" }}>
            <Search size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
            <input
              style={{
                paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
                border: "1px solid #EDEBE6", background: "transparent",
                fontSize: 12, color: "#1A1A1A", outline: "none", width: 200, borderRadius: 0,
              }}
              placeholder="Поиск..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Status tabs */}
      <div style={{ display: "flex", gap: 24, padding: "0 28px", borderBottom: "1px solid #EDEBE6" }}>
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => setStatus(s.value)}
            style={{
              fontSize: 13, padding: "12px 0",
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

      {/* Column headers */}
      <div style={{ display: "grid", gridTemplateColumns: cols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6" }}>
        {headers.map((h, i) => (
          <div key={i} style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>{h}</div>
        ))}
      </div>

      {isLoading ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>
      ) : (data as any[]).length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Заказов нет</div>
      ) : (
        <>
          {(data as any[]).map((o: any) => {
            const st = STATUS_MAP[o.status] || { label: o.status, color: "#A89070" };
            return (
              <div
                key={o.id}
                onClick={() => navigate(`/orders/${o.id}`)}
                style={{
                  display: "grid", gridTemplateColumns: cols,
                  padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
                  cursor: "pointer", alignItems: "center", transition: "background 0.1s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#FAF8F5")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{o.title}</div>
                <div style={{ fontSize: 13, color: "#6B6355" }}>{o.customer_name || "—"}</div>
                <div style={{ fontSize: 11, color: st.color, fontWeight: 500 }}>{st.label}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{fmt(o.price_plan)}</div>
                <div style={{ fontSize: 13, color: "#4A7C59" }}>{fmt(o.paid_total)}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: o.debt > 0 ? "#E8592A" : "#C8C0B0" }}>
                  {o.debt > 0 ? fmt(o.debt) : "—"}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <MoreHorizontal size={14} style={{ color: "#C8C0B0" }} />
                </div>
              </div>
            );
          })}

          {/* Footer */}
          <div style={{ display: "grid", gridTemplateColumns: cols, padding: "10px 28px", borderTop: "1px solid #EDEBE6", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "#A89070", gridColumn: "1 / 4" }}>
              {(data as any[]).length} заказов
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>
              {fmt((data as any[]).reduce((s: number, o: any) => s + (o.price_plan || 0), 0))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
