import { useQuery } from "@tanstack/react-query";
import { MONO } from "../components/ui/Num";
import { taxApi } from "../api";
import { WarningCircle, CheckCircle } from "@phosphor-icons/react";

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function ThinBar({ pct, color = "#E8592A" }: { pct: number; color?: string }) {
  return (
    <div style={{ height: 2, background: "#EDEBE6", marginTop: 10 }}>
      <div style={{ height: 2, background: color, width: `${Math.min(100, pct)}%`, transition: "width 0.5s" }} />
    </div>
  );
}

export default function Taxes() {
  const { data, isLoading } = useQuery({ queryKey: ["taxes"], queryFn: taxApi.summary });

  if (isLoading) return <div style={{ padding: 48, color: "#A89070", fontSize: 13 }}>Загружаем...</div>;
  if (!data) return null;

  const threshold300k = Math.min(100, (data.income_year / 300000) * 100);
  const section = { padding: "20px 28px", borderBottom: "1px solid #EDEBE6" };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ padding: "24px 28px 20px", borderBottom: "1px solid #EDEBE6" }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
          Налоги
        </div>
      </div>

      {/* Alert */}
      <div style={{
        ...section,
        display: "flex", alignItems: "flex-start", gap: 12,
        borderLeft: `3px solid ${data.tax_to_pay > 0 ? "#E8592A" : "#4A7C59"}`,
      }}>
        {data.tax_to_pay > 0
          ? <WarningCircle size={17} style={{ color: "#E8592A", flexShrink: 0, marginTop: 1 }} />
          : <CheckCircle size={17} style={{ color: "#4A7C59", flexShrink: 0, marginTop: 1 }} />
        }
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: data.tax_to_pay > 0 ? "#E8592A" : "#4A7C59" }}>
            {data.tax_to_pay > 0
              ? `К уплате: ${fmt(data.tax_to_pay)} до ${data.deadline}`
              : "Налоги за квартал покрыты взносами"}
          </div>
          <div style={{ fontSize: 12, color: "#A89070", marginTop: 4 }}>
            Q{data.quarter} {data.year} · УСН 6%
          </div>
        </div>
      </div>

      {/* 4 metric columns */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderBottom: "1px solid #EDEBE6" }}>
        {[
          { label: "ДОХОДЫ ЗА ГОД", value: fmt(data.income_year), sub: `Налог: ${fmt(data.tax_year)}`, pct: 100 },
          { label: "ДОХОДЫ ЗА КВАРТАЛ", value: fmt(data.income_quarter), sub: `6% = ${fmt(data.tax_quarter)}`, pct: data.income_year > 0 ? (data.income_quarter / data.income_year) * 100 : 0 },
          { label: "СТРАХОВЫЕ ВЗНОСЫ", value: fmt(data.insurance_fixed), sub: `Уплачено: ${fmt(data.insurance_paid)}`, pct: data.insurance_fixed > 0 ? Math.min(100, (data.insurance_paid / data.insurance_fixed) * 100) : 0 },
          { label: "ВЫЧЕТ ВЗНОСОВ", value: `−${fmt(data.insurance_deduction)}`, sub: "уменьшает налог", color: "#4A7C59", pct: data.tax_quarter > 0 ? Math.min(100, (data.insurance_deduction / data.tax_quarter) * 100) : 0 },
        ].map((item, i) => (
          <div key={item.label} style={{ padding: "20px 24px", borderRight: i < 3 ? "1px solid #EDEBE6" : "none" }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8 }}>{item.label}</div>
            <div style={{ fontSize: 19, fontWeight: 700, color: item.color ?? "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{item.value}</div>
            <div style={{ fontSize: 11, color: "#A89070", marginTop: 6 }}>{item.sub}</div>
            <ThinBar pct={item.pct} color={item.color ?? "#E8592A"} />
          </div>
        ))}
      </div>

      {/* 300k threshold */}
      <div style={section}>
        <div style={{ display: "flex", gap: 48, alignItems: "flex-start" }}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", width: 80, paddingTop: 2 }}>ПОРОГ 300К</div>
          <div style={{ flex: 1, maxWidth: 480 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#1A1A1A", marginBottom: 8 }}>
              <span style={{ fontWeight: 600, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(data.income_year)}</span>
              <span style={{ color: "#A89070", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>300 000 ₽</span>
            </div>
            <div style={{ height: 2, background: "#EDEBE6" }}>
              <div style={{
                height: 2,
                background: threshold300k >= 100 ? "#E8592A" : "#4A7C59",
                width: `${threshold300k}%`,
                transition: "width 0.5s",
              }} />
            </div>
            <div style={{ fontSize: 12, color: "#A89070", marginTop: 8 }}>
              {threshold300k >= 100
                ? `Превышено на ${fmt(data.income_year - 300000)} → доп. взносы ${fmt((data.income_year - 300000) * 0.01)}`
                : `Осталось ${fmt(300000 - data.income_year)} до порога`}
            </div>
          </div>
        </div>
      </div>

      {/* Оплачено в ФНС — фактические платежи (авто-распознанные из банка).
          Это «контрагент-налоговая»: все платежи Казначейству/ФНС собираются здесь,
          в Разноску они не попадают. */}
      {(data.tax_payments?.length ?? 0) > 0 && (
        <div style={section}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 4 }}>
            <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>ОПЛАЧЕНО В ФНС</div>
            <div style={{ fontSize: 10, color: "#C8C0B0" }}>платежи Казначейству/ФНС распознаются автоматически, в Разноску не попадают</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 220px))", gap: "0 24px", margin: "12px 0 6px" }}>
            {[
              { label: `ЗА ${data.year} ГОД`, value: fmt(data.tax_paid_year), color: "#1A1A1A" },
              { label: "ЗА ВСЁ ВРЕМЯ", value: fmt(data.tax_paid_total), color: "#1A1A1A" },
              {
                label: `К НАЧИСЛЕННОМУ ${data.year} (6%)`,
                value: (data.tax_paid_year - data.tax_year >= 0 ? "+" : "−") + fmt(Math.abs(data.tax_paid_year - data.tax_year)),
                color: data.tax_paid_year - data.tax_year >= 0 ? "#4A7C59" : "#8B3A3A",
              },
            ].map(m => (
              <div key={m.label}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>{m.label}</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: m.color, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{m.value}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            {data.tax_payments.map((p: any) => (
              <div key={p.id} style={{ display: "grid", gridTemplateColumns: "90px 1fr 110px", gap: 12, padding: "8px 0", borderBottom: "1px solid #F2EFE9", alignItems: "baseline" }}>
                <div style={{ fontSize: 11, color: "#A89070", fontFamily: MONO }}>{p.date}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.counterparty}</div>
                  {p.purpose && <div style={{ fontSize: 10, color: "#A89070", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.purpose}</div>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#8B3A3A", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>−{fmt(p.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
