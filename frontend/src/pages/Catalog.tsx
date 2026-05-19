import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { catalogApi } from "../api";
import { Search } from "lucide-react";

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

const cols = "2fr 1fr 80px 140px 120px 120px";
const headers = ["Изделие", "Категория", "Заказов", "Цена (ср.)", "Мин.", "Макс."];

export default function Catalog() {
  const [search, setSearch] = useState("");

  const { data = [], isLoading } = useQuery({
    queryKey: ["catalog", search],
    queryFn: () => catalogApi.list(search || undefined),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ padding: "24px 28px 20px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>КАТАЛОГ</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Изделия</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 12, color: "#A89070" }}>{(data as any[]).length} позиций</div>
          <div style={{ position: "relative" }}>
            <Search size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
            <input
              style={{
                paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
                border: "1px solid #EDEBE6", background: "transparent",
                fontSize: 12, color: "#1A1A1A", outline: "none", width: 180, borderRadius: 0,
              }}
              placeholder="Поиск..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
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
      ) : (data as any[]).length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Ничего не найдено</div>
      ) : (
        (data as any[]).map((item: any, i: number) => (
          <div
            key={i}
            style={{
              display: "grid", gridTemplateColumns: cols,
              padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
              alignItems: "center", transition: "background 0.1s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#FAF8F5")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{item.title}</div>
            <div style={{ fontSize: 12, color: "#A89070" }}>{item.category || "—"}</div>
            <div style={{ fontSize: 12, color: "#6B6355" }}>{item.times_ordered}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1A1A" }}>{fmt(item.avg_price)}</div>
            <div style={{ fontSize: 12, color: "#A89070" }}>{fmt(item.min_price)}</div>
            <div style={{ fontSize: 12, color: "#A89070" }}>{fmt(item.max_price)}</div>
          </div>
        ))
      )}
    </div>
  );
}
