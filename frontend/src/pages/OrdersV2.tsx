import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { MONO } from "../components/ui/Num";
import { Modal, ConfirmModal } from "../components/ui/Modal";
import { useNavigate } from "react-router-dom";
import { ordersApi, customersApi, brandsApi } from "../api";
import { MagnifyingGlass, DotsThree, Plus, Files, CaretRight, Archive, ArrowCounterClockwise, CaretDown, X, Trash, PencilSimple, UserCircle } from "@phosphor-icons/react";
import { ColumnFilter, AmountFilter } from "../components/TableFilters";

const BRANDS: { value: string; color: string }[] = [
  { value: "MeRA",    color: "#2E6DA4" },
  { value: "pbpb",    color: "#7B4F9E" },
  { value: "Транзит", color: "#3D8C6B" },
];
const BRAND_COLOR: Record<string, string> = Object.fromEntries(BRANDS.map(b => [b.value, b.color]));

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  draft:         { label: "Черновик",       color: "#A89070" },
  estimate:      { label: "Смета",          color: "#E8592A" },
  project:       { label: "Проект",         color: "#E8592A" },
  in_production: { label: "В производстве", color: "#1A1A1A" },
  completed:     { label: "Завершён",       color: "#4A7C59" },
  cancelled:     { label: "Отменён",        color: "#8B3A3A" },
};

const STATUSES = [
  { value: "in_production", label: "В работе" },
  { value: "draft,estimate", label: "Смета" },
  { value: "completed", label: "Завершён" },
];

const PAGE_SIZE = 10;

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

