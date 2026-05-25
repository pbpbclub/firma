import { useState, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ordersApi, estimatesApi, catalogApi } from "../api";
import {
  ArrowLeft, Plus, Trash, Package, Wrench, Truck, Cube,
  X, FileText,
} from "@phosphor-icons/react";

const TYPE_ICONS: Record<string, any> = {
  material: Cube,
  labor:    Wrench,
  service:  Truck,
  delivery: Truck,
};
const TYPE_COLORS: Record<string, string> = {
  material: "#6B6355",
  labor:    "#4A7C59",
  service:  "#A89070",
  delivery: "#A89070",
};
const TYPE_CYCLE = ["material", "labor", "service"];

function fmt(n: number | null | undefined) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function EditCell({
  value, onSave, numeric, placeholder, style, display,
}: {
  value: string | number | null | undefined;
  onSave: (v: string) => void;
  numeric?: boolean;
  placeholder?: string;
  style?: React.CSSProperties;
  display?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value ?? ""));

  useEffect(() => {
    if (!editing) setVal(String(value ?? ""));
  }, [value, editing]);

  if (!editing) {
    return (
      <span
        onClick={e => { e.stopPropagation(); setEditing(true); }}
        style={{ cursor: "text", display: "inline-block", minWidth: 12, ...style }}
      >
        {display ?? (value !== null && value !== undefined && value !== ""
          ? value
          : <span style={{ color: "#C8C0B0" }}>{placeholder || ""}</span>)}
      </span>
    );
  }
  return (
    <input
      autoFocus
      value={val}
      onClick={e => e.stopPropagation()}
      onChange={e => setVal(e.target.value)}
      onBlur={() => { setEditing(false); onSave(val); }}
      onKeyDown={e => {
        if (e.key === "Enter") { setEditing(false); onSave(val); }
        if (e.key === "Escape") setEditing(false);
      }}
      style={{
        width: numeric ? 60 : "100%",
        border: "none",
        borderBottom: "1px solid #E8592A",
        outline: "none",
        fontSize: "inherit",
        fontFamily: "inherit",
        background: "transparent",
        padding: "0 2px",
        ...style,
      }}
    />
  );
}

// ── Item detail modal ────────────────────────────────────────────────────────

