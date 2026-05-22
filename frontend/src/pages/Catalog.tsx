import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { catalogApi } from "../api";
import { MagnifyingGlass, Plus, X, Trash, Funnel } from "@phosphor-icons/react";

function ColumnFilter({ options, value, onChange, maxHeight }: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  maxHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEffect(() => { if (!open) setQ(""); }, [open]);
  const filtered = q ? options.filter(o => o.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", display: "flex", alignItems: "center", color: value ? "#E8592A" : "#C8C0B0" }}>
        <Funnel size={11} weight={value ? "fill" : "regular"} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#FFFFFF", border: "1px solid #EDEBE6", boxShadow: "0 4px 16px rgba(0,0,0,0.10)", minWidth: 180 }}>
          <div style={{ padding: "5px 8px", borderBottom: "1px solid #F2EFE9" }}>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} onClick={e => e.stopPropagation()}
              placeholder="Поиск..." style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 12, outline: "none", fontFamily: "inherit" }} />
          </div>
          <div style={{ maxHeight: maxHeight ?? 200, overflowY: "auto" }}>
            <div onClick={() => { onChange(""); setOpen(false); }} style={{ padding: "8px 12px", fontSize: 12, cursor: "pointer", color: !value ? "#E8592A" : "#1A1A1A", fontWeight: !value ? 600 : 400, borderBottom: "1px solid #F2EFE9" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>Все</div>
            {filtered.map(opt => (
              <div key={opt} onClick={() => { onChange(opt); setOpen(false); }} style={{ padding: "8px 12px", fontSize: 12, cursor: "pointer", color: value === opt ? "#E8592A" : "#1A1A1A", fontWeight: value === opt ? 600 : 400 }}
                onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>{opt}</div>
            ))}
            {filtered.length === 0 && <div style={{ padding: "8px 12px", fontSize: 12, color: "#C8C0B0" }}>Не найдено</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Checkbox({ checked, indeterminate = false, onChange }: {
  checked: boolean; indeterminate?: boolean; onChange: () => void;
}) {
  return (
    <div onClick={e => { e.stopPropagation(); onChange(); }} style={{
      width: 14, height: 14, flexShrink: 0, cursor: "pointer",
      border: `1.5px solid ${checked || indeterminate ? "#E8592A" : "#D0C8C0"}`,
      background: checked ? "#E8592A" : "transparent",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {checked && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3L3 5.5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      {!checked && indeterminate && <div style={{ width: 8, height: 1.5, background: "#E8592A" }} />}
    </div>
  );
}

function AmountFilter({ min, max, onChange }: {
  min: string; max: string;
  onChange: (min: string, max: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const active = !!min || !!max;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", display: "flex", alignItems: "center", color: active ? "#E8592A" : "#C8C0B0" }}>
        <Funnel size={11} weight={active ? "fill" : "regular"} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 200, background: "#FFFFFF", border: "1px solid #EDEBE6", boxShadow: "0 4px 16px rgba(0,0,0,0.10)", padding: "10px 12px", minWidth: 210 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="number" placeholder="От" value={min} onChange={e => onChange(e.target.value, max)} autoFocus
              style={{ width: 84, border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
            <span style={{ fontSize: 12, color: "#A89070" }}>—</span>
            <input type="number" placeholder="До" value={max} onChange={e => onChange(min, e.target.value)}
              style={{ width: 84, border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
          </div>
          {active && (
            <button onClick={() => { onChange("", ""); setOpen(false); }}
              style={{ marginTop: 8, width: "100%", padding: "5px", border: "none", background: "#FAF8F5", fontSize: 11, color: "#A89070", cursor: "pointer" }}>
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function fmtNum(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n);
}

type LineType = "material" | "labor" | "delivery";

interface Line {
  _key: string;
  type: LineType;
  title: string;
  qty: number;
  unit: string;
  unit_price: number;
  material_id?: string;
}

interface CatalogItem {
  id: string;
  title: string;
  category: string | null;
  markup_pct: number;
  cost_total: number;
  sale_price: number;
  notes: string | null;
}

interface CatalogItemFull extends CatalogItem {
  lines: Array<{
    id: string;
    type: LineType;
    title: string;
    qty: number;
    unit: string;
    unit_price: number;
    line_total: number;
    material_id?: string;
  }>;
}

const TYPE_LABELS: Record<LineType, string> = {
  material: "Материал",
  labor: "Работа",
  delivery: "Доставка",
};

let keyCounter = 0;
function newKey() { return String(++keyCounter); }

function emptyLine(type: LineType): Line {
  return { _key: newKey(), type, title: "", qty: 1, unit: type === "labor" ? "ч" : "шт", unit_price: 0 };
}

// ─── Material autocomplete row ────────────────────────────────────────────

function MaterialRow({
  line,
  onChange,
  onRemove,
}: {
  line: Line;
  onChange: (l: Line) => void;
  onRemove: () => void;
}) {
  const [materialSearch, setMaterialSearch] = useState(line.title);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const { data: suggestions = [] } = useQuery({
    queryKey: ["materials-suggest", materialSearch],
    queryFn: () => catalogApi.materials(materialSearch || undefined),
    enabled: line.type === "material" && showSuggestions && materialSearch.length > 0,
  });

  const lineTotal = line.qty * line.unit_price;

  const fieldStyle: React.CSSProperties = {
    border: "1px solid #EDEBE6",
    background: "transparent",
    fontSize: 12,
    color: "#1A1A1A",
    outline: "none",
    padding: "4px 7px",
    borderRadius: 0,
    width: "100%",
    boxSizing: "border-box",
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 72px 90px 80px 20px", gap: 6, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F2EFE9" }}>
      {/* Title */}
      <div style={{ position: "relative" }}>
        <input
          style={fieldStyle}
          value={line.type === "material" ? materialSearch : line.title}
          placeholder={TYPE_LABELS[line.type]}
          onChange={(e) => {
            if (line.type === "material") {
              setMaterialSearch(e.target.value);
              setShowSuggestions(true);
              onChange({ ...line, title: e.target.value, material_id: undefined });
            } else {
              onChange({ ...line, title: e.target.value });
            }
          }}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
        />
        {showSuggestions && (suggestions as any[]).length > 0 && (
          <div style={{
            position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100,
            background: "#FFFFFF", border: "1px solid #EDEBE6", boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
            maxHeight: 180, overflowY: "auto",
          }}>
            {(suggestions as any[]).map((m: any) => (
              <div
                key={m.id}
                onMouseDown={() => {
                  setMaterialSearch(m.name);
                  setShowSuggestions(false);
                  onChange({ ...line, title: m.name, unit: m.unit || "шт", unit_price: m.price || 0, material_id: m.id });
                }}
                style={{ padding: "7px 10px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid #F2EFE9" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#FAF8F5")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ color: "#1A1A1A" }}>{m.name}</span>
                <span style={{ color: "#A89070", marginLeft: 8 }}>{m.unit} · {fmt(m.price)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Qty */}
      <input
        style={{ ...fieldStyle, textAlign: "right" }}
        type="number"
        min="0"
        value={line.qty}
        onChange={(e) => onChange({ ...line, qty: parseFloat(e.target.value) || 0 })}
      />

      {/* Unit */}
      <input
        style={fieldStyle}
        value={line.unit}
        onChange={(e) => onChange({ ...line, unit: e.target.value })}
      />

      {/* Price */}
      <input
        style={{ ...fieldStyle, textAlign: "right" }}
        type="number"
        min="0"
        value={line.unit_price}
        onChange={(e) => onChange({ ...line, unit_price: parseFloat(e.target.value) || 0 })}
      />

      {/* Total */}
      <div style={{ fontSize: 12, color: "#1A1A1A", fontWeight: 600, textAlign: "right" }}>
        {lineTotal > 0 ? fmtNum(lineTotal) : "—"}
      </div>

      {/* Remove */}
      <button onClick={onRemove} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 0, display: "flex", alignItems: "center" }}>
        <X size={13} />
      </button>
    </div>
  );
}

// ─── Calculator Modal ────────────────────────────────────────────────────────

function CalculatorModal({
  item,
  onClose,
  onSaved,
}: {
  item: CatalogItemFull | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const isNew = !item?.id;

  const [title, setTitle] = useState(item?.title ?? "");
  const [category, setCategory] = useState(item?.category ?? "");
  const [markupPct, setMarkupPct] = useState(item?.markup_pct ?? 30);
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [lines, setLines] = useState<Line[]>(() =>
    item?.lines?.map((l) => ({ _key: newKey(), type: l.type as LineType, title: l.title, qty: l.qty, unit: l.unit, unit_price: l.unit_price, material_id: l.material_id })) ?? []
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const costTotal = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
  const markupAmt = costTotal * markupPct / 100;
  const salePrice = costTotal + markupAmt;

  const updateLine = useCallback((key: string, updated: Line) => {
    setLines((prev) => prev.map((l) => l._key === key ? updated : l));
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l._key !== key));
  }, []);

  const addLine = (type: LineType) => setLines((prev) => [...prev, emptyLine(type)]);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const payload = {
      title: title.trim(),
      category: category.trim() || null,
      markup_pct: markupPct,
      notes: notes.trim() || null,
      lines: lines.map((l, i) => ({
        type: l.type, title: l.title, qty: l.qty, unit: l.unit,
        unit_price: l.unit_price, material_id: l.material_id ?? null, sort_order: i,
      })),
    };
    try {
      if (isNew) {
        await catalogApi.items.create(payload);
      } else {
        await catalogApi.items.update(item!.id, payload);
      }
      qc.invalidateQueries({ queryKey: ["catalog-items"] });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async () => {
    if (!item?.id) return;
    setDeleting(true);
    try {
      await catalogApi.items.delete(item.id);
      qc.invalidateQueries({ queryKey: ["catalog-items"] });
      onSaved();
    } finally {
      setDeleting(false);
    }
  };

  const materialLines = lines.filter((l) => l.type === "material");
  const laborLines = lines.filter((l) => l.type === "labor");
  const deliveryLines = lines.filter((l) => l.type === "delivery");

  const inputBase: React.CSSProperties = {
    border: "1px solid #EDEBE6", background: "transparent",
    fontSize: 13, color: "#1A1A1A", outline: "none",
    padding: "6px 10px", borderRadius: 0, boxSizing: "border-box",
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 10, color: "#A89070", letterSpacing: "0.06em",
    marginBottom: 8, marginTop: 20,
  };

  const colHeader: React.CSSProperties = {
    fontSize: 10, color: "#A89070", letterSpacing: "0.04em",
  };

  const addBtn: React.CSSProperties = {
    background: "none", border: "none", cursor: "pointer",
    fontSize: 11, color: "#A89070", padding: "6px 0",
    display: "flex", alignItems: "center", gap: 4,
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.32)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#FFFFFF",
        width: 680, maxWidth: "95vw",
        maxHeight: "90vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 8px 40px rgba(0,0,0,0.16)",
      }}>
        {/* Modal header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #EDEBE6", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>
            {isNew ? "НОВОЕ ИЗДЕЛИЕ" : "РЕДАКТИРОВАТЬ"}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", display: "flex", alignItems: "center" }}>
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: "auto", flex: 1, padding: "0 24px 24px" }}>

          {/* Name + category */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 10, marginTop: 20 }}>
            <div>
              <div style={{ ...sectionLabel, marginTop: 0, marginBottom: 4 }}>НАЗВАНИЕ</div>
              <input
                style={{ ...inputBase, width: "100%" }}
                placeholder="Название изделия"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <div style={{ ...sectionLabel, marginTop: 0, marginBottom: 4 }}>КАТЕГОРИЯ</div>
              <input
                style={{ ...inputBase, width: "100%" }}
                placeholder="Столы"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>
          </div>

          {/* Column headers for lines */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 72px 90px 80px 20px", gap: 6, marginTop: 20, padding: "0 0 4px" }}>
            <div style={colHeader}>Наименование</div>
            <div style={{ ...colHeader, textAlign: "right" }}>Кол-во</div>
            <div style={colHeader}>Ед.</div>
            <div style={{ ...colHeader, textAlign: "right" }}>Цена, ₽</div>
            <div style={{ ...colHeader, textAlign: "right" }}>Итого, ₽</div>
            <div />
          </div>

          {/* МАТЕРИАЛЫ */}
          <div style={{ ...sectionLabel }}>МАТЕРИАЛЫ</div>
          {materialLines.map((l) => (
            <MaterialRow key={l._key} line={l} onChange={(u) => updateLine(l._key, u)} onRemove={() => removeLine(l._key)} />
          ))}
          <button style={addBtn} onClick={() => addLine("material")}>
            <Plus size={11} /> Добавить материал
          </button>

          {/* РАБОТЫ */}
          <div style={sectionLabel}>РАБОТЫ</div>
          {laborLines.map((l) => (
            <MaterialRow key={l._key} line={l} onChange={(u) => updateLine(l._key, u)} onRemove={() => removeLine(l._key)} />
          ))}
          <button style={addBtn} onClick={() => addLine("labor")}>
            <Plus size={11} /> Добавить работу
          </button>

          {/* ДОСТАВКА */}
          <div style={sectionLabel}>ДОСТАВКА</div>
          {deliveryLines.map((l) => (
            <MaterialRow key={l._key} line={l} onChange={(u) => updateLine(l._key, u)} onRemove={() => removeLine(l._key)} />
          ))}
          <button style={addBtn} onClick={() => addLine("delivery")}>
            <Plus size={11} /> Добавить доставку
          </button>

          {/* Notes */}
          {(notes || isNew) && (
            <>
              <div style={sectionLabel}>ПРИМЕЧАНИЕ</div>
              <textarea
                style={{ ...inputBase, width: "100%", resize: "vertical", minHeight: 48, fontFamily: "inherit" }}
                placeholder="Примечание..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </>
          )}

          {/* Summary */}
          <div style={{ marginTop: 24, borderTop: "2px solid #EDEBE6", paddingTop: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320, marginLeft: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#A89070" }}>
                <span>Себестоимость</span>
                <span style={{ fontWeight: 600, color: "#1A1A1A" }}>{fmt(costTotal)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#A89070" }}>
                <span>Наценка</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    value={markupPct}
                    onChange={(e) => setMarkupPct(parseFloat(e.target.value) || 0)}
                    style={{ ...inputBase, width: 56, fontSize: 12, padding: "3px 7px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: 11 }}>%</span>
                  <span style={{ color: "#1A1A1A", fontWeight: 600, minWidth: 72, textAlign: "right" }}>+ {fmt(markupAmt)}</span>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, color: "#1A1A1A", borderTop: "1px solid #EDEBE6", paddingTop: 10 }}>
                <span>Продажная цена</span>
                <span style={{ color: "#E8592A" }}>{fmt(salePrice)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer buttons */}
        <div style={{ padding: "14px 24px", borderTop: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          {!isNew ? (
            <button
              onClick={deleteItem}
              disabled={deleting}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#8B3A3A", display: "flex", alignItems: "center", gap: 5 }}
            >
              <Trash size={13} /> Удалить
            </button>
          ) : <div />}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{ padding: "7px 16px", background: "#F2EFE9", border: "none", cursor: "pointer", fontSize: 12, color: "#6B6355" }}
            >
              Отмена
            </button>
            <button
              onClick={save}
              disabled={saving || !title.trim()}
              style={{
                padding: "7px 20px", background: title.trim() ? "#E8592A" : "#EDEBE6",
                border: "none", cursor: title.trim() ? "pointer" : "default",
                fontSize: 12, color: title.trim() ? "#FFFFFF" : "#A89070", fontWeight: 600,
              }}
            >
              {saving ? "Сохраняем..." : "Сохранить в каталог"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

const tabs = ["Каталог", "Из смет"] as const;
type Tab = typeof tabs[number];

const catalogCols = "28px 2fr 1fr 130px 130px";
const fromSmetsCols = "28px 2fr 1fr 80px 140px 120px 120px";

export default function Catalog() {
  const [tab, setTab] = useState<Tab>("Каталог");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [modalItem, setModalItem] = useState<CatalogItemFull | null | "new">(undefined as any);
  const [modalOpen, setModalOpen] = useState(false);
  const [catFilter, setCatFilter] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const clearFilters = () => { setCatFilter(""); setNameFilter(""); setPriceMin(""); setPriceMax(""); setSelectedIds(new Set()); };
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const { data: savedItems = [], isLoading: loadingSaved } = useQuery<CatalogItem[]>({
    queryKey: ["catalog-items"],
    queryFn: catalogApi.items.list,
    enabled: tab === "Каталог",
  });

  const { data: fromSmets = [], isLoading: loadingSmets } = useQuery({
    queryKey: ["catalog", search],
    queryFn: () => catalogApi.list(search || undefined),
    enabled: tab === "Из смет",
  });

  const openNew = () => {
    setModalItem(null);
    setModalOpen(true);
  };

  const openEdit = async (item: CatalogItem) => {
    const full = await catalogApi.items.get(item.id);
    setModalItem(full);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalItem(undefined as any);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ padding: "24px 28px 0", borderBottom: "1px solid #EDEBE6" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Изделия</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 2 }}>
            {tab === "Из смет" && (
              searchOpen ? (
                <div style={{ position: "relative" }}>
                  <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
                  <input
                    autoFocus
                    style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6, border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, color: "#1A1A1A", outline: "none", width: 180, borderRadius: 0 }}
                    placeholder="Поиск..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearch(""); } }}
                  />
                </div>
              ) : (
                <button onClick={() => setSearchOpen(true)} style={{ width: 28, height: 28, background: "#F2EFE9", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <MagnifyingGlass size={13} color="#6B6355" />
                </button>
              )
            )}
            {tab === "Каталог" && (
              <button
                onClick={openNew}
                style={{ width: 28, height: 28, background: "#E8592A", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <Plus size={14} color="#FFFFFF" weight="bold" />
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0 }}>
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "8px 18px",
                background: "none", border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: tab === t ? 600 : 400,
                color: tab === t ? "#1A1A1A" : "#A89070",
                borderBottom: tab === t ? "2px solid #E8592A" : "2px solid transparent",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Tab: Каталог */}
      {tab === "Каталог" && (
        <>
          {/* Column headers */}
          {(() => {
            const uniqueCats = [...new Set(savedItems.map(i => i.category).filter(Boolean))].sort() as string[];
            const uniqueNames = [...new Set(savedItems.map(i => i.title).filter(Boolean))].sort() as string[];
            const filteredItems = savedItems.filter(i => {
              if (catFilter && i.category !== catFilter) return false;
              if (nameFilter && i.title !== nameFilter) return false;
              if (priceMin && (i.sale_price || 0) < parseFloat(priceMin)) return false;
              if (priceMax && (i.sale_price || 0) > parseFloat(priceMax)) return false;
              return true;
            });
            return (
              <>
                {(() => {
                  const hasFilters = !!(catFilter || nameFilter || priceMin || priceMax);
                  const canClear = hasFilters || selectedIds.size > 0;
                  const selSum = filteredItems.filter(i => selectedIds.has(i.id)).reduce((s, i) => s + (i.sale_price || 0), 0);
                  return (
                    <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                      <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
                        {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
                        {selectedIds.size > 0 && selSum > 0 && <span>{fmt(selSum)}</span>}
                        {selectedIds.size === 0 && <span>{filteredItems.length} изделий</span>}
                      </div>
                      <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
                        <X size={10} /> Сбросить
                      </button>
                    </div>
                  );
                })()}

                <div style={{ display: "grid", gridTemplateColumns: catalogCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <Checkbox
                      checked={filteredItems.length > 0 && filteredItems.every(i => selectedIds.has(i.id))}
                      indeterminate={filteredItems.some(i => selectedIds.has(i.id)) && !filteredItems.every(i => selectedIds.has(i.id))}
                      onChange={() => {
                        const allSel = filteredItems.every(i => selectedIds.has(i.id));
                        setSelectedIds(allSel ? new Set() : new Set(filteredItems.map(i => i.id)));
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ИЗДЕЛИЕ</span>
                    <ColumnFilter options={uniqueNames} value={nameFilter} onChange={setNameFilter} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>КАТЕГОРИЯ</span>
                    <ColumnFilter options={uniqueCats} value={catFilter} onChange={setCatFilter} />
                  </div>
                  <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>СЕБЕСТОИМОСТЬ</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ПРОДАЖНАЯ ЦЕНА</span>
                    <AmountFilter min={priceMin} max={priceMax} onChange={(mn, mx) => { setPriceMin(mn); setPriceMax(mx); }} />
                  </div>
                </div>
                {loadingSaved ? (
                  <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>
                ) : filteredItems.length === 0 ? (
                  <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>
                    {catFilter ? "Нет изделий в этой категории" : "Каталог пуст — нажмите + чтобы добавить первое изделие"}
                  </div>
                ) : filteredItems.map((item) => (
            <div
              key={item.id}
              onClick={() => openEdit(item)}
              style={{ display: "grid", gridTemplateColumns: catalogCols, padding: "13px 28px", borderBottom: "1px solid #F2EFE9", alignItems: "center", cursor: "pointer", transition: "background 0.1s", background: selectedIds.has(item.id) ? "#FFF8F5" : "transparent" }}
              onMouseEnter={(e) => { if (!selectedIds.has(item.id)) e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (!selectedIds.has(item.id)) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <Checkbox checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{item.title}</div>
              <div style={{ fontSize: 12, color: "#A89070" }}>{item.category || "—"}</div>
              <div style={{ fontSize: 12, color: "#6B6355" }}>{fmt(item.cost_total)}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#E8592A" }}>{fmt(item.sale_price)}</div>
            </div>
          ))}
              </>
            );
          })()}
        </>
      )}

      {/* Tab: Из смет */}
      {tab === "Из смет" && (
        <>
          {(() => {
            const smetsUniqueCats = [...new Set((fromSmets as any[]).map((i: any) => i.category).filter(Boolean))].sort() as string[];
            const smetsUniqueNames = [...new Set((fromSmets as any[]).map((i: any) => i.title).filter(Boolean))].sort() as string[];
            const filteredSmets = (fromSmets as any[]).filter((i: any) => {
              if (catFilter && i.category !== catFilter) return false;
              if (nameFilter && i.title !== nameFilter) return false;
              if (priceMin && (i.avg_price || 0) < parseFloat(priceMin)) return false;
              if (priceMax && (i.avg_price || 0) > parseFloat(priceMax)) return false;
              return true;
            });
            return (
              <>
                {(() => {
                  const hasFilters = !!(catFilter || nameFilter || priceMin || priceMax);
                  const canClear = hasFilters || selectedIds.size > 0;
                  const selSum = filteredSmets.filter((item: any) => selectedIds.has(item.title || "")).reduce((s: number, item: any) => s + (item.avg_price || 0), 0);
                  return (
                    <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                      <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
                        {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
                        {selectedIds.size > 0 && selSum > 0 && <span>{fmt(selSum)}</span>}
                        {selectedIds.size === 0 && <span>{filteredSmets.length} изделий</span>}
                      </div>
                      <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
                        <X size={10} /> Сбросить
                      </button>
                    </div>
                  );
                })()}
          <div style={{ display: "grid", gridTemplateColumns: fromSmetsCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <Checkbox
                checked={filteredSmets.length > 0 && filteredSmets.every((item: any) => selectedIds.has(item.title || ""))}
                indeterminate={filteredSmets.some((item: any) => selectedIds.has(item.title || "")) && !filteredSmets.every((item: any) => selectedIds.has(item.title || ""))}
                onChange={() => {
                  const allSel = filteredSmets.every((item: any) => selectedIds.has(item.title || ""));
                  setSelectedIds(allSel ? new Set() : new Set(filteredSmets.map((item: any) => item.title || "")));
                }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ИЗДЕЛИЕ</span>
              <ColumnFilter options={smetsUniqueNames} value={nameFilter} onChange={setNameFilter} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>КАТЕГОРИЯ</span>
              <ColumnFilter options={smetsUniqueCats} value={catFilter} onChange={setCatFilter} />
            </div>
            <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ЗАКАЗОВ</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ЦЕНА (СР.)</span>
              <AmountFilter min={priceMin} max={priceMax} onChange={(mn, mx) => { setPriceMin(mn); setPriceMax(mx); }} />
            </div>
            <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>МИН.</div>
            <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>МАКС.</div>
          </div>
          {loadingSmets ? (
            <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>
          ) : filteredSmets.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Ничего не найдено</div>
          ) : filteredSmets.map((item: any, i: number) => {
            const rowId = item.title || String(i);
            return (
            <div
              key={i}
              style={{ display: "grid", gridTemplateColumns: fromSmetsCols, padding: "13px 28px", borderBottom: "1px solid #F2EFE9", alignItems: "center", transition: "background 0.1s", background: selectedIds.has(rowId) ? "#FFF8F5" : "transparent" }}
              onMouseEnter={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <Checkbox checked={selectedIds.has(rowId)} onChange={() => toggleSelect(rowId)} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{item.title}</div>
              <div style={{ fontSize: 12, color: "#A89070" }}>{item.category || "—"}</div>
              <div style={{ fontSize: 12, color: "#6B6355" }}>{item.times_ordered}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1A1A" }}>{fmt(item.avg_price)}</div>
              <div style={{ fontSize: 12, color: "#A89070" }}>{fmt(item.min_price)}</div>
              <div style={{ fontSize: 12, color: "#A89070" }}>{fmt(item.max_price)}</div>
            </div>
            );
          })}
              </>
            );
          })()}
        </>
      )}

      {/* Modal */}
      {modalOpen && (
        <CalculatorModal
          item={modalItem as CatalogItemFull | null}
          onClose={closeModal}
          onSaved={closeModal}
        />
      )}
    </div>
  );
}
