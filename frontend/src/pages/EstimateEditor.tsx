import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ordersApi, estimatesApi, catalogApi, mastersApi, workTypesApi } from "../api";
import { useNavigationGuard, NavigationGuardModal } from "../components/NavigationGuard";
import {
  ArrowLeft, Plus, Trash, Package, Wrench, Truck, Cube,
  X, FileText, DotsSixVertical, PencilSimple, FloppyDisk, ListChecks, CheckCircle, Circle,
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

const BRANDS = [
  { value: "MeRA",    color: "#2E6DA4" },
  { value: "pbpb",    color: "#7B4F9E" },
  { value: "Транзит", color: "#3D8C6B" },
];

// ── Item detail modal ────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  width: "100%", border: "none", borderBottom: "1px solid #EDEBE6",
  outline: "none", fontSize: 11, color: "#1A1A1A", background: "transparent",
  padding: "2px 0", boxSizing: "border-box", cursor: "pointer", appearance: "none",
};

// Work-type dropdown (for non-material lines)
function WorkTypeSelect({ line, workTypes, onPick, onCreate }: {
  line: any;
  workTypes: any[];
  onPick: (wt: any | null) => void;
  onCreate: (name: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  if (adding) {
    return (
      <input
        autoFocus value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { const t = val.trim(); if (t) onCreate(t); setAdding(false); setVal(""); }}
        onKeyDown={e => { if (e.key === "Enter") { const t = val.trim(); if (t) onCreate(t); setAdding(false); setVal(""); } if (e.key === "Escape") { setAdding(false); setVal(""); } }}
        placeholder="Новый вид работ"
        style={{ ...selectStyle, borderBottom: "1px solid #E8592A", cursor: "text", fontSize: 12 }}
      />
    );
  }
  return (
    <select
      value={line.work_type_id || ""}
      onChange={e => {
        const v = e.target.value;
        if (v === "__add__") { setAdding(true); return; }
        onPick(workTypes.find((w: any) => w.id === v) || null);
      }}
      style={{ ...selectStyle, fontSize: 12, color: line.work_type_id ? "#1A1A1A" : "#C8C0B0" }}
    >
      <option value="">— работа —</option>
      {workTypes.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
      <option value="__add__">+ Добавить вид работ…</option>
    </select>
  );
}

const UNIT_OPTIONS = ["шт", "м.п.", "м²", "м³", "кг", "л", "компл.", "услуга", "ч"];

// Unit dropdown — preset units + custom
function UnitSelect({ line, onSave }: {
  line: any;
  onSave: (unit: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  const current = line.unit || "шт";
  const isCustom = !UNIT_OPTIONS.includes(current);
  if (adding) {
    return (
      <input
        autoFocus value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { const t = val.trim(); if (t) onSave(t); setAdding(false); setVal(""); }}
        onKeyDown={e => { if (e.key === "Enter") { const t = val.trim(); if (t) onSave(t); setAdding(false); setVal(""); } if (e.key === "Escape") { setAdding(false); setVal(""); } }}
        placeholder="ед."
        style={{ ...selectStyle, borderBottom: "1px solid #E8592A", cursor: "text" }}
      />
    );
  }
  return (
    <select
      value={isCustom ? "__custom__" : current}
      onChange={e => {
        const v = e.target.value;
        if (v === "__add__") { setAdding(true); return; }
        if (v === "__custom__") return;
        onSave(v);
      }}
      style={{ ...selectStyle, color: "#6B6355" }}
    >
      {isCustom && <option value="__custom__">{current}</option>}
      {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
      <option value="__add__">+ своя…</option>
    </select>
  );
}

// Contractor dropdown — sectioned by work type, with add
function ContractorSelect({ line, masters, onPickMaster, onCreateMaster }: {
  line: any;
  masters: any[];
  onPickMaster: (masterId: string) => void;
  onCreateMaster: (name: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  const wtId = line.work_type_id;
  const linked = wtId ? masters.filter((m: any) => (m.work_type_ids || []).includes(wtId)) : [];
  const linkedIds = new Set(linked.map((m: any) => m.id));
  const others = masters.filter((m: any) => !linkedIds.has(m.id));

  if (adding) {
    return (
      <input
        autoFocus value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { const t = val.trim(); if (t) onCreateMaster(t); setAdding(false); setVal(""); }}
        onKeyDown={e => { if (e.key === "Enter") { const t = val.trim(); if (t) onCreateMaster(t); setAdding(false); setVal(""); } if (e.key === "Escape") { setAdding(false); setVal(""); } }}
        placeholder="Новый исполнитель"
        style={{ ...selectStyle, borderBottom: "1px solid #E8592A", cursor: "text", fontSize: 10 }}
      />
    );
  }
  return (
    <select
      value={line.master_id || ""}
      onChange={e => {
        const v = e.target.value;
        if (v === "__add__") { setAdding(true); return; }
        if (v) onPickMaster(v);
      }}
      style={{ ...selectStyle, fontSize: 10, color: line.master_id ? "#1A1A1A" : "#C8C0B0" }}
    >
      <option value="">— исполнитель —</option>
      {linked.length > 0 && (
        <optgroup label="По этому виду работ">
          {linked.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </optgroup>
      )}
      <optgroup label={linked.length > 0 ? "Все исполнители" : "Исполнители"}>
        {others.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </optgroup>
      <option value="__add__">+ Добавить исполнителя…</option>
    </select>
  );
}

function ItemModal({ item, onClose, onRefetch }: {
  item: any;
  onClose: () => void;
  onRefetch: () => void;
}) {
  const lines: any[] = item.lines ?? [];
  const gridCols = "20px 1fr 52px 68px 88px 80px 130px 24px";
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const [masters, setMasters] = useState<any[]>([]);
  const [workTypes, setWorkTypes] = useState<any[]>([]);

  const reloadMasters = () =>
    mastersApi.list().then((data: any) => setMasters(Array.isArray(data) ? data : (data?.masters ?? [])));

  useEffect(() => {
    reloadMasters();
    workTypesApi.list().then((data: any) => setWorkTypes(Array.isArray(data) ? data : []));
  }, []);

  const save = (fn: () => Promise<any>) => fn().then(onRefetch);

  // Create a new work type, then assign it to the line
  const createWorkType = async (line: any, name: string) => {
    const wt = await workTypesApi.create(name);
    setWorkTypes(prev => prev.find((w: any) => w.id === wt.id) ? prev : [...prev, wt]);
    await save(() => estimatesApi.updateLine(line.id, { work_type_id: wt.id }));
  };

  // Create a new master (linked to line's work type), then assign to the line
  const createMaster = async (line: any, name: string) => {
    const m = await mastersApi.create({ name, role: "Мастер", work_type_id: line.work_type_id || undefined });
    await reloadMasters();
    await save(() => estimatesApi.updateLine(line.id, { master_id: m.id, contractor_name: m.name }));
  };

  // Pick existing master for a line
  const pickMaster = async (line: any, masterId: string) => {
    const m = masters.find((x: any) => x.id === masterId);
    await save(() => estimatesApi.updateLine(line.id, { master_id: masterId, contractor_name: m?.name || "" }));
    reloadMasters(); // refresh in case backend auto-linked master↔work_type
  };

  useEffect(() => {
    if (lines.length === 0) {
      estimatesApi.addLine(item.id, { type: "material", title: "", qty: 1, unit: "шт", unit_price: 0 }).then(onRefetch);
    }
  }, []);

  const handleSyncToCatalog = async () => {
    setSyncing(true);
    try {
      await estimatesApi.syncToCatalog(item.id);
      await onRefetch();
      setSynced(true);
      setTimeout(() => setSynced(false), 2000);
    } finally {
      setSyncing(false);
    }
  };

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
          {/* Brand selector */}
          <div style={{ display: "flex", gap: 4 }}>
            {BRANDS.map(b => (
              <button
                key={b.value}
                onClick={() => save(() => estimatesApi.updateItem(item.id, { brand: item.brand === b.value ? null : b.value }))}
                style={{
                  padding: "2px 8px", fontSize: 10, cursor: "pointer", fontWeight: 600,
                  border: `1px solid ${item.brand === b.value ? b.color : "#EDEBE6"}`,
                  background: item.brand === b.value ? b.color : "transparent",
                  color: item.brand === b.value ? "#FFFFFF" : "#A89070",
                }}
              >{b.value}</button>
            ))}
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
          {["", "Наименование", "Ед.", "Кол-во", "Цена", "Итого", "Исполнитель", ""].map((h, i) => (
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
                  {line.type === "material" ? (
                    <EditCell
                      value={line.title}
                      placeholder="Название"
                      onSave={v => save(() => estimatesApi.updateLine(line.id, { title: v }))}
                    />
                  ) : (
                    <WorkTypeSelect
                      line={line}
                      workTypes={workTypes}
                      onPick={wt => save(() => estimatesApi.updateLine(line.id, { work_type_id: wt?.id }))}
                      onCreate={name => createWorkType(line, name)}
                    />
                  )}
                </div>
                <div style={{ fontSize: 11, color: "#6B6355" }}>
                  <UnitSelect
                    line={line}
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
                <ContractorSelect
                  line={line}
                  masters={masters}
                  onPickMaster={mid => pickMaster(line, mid)}
                  onCreateMaster={name => createMaster(line, name)}
                />
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

        {/* Modal footer: totals + catalog save */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #EDEBE6", background: "#FAF8F5", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button
            onClick={handleSyncToCatalog}
            disabled={syncing}
            style={{
              fontSize: 11, fontWeight: 600, cursor: syncing ? "default" : "pointer",
              border: `1px solid ${synced ? "#4A7C59" : "#EDEBE6"}`,
              background: synced ? "#4A7C59" : "transparent",
              color: synced ? "#FFFFFF" : syncing ? "#C8C0B0" : "#6B6355",
              padding: "4px 10px", display: "flex", alignItems: "center", gap: 4,
            }}
            onMouseEnter={e => { if (!syncing && !synced) (e.currentTarget as HTMLElement).style.borderColor = "#1A1A1A"; }}
            onMouseLeave={e => { if (!synced) (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; }}
          >
            <Package size={11} />
            {synced ? "Сохранено ✓" : item.catalog_item_id ? "Обновить в каталоге" : "Сохранить в каталог"}
          </button>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 2 }}>СЕБЕСТОИМОСТЬ 1 ШТ</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#6B6355" }}>
              {fmt(lines.reduce((s: number, l: any) => s + (l.line_total || 0), 0))}
            </div>
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
      <div />
      <div>
        <div style={{ fontSize: 11, color: "#A89070" }}>{label}</div>
        {note && <div style={{ fontSize: 10, color: "#C8C0B0", marginTop: 1 }}>{note}</div>}
      </div>
      <div /><div />
      <div />
      <div style={{ fontSize: 12, color: "#6B6355", textAlign: "right" }}>{cost ?? ""}</div>
      <div />
      <div />
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
  const [obligating, setObligating] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  const [editingSetId, setEditingSetId] = useState<string | null>(null);
  const [editingSetName, setEditingSetName] = useState("");
  const [confirmDeleteSet, setConfirmDeleteSet] = useState(false);
  const blocker = useNavigationGuard(editMode);

  const switchSet = (id: string) => {
    if (editMode && id !== activeSetId) {
      setPendingSwitchId(id);
    } else {
      setSelectedSetId(id);
    }
  };

  const { data: order } = useQuery({
    queryKey: ["order-detail-v2", orderId],
    queryFn: () => ordersApi.get(orderId!),
    enabled: !!orderId,
  });

  const { data: sets = [], refetch, isLoading: setsLoading } = useQuery({
    queryKey: ["estimate", orderId],
    queryFn: () => ordersApi.estimate(orderId!),
    enabled: !!orderId,
  });

  // After creating a new order (?new=1): jump straight into a fresh estimate
  const autoNewRef = useRef(false);
  useEffect(() => {
    if (searchParams.get("new") !== "1" || setsLoading || autoNewRef.current) return;
    autoNewRef.current = true;
    (async () => {
      if ((sets as any[]).length === 0) {
        const s = await estimatesApi.createSet(orderId!);
        setSelectedSetId(s.id);
        setEditMode(true);
        refetch();
      } else {
        setSelectedSetId((sets as any[])[0].id);
        setEditMode(true);
      }
      navigate(`/orders/${orderId}/estimate`, { replace: true });
    })();
  }, [sets, setsLoading]);

  const activeSetId = selectedSetId ?? ((sets as any[])[0]?.id ?? null);
  const activeSet   = (sets as any[]).find((s: any) => s.id === activeSetId) ?? null;
  const items: any[] = activeSet?.items ?? [];
  const openItem    = items.find((it: any) => it.id === openItemId) ?? null;

  const totalCost   = items.reduce((s: number, it: any) => s + (it.cost_total || 0), 0);
  const totalSale   = items.reduce((s: number, it: any) => s + (it.sale_price || 0), 0);
  const totalDelta  = totalSale - totalCost;
  const totalQty    = items.reduce((s: number, it: any) => s + (it.quantity || 1), 0);
  const totalFact   = items.reduce((s: number, it: any) => s + (it.actual_paid || 0), 0);
  const avgMarkup   = totalCost > 0 ? totalSale / totalCost : 0;
  const bankPct    = activeSet?.bank_pct ?? 13;
  const isBank     = activeSet?.payment_type === "bank";
  const clientPriceForItem = (it: any) =>
    isBank ? Math.round((it.sale_price || 0) * (1 + (it.bank_pct ?? bankPct) / 100)) : (it.sale_price || 0);
  const totalClient  = items.reduce((s: number, it: any) => s + clientPriceForItem(it), 0);
  const grandTotal   = isBank ? totalClient : totalSale;
  const taxes        = isBank ? Math.round(grandTotal * 0.06) : 0;

  const createSet = async () => {
    const s = await estimatesApi.createSet(orderId!);
    setSelectedSetId(s.id);
    setEditMode(true);
    refetch();
  };

  const updateSet = async (data: any) => {
    if (!activeSetId) return;
    await estimatesApi.updateSet(activeSetId, data);
    refetch();
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

  const hasObligations = items.some((it: any) => (it.obligations_count ?? 0) > 0);

  const createObligations = async () => {
    if (!activeSetId) return;
    setObligating(true);
    try {
      await estimatesApi.createObligations(activeSetId);
      refetch();
    } finally {
      setObligating(false);
    }
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

  const colsMain = "20px 1fr 56px 70px 90px 100px 100px 90px 100px 80px 44px";

  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  return (
    <>
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* ─ Header ─────────────────────────────────────────────────────────── */}
      <div style={{ padding: "0 16px 0 28px", borderBottom: "1px solid #EDEBE6", display: "flex", alignItems: "center", gap: 8, flexShrink: 0, height: 46 }}>

        {/* Left fixed: back + add item + order title */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button
            onClick={() => navigate("/orders")}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", display: "flex", alignItems: "center", gap: 4, fontSize: 12, padding: 0 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
          >
            <ArrowLeft size={13} /> Заказы
          </button>

          <span style={{ color: "#EDEBE6" }}>·</span>
          <button
            onClick={() => navigate(`/orders/${orderId}`)}
            title="Открыть сводку по заказу"
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 13, fontWeight: 500, color: "#1A1A1A", whiteSpace: "nowrap", fontFamily: "inherit", borderBottom: "1px solid transparent" }}
            onMouseEnter={e => { e.currentTarget.style.color = "#E8592A"; e.currentTarget.style.borderBottomColor = "#E8592A"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "#1A1A1A"; e.currentTarget.style.borderBottomColor = "transparent"; }}
          >
            {order?.title ?? orderId}
          </button>
        </div>

        {/* Middle scrollable: estimate tabs */}
        {activeSet && (
          <div style={{ flex: 1, minWidth: 0, overflow: "hidden", position: "relative" }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 4,
              overflowX: "auto", padding: "8px 4px",
              scrollbarWidth: "none",
            }}>
              <span style={{ color: "#EDEBE6", flexShrink: 0 }}>·</span>
              {(sets as any[]).map((s: any, i: number) => {
                const isActive = activeSetId === s.id;
                const label = s.title || `Смета ${i + 1}`;
                return (
                  <div
                    key={s.id}
                    style={{
                      display: "inline-flex", alignItems: "center", flexShrink: 0,
                      border: "1px solid",
                      borderColor: isActive ? "#E8592A" : "#EDEBE6",
                      background: isActive ? "#FFF3EF" : "transparent",
                    }}
                  >
                    {editingSetId === s.id ? (
                      <input
                        autoFocus
                        value={editingSetName}
                        onChange={e => setEditingSetName(e.target.value)}
                        onBlur={async () => {
                          const name = editingSetName.trim();
                          await estimatesApi.updateSet(s.id, { title: name || null });
                          refetch();
                          setEditingSetId(null);
                        }}
                        onKeyDown={async e => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setEditingSetId(null);
                        }}
                        style={{
                          border: "none", outline: "none", background: "transparent",
                          fontSize: 11, color: "#E8592A", fontFamily: "inherit",
                          padding: "3px 8px", width: Math.max(60, editingSetName.length * 7 + 20),
                        }}
                      />
                    ) : (
                      <>
                        <button
                          onClick={() => isActive
                            ? (setEditingSetId(s.id), setEditingSetName(s.title || ""))
                            : switchSet(s.id)
                          }
                          title={isActive ? "Нажмите для переименования" : undefined}
                          style={{
                            padding: editMode && isActive ? "3px 4px 3px 8px" : "3px 8px",
                            fontSize: 11, cursor: "pointer",
                            border: "none", background: "transparent",
                            color: isActive ? "#E8592A" : "#A89070",
                            whiteSpace: "nowrap",
                          }}
                        >{label}</button>
                        {editMode && isActive && (
                          <button
                            onClick={() => setConfirmDeleteSet(true)}
                            title="Удалить смету"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: "2px 6px 2px 0", display: "flex", alignItems: "center", fontSize: 14, lineHeight: 1 }}
                            onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                            onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}
                          >×</button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              <button
                onClick={createSet}
                title="Новая смета"
                style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", display: "flex", alignItems: "center", padding: "2px 4px", fontSize: 18, lineHeight: 1, flexShrink: 0 }}
                onMouseEnter={e => (e.currentTarget.style.color = "#E8592A")}
                onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
              >+</button>
            </div>
          </div>
        )}

        {/* Right fixed: controls */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, marginLeft: activeSet ? 0 : "auto" }}>
          {activeSet ? (
            <>
              {/* Нал/Безнал — только в режиме редактирования */}
              <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
                {[{ v: "cash", l: "Нал" }, { v: "bank", l: "Безнал" }].map(pt => (
                  <button
                    key={pt.v}
                    onClick={() => editMode && updateSet({ payment_type: pt.v })}
                    style={{
                      padding: "4px 10px", fontSize: 11,
                      cursor: editMode ? "pointer" : "default",
                      border: "1px solid",
                      borderColor: activeSet.payment_type === pt.v ? "#1A1A1A" : "#EDEBE6",
                      background: activeSet.payment_type === pt.v ? "#1A1A1A" : "transparent",
                      color: activeSet.payment_type === pt.v ? "#FFFFFF" : "#A89070",
                      marginRight: -1,
                    }}
                  >{pt.l}</button>
                ))}
              </div>

              {/* Банк % */}
              {isBank && (
                <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <span style={{ fontSize: 11, color: "#A89070" }}>Банк</span>
                  {editMode ? (
                    <input
                      key={activeSet.bank_pct}
                      defaultValue={activeSet.bank_pct ?? 13}
                      onBlur={e => updateSet({ bank_pct: parseFloat(e.target.value) || 13 })}
                      style={{ width: 30, border: "1px solid #EDEBE6", background: "transparent", fontSize: 11, textAlign: "center", padding: "3px 2px", outline: "none" }}
                    />
                  ) : (
                    <span style={{ fontSize: 11, color: "#A89070" }}>{bankPct}%</span>
                  )}
                </div>
              )}

              <div style={{ width: 1, height: 18, background: "#EDEBE6", margin: "0 2px" }} />

              {/* Согласовать */}
              <button
                onClick={() => updateSet({ status: activeSet.status === "approved" ? "draft" : "approved" })}
                title={activeSet.status === "approved" ? "Снять согласование" : "Согласовать"}
                style={{
                  width: 28, height: 28, padding: 0, border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: activeSet.status === "approved" ? "#4A7C59" : "#E8592A",
                  color: "#FFFFFF",
                }}
              >
                {activeSet.status === "approved" ? <CheckCircle size={16} weight="bold" /> : <Circle size={16} weight="bold" />}
              </button>

              {/* Обязательства */}
              <button
                onClick={activeSet.status !== "approved" ? undefined : hasObligations ? () => setConfirmRevert(true) : createObligations}
                disabled={obligating || activeSet.status !== "approved"}
                title={activeSet.status !== "approved" ? "Доступно после согласования" : hasObligations ? "Обязательства созданы (нажмите для отмены)" : "Создать обязательства"}
                style={{
                  width: 28, height: 28, padding: 0, cursor: activeSet.status !== "approved" || obligating ? "default" : "pointer",
                  border: "1px solid",
                  borderColor: hasObligations ? "#4A7C59" : "#EDEBE6",
                  background: "transparent",
                  color: hasObligations ? "#4A7C59" : activeSet.status !== "approved" ? "#D0C8C0" : "#6B6355",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
                onMouseEnter={e => { if (activeSet.status === "approved" && !obligating) (e.currentTarget as HTMLElement).style.borderColor = hasObligations ? "#4A7C59" : "#1A1A1A"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = hasObligations ? "#4A7C59" : "#EDEBE6"; }}
              >
                <ListChecks size={16} weight={hasObligations ? "bold" : "regular"} />
              </button>

              {/* Счёт */}
              <button
                onClick={generateInvoice}
                disabled={invoicing}
                title="Сгенерировать счёт"
                style={{
                  width: 28, height: 28, padding: 0, cursor: invoicing ? "default" : "pointer",
                  border: "1px solid #EDEBE6", background: "transparent",
                  color: invoicing ? "#C8C0B0" : "#6B6355",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
                onMouseEnter={e => { if (!invoicing) { (e.currentTarget as HTMLElement).style.borderColor = "#1A1A1A"; (e.currentTarget as HTMLElement).style.color = "#1A1A1A"; } }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; (e.currentTarget as HTMLElement).style.color = invoicing ? "#C8C0B0" : "#6B6355"; }}
              >
                <FileText size={16} />
              </button>

              <div style={{ width: 1, height: 18, background: "#EDEBE6", margin: "0 2px" }} />

              {/* Редактировать / Сохранить */}
              {editMode ? (
                <button
                  onClick={() => setEditMode(false)}
                  title="Сохранить"
                  style={{ width: 28, height: 28, padding: 0, border: "none", background: "#4A7C59", color: "#FFFFFF", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <FloppyDisk size={16} />
                </button>
              ) : (
                <button
                  onClick={() => setEditMode(true)}
                  title="Редактировать"
                  style={{ width: 28, height: 28, padding: 0, border: "1px solid #EDEBE6", background: "transparent", color: "#6B6355", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#1A1A1A"; (e.currentTarget as HTMLElement).style.borderColor = "#1A1A1A"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "#6B6355"; (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; }}
                >
                  <PencilSimple size={16} />
                </button>
              )}
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
          {/* ─ Metadata strip ─────────────────────────────────────────────── */}
          {activeSet && (() => {
            const fmtSetDate = (iso: string) => {
              if (!iso) return "—";
              const d = new Date(iso);
              const now = new Date();
              const isToday = d.toDateString() === now.toDateString();
              const isThisYear = d.getFullYear() === now.getFullYear();
              const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
              const day = d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", ...(!isThisYear ? { year: "numeric" } : {}) });
              return isToday ? `сегодня в ${time}` : `${day} в ${time}`;
            };
            return (
              <div style={{ padding: "4px 28px", display: "flex", gap: 16, flexShrink: 0, borderBottom: "1px solid #F2EFE9" }}>
                <span style={{ fontSize: 10, color: "#C8C0B0" }}>
                  Создана: <span style={{ color: "#A89070" }}>{fmtSetDate(activeSet.created_at)}</span>
                </span>
                <span style={{ fontSize: 10, color: "#C8C0B0" }}>
                  Изменена: <span style={{ color: "#A89070" }}>{fmtSetDate(activeSet.updated_at)}</span>
                </span>
              </div>
            );
          })()}

          {/* ─ Table: horizontally scrollable, vertically flex ───────────── */}
          <div style={{ flex: 1, overflowX: "auto", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ minWidth: 1020, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>

          {/* ─ Column headers ─────────────────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: colsMain, padding: "7px 28px", gap: 12, borderBottom: "1px solid #EDEBE6", flexShrink: 0 }}>
            {["", "Позиция", "Кол-во", "Наценка", "Себест./шт", "Себест.", "Факт", isBank ? "К опл./шт" : "Клиент./шт", isBank ? "К оплате" : "Клиенту", "Δ Доход", ""].map((h, i) => (
              <div key={i} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", textAlign: i >= 4 ? "right" : "left" }}>{h}</div>
            ))}
          </div>

          {/* ─ Item rows ──────────────────────────────────────────────────── */}
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {items.length === 0 && (
              <div style={{ padding: "48px 28px", textAlign: "center", color: "#C8C0B0", fontSize: 13 }}>
                Добавьте позиции в смету
              </div>
            )}

            {items.map((item: any, idx: number) => (
              <div
                key={item.id}
                draggable={editMode}
                onDragStart={() => { setDragIdx(idx); setDragOverIdx(idx); }}
                onDragEnter={() => setDragOverIdx(idx)}
                onDragOver={e => e.preventDefault()}
                onDragEnd={() => {
                  if (dragIdx !== null && dragOverIdx !== null && dragIdx !== dragOverIdx) {
                    const reordered = [...items];
                    const [moved] = reordered.splice(dragIdx, 1);
                    reordered.splice(dragOverIdx, 0, moved);
                    reordered.forEach((it, i) => {
                      estimatesApi.updateItem(it.id, { sort_order: i });
                    });
                    setTimeout(() => refetch(), 300);
                  }
                  setDragIdx(null);
                  setDragOverIdx(null);
                }}
                style={{
                  display: "grid", gridTemplateColumns: colsMain,
                  padding: "11px 28px", gap: 12,
                  borderBottom: "1px solid #F2EFE9",
                  alignItems: "center",
                  opacity: dragIdx === idx && dragOverIdx !== idx ? 0.4 : 1,
                  background: dragOverIdx === idx && dragIdx !== idx ? "#F5F2EC" : "transparent",
                  cursor: editMode ? "grab" : "default",
                }}
                onMouseEnter={e => { if (dragIdx === null) e.currentTarget.style.background = "#FAF8F5"; }}
                onMouseLeave={e => { if (dragIdx === null) e.currentTarget.style.background = "transparent"; }}
              >
                {/* Row number / drag handle */}
                <div style={{ fontSize: 10, color: "#C8C0B0", userSelect: "none", display: "flex", alignItems: "center" }}>
                  {editMode
                    ? <DotsSixVertical size={13} style={{ color: "#C8C0B0", cursor: "grab" }} />
                    : <span>{idx + 1}</span>}
                </div>

                {/* Title */}
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }} onClick={e => e.stopPropagation()}>
                  {editMode ? (
                    <EditCell
                      value={item.title}
                      placeholder="Без названия"
                      onSave={v => estimatesApi.updateItem(item.id, { title: v }).then(() => refetch())}
                    />
                  ) : (
                    item.title || <span style={{ color: "#C8C0B0" }}>Без названия</span>
                  )}
                </div>

                {/* Qty — правка сохраняет пер-юнит (итоги масштабируются) */}
                <div style={{ fontSize: 13, color: "#1A1A1A", fontWeight: 500 }}>
                  {editMode ? (
                    <EditCell
                      value={item.quantity ?? 1}
                      numeric
                      onSave={v => {
                        const oldQty = item.quantity || 1;
                        const newQty = parseInt(v) || 1;
                        const costUnit = (item.cost_total || 0) / oldQty;
                        const saleUnit = (item.sale_price || 0) / oldQty;
                        const payload: any = { quantity: newQty, sale_price: Math.round(saleUnit * newQty) };
                        if ((item.lines?.length ?? 0) === 0) payload.cost_total = Math.round(costUnit * newQty);
                        estimatesApi.updateItem(item.id, payload).then(() => refetch());
                      }}
                    />
                  ) : (
                    item.quantity ?? 1
                  )}
                </div>

                {/* Markup — задаёт цену: sale = cost × markup */}
                <div style={{ fontSize: 12, color: "#6B6355" }}>
                  {editMode ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                      ×<EditCell
                        value={item.markup ?? 2}
                        numeric
                        onSave={v => {
                          const markup = parseFloat(v) || 1;
                          const cost = item.cost_total || 0;
                          const payload: any = { markup };
                          if (cost > 0) payload.sale_price = Math.round(cost * markup);
                          estimatesApi.updateItem(item.id, payload).then(() => refetch());
                        }}
                      />
                    </span>
                  ) : (
                    `×${item.markup ?? 2}`
                  )}
                </div>

                {/* Себест./шт — редактируемо у всех позиций (итог пересчитывается) */}
                {(() => {
                  const qty = item.quantity || 1;
                  const costUnit = Math.round((item.cost_total || 0) / qty);
                  if (editMode) {
                    return (
                      <div style={{ fontSize: 11, color: "#6B6355", textAlign: "right" }}>
                        <EditCell
                          value={costUnit}
                          numeric
                          display={costUnit > 0 ? fmt(costUnit) : "—"}
                          style={{ textAlign: "right" }}
                          onSave={v => {
                            const newCostUnit = parseFloat(v) || 0;
                            const cost_total = Math.round(newCostUnit * qty);
                            const payload: any = { cost_total };
                            if (cost_total > 0) payload.markup = Math.round((item.sale_price || 0) / cost_total * 1000) / 1000;
                            estimatesApi.updateItem(item.id, payload).then(() => refetch());
                          }}
                        />
                      </div>
                    );
                  }
                  return (
                    <div style={{ fontSize: 11, color: "#A89070", textAlign: "right" }}>
                      {qty > 1 && costUnit > 0 ? fmt(costUnit) : <span style={{ color: "#EDEBE6" }}>—</span>}
                    </div>
                  );
                })()}

                {/* Себест. итого — read-only (вычисляется) */}
                <div style={{ fontSize: 13, color: "#6B6355", textAlign: "right" }}>
                  {fmt(item.cost_total)}
                </div>

                {/* Факт */}
                <div style={{ fontSize: 12, textAlign: "right" }}>
                  {(item.actual_paid ?? 0) > 0 ? (
                    <>
                      <div style={{ color: (item.actual_paid ?? 0) > (item.cost_total || 0) ? "#8B3A3A" : "#4A7C59", fontWeight: 600 }}>
                        {fmt(item.actual_paid)}
                      </div>
                      <div style={{ fontSize: 9, color: (item.actual_paid ?? 0) > (item.cost_total || 0) ? "#8B3A3A" : "#4A7C59", marginTop: 1 }}>
                        {(item.actual_paid ?? 0) > (item.cost_total || 0) ? "+" : ""}{fmt((item.actual_paid ?? 0) - (item.cost_total || 0))}
                      </div>
                    </>
                  ) : (item.obligations_count ?? 0) > 0 ? (
                    <span style={{ color: "#C8C0B0", fontSize: 11 }}>0 ₽</span>
                  ) : (
                    <span style={{ color: "#C8C0B0" }}>—</span>
                  )}
                </div>

                {/* К опл./шт — редактируемо (цена клиенту за штуку) */}
                {(() => {
                  const qty = item.quantity || 1;
                  const priceUnit = Math.round(clientPriceForItem(item) / qty);
                  if (editMode) {
                    return (
                      <div style={{ fontSize: 11, color: isBank ? "#E8592A" : "#6B6355", textAlign: "right" }}>
                        <EditCell
                          value={priceUnit}
                          numeric
                          display={priceUnit > 0 ? fmt(priceUnit) : "—"}
                          style={{ textAlign: "right", color: isBank ? "#E8592A" : "#1A1A1A" }}
                          onSave={v => {
                            const newPriceUnit = parseFloat(v) || 0;
                            const clientTotal = newPriceUnit * qty;
                            const sale_new = isBank
                              ? Math.round(clientTotal / (1 + (item.bank_pct ?? bankPct) / 100))
                              : Math.round(clientTotal);
                            const cost = item.cost_total || 0;
                            const payload: any = { sale_price: sale_new };
                            if (cost > 0) payload.markup = Math.round(sale_new / cost * 1000) / 1000;
                            estimatesApi.updateItem(item.id, payload).then(() => refetch());
                          }}
                        />
                      </div>
                    );
                  }
                  return (
                    <div style={{ fontSize: 11, color: isBank ? "#E8592A" : "#A89070", textAlign: "right", opacity: 0.7 }}>
                      {qty > 1 && priceUnit > 0 ? fmt(priceUnit) : <span style={{ color: "#EDEBE6" }}>—</span>}
                    </div>
                  );
                })()}

                {/* К оплате итого — read-only (вычисляется = К опл./шт × кол-во) */}
                <div style={{ fontSize: 13, fontWeight: 700, textAlign: "right", color: isBank ? "#E8592A" : "#1A1A1A" }}>
                  {fmt(clientPriceForItem(item))}
                </div>

                {/* Col 6: Δ Доход */}
                <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", textAlign: "right" }}>
                  {(() => { const d = clientPriceForItem(item) - (item.cost_total || 0); return (d >= 0 ? "+" : "") + fmt(d); })()}
                </div>

                {/* Actions: open calculator + (edit mode) delete */}
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
                  {editMode && (
                    <button
                      onClick={e => { e.stopPropagation(); estimatesApi.deleteItem(item.id).then(() => refetch()); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#D0C8C0", padding: 2, display: "flex" }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                      onMouseLeave={e => (e.currentTarget.style.color = "#D0C8C0")}
                    >
                      <Trash size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}

            {/* Add row — visible in edit mode */}
            {editMode && <div style={{ padding: "10px 28px", display: "flex", gap: 10 }}>
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
            </div>}
          </div>

          {/* ─ Footer totals ──────────────────────────────────────────────── */}
          <div style={{ flexShrink: 0, borderTop: "1px solid #EDEBE6" }}>

            {/* Итого — все колонки */}
            <div style={{ display: "grid", gridTemplateColumns: colsMain, padding: "7px 28px", gap: 12, alignItems: "center", borderBottom: "1px solid #F2EFE9" }}>
              <div />
              <div style={{ fontSize: 11, color: "#A89070" }}>Итого</div>
              <div style={{ fontSize: 12, color: "#6B6355" }}>{totalQty}</div>
              <div style={{ fontSize: 12, color: "#6B6355" }}>×{avgMarkup.toFixed(2)}</div>
              <div style={{ fontSize: 11, color: "#A89070", textAlign: "right" }}>{totalQty > 1 ? fmt(Math.round(totalCost / totalQty)) : "—"}</div>
              <div style={{ fontSize: 12, color: "#6B6355", textAlign: "right" }}>{fmt(totalCost)}</div>
              <div style={{ fontSize: 12, color: totalFact > totalCost ? "#8B3A3A" : totalFact > 0 ? "#4A7C59" : "#C8C0B0", textAlign: "right" }}>
                {totalFact > 0 ? fmt(totalFact) : <span style={{ fontSize: 11 }}>0 ₽</span>}
              </div>
              <div style={{ fontSize: 11, color: isBank ? "#E8592A" : "#A89070", textAlign: "right", opacity: 0.7 }}>{totalQty > 1 ? fmt(Math.round((isBank ? totalClient : totalSale) / totalQty)) : "—"}</div>
              <div style={{ fontSize: 13, fontWeight: 500, textAlign: "right" }}>{fmt(isBank ? totalClient : totalSale)}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#4A7C59", textAlign: "right" }}>+{fmt(isBank ? totalClient - totalCost : totalDelta)}</div>
              <div />
            </div>

            {isBank && (
              <FooterRow cols={colsMain} label="Налоги УСН 6%"
                sale={`−${fmt(taxes)}`} saleColor="#8B3A3A" />
            )}

            <div style={{
              display: "grid", gridTemplateColumns: colsMain,
              padding: "10px 28px", gap: 12, alignItems: "center",
              background: "#FAF8F5", borderTop: "1px solid #EDEBE6",
            }}>
              <div />
              <div style={{ fontSize: 12, color: "#A89070", fontWeight: 500 }}>К оплате</div>
              <div /><div />
              <div />
              <div style={{ fontSize: 12, color: "#6B6355", textAlign: "right" }}>{fmt(totalCost)}</div>
              <div />
              <div />
              <div style={{ fontSize: 15, fontWeight: 700, color: isBank ? "#E8592A" : "#1A1A1A", textAlign: "right" }}>{fmt(grandTotal)}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", textAlign: "right" }}>
                {isBank ? `+${fmt(grandTotal - totalCost - taxes)}` : `+${fmt(totalDelta)}`}
              </div>
              <div />
            </div>
          </div>
          </div>{/* end minWidth wrapper */}
          </div>{/* end overflowX:auto wrapper */}
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
    <NavigationGuardModal blocker={blocker} />

    {/* Confirm delete estimate set */}
    {confirmDeleteSet && (
      <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ background: "#FFF", width: 380, padding: "28px 32px", boxShadow: "0 8px 40px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A", marginBottom: 8, letterSpacing: "-0.02em" }}>
            Удалить смету?
          </div>
          <div style={{ fontSize: 13, color: "#6B6355", marginBottom: 24, lineHeight: 1.6 }}>
            Смета «{activeSet?.title || `Смета ${(sets as any[]).findIndex((s: any) => s.id === activeSetId) + 1}`}» и все её позиции будут удалены без возможности восстановления.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={async () => {
                const remaining = (sets as any[]).filter((s: any) => s.id !== activeSetId);
                await estimatesApi.deleteSet(activeSetId!);
                setConfirmDeleteSet(false);
                setEditMode(false);
                setSelectedSetId(remaining[0]?.id ?? null);
                refetch();
              }}
              style={{ flex: 1, background: "#8B3A3A", color: "#FFF", border: "none", padding: "9px 0", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
            >
              Удалить
            </button>
            <button
              onClick={() => setConfirmDeleteSet(false)}
              style={{ flex: 1, background: "none", border: "1px solid #EDEBE6", padding: "9px 0", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: "#1A1A1A", fontWeight: 600 }}
            >
              Отмена
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Confirm revert obligations */}
    {confirmRevert && (
      <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ background: "#FFF", width: 380, padding: "28px 32px", boxShadow: "0 8px 40px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A", marginBottom: 8, letterSpacing: "-0.02em" }}>
            Вернуть обязательства?
          </div>
          <div style={{ fontSize: 13, color: "#6B6355", marginBottom: 24, lineHeight: 1.6 }}>
            Все обязательства, созданные по этой смете, будут удалены. Если по ним уже зафиксированы оплаты — они тоже пропадут.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={async () => {
                setConfirmRevert(false);
                await estimatesApi.deleteObligations(activeSetId!);
                refetch();
              }}
              style={{ flex: 1, background: "#8B3A3A", color: "#FFF", border: "none", padding: "9px 0", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
            >
              Удалить обязательства
            </button>
            <button
              onClick={() => setConfirmRevert(false)}
              style={{ flex: 1, background: "none", border: "1px solid #EDEBE6", padding: "9px 0", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: "#1A1A1A", fontWeight: 600 }}
            >
              Отмена
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Confirm switching estimate while in edit mode */}
    {pendingSwitchId && (
      <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ background: "#FFF", width: 380, padding: "28px 32px", boxShadow: "0 8px 40px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A", marginBottom: 8, letterSpacing: "-0.02em" }}>
            Несохранённые изменения
          </div>
          <div style={{ fontSize: 13, color: "#6B6355", marginBottom: 24, lineHeight: 1.6 }}>
            Если перейти на другую смету сейчас, все незаписанные изменения будут потеряны.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => { setSelectedSetId(pendingSwitchId); setEditMode(false); setPendingSwitchId(null); }}
              style={{ flex: 1, background: "#1A1A1A", color: "#FFF", border: "none", padding: "9px 0", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
            >
              Перейти без сохранения
            </button>
            <button
              onClick={() => setPendingSwitchId(null)}
              style={{ flex: 1, background: "none", border: "1px solid #EDEBE6", padding: "9px 0", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: "#1A1A1A", fontWeight: 600 }}
            >
              Остаться
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
