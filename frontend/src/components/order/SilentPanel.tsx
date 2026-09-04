// «Молчат» — просчёты и проекты, по которым заказчик не отвечает. Правило и пороги
// взяты у фин-агента (weekly_report.py::silent_orders, просьба Юры 07.08.2026):
// движение = максимум из дат заведения заказа, последней сметы и последнего платежа;
// updated_at намеренно не участвует — техническая правка не значит, что заказчик ожил.
// 14 дн. — напомнить, 30 — актуализировать цену, 60 — кандидат в архив (архивирует
// только Юра, автоматики здесь нет).
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ordersApi } from "../../api";
import { ORDER_STATUS_MAP } from "../domain";
import { fmtMoneyDash as fmt } from "../ui/format";
import { MONO } from "../ui/Num";
import { Loading } from "../ui/Loading";
import { EmptyState } from "../ui/EmptyState";

const STEP: Record<string, { label: string; color: string }> = {
  remind:  { label: "напомнить заказчику",   color: "#A89070" },
  refresh: { label: "актуализировать цену",  color: "#E8592A" },
  archive: { label: "кандидат в архив",      color: "#8B3A3A" },
};

const COLS = "1.9fr 1.2fr 1fr 110px 170px";

export function SilentPanel() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ["orders", "silent"], queryFn: ordersApi.silent });

  if (!data) return <div style={{ padding: "8px 28px 24px" }}><Loading compact /></div>;

  const rows: any[] = data.orders || [];
  // Заказы, у которых дату движения разобрать не удалось: тишину по ним посчитать
  // нельзя, и в список они не попали. Плашка ВЫШЕ пустого состояния — «все просчёты
  // свежие» при неразобранных датах означало бы «не проверяли» = «всё хорошо».
  const undated: any[] = data.undated || [];
  const undatedWarn = undated.length > 0 ? (
    <div style={{ margin: "8px 0 4px", padding: "10px 12px", background: "#FBF3F2",
                  borderLeft: "3px solid #8B3A3A", fontSize: 12, color: "#8B3A3A", lineHeight: 1.5 }}>
      ⚠ У {undated.length} {undated.length === 1 ? "заказа" : "заказов"} не разобрана дата движения —
      тишину по ним посчитать нельзя, в список ниже они не вошли:{" "}
      {undated.map((o: any) => o.number || o.title).join(", ")}.
    </div>
  ) : null;

  if (rows.length === 0)
    return (
      <div style={{ flex: 1, overflow: "auto", padding: "8px 28px 24px" }}>
        {undatedWarn}
        <EmptyState compact title="Все просчёты свежие" hint="Ни одного заказа без движения дольше 14 дней" />
      </div>
    );

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "8px 28px 24px" }}>
      {undatedWarn}
      <div style={{ fontSize: 11, color: "#6B6355", padding: "6px 0 12px" }}>
        {rows.length} без движения дольше {data.thresholds.ask} дн.
        {data.archive_candidates > 0 && (
          <span style={{ color: "#8B3A3A", fontWeight: 600 }}> · {data.archive_candidates} — кандидаты в архив</span>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: COLS, gap: "0 16px", padding: "8px 0",
        borderBottom: "1px solid #EDEBE6", fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>
        <span>ЗАКАЗ</span>
        <span>ЗАКАЗЧИК</span>
        <span style={{ textAlign: "right" }}>СУММА</span>
        <span style={{ textAlign: "right" }}>ТИШИНА</span>
        <span>ЧТО ДЕЛАТЬ</span>
      </div>

      {rows.map((o) => {
        const step = STEP[o.step] || STEP.remind;
        const hot = o.step === "archive";
        return (
          <div key={o.id}
            onClick={() => navigate(`/orders/${o.id}`)}
            style={{ display: "grid", gridTemplateColumns: COLS, gap: "0 16px", padding: "11px 0",
              borderBottom: "1px solid #F7F5F1", cursor: "pointer", alignItems: "center",
              background: hot ? "#FFF8F5" : "transparent", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#FAF8F5"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = hot ? "#FFF8F5" : "transparent"; }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A", fontFamily: "inherit" }}>{o.title}</div>
              <div style={{ fontSize: 9, color: "#A89070", marginTop: 2 }}>
                {ORDER_STATUS_MAP[o.status]?.label || o.status} · движение {o.moved_at}
              </div>
            </div>
            <span style={{ fontSize: 12, color: "#6B6355" }}>{o.customer || "—"}</span>
            <span style={{ textAlign: "right", fontSize: 12, color: "#1A1A1A" }}>{fmt(o.price_plan)}</span>
            <span style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: step.color }}>{o.days} дн.</span>
            <span style={{ fontSize: 11, color: step.color, fontWeight: hot ? 600 : 400 }}>{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}
