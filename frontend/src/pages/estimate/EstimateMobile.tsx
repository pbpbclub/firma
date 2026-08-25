/**
 * Смета на телефоне — только чтение.
 *
 * Редактор сметы — 11 колонок с minWidth 1020 и HTML5 drag&drop, который в
 * мобильном Safari не работает вообще. Адаптировать его — не «неудобно», а
 * несовместимо. Поэтому телефон получает список позиций карточками, итоги той же
 * формулой, что в карточке заказа, и две кнопки, ради которых смету на телефоне
 * открывают: «Счёт» и «КП». Правка — с компьютера.
 */
import { useNavigate } from "react-router-dom";
import { FilePdf, Receipt } from "@phosphor-icons/react";
import { Breadcrumbs } from "../../components/ui/Breadcrumbs";
import { Button } from "../../components/ui/Button";
import { RowCard } from "../../components/ui/RowCard";
import { MONO } from "../../components/ui/Num";
import { M } from "../../components/ui/responsive";
import { fmtMoneyDash as fmt } from "../../components/ui/format";
import { clientPrice } from "../../components/ui/priceMath";

const STATUS: Record<string, { label: string; color: string }> = {
  draft: { label: "Черновик", color: "#A89070" },
  approved: { label: "Согласована", color: "#4A7C59" },
  superseded: { label: "Заменена", color: "#C8C0B0" },
};

export function EstimateMobile({ order, orderId, sets, activeSet, items, isBank, bankPct, totalCost, totalClient,
  onInvoice, onKp, invoicing, kping, error }: {
  order: any; orderId: string; sets: any[]; activeSet: any; items: any[]; isBank: boolean; bankPct: number;
  totalCost: number; totalClient: number;
  onInvoice: () => void; onKp: () => void; invoicing: boolean; kping: boolean; error?: string;
}) {
  const navigate = useNavigate();
  const delta = totalClient - totalCost;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #EDEBE6", flexShrink: 0 }}>
        <Breadcrumbs items={[
          { label: "Заказы", to: "/orders" },
          { label: order?.title ?? "…", to: `/orders/${orderId}` },
          { label: "Смета" },
        ]} />
        {/* Вкладки смет — прокруткой */}
        {sets.length > 1 && (
          <div style={{ display: "flex", gap: 16, marginTop: 10, ...M.tabStrip }}>
            {sets.map((s: any, i: number) => {
              const active = s.id === activeSet?.id;
              return (
                <button type="button" key={s.id} onClick={() => navigate(`/orders/${orderId}/estimate?set=${s.id}`)}
                  style={{ background: "none", border: "none", padding: "6px 0", fontFamily: "inherit", fontSize: 13,
                           color: active ? "#1A1A1A" : "#A89070", fontWeight: active ? 600 : 400,
                           borderBottom: active ? "2px solid #E8592A" : "2px solid transparent", cursor: "pointer" }}>
                  {s.title || `Смета ${i + 1}`}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {activeSet && (
          <div style={{ padding: "14px 16px 6px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#1A1A1A" }}>{activeSet.title || "Смета"}</span>
            <span style={{ fontSize: 11, color: STATUS[activeSet.status]?.color ?? "#A89070", fontWeight: 500 }}>
              {STATUS[activeSet.status]?.label ?? activeSet.status}
            </span>
            {isBank && <span style={{ fontSize: 10, color: "#A89070", border: "1px solid #EDEBE6", padding: "2px 6px" }}>безнал +{bankPct}%</span>}
          </div>
        )}
        {error && <div style={{ padding: "6px 16px", fontSize: 12, color: "#8B3A3A" }}>{error}</div>}

        {items.length === 0 ? (
          <div style={{ padding: "24px 16px", fontSize: 13, color: "#C8C0B0" }}>Позиций нет.</div>
        ) : items.map((it: any, i: number) => {
          const qty = it.quantity || 1;
          const client = clientPrice(it.sale_price || 0, isBank, bankPct);
          return (
            <RowCard key={it.id ?? i}
              title={it.title || `Позиция ${i + 1}`}
              sub={<>{qty} шт{it.sale_price ? <> × <span style={{ fontFamily: MONO }}>{fmt(client / qty)}</span></> : null}</>}
              right={fmt(client)}
              rightSub={<>себест. <span style={{ fontFamily: MONO }}>{fmt(it.cost_total || 0)}</span></>}
            />
          );
        })}

        {items.length > 0 && (
          <div style={{ padding: "14px 16px 24px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 16px" }}>
            {[
              { l: "СЕБЕСТОИМОСТЬ", v: fmt(totalCost), c: "#1A1A1A" },
              { l: "К ОПЛАТЕ", v: fmt(totalClient), c: "#1A1A1A" },
              { l: "ДОХОД", v: (delta >= 0 ? "+" : "−") + fmt(Math.abs(delta)), c: delta >= 0 ? "#4A7C59" : "#8B3A3A" },
            ].map(x => (
              <div key={x.l}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>{x.l}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: x.c, fontFamily: MONO, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{x.v}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: "10px 16px", borderTop: "1px solid #EDEBE6", flexShrink: 0, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button onClick={onInvoice} disabled={invoicing || !activeSet} style={{ flex: 1 }}>
          <Receipt size={15} /> {invoicing ? "Собираем…" : "Счёт"}
        </Button>
        <Button onClick={onKp} disabled={kping || !activeSet} style={{ flex: 1 }}>
          <FilePdf size={15} /> {kping ? "Собираем…" : "КП"}
        </Button>
        <div style={{ flexBasis: "100%", fontSize: 11, color: "#A89070", textAlign: "center" }}>
          Редактирование сметы — с компьютера
        </div>
      </div>
    </div>
  );
}
