import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { financeApi } from "../api";
import { Search } from "lucide-react";

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.abs(n)) + " ₽";
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

const FILTERS = [
  { v: "", l: "Все" },
  { v: "in", l: "Поступления" },
  { v: "out", l: "Списания" },
];

export default function Finance() {
  const [direction, setDirection] = useState("");
  const [search, setSearch] = useState("");

  const { data: balance } = useQuery({ queryKey: ["balance"], queryFn: financeApi.balance });
  const { data: summary } = useQuery({ queryKey: ["dds-summary"], queryFn: financeApi.summary });
  const { data: txs = [], isLoading } = useQuery({
    queryKey: ["transactions", direction, search],
    queryFn: () => {
      const p: Record<string, string> = {};
      if (direction) p.direction = direction;
      if (search) p.search = search;
      return financeApi.transactions(p);
    },
  });

  const monthly: any[] = summary?.monthly_chart || [];
  const maxVal = monthly.length > 0 ? Math.max(...monthly.map((m: any) => Math.max(m.income, m.expense))) : 0;
  const section = { padding: "20px 28px", borderBottom: "1px solid #EDEBE6" };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ padding: "24px 28px 20px", borderBottom: "1px solid #EDEBE6" }}>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>
          {new Date().toLocaleDateString("ru-RU", { month: "short", year: "numeric" }).toUpperCase().replace(" ", "'")}
        </div>
        <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
          ДДС
        </div>
      </div>

      {/* Balance row */}
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${1 + (balance?.accounts?.length ?? 0)}, 1fr)`,
        borderBottom: "1px solid #EDEBE6",
      }}>
        <div style={{ padding: "20px 24px", borderRight: "1px solid #EDEBE6" }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8 }}>ИТОГО НА СЧЕТАХ</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: (balance?.total ?? 0) >= 0 ? "#4A7C59" : "#8B3A3A" }}>
            {fmt(balance?.total ?? 0)}
          </div>
        </div>
        {balance?.accounts?.map((a: any, i: number) => (
          <div key={a.account} style={{ padding: "20px 24px", borderRight: i < (balance.accounts.length - 1) ? "1px solid #EDEBE6" : "none" }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8 }}>
              {(a.name || a.account).toUpperCase()}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#1A1A1A" }}>{fmt(a.balance)}</div>
          </div>
        ))}
      </div>

      {/* Chart */}
      {monthly.length > 0 && (
        <div style={section}>
          <div style={{ display: "flex", gap: 48, alignItems: "flex-start" }}>
            <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", width: 80, paddingTop: 2 }}>ПО МЕСЯЦАМ</div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 72 }}>
                {monthly.map((m: any) => {
                  const incH = maxVal > 0 ? (m.income / maxVal) * 68 : 0;
                  const expH = maxVal > 0 ? (m.expense / maxVal) * 68 : 0;
                  return (
                    <div key={m.month} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                      <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 68 }}>
                        <div style={{ width: 7, background: "#4A7C59", height: incH }} title={fmt(m.income)} />
                        <div style={{ width: 7, background: "#EDEBE6", height: expH }} title={fmt(m.expense)} />
                      </div>
                      <div style={{ fontSize: 9, color: "#A89070" }}>{m.month.slice(5)}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                {[{ color: "#4A7C59", label: "Поступления" }, { color: "#EDEBE6", label: "Списания", border: "#C8C0B0" }].map((l) => (
                  <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#A89070" }}>
                    <div style={{ width: 8, height: 8, background: l.color, border: l.border ? `1px solid ${l.border}` : "none" }} />
                    {l.label}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ padding: "12px 28px", borderBottom: "1px solid #EDEBE6", display: "flex", gap: 12, alignItems: "center" }}>
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
        <div style={{ display: "flex", gap: 4 }}>
          {FILTERS.map((f) => (
            <button
              key={f.v}
              onClick={() => setDirection(f.v)}
              style={{
                padding: "5px 14px", border: "1px solid",
                borderColor: direction === f.v ? "#E8592A" : "#EDEBE6",
                background: direction === f.v ? "#E8592A" : "transparent",
                color: direction === f.v ? "#FFFFFF" : "#6B6355",
                fontSize: 12, cursor: "pointer", borderRadius: 0,
                fontWeight: direction === f.v ? 600 : 400,
                transition: "all 0.12s",
              }}
            >
              {f.l}
            </button>
          ))}
        </div>
      </div>

      {/* Column headers */}
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 130px 130px", padding: "8px 28px", borderBottom: "1px solid #EDEBE6" }}>
        {["Дата", "Описание", "Счёт", "Сумма"].map((h) => (
          <div key={h} style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>{h}</div>
        ))}
      </div>

      {/* Rows */}
      {isLoading ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>
      ) : (txs as any[]).length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Транзакций нет</div>
      ) : (
        (txs as any[]).map((t: any, i: number) => (
          <div
            key={t.id || i}
            style={{
              display: "grid", gridTemplateColumns: "120px 1fr 130px 130px",
              padding: "12px 28px", borderBottom: "1px solid #F2EFE9",
              alignItems: "center", transition: "background 0.1s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#FAF8F5")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <div style={{ fontSize: 12, color: "#A89070" }}>{fmtDate(t.date)}</div>
            <div style={{ fontSize: 13, color: "#1A1A1A", paddingRight: 16 }}>{t.counterparty || t.purpose || "—"}</div>
            <div style={{ fontSize: 12, color: "#A89070" }}>
              {t.bank === "tbank" ? "Т-Банк" : t.bank === "sber" ? "Сбербанк" : t.bank || "—"}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: t.direction === "in" ? "#4A7C59" : "#8B3A3A" }}>
              {t.direction === "in" ? "+" : "−"}{fmt(t.amount)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