function ItemModal({ item, onClose, onRefetch }: {
  item: any;
  onClose: () => void;
  onRefetch: () => void;
}) {
  const lines: any[] = item.lines ?? [];
  const gridCols = "20px 1fr 52px 68px 88px 80px 24px";

  const save = (fn: () => Promise<any>) => fn().then(onRefetch);

  useEffect(() => {
    if (lines.length === 0) {
      estimatesApi.addLine(item.id, { type: "material", title: "", qty: 1, unit: "шт", unit_price: 0 }).then(onRefetch);
    }
  }, []);

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
      onClick={onClose}
    >
      <div
        style={{ background: "#FFFFFF", width: 680, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.16)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #EDEBE6", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, fontSize: 15, fontWeight: 700, color: "#1A1A1A" }}>
            <EditCell
              value={item.title}
              placeholder="Название позиции"
              onSave={v => save(() => estimatesApi.updateItem(item.id, { title: v }))}
              style={{ fontSize: 15, fontWeight: 700 }}
            />
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", display: "flex", padding: 4 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
          >
            <X size={16} />
          </button>
        </div>

        {/* Lines header */}
        <div style={{ display: "grid", gridTemplateColumns: gridCols, padding: "7px 20px", gap: 8, borderBottom: "1px solid #EDEBE6" }}>
          {["", "Наименование", "Ед.", "Кол-во", "Цена", "Итого", ""].map((h, i) => (
            <div key={i} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>{h}</div>
          ))}
        </div>

        {/* Lines */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {lines.length === 0 && (
            <div style={{ padding: "28px 20px", textAlign: "center", color: "#C8C0B0", fontSize: 12 }}>
              Загружаем...
            </div>
          )}
          {lines.map((line: any) => {
            const Icon = TYPE_ICONS[line.type] ?? Cube;
            const nextType = TYPE_CYCLE[(TYPE_CYCLE.indexOf(line.type) + 1) % TYPE_CYCLE.length];
            return (
              <div
                key={line.id}
                style={{ display: "grid", gridTemplateColumns: gridCols, padding: "7px 20px", gap: 8, alignItems: "center", borderBottom: "1px solid #F2EFE9" }}
              >
                <button
                  onClick={() => save(() => estimatesApi.updateLine(line.id, { type: nextType }))}
                  title={line.type}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", color: TYPE_COLORS[line.type] ?? "#A89070" }}
                >
                  <Icon size={12} />
                </button>

                <div style={{ fontSize: 12, color: "#1A1A1A" }}>
                  <EditCell
                    value={line.title}
                    placeholder="Название"
                    onSave={v => save(() => estimatesApi.updateLine(line.id, { title: v }))}
                  />
                </div>
                <div style={{ fontSize: 11, color: "#6B6355" }}>
                  <EditCell
                    value={line.unit}
                    onSave={v => save(() => estimatesApi.updateLine(line.id, { unit: v }))}
                  />
                </div>
                <div style={{ fontSize: 12 }}>
                  <EditCell
                    value={line.qty}
                    numeric
                    onSave={v => save(() => estimatesApi.updateLine(line.id, { qty: parseFloat(v) || 1 }))}
                  />
                </div>
                <div style={{ fontSize: 12 }}>
                  <EditCell
                    value={line.unit_price}
                    numeric
                    onSave={v => save(() => estimatesApi.updateLine(line.id, { unit_price: parseFloat(v) || 0 }))}
                  />
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>
                  {fmt(line.line_total)}
                </div>
                <button
                  onClick={() => save(() => estimatesApi.deleteLine(line.id))}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#D0C8C0", padding: 0, display: "flex" }}
                  onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                  onMouseLeave={e => (e.currentTarget.style.color = "#D0C8C0")}
                >
                  <Trash size={12} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Add line */}
        <div style={{ padding: "8px 20px", borderTop: "1px solid #F2EFE9" }}>
          <button
            onClick={() => save(() => estimatesApi.addLine(item.id, { type: "material", title: "", qty: 1, unit: "шт", unit_price: 0 }))}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#A89070", padding: 0, display: "flex", alignItems: "center", gap: 5 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#E8592A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
          >
            <Plus size={11} /> Добавить строку
          </button>
        </div>

        {/* Modal footer: totals */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #EDEBE6", background: "#FAF8F5", display: "flex", justifyContent: "flex-end" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 2 }}>СЕБЕСТОИМОСТЬ</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#6B6355" }}>{fmt(item.cost_total)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Catalog modal ────────────────────────────────────────────────────────────

function CatalogModal({ onClose, onSelect }: {
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data: items = [] } = useQuery({ queryKey: ["catalog-items"], queryFn: catalogApi.items.list });
  const filtered = (items as any[]).filter((c: any) =>
    !search || (c.title ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
      onClick={onClose}
    >
      <div
        style={{ background: "#FFFFFF", width: 440, maxHeight: 500, display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.16)" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>Из каталога</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", display: "flex" }}>
            <X size={15} />
          </button>
        </div>
        <div style={{ padding: "8px 20px", borderBottom: "1px solid #EDEBE6" }}>
          <input
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск..."
            style={{ width: "100%", border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 12, outline: "none", boxSizing: "border-box" }}
          />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>Каталог пуст</div>
          ) : (
            filtered.map((c: any) => (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                style={{ padding: "11px 20px", borderBottom: "1px solid #F2EFE9", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <div>
                  <div style={{ fontSize: 13, color: "#1A1A1A" }}>{c.title || "—"}</div>
                  {c.category && <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>{c.category}</div>}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{fmt(c.sale_price)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Footer row helper ────────────────────────────────────────────────────────

function FooterRow({ cols, label, cost, sale, delta, deltaColor, saleColor, note }: {
  cols: string;
  label: string;
  cost?: string;
  sale?: string;
  delta?: string;
  deltaColor?: string;
  saleColor?: string;
  note?: string;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: cols, padding: "7px 28px", gap: 12, alignItems: "center", borderBottom: "1px solid #F2EFE9" }}>
      <div>
        <div style={{ fontSize: 11, color: "#A89070" }}>{label}</div>
        {note && <div style={{ fontSize: 10, color: "#C8C0B0", marginTop: 1 }}>{note}</div>}
      </div>
      <div /><div />
      <div style={{ fontSize: 12, color: "#6B6355", textAlign: "right" }}>{cost ?? ""}</div>
      <div style={{ fontSize: 13, fontWeight: 500, color: saleColor ?? "#1A1A1A", textAlign: "right" }}>{sale ?? ""}</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: deltaColor ?? "#A89070", textAlign: "right" }}>{delta ?? ""}</div>
      <div />
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function EstimateEditor() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [selectedSetId, setSelectedSetId] = useState<string | null>(searchParams.get("set"));
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [invoicing, setInvoicing] = useState(false);

  const { data: order } = useQuery({
    queryKey: ["order-detail-v2", orderId],
    queryFn: () => ordersApi.get(orderId!),
    enabled: !!orderId,
  });

  const { data: sets = [], refetch } = useQuery({
    queryKey: ["estimate", orderId],
    queryFn: () => ordersApi.estimate(orderId!),
    enabled: !!orderId,
  });

  const activeSetId = selectedSetId ?? ((sets as any[])[0]?.id ?? null);
  const activeSet   = (sets as any[]).find((s: any) => s.id === activeSetId) ?? null;
  const items: any[] = activeSet?.items ?? [];
  const openItem    = items.find((it: any) => it.id === openItemId) ?? null;

  const totalCost  = items.reduce((s: number, it: any) => s + (it.cost_total || 0), 0);
  const totalSale  = items.reduce((s: number, it: any) => s + (it.sale_price || 0), 0);
  const totalDelta = totalSale - totalCost;
  const bankPct    = activeSet?.bank_pct ?? 13;
  const isBank     = activeSet?.payment_type === "bank";
  const bankAdd    = isBank ? Math.round(totalSale * bankPct / 100) : 0;
  const grandTotal = totalSale + bankAdd;
  const taxes      = isBank ? Math.round(grandTotal * 0.06) : 0;
  const fund       = isBank ? Math.round(bankAdd - taxes) : 0;

  const createSet = async () => {
    const s = await estimatesApi.createSet(orderId!);
    setSelectedSetId(s.id);
    refetch();
  };

  const updateSet = async (data: any) => {
    if (!activeSetId) return;
    await estimatesApi.updateSet(activeSetId, data);
    refetch();
  };

  const addItemWithModal = async () => {
    if (!activeSetId) return;
    const it = await estimatesApi.addItem(activeSetId, { title: "", markup: 2.0 });
    await refetch();
    setOpenItemId(it.id);
  };

  const addItemInline = async () => {
    if (!activeSetId) return;
    await estimatesApi.addItem(activeSetId, { title: "", markup: 2.0 });
    refetch();
  };

  const importFromCatalog = async (catalogItemId: string) => {
    if (!activeSetId) return;
    const it = await estimatesApi.fromCatalog(activeSetId, catalogItemId);
    setCatalogOpen(false);
    await refetch();
    setOpenItemId(it.id);
  };

  const generateInvoice = async () => {
    if (!activeSetId) return;
    setInvoicing(true);
    try {
      const blob = await estimatesApi.invoice(activeSetId);
      window.open(URL.createObjectURL(blob), "_blank");
    } catch {
      alert("Ошибка генерации счёта");
    } finally {
      setInvoicing(false);
    }
  };

  const colsMain = "1fr 64px 80px 110px 110px 90px 52px";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* ─ Header ─────────────────────────────────────────────────────────── */}
      <div style={{ padding: "13px 28px", borderBottom: "1px solid #EDEBE6", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button
          onClick={() => navigate("/orders")}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", display: "flex", alignItems: "center", gap: 4, fontSize: 12, padding: 0, flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
          onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
        >
          <ArrowLeft size={13} /> Заказы
        </button>

        {/* Add item via calculator — near back arrow */}
        {activeSet && (
          <button
            onClick={addItemWithModal}
            title="Добавить изделие (калькулятор)"
            style={{
              background: "none", border: "1px solid #EDEBE6", cursor: "pointer",
              color: "#6B6355", display: "flex", alignItems: "center", gap: 4,
              fontSize: 11, padding: "3px 8px", flexShrink: 0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#E8592A"; (e.currentTarget as HTMLElement).style.color = "#E8592A"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; (e.currentTarget as HTMLElement).style.color = "#6B6355"; }}
          >
            <Plus size={11} /> Изделие
          </button>
        )}

        <span style={{ color: "#EDEBE6" }}>·</span>
        <span style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{order?.title ?? orderId}</span>

        {(sets as any[]).length > 1 && (
          <>
            <span style={{ color: "#EDEBE6" }}>·</span>
            {(sets as any[]).map((s: any, i: number) => (
              <button
                key={s.id}
                onClick={() => setSelectedSetId(s.id)}
                style={{
                  padding: "3px 8px", fontSize: 11, cursor: "pointer",
                  border: "1px solid",
                  borderColor: activeSetId === s.id ? "#E8592A" : "#EDEBE6",
                  background: activeSetId === s.id ? "#FFF3EF" : "transparent",
                  color: activeSetId === s.id ? "#E8592A" : "#A89070",
                }}
              >Смета {i + 1}</button>
            ))}
          </>
        )}

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {activeSet ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
                {[{ v: "cash", l: "Нал" }, { v: "bank", l: "Безнал" }].map(pt => (
                  <button
                    key={pt.v}
                    onClick={() => updateSet({ payment_type: pt.v })}
                    style={{
                      padding: "4px 10px", fontSize: 11, cursor: "pointer",
                      border: "1px solid",
                      borderColor: activeSet.payment_type === pt.v ? "#1A1A1A" : "#EDEBE6",
                      background: activeSet.payment_type === pt.v ? "#1A1A1A" : "transparent",
                      color: activeSet.payment_type === pt.v ? "#FFFFFF" : "#A89070",
                      marginRight: -1,
                    }}
                  >{pt.l}</button>
                ))}
              </div>

              <div style={{ width: 100, display: "flex", alignItems: "center", gap: 4 }}>
                {activeSet.payment_type === "bank" && (
                  <>
                    <span style={{ fontSize: 11, color: "#A89070" }}>Банк</span>
                    <input
                      key={activeSet.bank_pct}
                      defaultValue={activeSet.bank_pct ?? 13}
                      onBlur={e => updateSet({ bank_pct: parseFloat(e.target.value) || 13 })}
                      style={{ width: 36, border: "1px solid #EDEBE6", background: "transparent", fontSize: 11, textAlign: "center", padding: "3px 4px", outline: "none" }}
                    />
                    <span style={{ fontSize: 11, color: "#A89070" }}>%</span>
                  </>
                )}
              </div>

              <button
                onClick={() => updateSet({ status: activeSet.status === "approved" ? "draft" : "approved" })}
                style={{
                  padding: "4px 12px", fontSize: 11, cursor: "pointer", fontWeight: 600,
                  border: "none",
                  background: activeSet.status === "approved" ? "#4A7C59" : "#E8592A",
                  color: "#FFFFFF",
                }}
              >
                {activeSet.status === "approved" ? "Согласована ✓" : "Согласовать"}
              </button>

              <button
                onClick={generateInvoice}
                disabled={invoicing}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "4px 10px", fontSize: 11, fontWeight: 600,
                  border: "1px solid #EDEBE6", background: "none",
                  color: invoicing ? "#C8C0B0" : "#1A1A1A",
                  cursor: invoicing ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <FileText size={12} />
                {invoicing ? "..." : "Счёт"}
              </button>
            </>
          ) : (
            <button
              onClick={createSet}
              style={{ padding: "5px 14px", background: "#E8592A", border: "none", color: "#FFFFFF", fontSize: 12, cursor: "pointer", fontWeight: 600 }}
            >
              + Создать смету
            </button>
          )}
        </div>
      </div>

      {!activeSet ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, color: "#A89070", fontSize: 13 }}>
          <Package size={32} style={{ opacity: 0.3 }} />
          Смет нет — создайте первую
        </div>
      ) : (
        <>
          {/* ─ Column headers ─────────────────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: colsMain, padding: "7px 28px", gap: 12, borderBottom: "1px solid #EDEBE6", flexShrink: 0 }}>
            {["Позиция", "Кол-во", "Наценка", "Себестоимость", "Клиенту", "Δ Доход", ""].map((h, i) => (
              <div key={i} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", textAlign: i >= 3 ? "right" : "left" }}>{h}</div>
            ))}
          </div>

          {/* ─ Item rows ──────────────────────────────────────────────────── */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {items.length === 0 && (
              <div style={{ padding: "48px 28px", textAlign: "center", color: "#C8C0B0", fontSize: 13 }}>
                Добавьте позиции в смету
              </div>
            )}

            {items.map((item: any) => (
              <div
                key={item.id}
                style={{
                  display: "grid", gridTemplateColumns: colsMain,
                  padding: "11px 28px", gap: 12,
                  borderBottom: "1px solid #F2EFE9",
                  alignItems: "center",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                {/* Title */}
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }} onClick={e => e.stopPropagation()}>
                  <EditCell
                    value={item.title}
                    placeholder="Без названия"
                    onSave={v => estimatesApi.updateItem(item.id, { title: v }).then(() => refetch())}
                  />
                </div>

                {/* Qty */}
                <div onClick={e => e.stopPropagation()} style={{ fontSize: 13, color: "#1A1A1A", fontWeight: 500 }}>
                  <EditCell
                    value={item.quantity ?? 1}
                    numeric
                    onSave={v => estimatesApi.updateItem(item.id, { quantity: parseInt(v) || 1 }).then(() => refetch())}
                  />
                </div>

                {/* Markup */}
                <div onClick={e => e.stopPropagation()} style={{ fontSize: 12, color: "#6B6355" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                    ×<EditCell
                      value={item.markup ?? 2}
                      numeric
                      onSave={v => estimatesApi.updateItem(item.id, { markup: parseFloat(v) || 1 }).then(() => refetch())}
                    />
                  </span>
                </div>

                {/* Cost */}
                <div onClick={e => e.stopPropagation()} style={{ fontSize: 13, color: "#6B6355", textAlign: "right" }}>
                  <EditCell
                    value={item.cost_total ?? 0}
                    numeric
                    display={fmt(item.cost_total)}
                    style={{ textAlign: "right" }}
                    onSave={v => {
                      const cost = parseFloat(v) || 0;
                      estimatesApi.updateItem(item.id, { cost_total: cost }).then(() => refetch());
                    }}
                  />
                </div>

                {/* Sale price / Клиенту */}
                <div onClick={e => e.stopPropagation()} style={{ fontSize: 13, fontWeight: 700, color: "#1A1A1A", textAlign: "right" }}>
                  <EditCell
                    value={item.sale_price ?? 0}
                    numeric
                    display={fmt(item.sale_price)}
                    style={{ fontWeight: 700, textAlign: "right" }}
                    onSave={v => {
                      const entered = parseFloat(v) || 0;
                      const cost = item.cost_total || 0;
                      const newMarkup = cost > 0 ? Math.round((entered / cost) * 1000) / 1000 : 1;
                      estimatesApi.updateItem(item.id, { markup: newMarkup }).then(() => refetch());
                    }}
                  />
                </div>

                {/* Delta */}
                <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", textAlign: "right" }}>
                  +{fmt((item.sale_price || 0) - (item.cost_total || 0))}
                </div>

                {/* Actions: open calculator + delete */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                  <button
                    onClick={e => { e.stopPropagation(); setOpenItemId(item.id); }}
                    title="Открыть калькулятор"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2, display: "flex" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#6B6355")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}
                  >
                    <Cube size={13} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); estimatesApi.deleteItem(item.id).then(() => refetch()); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#D0C8C0", padding: 2, display: "flex" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#D0C8C0")}
                  >
                    <Trash size={13} />
                  </button>
                </div>
              </div>
            ))}

            {/* Add row — always visible */}
            <div style={{ padding: "10px 28px", display: "flex", gap: 10 }}>
              <button
                onClick={addItemInline}
                style={{ background: "none", border: "1px solid #EDEBE6", cursor: "pointer", fontSize: 12, color: "#6B6355", padding: "6px 12px", display: "flex", alignItems: "center", gap: 5 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#1A1A1A"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; }}
              >
                <Plus size={11} /> Позиция
              </button>
              <button
                onClick={() => setCatalogOpen(true)}
                style={{ background: "none", border: "1px solid #EDEBE6", cursor: "pointer", fontSize: 12, color: "#6B6355", padding: "6px 12px", display: "flex", alignItems: "center", gap: 5 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#1A1A1A"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; }}
              >
                <Package size={11} /> Из каталога
              </button>
            </div>
          </div>

          {/* ─ Footer totals ──────────────────────────────────────────────── */}
          <div style={{ flexShrink: 0, borderTop: "1px solid #EDEBE6" }}>

            <FooterRow cols={colsMain} label="Итого себестоимость"
              cost={fmt(totalCost)} sale={fmt(totalSale)} delta={`+${fmt(totalDelta)}`} deltaColor="#4A7C59" />

            {isBank && <>
              <FooterRow cols={colsMain} label={`Надбавка безнал ${bankPct}%`}
                sale={`+${fmt(bankAdd)}`} saleColor="#1A1A1A" />
              <FooterRow cols={colsMain} label="Налоги УСН 6%"
                sale={`−${fmt(taxes)}`} saleColor="#8B3A3A" />
              {fund > 0 && (
                <FooterRow cols={colsMain} label="Фонд бухгалтерии"
                  sale={`+${fmt(fund)}`} saleColor="#4A7C59"
                  note="остаток надбавки безнала после налогов" />
              )}
            </>}

            <div style={{
              display: "grid", gridTemplateColumns: colsMain,
              padding: "10px 28px", gap: 12, alignItems: "center",
              background: "#FAF8F5", borderTop: "1px solid #EDEBE6",
            }}>
              <div style={{ fontSize: 12, color: "#A89070", fontWeight: 500 }}>К оплате</div>
              <div /><div />
              <div />
              <div style={{ fontSize: 15, fontWeight: 700, color: "#E8592A", textAlign: "right" }}>{fmt(grandTotal)}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", textAlign: "right" }}>+{fmt(totalDelta)}</div>
              <div />
            </div>
          </div>
        </>
      )}

      {/* ─ Item detail modal ────────────────────────────────────────────── */}
      {openItem && (
        <ItemModal
          item={openItem}
          onClose={() => setOpenItemId(null)}
          onRefetch={() => refetch()}
        />
      )}

      {/* ─ Catalog modal ────────────────────────────────────────────────── */}
      {catalogOpen && (
        <CatalogModal
          onClose={() => setCatalogOpen(false)}
          onSelect={importFromCatalog}
        />
      )}
    </div>
  );
}