function initials(name: string | undefined) {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const ALL_STATUSES = [
  { value: "draft",         label: "Черновик",        color: "#A89070" },
  { value: "estimate",      label: "Смета",            color: "#E8592A" },
  { value: "project",       label: "Проект",           color: "#E8592A" },
  { value: "in_production", label: "В производстве",   color: "#1A1A1A" },
  { value: "completed",     label: "Завершён",         color: "#4A7C59" },
  { value: "cancelled",     label: "Отменён",          color: "#8B3A3A" },
];

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

function StatusPicker({ orderId, current, onChange }: { orderId: string; current: string; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const st = ALL_STATUSES.find(s => s.value === current) || { label: current, color: "#A89070" };

  const pick = async (value: string) => {
    if (value === current) { setOpen(false); return; }
    setSaving(true);
    try {
      await ordersApi.updateStatus(orderId, value);
      onChange();
    } finally {
      setSaving(false);
      setOpen(false);
    }
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "5px 10px", border: "1px solid #EDEBE6", background: "none",
          fontSize: 11, cursor: "pointer", color: st.color, fontWeight: 600,
        }}
      >
        {saving ? "..." : st.label}
        <CaretDown size={10} style={{ color: "#A89070" }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 2,
          background: "#fff", border: "1px solid #EDEBE6", zIndex: 100,
          boxShadow: "0 4px 16px rgba(0,0,0,0.12)", minWidth: 160,
        }}>
          {ALL_STATUSES.map(s => (
            <div
              key={s.value}
              onClick={() => pick(s.value)}
              style={{
                padding: "8px 14px", fontSize: 12, cursor: "pointer",
                color: s.value === current ? "#1A1A1A" : s.color,
                fontWeight: s.value === current ? 700 : 400,
                background: s.value === current ? "#FAF8F5" : "transparent",
              }}
              onMouseEnter={(e) => { if (s.value !== current) (e.currentTarget as HTMLElement).style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (s.value !== current) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BrandPicker({ orderId, current, onChange }: { orderId: string; current: string | null; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const pick = async (value: string | null) => {
    if (value === current) { setOpen(false); return; }
    setSaving(true);
    try {
      await ordersApi.updateBrand(orderId, value);
      onChange();
    } finally {
      setSaving(false);
      setOpen(false);
    }
  };

  const color = current ? (BRAND_COLOR[current] || "#A89070") : "#A89070";

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "5px 10px", border: `1px solid ${current ? color : "#EDEBE6"}`, background: "none",
          fontSize: 11, cursor: "pointer", color: current ? color : "#A89070", fontWeight: 600,
        }}
      >
        {saving ? "..." : (current || "Бренд")}
        <CaretDown size={10} style={{ color: "#A89070" }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 2,
          background: "#fff", border: "1px solid #EDEBE6", zIndex: 100,
          boxShadow: "0 4px 16px rgba(0,0,0,0.12)", minWidth: 140,
        }}>
          <div
            onClick={() => pick(null)}
            style={{ padding: "8px 14px", fontSize: 12, cursor: "pointer", color: !current ? "#1A1A1A" : "#A89070", fontWeight: !current ? 700 : 400, background: !current ? "#FAF8F5" : "transparent" }}
            onMouseEnter={(e) => { if (current) (e.currentTarget as HTMLElement).style.background = "#FAF8F5"; }}
            onMouseLeave={(e) => { if (current) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            Без бренда
          </div>
          {BRANDS.map(b => (
            <div
              key={b.value}
              onClick={() => pick(b.value)}
              style={{ padding: "8px 14px", fontSize: 12, cursor: "pointer", color: b.value === current ? b.color : "#1A1A1A", fontWeight: b.value === current ? 700 : 400, background: b.value === current ? "#FAF8F5" : "transparent" }}
              onMouseEnter={(e) => { if (b.value !== current) (e.currentTarget as HTMLElement).style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (b.value !== current) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {b.value}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IconBtn({ onClick, children, orange }: { onClick?: () => void; children: React.ReactNode; orange?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 28, height: 28,
        background: orange ? "#E8592A" : "#F2EFE9",
        border: "none",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: orange ? "#FFFFFF" : "#6B6355",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function EstimatesDropdown({ orderId, sets }: { orderId: string; sets: any[] }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const STATUS_LABEL: Record<string, string> = { approved: "Согласована", draft: "Черновик" };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => sets.length === 1 ? navigate(`/orders/${orderId}/estimate?set=${sets[0].id}`) : setOpen(v => !v)}
        style={{ padding: "5px 10px", border: "1px solid #E8592A", background: "transparent", color: "#E8592A", fontSize: 11, cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
      >
        Сметы{sets.length > 0 && <span style={{ fontSize: 10, opacity: 0.8 }}>({sets.length})</span>}
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 300, background: "#fff", border: "1px solid #EDEBE6", boxShadow: "0 4px 16px rgba(0,0,0,0.10)", minWidth: 200 }}>
          {sets.length === 0 ? (
            <div
              onClick={() => { navigate(`/orders/${orderId}/estimate`); setOpen(false); }}
              style={{ padding: "10px 14px", fontSize: 12, color: "#A89070", cursor: "pointer" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
              onMouseLeave={e => (e.currentTarget.style.background = "")}
            >Создать смету...</div>
          ) : sets.map((s: any, i: number) => (
            <div
              key={s.id}
              onClick={() => { navigate(`/orders/${orderId}/estimate?set=${s.id}`); setOpen(false); }}
              style={{ padding: "9px 14px", fontSize: 12, cursor: "pointer", borderBottom: i < sets.length - 1 ? "1px solid #F2EFE9" : "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
              onMouseLeave={e => (e.currentTarget.style.background = "")}
            >
              <span style={{ color: "#1A1A1A", fontWeight: 500 }}>Смета {i + 1}</span>
              <span style={{ fontSize: 10, color: s.status === "approved" ? "#4A7C59" : "#A89070" }}>{STATUS_LABEL[s.status] ?? s.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CUSTOMER_SOURCES = ["Сарафан", "Инстаграм", "Авито", "Сайт", "ВКонтакте", "Выставка", "Прочее"];

function NewOrderModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (orderId: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState("normal");
  const [brand, setBrand] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupMsg, setLookupMsg] = useState("");
  const [newCustomer, setNewCustomer] = useState<Record<string, string>>({
    name: "", inn: "", full_name: "", phone: "", email: "", contact: "",
    telegram: "", instagram: "", whatsapp: "", source: "", notes: "",
  });

  const { data: customers = [] } = useQuery({
    queryKey: ["customers", ""],
    queryFn: () => customersApi.list(""),
  });

  const { data: brandsList = [] } = useQuery({
    queryKey: ["brands"],
    queryFn: brandsApi.list,
  });

  const setNC = (k: string, v: string) => setNewCustomer(prev => ({ ...prev, [k]: v }));

  async function handleInnLookup() {
    const inn = newCustomer.inn.trim();
    if (!inn) return;
    setLookingUp(true);
    setLookupMsg("");
    try {
      const res = await customersApi.lookupInn(inn);
      if (res.found) {
        setNewCustomer(prev => ({
          ...prev,
          name: res.name || prev.name,
          full_name: res.full_name || prev.full_name,
          inn: res.inn || prev.inn,
          contact: res.contact || prev.contact,
          notes: res.notes || prev.notes,
        }));
        setLookupMsg("Найдено ✓");
      } else {
        setLookupMsg("Не найдено");
      }
    } catch {
      setLookupMsg("Ошибка поиска");
    } finally {
      setLookingUp(false);
    }
  }

  async function handleCreateCustomer() {
    if (!newCustomer.name.trim()) { setLookupMsg("Введите название"); return; }
    setCreatingCustomer(true);
    try {
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(newCustomer)) {
        if (v && v.trim()) payload[k] = v.trim();
      }
      const c = await customersApi.create(payload);
      qc.invalidateQueries({ queryKey: ["customers"] });
      setCustomerId(String(c.id));
    } finally {
      setCreatingCustomer(false);
    }
  }

  async function handleSubmit() {
    if (!title.trim()) { setError("Введите название заказа"); return; }
    setSaving(true);
    try {
      const order = await ordersApi.create({
        title: title.trim(),
        customer_id: customerId && customerId !== "__new__" ? customerId : null,
        deadline: deadline || null,
        priority,
        brand: brand || null,
      });
      qc.invalidateQueries({ queryKey: ["orders-v2"] });
      onCreated(order.id);
    } catch {
      setError("Ошибка при создании заказа");
      setSaving(false);
    }
  }

  return (
    <Modal
      size="md"
      eyebrow="НОВЫЙ ЗАКАЗ"
      onClose={onClose}
      onCancel={onClose}
      onSave={handleSubmit}
      saveLabel={saving ? "Создаём..." : "Создать и открыть смету →"}
      saving={saving}
    >
        <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>НАЗВАНИЕ *</div>
            <input autoFocus value={title} onChange={e => { setTitle(e.target.value); setError(""); }}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${error && !title.trim() ? "#E8592A" : "#EDEBE6"}`, padding: "7px 10px", fontSize: 13, outline: "none" }} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>КЛИЕНТ</div>
            <select value={customerId} onChange={e => {
              setCustomerId(e.target.value);
              if (e.target.value !== "__new__") setLookupMsg("");
            }}
              style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", background: "#fff", color: customerId && customerId !== "__new__" ? "#1A1A1A" : "#A89070" }}>
              <option value="">— не выбран —</option>
              {(customers as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new__">+ добавить нового</option>
            </select>
            {customerId === "__new__" && (
              <div style={{ marginTop: 8, border: "1px solid #EDEBE6", padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "#FAF8F5" }}>
                {/* ИНН + поиск */}
                <div>
                  <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ИНН</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      autoFocus
                      placeholder="ИНН — найдём реквизиты"
                      value={newCustomer.inn}
                      onChange={e => setNC("inn", e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") handleInnLookup(); }}
                      style={{ flex: 1, border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 13, outline: "none", boxSizing: "border-box" }}
                    />
                    <button
                      disabled={lookingUp || !newCustomer.inn.trim()}
                      onClick={handleInnLookup}
                      style={{ padding: "6px 12px", border: "1px solid #1A1A1A", background: "#1A1A1A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: lookingUp || !newCustomer.inn.trim() ? 0.5 : 1, whiteSpace: "nowrap" }}>
                      {lookingUp ? "..." : "Найти"}
                    </button>
                  </div>
                  {lookupMsg && <div style={{ fontSize: 10, color: lookupMsg.includes("✓") ? "#4A7C59" : "#8B3A3A", marginTop: 3 }}>{lookupMsg}</div>}
                </div>
                {/* Поля карточки */}
                {[
                  { k: "name", l: "НАЗВАНИЕ *", ph: "ООО «...» или ФИО" },
                  { k: "full_name", l: "ПОЛНОЕ ИМЯ", ph: "" },
                  { k: "contact", l: "КОНТАКТНОЕ ЛИЦО", ph: "" },
                  { k: "phone", l: "ТЕЛЕФОН", ph: "+7..." },
                  { k: "telegram", l: "TELEGRAM", ph: "@username" },
                  { k: "instagram", l: "INSTAGRAM", ph: "@username" },
                  { k: "whatsapp", l: "WHATSAPP", ph: "+7..." },
                  { k: "email", l: "EMAIL", ph: "" },
                ].map(f => (
                  <div key={f.k}>
                    <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>{f.l}</div>
                    <input
                      placeholder={f.ph}
                      value={newCustomer[f.k]}
                      onChange={e => setNC(f.k, e.target.value)}
                      style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 13, outline: "none" }}
                    />
                  </div>
                ))}
                <div>
                  <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ИСТОЧНИК</div>
                  <select value={newCustomer.source} onChange={e => setNC("source", e.target.value)}
                    style={{ width: "100%", border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 13, outline: "none", background: "#fff", color: newCustomer.source ? "#1A1A1A" : "#A89070" }}>
                    <option value="">— не выбран —</option>
                    {CUSTOMER_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <button
                    onClick={() => { setCustomerId(""); }}
                    style={{ padding: "6px 12px", border: "1px solid #EDEBE6", background: "#fff", color: "#6B6355", fontSize: 12, cursor: "pointer" }}>
                    Отмена
                  </button>
                  <button
                    disabled={creatingCustomer || !newCustomer.name.trim()}
                    onClick={handleCreateCustomer}
                    style={{ flex: 1, padding: "6px 12px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: creatingCustomer || !newCustomer.name.trim() ? 0.5 : 1 }}>
                    {creatingCustomer ? "Создаём..." : "Создать клиента"}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ДЕДЛАЙН</div>
              <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ПРИОРИТЕТ</div>
              <select value={priority} onChange={e => setPriority(e.target.value)}
                style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", background: "#fff" }}>
                <option value="low">Низкий</option>
                <option value="normal">Обычный</option>
                <option value="high">Высокий</option>
                <option value="urgent">Срочный</option>
              </select>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>БРЕНД</div>
            <select value={brand} onChange={e => setBrand(e.target.value)}
              style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", background: "#fff", color: brand ? "#1A1A1A" : "#A89070" }}>
              <option value="">— не выбран —</option>
              {(brandsList as any[]).map((b: any) => <option key={b.id} value={b.name}>{b.name}</option>)}
            </select>
          </div>
          {error && <div style={{ fontSize: 11, color: "#8B3A3A" }}>{error}</div>}
        </div>
    </Modal>
  );
}

export default function OrdersV2() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [status, setStatus] = useState("in_production");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [archiveMode, setArchiveMode] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [customerFilter, setCustomerFilter] = useState("");
  const [titleFilter, setTitleFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const clearFilters = () => { setCustomerFilter(""); setTitleFilter(""); setAmountMin(""); setAmountMax(""); setBrandFilter(""); setPage(0); setSelectedIds(new Set()); };
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await ordersApi.delete(id);
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      setConfirmDelete(false);
      if (selected && selectedIds.has(selected.id)) setSelected(null);
      qc.invalidateQueries({ queryKey: ["orders-v2"] });
    },
  });
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [showNewOrder, setShowNewOrder] = useState(false);

  const { data = [], isLoading } = useQuery({
    queryKey: ["orders-v2", status, search, archiveMode],
    queryFn: () => {
      const params: Record<string, string | boolean> = {};
      if (status && !archiveMode) params.status = status;
      if (search) params.search = search;
      if (archiveMode) params.archived = true;
      return ordersApi.list(params);
    },
  });

  const handleArchive = async () => {
    if (!selected) return;
    setArchiving(true);
    try {
      if (archiveMode) {
        await ordersApi.unarchive(selected.id);
      } else {
        await ordersApi.archive(selected.id);
      }
      qc.invalidateQueries({ queryKey: ["orders-v2"] });
      setSelected(null);
    } finally {
      setArchiving(false);
    }
  };

  const { data: detail } = useQuery({
    queryKey: ["order-detail-v2", selected?.id],
    queryFn: () => ordersApi.get(selected.id),
    enabled: !!selected,
  });

  const paidTotal = detail?.payments?.reduce((s: number, p: any) => s + p.amount, 0) ?? 0;
  const pct = detail?.price_plan > 0 ? Math.min(100, (paidTotal / detail.price_plan) * 100) : 0;

  const allData = data as any[];
  const uniqueCustomers = useMemo(() => [...new Set(allData.map((r: any) => r.customer_name).filter(Boolean))].sort() as string[], [allData]);
  const uniqueTitles = useMemo(() => [...new Set(allData.map((r: any) => r.title).filter(Boolean))].sort() as string[], [allData]);
  const filteredData = useMemo(() => {
    let r = allData;
    if (customerFilter) r = r.filter((o: any) => o.customer_name === customerFilter);
    if (titleFilter) r = r.filter((o: any) => o.title === titleFilter);
    if (brandFilter) r = r.filter((o: any) => o.brand === brandFilter);
    if (amountMin) r = r.filter((o: any) => (o.price_plan || 0) >= parseFloat(amountMin));
    if (amountMax) r = r.filter((o: any) => (o.price_plan || 0) <= parseFloat(amountMax));
    return r;
  }, [allData, customerFilter, titleFilter, brandFilter, amountMin, amountMax]);
  const totalCount = filteredData.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageData = filteredData.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const cols = selected
    ? "28px 2fr 1.2fr 100px 120px 40px"
    : "28px 2fr 1.5fr 120px 130px 120px 40px";

  function renderPageNums() {
    const pages: (number | "…")[] = [];
    if (totalPages <= 5) {
      for (let i = 0; i < totalPages; i++) pages.push(i);
    } else {
      pages.push(0, 1, 2);
      if (page > 3) pages.push("…");
      if (page > 2 && page < totalPages - 2) pages.push(page);
      if (page < totalPages - 3) pages.push("…");
      pages.push(totalPages - 1);
    }
    return [...new Set(pages)].map((p, i) =>
      p === "…" ? (
        <span key={`e${i}`} style={{ fontSize: 10, color: "#A89070", padding: "0 2px" }}>…</span>
      ) : (
        <button
          key={p}
          onClick={() => setPage(p as number)}
          style={{
            minWidth: 20, height: 20,
            background: "none", border: "none", cursor: "pointer",
            fontSize: 10,
            fontWeight: page === p ? 600 : 400,
            color: page === p ? "#1A1A1A" : "#A89070",
            borderBottom: page === p ? "2px solid #E8592A" : "2px solid transparent",
            padding: "0 2px",
          }}
        >
          {(p as number) + 1}
        </button>
      )
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>

      {/* ── Left: table panel ───────────────────────────── */}
      <div style={{
        flex: selected ? "0 0 58%" : "1 1 0",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        borderRight: selected ? "1px solid #EDEBE6" : "none",
        transition: "flex 0.2s ease",
      }}>

        {/* Panel header */}
        <div style={{ padding: "24px 28px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
              Заказы
            </div>
            {/* Action buttons */}
            {searchOpen ? (
              <div style={{ position: "relative" }}>
                <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
                <input
                  autoFocus
                  style={{
                    paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
                    border: "1px solid #EDEBE6",
                    background: "transparent",
                    fontSize: 12, color: "#1A1A1A",
                    outline: "none", width: 180,
                    borderRadius: 0,
                  }}
                  placeholder="Поиск..."
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearch(""); setPage(0); } }}
                />
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <IconBtn onClick={() => setSearchOpen(true)}><MagnifyingGlass size={14} /></IconBtn>
                <IconBtn><Files size={14} /></IconBtn>
                <IconBtn orange onClick={() => setShowNewOrder(true)}><Plus size={14} /></IconBtn>
              </div>
            )}
          </div>

          {/* Status tabs */}
          <div style={{ display: "flex", gap: 24, borderBottom: "1px solid #EDEBE6" }}>
            {!archiveMode && STATUSES.map((s) => (
              <button
                key={s.value}
                onClick={() => { setStatus(s.value); setPage(0); }}
                style={{
                  fontSize: 13, padding: "0 0 12px",
                  border: "none", background: "none", cursor: "pointer",
                  color: status === s.value ? "#1A1A1A" : "#A89070",
                  fontWeight: status === s.value ? 600 : 400,
                  borderBottom: status === s.value ? "2px solid #E8592A" : "2px solid transparent",
                  marginBottom: -1,
                  transition: "all 0.15s",
                }}
              >
                {s.label}
              </button>
            ))}
            <button
              onClick={() => { setArchiveMode(!archiveMode); setStatus(""); setPage(0); setSelected(null); }}
              style={{
                fontSize: 13, padding: "0 0 12px",
                border: "none", background: "none", cursor: "pointer",
                color: archiveMode ? "#1A1A1A" : "#A89070",
                fontWeight: archiveMode ? 600 : 400,
                borderBottom: archiveMode ? "2px solid #A89070" : "2px solid transparent",
                marginBottom: -1,
                marginLeft: archiveMode ? 0 : "auto",
                transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              <Archive size={12} />
              Архив
            </button>
          </div>
        </div>

        {/* Filter / selection bar — always visible to prevent layout shift */}
        {(() => {
          const hasFilters = !!(titleFilter || customerFilter || brandFilter || amountMin || amountMax);
          const canClear = hasFilters || selectedIds.size > 0;
          const sum = filteredData.reduce((s: number, o: any) => s + (o.price_plan || 0), 0);
          const selSum = filteredData.filter((o: any) => selectedIds.has(o.id)).reduce((s: number, o: any) => s + (o.price_plan || 0), 0);
          return (
            <>
              <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
                  {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
                  {selectedIds.size > 0 && selSum > 0 && <span>{fmt(selSum)}</span>}
                  {selectedIds.size === 0 && <span>{filteredData.length} заказов</span>}
                  {selectedIds.size === 0 && hasFilters && sum > 0 && <span>{fmt(sum)}</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {selectedIds.size > 0 && (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      style={{ fontSize: 10, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 3, padding: 0 }}
                    >
                      <Trash size={10} /> Удалить
                    </button>
                  )}
                  <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
                    <X size={10} /> Сбросить
                  </button>
                </div>
              </div>

              {/* Confirm delete modal */}
              {confirmDelete && (
                <ConfirmModal
                  message={`Удалить ${selectedIds.size} ${selectedIds.size === 1 ? "заказ" : selectedIds.size < 5 ? "заказа" : "заказов"}? Это действие необратимо — сметы и платежи будут удалены навсегда.`}
                  confirmLabel={bulkDelete.isPending ? "Удаляем..." : "Удалить"}
                  onConfirm={() => bulkDelete.mutate([...selectedIds])}
                  onCancel={() => setConfirmDelete(false)}
                />
              )}
            </>
          );
        })()}

        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: cols, padding: "8px 28px", borderBottom: "1px solid #F7F5F1", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <Checkbox
              checked={pageData.length > 0 && pageData.every((o: any) => selectedIds.has(o.id))}
              indeterminate={pageData.some((o: any) => selectedIds.has(o.id)) && !pageData.every((o: any) => selectedIds.has(o.id))}
              onChange={() => {
                const allSel = pageData.every((o: any) => selectedIds.has(o.id));
                setSelectedIds(allSel ? new Set() : new Set(pageData.map((o: any) => o.id)));
              }}
            />
          </div>
          <div><ColumnFilter label="НАЗВАНИЕ" options={uniqueTitles} value={titleFilter} onChange={(v) => { setTitleFilter(v); setPage(0); }} /></div>
          <div><ColumnFilter label="КЛИЕНТ" options={uniqueCustomers} value={customerFilter} onChange={(v) => { setCustomerFilter(v); setPage(0); }} /></div>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>СТАТУС</div>
          <div><AmountFilter label="СУММА" min={amountMin} max={amountMax} onChange={(mn, mx) => { setAmountMin(mn); setAmountMax(mx); setPage(0); }} /></div>
          {!selected && <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>К ПОЛУЧЕНИЮ</div>}
          <div />
        </div>

        {/* Rows */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {isLoading ? (
            <Loading compact />
          ) : pageData.length === 0 ? (
            <EmptyState compact title="Заказов нет" />
          ) : (
            pageData.map((o: any) => {
              const st = STATUS_MAP[o.status] || { label: o.status, color: "#A89070" };
              const isActive = selected?.id === o.id;
              return (
                <div
                  key={o.id}
                  onClick={() => setSelected(isActive ? null : o)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: cols,
                    padding: "10px 28px",
                    borderBottom: "1px solid #F7F5F1",
                    cursor: "pointer",
                    background: isActive ? "#E8592A" : selectedIds.has(o.id) ? "#FFF8F5" : "transparent",
                    alignItems: "center",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!isActive && !selectedIds.has(o.id)) e.currentTarget.style.background = "#FAF8F5"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = selectedIds.has(o.id) ? "#FFF8F5" : "transparent"; }}
                >
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <Checkbox checked={selectedIds.has(o.id)} onChange={() => toggleSelect(o.id)} />
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: isActive ? "#FFFFFF" : "#1A1A1A", lineHeight: 1.4 }}>
                    {o.title}
                    {o.brand && (
                      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", marginTop: 2, color: isActive ? "rgba(255,255,255,0.75)" : (BRAND_COLOR[o.brand] || "#A89070"), fontFamily: MONO }}>
                        {o.brand}
                      </div>
                    )}
                  </div>
                  <div style={{
                    width: 28, height: 28,
                    borderRadius: "50%",
                    background: isActive ? "rgba(255,255,255,0.25)" : "#F2EFE9",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 700,
                    color: isActive ? "#FFFFFF" : "#1A1A1A",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}>
                    {initials(o.customer_name)}
                  </div>
                  <div style={{ fontSize: 11, color: isActive ? "#FFFFFF" : st.color, fontWeight: 500, lineHeight: 1.4 }}>
                    {st.label}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: isActive ? "#FFFFFF" : "#1A1A1A", lineHeight: 1.4, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                    {fmt(o.price_plan)}
                  </div>
                  {!selected && (
                    <div style={{ fontSize: 13, fontWeight: 600, color: isActive ? "#FFFFFF" : (o.debt > 0 ? "#E8592A" : "#C8C0B0"), lineHeight: 1.4, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                      {o.debt > 0 ? fmt(o.debt) : "—"}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <DotsThree size={14} style={{ color: isActive ? "rgba(255,255,255,0.6)" : "#C8C0B0" }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer with pagination */}
        <div style={{
          padding: "8px 28px",
          borderTop: "1px solid #F7F5F1",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 10, color: "#A89070" }}>
            {totalCount > 0
              ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, totalCount)} из ${totalCount}`
              : "0 заказов"
            }
          </div>
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            {renderPageNums()}
            <button
              onClick={() => setPage(p => Math.min(p + 1, totalPages - 1))}
              disabled={page >= totalPages - 1}
              style={{
                background: "none", border: "none", cursor: page >= totalPages - 1 ? "default" : "pointer",
                color: page >= totalPages - 1 ? "#D0C8C0" : "#A89070",
                display: "flex", alignItems: "center", padding: "0 2px",
              }}
            >
              <CaretRight size={11} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Right: detail panel ─────────────────────────── */}
      {selected && (
        <div style={{
          flex: "0 0 42%",
          display: "flex",
          flexDirection: "column",
          animation: "slideIn 0.18s ease",
          minWidth: 0,
        }}>
          {/* Detail header */}
          <div style={{
            padding: "22px 24px 18px",
            borderBottom: "1px solid #EDEBE6",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}>
            <div>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em", maxWidth: 300 }}>
                {selected.title}
              </div>
              <div style={{ fontSize: 11, color: "#A89070", marginTop: 8 }}>
                {selected.customer_name || ""}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                <StatusPicker
                  orderId={selected.id}
                  current={detail?.status ?? selected.status}
                  onChange={() => {
                    qc.invalidateQueries({ queryKey: ["orders-v2"] });
                    qc.invalidateQueries({ queryKey: ["order-detail-v2", selected.id] });
                  }}
                />
                <BrandPicker
                  orderId={selected.id}
                  current={detail?.brand ?? selected.brand ?? null}
                  onChange={() => {
                    qc.invalidateQueries({ queryKey: ["orders-v2"] });
                    qc.invalidateQueries({ queryKey: ["order-detail-v2", selected.id] });
                  }}
                />
                <EstimatesDropdown orderId={selected.id} sets={detail?.estimate_sets ?? []} />
                <button
                  onClick={() => navigate(`/orders/${selected.id}`)}
                  title="Редактировать"
                  style={{ width: 28, height: 28, padding: 0, border: "none", background: "#E8592A", color: "#FFFFFF", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <PencilSimple size={15} />
                </button>
                <button
                  onClick={handleArchive}
                  disabled={archiving}
                  title={archiveMode ? "Восстановить из архива" : "В архив"}
                  style={{
                    width: 28, height: 28, padding: 0, border: "1px solid #EDEBE6", background: "transparent",
                    color: archiveMode ? "#4A7C59" : "#A89070", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#1A1A1A"; (e.currentTarget as HTMLElement).style.color = "#1A1A1A"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; (e.currentTarget as HTMLElement).style.color = archiveMode ? "#4A7C59" : "#A89070"; }}
                >
                  {archiveMode ? <ArrowCounterClockwise size={15} /> : <Archive size={15} />}
                </button>
                {selected.customer_id && (
                  <button
                    onClick={() => navigate(`/customers/${selected.customer_id}`)}
                    title="Перейти к клиенту"
                    style={{
                      width: 28, height: 28, padding: 0, border: "1px solid #EDEBE6", background: "transparent",
                      color: "#A89070", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#1A1A1A"; (e.currentTarget as HTMLElement).style.color = "#1A1A1A"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; (e.currentTarget as HTMLElement).style.color = "#A89070"; }}
                  >
                    <UserCircle size={15} />
                  </button>
                )}
              </div>
            </div>
            <button
              onClick={() => setSelected(null)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 4, marginTop: -2 }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#1A1A1A")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#C8C0B0")}
            >
              <DotsThree size={20} />
            </button>
          </div>

          {/* Detail content */}
          <div style={{ flex: 1, overflow: "auto", padding: "24px 24px 20px" }}>

            {/* Finances */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 16, textTransform: "uppercase" }}>Финансы</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "16px 32px" }}>
                {(() => {
                  const ebitda = selected.margin || 0;
                  const taxes = Math.round((selected.price_plan || 0) * 0.06);
                  const netMargin = ebitda - taxes;
                  return [
                    { label: "Стоимость", value: fmt(selected.price_plan), color: "#1A1A1A" },
                    { label: "Оплачено",  value: fmt(paidTotal),           color: "#4A7C59" },
                    { label: "Долг",      value: selected.debt > 0 ? fmt(selected.debt) : "Оплачено", color: selected.debt > 0 ? "#E8592A" : "#4A7C59" },
                    { label: "EBITDA",    value: fmt(ebitda),              color: "#1A1A1A" },
                    { label: "Маржа",     value: fmt(netMargin),           color: netMargin > 0 ? "#4A7C59" : "#8B3A3A" },
                  ];
                })().map((item) => (
                  <div key={item.label}>
                    <div style={{ fontSize: 10, color: "#A89070", marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Progress */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#A89070", marginBottom: 8 }}>
                <span>Прогресс оплаты</span>
                <span style={{ color: "#1A1A1A", fontWeight: 600 }}>{Math.round(pct)}%</span>
              </div>
              <div style={{ height: 2, background: "#F2EFE9" }}>
                <div style={{ height: 2, background: "#E8592A", width: `${pct}%`, transition: "width 0.4s" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#A89070", marginTop: 6 }}>
                <span>{fmt(paidTotal)} оплачено</span>
                <span>{fmt(selected.price_plan)} всего</span>
              </div>
            </div>

            {/* Meta */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 16, textTransform: "uppercase" }}>Детали</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "16px 32px" }}>
                {[
                  { label: "Статус",   value: (STATUS_MAP[selected.status] || {}).label || "—" },
                  { label: "Приоритет", value: selected.priority_label || "—" },
                  { label: "Платежи",  value: String(detail?.payments?.length ?? "—") },
                  { label: "Сметы",    value: String(detail?.estimate_sets?.length ?? "—") },
                  ...(selected.deadline ? [{ label: "Дедлайн", value: fmtDate(selected.deadline) }] : []),
                ].map((item) => (
                  <div key={item.label}>
                    <div style={{ fontSize: 10, color: "#A89070", marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Payments list */}
            {detail?.payments?.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14, textTransform: "uppercase" }}>
                  Платежи
                </div>
                {detail.payments.slice(0, 4).map((p: any, i: number) => (
                  <div
                    key={i}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                      paddingBottom: 12, marginBottom: 12,
                      borderBottom: "1px solid #F2EFE9",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{fmt(p.amount)}</div>
                      {p.note && <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>{p.note}</div>}
                    </div>
                    <div style={{ fontSize: 10, color: "#A89070" }}>{fmtDate(p.paid_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(10px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      {showNewOrder && (
        <NewOrderModal
          onClose={() => setShowNewOrder(false)}
          onCreated={(id) => { setShowNewOrder(false); navigate(`/orders/${id}/estimate?new=1`); }}
        />
      )}
    </div>
  );
}
