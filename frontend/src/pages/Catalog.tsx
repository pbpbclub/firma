import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { catalogApi } from "../api";
import { MagnifyingGlass, Plus, X, Trash } from "@phosphor-icons/react";
import { ColumnFilter, AmountFilter } from "../components/TableFilters";
import { Modal, ConfirmModal } from "../components/ui/Modal";
import { CalcHeader, CalcSection, CalcRow, CalcFooter } from "../components/ui/Calc";
import { BrandSelect } from "../components/ui/Selects";
import { MONO } from "../components/ui/Num";

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

// ─── helpers ────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

const _num: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: "tabular-nums" };
const _STATUS_RU: Record<string, string> = {
  draft: "Черновик", estimate: "Смета", project: "Проект",
  in_production: "В производстве", completed: "Завершён", cancelled: "Отменён",
};

function CostHistorySection({ data, onOpenOrder }: { data: any; onOpenOrder: (orderId: string) => void }) {
  const etalon: number = data.etalon_unit || 0;
  const stats = data.stats;
  const planStats = data.plan_stats;
  const history: any[] = data.history || [];
  const histCols = "1fr 70px 64px 92px 92px 84px";

  return (
    <div style={{ padding: "18px 24px 4px", borderTop: "1px solid #EDEBE6", marginTop: 4 }}>
      <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 12 }}>ФАКТ ПО ЗАКАЗАМ</div>

      {history.length === 0 ? (
        <EmptyState title="Ещё нет заказов с этим изделием" compact />
      ) : (
        <>
          {/* Сводка эталон vs факт */}
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 16 }}>
            <Metric label="ЭТАЛОН / ШТ" value={fmt(etalon)} color="#1A1A1A" />
            {planStats && (
              <>
                <Metric label="СРЕДН. ПЛАН / ШТ" value={fmt(planStats.avg_plan_unit)} color="#1A1A1A" />
                {planStats.deviation_pct != null && (
                  <Metric
                    label="ПЛАН Δ К ЭТАЛОНУ"
                    value={`${planStats.deviation_pct > 0 ? "+" : ""}${planStats.deviation_pct}%`}
                    color={planStats.deviation_pct > 0 ? "#8B3A3A" : "#4A7C59"}
                  />
                )}
              </>
            )}
            {stats ? (
              <>
                <Metric label="СРЕДН. ФАКТ / ШТ" value={fmt(stats.avg_actual_unit)} color="#1A1A1A" />
                <Metric label="МИН" value={fmt(stats.min_actual_unit)} color="#A89070" />
                <Metric label="МАКС" value={fmt(stats.max_actual_unit)} color="#A89070" />
                <Metric label="ПОСЛЕДНИЙ" value={fmt(stats.last_actual_unit)} color="#A89070" />
                {stats.deviation_pct != null && (
                  <Metric
                    label="ОТКЛОНЕНИЕ"
                    value={`${stats.deviation_pct > 0 ? "+" : ""}${stats.deviation_pct}%`}
                    color={stats.deviation_pct > 0 ? "#8B3A3A" : "#4A7C59"}
                  />
                )}
              </>
            ) : (
              <Metric label="ФАКТ" value="нет привязанных трат" color="#A89070" />
            )}
          </div>

          {/* Список заказов */}
          <div style={{ display: "grid", gridTemplateColumns: histCols, gap: 8, fontSize: 9, color: "#A89070", letterSpacing: "0.04em", padding: "0 0 6px", borderBottom: "1px solid #F2EFE9" }}>
            <div>ЗАКАЗ</div>
            <div style={{ textAlign: "right" }}>КОЛ-ВО</div>
            <div style={{ textAlign: "right" }}>СТАТУС</div>
            <div style={{ textAlign: "right" }}>ПЛАН/ШТ</div>
            <div style={{ textAlign: "right" }}>ФАКТ/ШТ</div>
            <div style={{ textAlign: "right" }}>Δ/ШТ</div>
          </div>
          {history.map((h) => {
            const delta = h.has_fact ? h.actual_unit - h.plan_unit : null;
            return (
              <div
                key={h.order_id + h.title}
                onClick={() => onOpenOrder(h.order_id)}
                style={{
                  display: "grid", gridTemplateColumns: histCols, gap: 8, alignItems: "center",
                  fontSize: 12, padding: "8px 0", borderBottom: "1px solid #F2EFE9", cursor: "pointer",
                  color: h.has_fact ? "#1A1A1A" : "#A89070",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#FAF8F5")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.title}
                </div>
                <div style={{ ..._num, textAlign: "right" }}>{h.qty}</div>
                <div style={{ textAlign: "right", fontSize: 10, color: "#6B6355" }}>{_STATUS_RU[h.status] || h.status}</div>
                <div style={{ ..._num, textAlign: "right", color: "#A89070" }}>{fmt(h.plan_unit)}</div>
                <div style={{ ..._num, textAlign: "right" }}>{h.has_fact ? fmt(h.actual_unit) : "—"}</div>
                <div style={{ ..._num, textAlign: "right", color: delta == null ? "#A89070" : delta > 0 ? "#8B3A3A" : "#4A7C59" }}>
                  {delta == null ? "—" : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${fmt(Math.abs(delta)).replace(" ₽", "")}`}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.04em", marginBottom: 3 }}>{label}</div>
      <div style={{ ..._num, fontSize: 15, fontWeight: 700, color }}>{value}</div>
    </div>
  );
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
  brand: string | null;
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

let keyCounter = 0;
function newKey() { return String(++keyCounter); }

function emptyLine(type: LineType): Line {
  return { _key: newKey(), type, title: "", qty: 1, unit: type === "labor" ? "ч" : "шт", unit_price: 0 };
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
  const navigate = useNavigate();
  const isNew = !item?.id;

  const { data: costHistory } = useQuery({
    queryKey: ["catalog-cost-history", item?.id],
    queryFn: () => catalogApi.items.costHistory(item!.id),
    enabled: !!item?.id,
  });

  const [title, setTitle] = useState(item?.title ?? "");
  const [category, setCategory] = useState(item?.category ?? "");
  const [brand, setBrand] = useState<string | null>(item?.brand ?? null);
  const [markupPct, setMarkupPct] = useState(item?.markup_pct ?? 30);
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [lines, setLines] = useState<Line[]>(() =>
    item?.lines?.map((l) => ({ _key: newKey(), type: l.type as LineType, title: l.title, qty: l.qty, unit: l.unit, unit_price: l.unit_price, material_id: l.material_id })) ?? []
  );
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const costTotal = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);

  const updateLine = (key: string, updated: Line) => setLines(prev => prev.map(l => l._key === key ? updated : l));
  const removeLine = (key: string) => setLines(prev => prev.filter(l => l._key !== key));
  const addLine = (type: LineType) => setLines(prev => [...prev, emptyLine(type)]);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const payload = {
      title: title.trim(),
      category: category.trim() || null,
      brand: brand || null,
      markup_pct: markupPct,
      notes: notes.trim() || null,
      lines: lines.map((l, i) => ({
        type: l.type, title: l.title, qty: l.qty, unit: l.unit,
        unit_price: l.unit_price, material_id: l.material_id ?? null, sort_order: i,
      })),
    };
    try {
      if (isNew) await catalogApi.items.create(payload);
      else await catalogApi.items.update(item!.id, payload);
      qc.invalidateQueries({ queryKey: ["catalog-items"] });
      onSaved();
    } finally { setSaving(false); }
  };

  const deleteItem = async () => {
    if (!item?.id) return;
    await catalogApi.items.delete(item.id);
    qc.invalidateQueries({ queryKey: ["catalog-items"] });
    onSaved();
  };

  const materialLines = lines.filter(l => l.type === "material");
  const laborLines = lines.filter(l => l.type === "labor");
  const deliveryLines = lines.filter(l => l.type === "delivery");

  const inputBase: React.CSSProperties = {
    border: "1px solid #EDEBE6", background: "transparent", fontSize: 13, color: "#1A1A1A",
    outline: "none", padding: "6px 10px", boxSizing: "border-box", width: "100%",
  };
  const fieldLabel: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 };
  const CATEGORIES = ["Столы", "Уличная мебель", "Мягкая мебель", "Металлокаркасы", "Стулья", "Каркас дивана", "Кашпо", "Перегородки", "Полки", "Скамейки", "Доставка"];

  const renderRow = (l: Line) => (
    <CalcRow
      key={l._key} line={l} isMaterial={l.type === "material"}
      withAutocomplete={l.type === "material"} materialsFetch={catalogApi.materials}
      onPatch={p => updateLine(l._key, { ...l, ...p })}
      onRemove={() => removeLine(l._key)}
      onPickMaterial={m => updateLine(l._key, { ...l, title: m.name, unit: m.unit || "шт", unit_price: m.price || 0, material_id: m.id })}
    />
  );

  return (
    <>
      <Modal
        size="lg"
        eyebrow={isNew ? "НОВОЕ ИЗДЕЛИЕ" : "РЕДАКТИРОВАТЬ"}
        onClose={onClose}
        onDelete={!isNew ? () => setConfirmDelete(true) : undefined}
        onCancel={onClose}
        onSave={save}
        saveLabel="Сохранить в каталог"
        saving={saving}
        canSave={!!title.trim()}
      >
        <div style={{ padding: "16px 24px 0" }}>
          <div style={fieldLabel}>НАЗВАНИЕ</div>
          <input style={inputBase} placeholder="Название изделия" value={title} onChange={e => setTitle(e.target.value)} autoFocus />

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 16, marginTop: 14, alignItems: "end" }}>
            <div>
              <div style={fieldLabel}>КАТЕГОРИЯ</div>
              <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...inputBase, appearance: "none", cursor: "pointer" }}>
                <option value="">— не выбрана —</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                {category && !CATEGORIES.includes(category) && <option value={category}>{category}</option>}
              </select>
            </div>
            <div>
              <div style={fieldLabel}>БРЕНД</div>
              <BrandSelect value={brand} onChange={setBrand} />
            </div>
          </div>

          <div style={{ marginTop: 18 }}><CalcHeader /></div>
          <CalcSection label="Материалы" addLabel="Добавить материал" onAdd={() => addLine("material")}>
            {materialLines.map(renderRow)}
          </CalcSection>
          <CalcSection label="Работы" addLabel="Добавить работу" onAdd={() => addLine("labor")}>
            {laborLines.map(renderRow)}
          </CalcSection>
          <CalcSection label="Доставка" addLabel="Добавить доставку" onAdd={() => addLine("delivery")}>
            {deliveryLines.map(renderRow)}
          </CalcSection>

          {(notes || isNew) && (
            <>
              <div style={{ ...fieldLabel, marginTop: 18 }}>ПРИМЕЧАНИЕ</div>
              <textarea style={{ ...inputBase, resize: "vertical", minHeight: 48, fontFamily: "inherit" }} placeholder="Примечание..." value={notes} onChange={e => setNotes(e.target.value)} />
            </>
          )}
        </div>

        <CalcFooter cost={costTotal} pct={markupPct} onPctChange={setMarkupPct} />

        {!isNew && costHistory && (
          <CostHistorySection data={costHistory} onOpenOrder={(oid) => { onClose(); navigate(`/orders/${oid}/estimate`); }} />
        )}
      </Modal>

      {confirmDelete && (
        <ConfirmModal
          message={`Удалить «${item?.title}» из каталога? Это действие безвозвратно.`}
          onConfirm={() => { setConfirmDelete(false); deleteItem(); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

const tabs = ["Каталог", "Из смет"] as const;
type Tab = typeof tabs[number];

const catalogCols = "28px 2fr 90px 1fr 130px 130px";
const fromSmetsCols = "28px 2fr 1fr 80px 140px 120px 120px";

export default function Catalog() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("Каталог");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [modalItem, setModalItem] = useState<CatalogItemFull | null | "new">(undefined as any);
  const [modalOpen, setModalOpen] = useState(false);
  const [catFilter, setCatFilter] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const clearFilters = () => { setCatFilter(""); setNameFilter(""); setBrandFilter(""); setPriceMin(""); setPriceMax(""); setSelectedIds(new Set()); };
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [confirmSmetsDelete, setConfirmSmetsDelete] = useState(false);
  const [smetsDeleting, setSmetsDeleting] = useState(false);

  const smetsDelete = async () => {
    setSmetsDeleting(true);
    try {
      await catalogApi.deleteByTitles(Array.from(selectedIds));
      qc.invalidateQueries({ queryKey: ["catalog"] });
      setSelectedIds(new Set());
    } finally {
      setSmetsDeleting(false);
    }
  };

  const bulkDelete = async () => {
    setBulkDeleting(true);
    try {
      for (const id of Array.from(selectedIds)) {
        await catalogApi.items.delete(id);
      }
      qc.invalidateQueries({ queryKey: ["catalog-items"] });
      setSelectedIds(new Set());
    } finally {
      setBulkDeleting(false);
    }
  };

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
            const uniqueBrands = [...new Set(savedItems.map(i => i.brand).filter(Boolean))].sort() as string[];
            const filteredItems = savedItems.filter(i => {
              if (catFilter && i.category !== catFilter) return false;
              if (nameFilter && i.title !== nameFilter) return false;
              if (brandFilter && i.brand !== brandFilter) return false;
              if (priceMin && (i.sale_price || 0) < parseFloat(priceMin)) return false;
              if (priceMax && (i.sale_price || 0) > parseFloat(priceMax)) return false;
              return true;
            });
            return (
              <>
                {(() => {
                  const hasFilters = !!(catFilter || nameFilter || brandFilter || priceMin || priceMax);
                  const canClear = hasFilters || selectedIds.size > 0;
                  const selSum = filteredItems.filter(i => selectedIds.has(i.id)).reduce((s, i) => s + (i.sale_price || 0), 0);
                  return (
                    <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                      <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
                        {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
                        {selectedIds.size > 0 && selSum > 0 && <span>{fmt(selSum)}</span>}
                        {selectedIds.size === 0 && <span>{filteredItems.length} изделий</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        {selectedIds.size > 0 && (
                          <button
                            onClick={() => setConfirmBulkDelete(true)}
                            disabled={bulkDeleting}
                            style={{ fontSize: 10, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 3, padding: 0 }}
                          >
                            <Trash size={10} /> Удалить ({selectedIds.size})
                          </button>
                        )}
                        <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
                          <X size={10} /> Сбросить
                        </button>
                      </div>
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
                  <div><ColumnFilter label="ИЗДЕЛИЕ" options={uniqueNames} value={nameFilter} onChange={setNameFilter} /></div>
                  <div><ColumnFilter label="БРЕНД" options={uniqueBrands} value={brandFilter} onChange={setBrandFilter} /></div>
                  <div><ColumnFilter label="КАТЕГОРИЯ" options={uniqueCats} value={catFilter} onChange={setCatFilter} /></div>
                  <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>СЕБЕСТОИМОСТЬ</div>
                  <div><AmountFilter label="ПРОДАЖНАЯ ЦЕНА" min={priceMin} max={priceMax} onChange={(mn, mx) => { setPriceMin(mn); setPriceMax(mx); }} /></div>
                </div>
                {loadingSaved ? (
                  <Loading />
                ) : filteredItems.length === 0 ? (
                  <EmptyState title={catFilter ? "Нет изделий в этой категории" : "Каталог пуст — нажмите + чтобы добавить первое изделие"} />
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
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</div>
              <div>
                {item.brand ? (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 6px", fontFamily: MONO,
                    color: item.brand === "MeRA" ? "#2E6DA4" : item.brand === "pbpb" ? "#7B4F9E" : "#3D8C6B",
                    border: `1px solid ${item.brand === "MeRA" ? "#2E6DA4" : item.brand === "pbpb" ? "#7B4F9E" : "#3D8C6B"}`,
                  }}>{item.brand}</span>
                ) : <span style={{ fontSize: 11, color: "#C8C0B0" }}>—</span>}
              </div>
              <div style={{ fontSize: 12, color: "#A89070" }}>{item.category || "—"}</div>
              <div style={{ fontSize: 12, color: "#6B6355", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(item.cost_total)}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#E8592A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(item.sale_price)}</div>
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
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        {selectedIds.size > 0 && (
                          <button
                            onClick={() => setConfirmSmetsDelete(true)}
                            disabled={smetsDeleting}
                            style={{ fontSize: 10, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 3, padding: 0 }}
                          >
                            <Trash size={10} /> Удалить ({selectedIds.size})
                          </button>
                        )}
                        <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
                          <X size={10} /> Сбросить
                        </button>
                      </div>
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
            <div><ColumnFilter label="ИЗДЕЛИЕ" options={smetsUniqueNames} value={nameFilter} onChange={setNameFilter} /></div>
            <div><ColumnFilter label="КАТЕГОРИЯ" options={smetsUniqueCats} value={catFilter} onChange={setCatFilter} /></div>
            <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ЗАКАЗОВ</div>
            <div><AmountFilter label="ЦЕНА (СР.)" min={priceMin} max={priceMax} onChange={(mn, mx) => { setPriceMin(mn); setPriceMax(mx); }} /></div>
            <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>МИН.</div>
            <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>МАКС.</div>
          </div>
          {loadingSmets ? (
            <Loading />
          ) : filteredSmets.length === 0 ? (
            <EmptyState title="Ничего не найдено" />
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
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(item.avg_price)}</div>
              <div style={{ fontSize: 12, color: "#A89070", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(item.min_price)}</div>
              <div style={{ fontSize: 12, color: "#A89070", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(item.max_price)}</div>
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
      {confirmBulkDelete && (
        <ConfirmModal
          message={`Удалить ${selectedIds.size} изделий${selectedIds.size === 1 ? "" : ""} из каталога? Это действие безвозвратно.`}
          onConfirm={() => { setConfirmBulkDelete(false); bulkDelete(); }}
          onCancel={() => setConfirmBulkDelete(false)}
        />
      )}
      {confirmSmetsDelete && (
        <ConfirmModal
          message={`Удалить ${selectedIds.size} позиций из всех смет? Это изменит суммы смет и безвозвратно удалит эти позиции.`}
          onConfirm={() => { setConfirmSmetsDelete(false); smetsDelete(); }}
          onCancel={() => setConfirmSmetsDelete(false)}
        />
      )}
    </div>
  );
}
