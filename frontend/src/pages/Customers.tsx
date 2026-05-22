import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  MagnifyingGlass, DotsThree, Plus, CaretRight,
  PencilSimple, Check, X, FloppyDisk, Funnel,
} from "@phosphor-icons/react";
import { customersApi, mastersApi, financeApi } from "../api";

// ── Helpers ────────────────────────────────────────────────────────────────

function initials(name: string | undefined) {
  if (!name) return "—";
  const cleaned = name.trim().replace(/["«»„"]/g, "").replace(/^(ООО|ИП|ЗАО|ОАО|ПАО)\s+/i, "");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

const PAGE_SIZE = 15;

function ColumnFilter({ options, value, onChange }: {
  options: string[]; value: string; onChange: (v: string) => void;
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
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
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

const STATUS_COLORS: Record<string, string> = {
  favorite: "#E8592A", stable: "#4A7C59", available: "#A89070", risk: "#8B3A3A",
};

const CUSTOMER_STATUS_COLORS: Record<string, string> = {
  "VIP": "#E8592A", "Постоянный": "#4A7C59", "Разовый": "#A89070", "Холодный": "#6B6355",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик", estimate: "Смета", project: "Проект",
  in_production: "В производстве", completed: "Завершён", cancelled: "Отменён",
};

// ── Edit modal ─────────────────────────────────────────────────────────────

type FieldDef = { key: string; label: string; type?: "text" | "textarea" | "select"; options?: { v: string; l: string }[] };

function EditModal({
  title, fields, initial, onSave, onClose, isPending,
}: {
  title: string;
  fields: FieldDef[];
  initial: Record<string, any>;
  onSave: (data: Record<string, any>) => void;
  onClose: () => void;
  isPending: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, any>>({ ...initial });
  const set = (key: string, val: string) => setDraft(d => ({ ...d, [key]: val }));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", width: 480, maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 24px 16px", borderBottom: "1px solid #EDEBE6" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1A1A" }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070" }}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
          {fields.map(f => (
            <div key={f.key}>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>{f.label.toUpperCase()}</div>
              {f.type === "textarea" ? (
                <textarea
                  value={draft[f.key] ?? ""}
                  onChange={e => set(f.key, e.target.value)}
                  rows={3}
                  style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 12, outline: "none", resize: "vertical", fontFamily: "inherit" }}
                />
              ) : f.type === "select" ? (
                <select
                  value={draft[f.key] ?? ""}
                  onChange={e => set(f.key, e.target.value)}
                  style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 12, outline: "none", background: "#fff" }}
                >
                  <option value="">—</option>
                  {f.options?.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              ) : (
                <input
                  value={draft[f.key] ?? ""}
                  onChange={e => set(f.key, e.target.value)}
                  style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 12, outline: "none" }}
                />
              )}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 24px", borderTop: "1px solid #EDEBE6" }}>
          <button onClick={onClose} style={{ padding: "7px 16px", border: "1px solid #EDEBE6", background: "none", fontSize: 12, cursor: "pointer", color: "#6B6355" }}>Отмена</button>
          <button
            disabled={isPending}
            onClick={() => onSave(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, (v as string)?.trim() || null])))}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600 }}
          >
            <FloppyDisk size={13} /> {isPending ? "Сохраняем..." : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Customer detail panel ──────────────────────────────────────────────────

const CUSTOMER_FIELDS: FieldDef[] = [
  { key: "name",      label: "Название" },
  { key: "full_name", label: "Полное имя" },
  { key: "inn",       label: "ИНН" },
  { key: "phone",     label: "Телефон" },
  { key: "email",     label: "Email" },
  { key: "contact",   label: "Контактное лицо" },
  { key: "status",    label: "Статус клиента", type: "select", options: [
    { v: "VIP",        l: "VIP" },
    { v: "Постоянный", l: "Постоянный" },
    { v: "Разовый",    l: "Разовый" },
    { v: "Холодный",   l: "Холодный" },
  ]},
  { key: "source",    label: "Источник / Канал", type: "select", options: [
    { v: "Сарафан",   l: "Сарафан" },
    { v: "Инстаграм", l: "Инстаграм" },
    { v: "Авито",     l: "Авито" },
    { v: "Сайт",      l: "Сайт" },
    { v: "ВКонтакте", l: "ВКонтакте" },
    { v: "Выставка",  l: "Выставка" },
    { v: "Прочее",    l: "Прочее" },
  ]},
  { key: "wiki_ref",  label: "Ссылка (wiki)" },
  { key: "notes",     label: "Заметки", type: "textarea" },
];

function CustomerDetail({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["customer", customerId],
    queryFn: () => customersApi.get(customerId),
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, any>) => customersApi.update(customerId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customer", customerId] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      setEditing(false);
    },
  });

  if (isLoading) return <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>;
  const customer = data?.customer;
  if (!customer) return null;
  const summary = data?.transaction_summary;
  const totalDebt = (data?.orders ?? []).reduce((s: number, o: any) => s + Math.max(0, o.debt ?? 0), 0);

  const Row = ({ label, value }: { label: string; value?: string | null }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #F2EFE9" }}>
      <div style={{ fontSize: 11, color: "#A89070" }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 500, color: value ? "#1A1A1A" : "#C8C0B0", textAlign: "right", maxWidth: 240, wordBreak: "break-word" }}>{value || "—"}</div>
    </div>
  );

  return (
    <>
      {editing && (
        <EditModal
          title={`Редактировать: ${customer.name}`}
          fields={CUSTOMER_FIELDS}
          initial={customer}
          isPending={save.isPending}
          onSave={(d) => save.mutate(d)}
          onClose={() => setEditing(false)}
        />
      )}

      {/* Header */}
      <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <div style={{ fontSize: 21, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em", maxWidth: 270 }}>{customer.name}</div>
            {customer.status && (
              <span style={{ fontSize: 9, color: CUSTOMER_STATUS_COLORS[customer.status] || "#A89070", border: `1px solid ${CUSTOMER_STATUS_COLORS[customer.status] || "#EDEBE6"}`, padding: "2px 6px", letterSpacing: "0.04em", flexShrink: 0 }}>
                {customer.status}
              </span>
            )}
          </div>
          {customer.full_name && <div style={{ fontSize: 11, color: "#A89070" }}>{customer.full_name}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            onClick={() => setEditing(true)}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", border: "1px solid #EDEBE6", background: "none", fontSize: 11, cursor: "pointer", color: "#6B6355" }}
          >
            <PencilSimple size={12} /> Редактировать
          </button>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 4 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}>
            <X size={18} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px" }}>

        {/* Stats */}
        {summary && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 20 }}>
            {[
              { l: "Заказов",  v: String(data?.orders?.length ?? 0), c: "#1A1A1A" },
              { l: "Получено", v: fmt(summary.income),                c: "#4A7C59" },
              { l: "Долг",     v: totalDebt > 0 ? fmt(totalDebt) : "нет", c: totalDebt > 0 ? "#8B3A3A" : "#4A7C59" },
            ].map(s => (
              <div key={s.l} style={{ background: "#FAF8F5", padding: "9px 11px" }}>
                <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 3 }}>{s.l.toUpperCase()}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>
        )}

        {/* Contacts */}
        <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>КОНТАКТЫ</div>
        <Row label="ИНН"              value={customer.inn} />
        <Row label="Телефон"          value={customer.phone} />
        <Row label="Email"            value={customer.email} />
        <Row label="Контактное лицо"  value={customer.contact} />

        {/* Profile */}
        {(customer.source || customer.notes) && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 20 }}>ПРОФИЛЬ</div>
            {customer.source && <Row label="Источник" value={customer.source} />}
            {customer.notes && (
              <div style={{ marginTop: 8, padding: "10px 12px", background: "#FAF8F5", fontSize: 12, color: "#1A1A1A", lineHeight: 1.7, borderLeft: "3px solid #EDEBE6" }}>
                {customer.notes}
              </div>
            )}
          </>
        )}

        {/* Wiki */}
        {customer.wiki_ref && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 20 }}>ВИКИ</div>
            <Row label="Ссылка" value={customer.wiki_ref} />
          </>
        )}

        {/* Orders */}
        {data?.orders?.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>
              ЗАКАЗЫ <span style={{ color: "#C8C0B0", fontWeight: 400 }}>· {data.orders.length}</span>
            </div>
            {data.orders.map((o: any) => (
              <div key={o.id} style={{ padding: "9px 0", borderBottom: "1px solid #F2EFE9" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{o.title || o.number || "—"}</div>
                  <div style={{ fontSize: 10, color: "#A89070" }}>{ORDER_STATUS_LABELS[o.status] || o.status}</div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6B6355" }}>
                  <span>{fmt(o.price_plan)}</span>
                  <span style={{ color: o.debt > 0 ? "#E8592A" : "#4A7C59" }}>{o.debt > 0 ? `долг ${fmt(o.debt)}` : "оплачен"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Master detail panel ────────────────────────────────────────────────────

const MASTER_FIELDS: FieldDef[] = [
  { key: "name",           label: "Имя / Название" },
  { key: "role",           label: "Роль",
    type: "select", options: [{ v: "Мастер", l: "Мастер" }, { v: "Подрядчик", l: "Подрядчик" }] },
  { key: "specialization", label: "Специализация" },
  { key: "phone",          label: "Телефон" },
  { key: "telegram",       label: "Telegram" },
  { key: "email",          label: "Email" },
  { key: "pay_scheme",     label: "Схема оплаты",
    type: "select", options: [
      { v: "percent",  l: "% от счёта" },
      { v: "fixed",    l: "Фиксированная ставка" },
      { v: "per_unit", l: "За единицу" },
      { v: "other",    l: "Другое" },
    ]},
  { key: "pay_rate",  label: "Ставка / %" },
  { key: "pay_note",  label: "Условия оплаты" },
  { key: "notes",     label: "Заметки (карточка)", type: "textarea" },
  { key: "wiki_notes",label: "Вики (fin-agent)",   type: "textarea" },
  { key: "status",    label: "Статус",
    type: "select", options: [
      { v: "favorite",  l: "Постоянный" },
      { v: "stable",    l: "Стабильный" },
      { v: "available", l: "Доступен" },
      { v: "risk",      l: "Риск" },
    ]},
];

function MasterDetail({ masterId, onClose }: { masterId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editCreditor, setEditCreditor] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["master", masterId],
    queryFn: () => mastersApi.get(masterId),
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, any>) => mastersApi.update(masterId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["master", masterId] });
      qc.invalidateQueries({ queryKey: ["masters"] });
      setEditing(false);
    },
  });

  const saveCreditor = useMutation({
    mutationFn: (patch: any) => financeApi.updateCreditor(editCreditor.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["master", masterId] });
      qc.invalidateQueries({ queryKey: ["creditors"] });
      setEditCreditor(null);
    },
  });

  if (isLoading) return <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>;
  const master = data?.master;
  if (!master) return null;
  const wiki = data?.wiki || {};
  const creditors: any[] = data?.creditors || [];
  const totalDebt = data?.total_debt ?? 0;

  const statusLabel: Record<string, string> = {
    favorite: "Постоянный", stable: "Стабильный", available: "Доступен", risk: "Риск",
  };

  // Initial values for edit modal include wiki fields
  const editInitial = {
    name:           master.name,
    role:           master.role,
    specialization: master.specialization || wiki.wiki_spec || "",
    phone:          master.phone,
    telegram:       master.telegram,
    email:          master.email,
    pay_scheme:     wiki.pay_scheme || "",
    pay_rate:       wiki.pay_rate != null ? String(wiki.pay_rate) : "",
    pay_note:       wiki.pay_note || "",
    notes:          master.notes || "",
    wiki_notes:     wiki.wiki_notes || "",
    status:         master.status,
  };

  const Row = ({ label, value }: { label: string; value?: string | null }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
      <div style={{ fontSize: 11, color: "#A89070" }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 500, color: value ? "#1A1A1A" : "#C8C0B0", textAlign: "right", maxWidth: 240 }}>{value || "—"}</div>
    </div>
  );

  return (
    <>
      {editing && (
        <EditModal
          title={`Редактировать: ${master.name}`}
          fields={MASTER_FIELDS}
          initial={editInitial}
          isPending={save.isPending}
          onSave={(d) => save.mutate(d)}
          onClose={() => setEditing(false)}
        />
      )}

      {/* Header */}
      <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <div style={{ fontSize: 21, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em", maxWidth: 260 }}>{master.name}</div>
            <span style={{ fontSize: 9, color: STATUS_COLORS[master.status] || "#A89070", border: `1px solid ${STATUS_COLORS[master.status] || "#EDEBE6"}`, padding: "2px 6px", letterSpacing: "0.04em" }}>
              {statusLabel[master.status] || master.status}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#A89070" }}>{master.role}{master.specialization ? ` · ${master.specialization}` : ""}</div>
          {totalDebt > 0 && (
            <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700, color: "#8B3A3A" }}>Долг: {fmt(totalDebt)}</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            onClick={() => setEditing(true)}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", border: "1px solid #EDEBE6", background: "none", fontSize: 11, cursor: "pointer", color: "#6B6355" }}
          >
            <PencilSimple size={12} /> Редактировать
          </button>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 4 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}>
            <DotsThree size={20} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px" }}>

        {/* Contacts */}
        <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>КОНТАКТЫ</div>
        <Row label="Телефон"  value={master.phone} />
        <Row label="Telegram" value={master.telegram} />
        <Row label="Email"    value={master.email} />

        {/* Payment */}
        {(wiki.pay_label || wiki.pay_note || wiki.prepay_pct) && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 18 }}>ОПЛАТА</div>
            {wiki.pay_label && <Row label="Схема" value={wiki.pay_label} />}
            {wiki.prepay_pct > 0 && <Row label="Предоплата" value={`${wiki.prepay_pct}%`} />}
          </>
        )}

        {/* Wiki notes */}
        {(master.notes || wiki.wiki_notes) && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 18 }}>ВИКИ</div>
            {(wiki.wiki_notes || master.notes) && (
              <div style={{ padding: "10px 12px", background: "#FAF8F5", fontSize: 12, color: "#1A1A1A", lineHeight: 1.7, borderLeft: "3px solid #EDEBE6" }}>
                {wiki.wiki_notes || master.notes}
              </div>
            )}
            {wiki.wiki_notes && master.notes && wiki.wiki_notes !== master.notes && (
              <div style={{ padding: "10px 12px", background: "#FFF8F5", fontSize: 12, color: "#6B6355", lineHeight: 1.7, borderLeft: "3px solid #FAD0C0", marginTop: 6 }}>
                {master.notes}
              </div>
            )}
          </>
        )}

        {/* Obligations */}
        <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 18 }}>
          ОБЯЗАТЕЛЬСТВА
          {creditors.filter(c => c.status === "open").length > 0 &&
            <span style={{ color: "#8B3A3A", marginLeft: 6 }}>· {creditors.filter(c => c.status === "open").length} открытых</span>}
        </div>

        {creditors.length === 0 ? (
          <div style={{ fontSize: 12, color: "#C8C0B0" }}>Нет зафиксированных долгов</div>
        ) : (
          creditors.map((c: any) => (
            <div key={c.id}>
              <div
                onClick={() => setEditCreditor(editCreditor?.id === c.id ? null : c)}
                style={{
                  padding: "9px 12px", marginBottom: 6, cursor: "pointer",
                  background: c.status === "open" ? "#FFF8F5" : "#FAF8F5",
                  borderLeft: `3px solid ${c.status === "open" ? "#E8592A" : "#EDEBE6"}`,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "#F5EDE8")}
                onMouseLeave={e => (e.currentTarget.style.background = c.status === "open" ? "#FFF8F5" : "#FAF8F5")}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 11, color: "#6B6355", flex: 1, paddingRight: 8 }}>{c.description || "—"}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: c.status === "open" ? "#8B3A3A" : "#A89070", flexShrink: 0 }}>
                    {c.status === "open" ? fmt(c.debt) : <span style={{ fontSize: 10 }}>Закрыт</span>}
                  </div>
                </div>
                {(c.paid > 0 || c.due_date) && (
                  <div style={{ fontSize: 10, color: "#A89070", marginTop: 3 }}>
                    {c.paid > 0 && `оплачено ${fmt(c.paid)} из ${fmt(c.total)}`}
                    {c.paid > 0 && c.due_date && " · "}
                    {c.due_date && `до ${fmtDate(c.due_date)}`}
                  </div>
                )}
              </div>

              {/* Inline creditor editor */}
              {editCreditor?.id === c.id && (
                <div style={{ padding: "12px 14px", marginBottom: 8, background: "#fff", border: "1px solid #EDEBE6" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#A89070", marginBottom: 3 }}>СУММА ₽</div>
                      <input type="number" defaultValue={c.total} id={`ec-total-${c.id}`}
                        style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#A89070", marginBottom: 3 }}>ОПЛАЧЕНО ₽</div>
                      <input type="number" defaultValue={c.paid} id={`ec-paid-${c.id}`}
                        style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button onClick={() => saveCreditor.mutate({ status: "closed" })}
                      style={{ padding: "4px 10px", border: "1px solid #4A7C59", background: "none", fontSize: 11, cursor: "pointer", color: "#4A7C59", display: "flex", alignItems: "center", gap: 4 }}>
                      <Check size={11} /> Закрыть
                    </button>
                    <button onClick={() => {
                      const t = parseFloat((document.getElementById(`ec-total-${c.id}`) as HTMLInputElement).value);
                      const p = parseFloat((document.getElementById(`ec-paid-${c.id}`) as HTMLInputElement).value);
                      saveCreditor.mutate({ total: isNaN(t) ? c.total : t, paid: isNaN(p) ? c.paid : p });
                    }} style={{ padding: "4px 10px", border: "none", background: "#E8592A", color: "#fff", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
                      Сохранить
                    </button>
                    <button onClick={() => setEditCreditor(null)}
                      style={{ padding: "4px 10px", border: "1px solid #EDEBE6", background: "none", fontSize: 11, cursor: "pointer", color: "#A89070" }}>
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

const TABS = [
  { id: "clients",  label: "Клиенты" },
  { id: "masters",  label: "Исполнители" },
];

export default function Customers() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<"clients" | "masters">("clients");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [selectedMaster, setSelectedMaster] = useState<any>(null);
  const [nameFilter, setNameFilter] = useState("");

  const { data: customers = [], isLoading: loadingC } = useQuery({
    queryKey: ["customers", search],
    queryFn: () => customersApi.list(search),
    enabled: tab === "clients",
  });

  const { data: masters = [], isLoading: loadingM } = useQuery({
    queryKey: ["masters"],
    queryFn: mastersApi.list,
    enabled: tab === "masters",
  });

  const rightOpen = tab === "clients" ? !!id : !!selectedMaster;
  const allItems = (tab === "clients" ? customers : masters) as any[];
  const uniqueNames = [...new Set(allItems.map((i: any) => i.name).filter(Boolean))].sort() as string[];
  const filteredItems = nameFilter ? allItems.filter((i: any) => i.name === nameFilter) : allItems;
  const totalCount = filteredItems.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageItems = filteredItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const isLoading = tab === "clients" ? loadingC : loadingM;

  const cols = rightOpen ? "32px 1fr" : "32px 2fr 130px 150px";

  function renderPageNums() {
    const pages: (number | "…")[] = [];
    if (totalPages <= 5) for (let i = 0; i < totalPages; i++) pages.push(i);
    else {
      pages.push(0);
      if (page > 2) pages.push("…");
      if (page > 1 && page < totalPages - 1) pages.push(page);
      if (page < totalPages - 2) pages.push("…");
      pages.push(totalPages - 1);
    }
    return [...new Set(pages)].map((p, i) =>
      p === "…" ? (
        <span key={`e${i}`} style={{ fontSize: 10, color: "#A89070", padding: "0 2px" }}>…</span>
      ) : (
        <button key={p} onClick={() => setPage(p as number)} style={{
          minWidth: 20, height: 20, background: "none", border: "none", cursor: "pointer",
          fontSize: 10, fontWeight: page === p ? 600 : 400,
          color: page === p ? "#1A1A1A" : "#A89070",
          borderBottom: page === p ? "2px solid #E8592A" : "2px solid transparent", padding: "0 2px",
        }}>{(p as number) + 1}</button>
      )
    );
  }

  const closeRight = () => {
    if (tab === "clients") navigate("/customers");
    else setSelectedMaster(null);
  };

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>

      {/* Left panel */}
      <div style={{
        flex: rightOpen ? "0 0 50%" : "1 1 0",
        display: "flex", flexDirection: "column", minWidth: 0,
        borderRight: rightOpen ? "1px solid #EDEBE6" : "none",
        transition: "flex 0.2s ease",
      }}>
        <div style={{ padding: "24px 28px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Контакты</div>
            {searchOpen ? (
              <div style={{ position: "relative" }}>
                <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
                <input autoFocus
                  style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6, border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, color: "#1A1A1A", outline: "none", width: 180 }}
                  placeholder="Поиск..."
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(0); }}
                  onKeyDown={e => { if (e.key === "Escape") { setSearchOpen(false); setSearch(""); setPage(0); } }}
                />
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setSearchOpen(true)} style={{ width: 28, height: 28, background: "#F2EFE9", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#6B6355" }}><MagnifyingGlass size={14} /></button>
                <button style={{ width: 28, height: 28, background: "#E8592A", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}><Plus size={14} /></button>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 24, borderBottom: "1px solid #EDEBE6" }}>
            {TABS.map(t => (
              <button key={t.id}
                onClick={() => { setTab(t.id as any); setPage(0); setSearch(""); setNameFilter(""); if (t.id !== "clients") navigate("/customers"); setSelectedMaster(null); }}
                style={{
                  fontSize: 13, padding: "0 0 12px", border: "none", background: "none", cursor: "pointer",
                  color: tab === t.id ? "#1A1A1A" : "#A89070",
                  fontWeight: tab === t.id ? 600 : 400,
                  borderBottom: tab === t.id ? "2px solid #E8592A" : "2px solid transparent", marginBottom: -1,
                }}>{t.label}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: cols, padding: "8px 28px", borderBottom: "1px solid #F7F5F1", alignItems: "center" }}>
          <div />
          {!rightOpen ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>
                  {tab === "clients" ? "КЛИЕНТ" : "ИСПОЛНИТЕЛЬ"}
                </span>
                <ColumnFilter options={uniqueNames} value={nameFilter} onChange={(v) => { setNameFilter(v); setPage(0); }} />
              </div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>ТЕЛЕФОН</div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>
                {tab === "clients" ? "ИНН" : "РОЛЬ / ДОЛГ"}
              </div>
            </>
          ) : <div />}
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>Загружаем...</div>
          ) : pageItems.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>Ничего не найдено</div>
          ) : pageItems.map((item: any) => {
            const isActive = tab === "clients" ? id === item.id : selectedMaster?.id === item.id;
            return (
              <div key={item.id}
                onClick={() => {
                  if (tab === "clients") navigate(isActive ? "/customers" : `/customers/${item.id}`);
                  else setSelectedMaster(isActive ? null : item);
                }}
                style={{
                  display: "grid", gridTemplateColumns: cols,
                  padding: "10px 28px", borderBottom: "1px solid #F7F5F1",
                  cursor: "pointer", alignItems: "center",
                  background: isActive ? "#E8592A" : "transparent", transition: "background 0.1s",
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "#FAF8F5"; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{
                  width: 26, height: 26, borderRadius: "50%",
                  background: isActive ? "rgba(255,255,255,0.25)" : (tab === "masters" && item.debt > 0 ? "#FFF0EC" : "#F2EFE9"),
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", flexShrink: 0,
                  color: isActive ? "#fff" : (tab === "masters" && item.debt > 0 ? "#8B3A3A" : "#1A1A1A"),
                }}>{initials(item.name)}</div>

                <div style={{ fontSize: 12, fontWeight: 500, color: isActive ? "#fff" : "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.name}
                </div>

                {!rightOpen && (
                  <>
                    <div style={{ fontSize: 11, color: isActive ? "rgba(255,255,255,0.7)" : "#6B6355" }}>
                      {item.phone || "—"}
                    </div>
                    <div style={{ fontSize: 11, color: isActive ? "rgba(255,255,255,0.7)" : "#6B6355" }}>
                      {tab === "clients"
                        ? (item.inn || "—")
                        : <span>
                            {item.role || "—"}
                            {item.debt > 0 && !isActive && (
                              <span style={{ marginLeft: 8, fontWeight: 700, color: "#8B3A3A" }}>{fmt(item.debt)}</span>
                            )}
                          </span>
                      }
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ padding: "8px 28px", borderTop: "1px solid #F7F5F1", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: "#A89070" }}>
            {totalCount > 0 ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, totalCount)} из ${totalCount}` : "0"}
          </div>
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            {renderPageNums()}
            <button onClick={() => setPage(p => Math.min(p + 1, totalPages - 1))} disabled={page >= totalPages - 1}
              style={{ background: "none", border: "none", cursor: page >= totalPages - 1 ? "default" : "pointer", color: page >= totalPages - 1 ? "#D0C8C0" : "#A89070", display: "flex", alignItems: "center", padding: "0 2px" }}>
              <CaretRight size={11} />
            </button>
          </div>
        </div>
      </div>

      {/* Right panel */}
      {rightOpen && (
        <div style={{ flex: "0 0 50%", display: "flex", flexDirection: "column", animation: "slideIn 0.18s ease", minWidth: 0 }}>
          {tab === "clients" && id
            ? <CustomerDetail customerId={id} onClose={closeRight} />
            : selectedMaster
              ? <MasterDetail masterId={selectedMaster.id} onClose={closeRight} />
              : null}
        </div>
      )}

      <style>{`
        @keyframes slideIn { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }
      `}</style>
    </div>
  );
}
