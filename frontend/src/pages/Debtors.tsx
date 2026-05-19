import { useQuery } from "@tanstack/react-query";
import { financeApi } from "../api";
import { useNavigate } from "react-router-dom";

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function deadlineColor(deadline: string) {
  if (!deadline) return "#A89070";
  const days = (new Date(deadline).getTime() - Date.now()) / 86400000;
  if (days < 0) return "#8B3A3A";
  if (days < 7) return "#E8592A";
  return "#6B6355";
}

const cols = "2fr 1fr 130px 130px 130px 100px";
const headers = ["Клиент / Заказ", "Статус", "Сумма", "Оплачено", "Долг", "Дедлайн"];

export default function Debtors() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors });

  const items: any[] = data?.items || [];
  const total = data?.total ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ padding: "24px 28px 20px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>
            {new Date().toLocaleDateString("ru-RU", { month: "short", year: "numeric" }).toUpperCase().replace(" ", "'")}
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
            Дебиторка
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ЖДЁМ ОТ КЛИЕНТОВ</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#E8592A" }}>{fmt(total)}</div>
        </div>
      </div>

      {/* Column headers */}
      <div style={{ display: "grid", gridTemplateColumns: cols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6" }}>
        {headers.map((h) => (
          <div key={h} style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>{h}</div>
        ))}
      </div>

      {isLoading ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Долгов нет</div>
      ) : (
        <>
          {items.map((d: any, i: number) => (
            <div
              key={i}
              onClick={() => navigate(`/orders/${d.number}`)}
              style={{
                display: "grid", gridTemplateColumns: cols,
                padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
                cursor: "pointer", alignItems: "center", transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#FAF8F5")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{d.customer_name || "—"}</div>
                <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{d.title}</div>
              </div>
              <div style={{ fontSize: 12, color: "#6B6355" }}>{d.status_label || d.status}</div>
              <div style={{ fontSize: 13, color: "#1A1A1A" }}>{fmt(d.price_plan)}</div>
              <div style={{ fontSize: 13, color: "#4A7C59" }}>{fmt(d.paid_total)}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#E8592A" }}>{fmt(d.debt)}</div>
              <div style={{ fontSize: 12, color: deadlineColor(d.deadline) }}>{fmtDate(d.deadline)}</div>
            </div>
          ))}

          {/* Footer */}
          <div style={{
            display: "grid", gridTemplateColumns: cols,
            padding: "10px 28px", borderTop: "1px solid #EDEBE6",
            alignItems: "center",
          }}>
            <div style={{ fontSize: 11, color: "#A89070", gridColumn: "1 / 4" }}>
              {items.length} заказов
            </div>
            <div style={{ fontSize: 13, color: "#4A7C59", fontWeight: 500 }}>
              {fmt(items.reduce((s: number, d: any) => s + (d.paid_total || 0), 0))}
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#E8592A" }}>{fmt(total)}</div>
          </div>
        </>
      )}
    </div>
  );
}
