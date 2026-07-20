import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { MONO } from "../components/ui/Num";
import { IconButton } from "../components/ui/IconButton";
import { useNavigate, useParams } from "react-router-dom";
import { useNavigationGuard, NavigationGuardModal } from "../components/NavigationGuard";
import {
  MagnifyingGlass, Plus, CaretRight, PencilSimple, X,
} from "@phosphor-icons/react";
import { customersApi } from "../api";
import { EditModal, type FieldDef } from "../components/EditModal";
import { PayeeRulesSection } from "../components/PayeeRulesSection";
import { ColumnFilter } from "../components/TableFilters";

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

const PAGE_SIZE = 15;

const CUSTOMER_STATUS_COLORS: Record<string, string> = {
  "VIP": "#E8592A", "Постоянный": "#4A7C59", "Разовый": "#A89070", "Холодный": "#6B6355",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик", estimate: "Смета", project: "Проект",
  in_production: "В производстве", completed: "Завершён", cancelled: "Отменён",
};

// ── Edit modal ─────────────────────────────────────────────────────────────



// ── Payee rules section ───────────────────────────────────────────────────



// ── Customer detail panel ──────────────────────────────────────────────────

const CUSTOMER_FIELDS: FieldDef[] = [
  { key: "name",      label: "Название" },
  { key: "full_name", label: "Полное имя" },
  { key: "inn",       label: "ИНН" },
  { key: "contact",   label: "Контактное лицо" },
  { key: "phone",     label: "Телефон" },
  { key: "telegram",  label: "Telegram" },
  { key: "instagram", label: "Instagram" },
  { key: "whatsapp",  label: "WhatsApp" },
  { key: "email",     label: "Email" },
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
  const blocker = useNavigationGuard(editing);

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

  const del = useMutation({
    mutationFn: () => customersApi.delete(customerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      setEditing(false);
      onClose();
    },
  });

  if (isLoading) return <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>;
  const customer = data?.customer;
  if (!customer) return null;
  const summary = data?.transaction_summary;
  const totalDebt = (data?.orders ?? []).reduce((s: number, o: any) => s + Math.max(0, o.debt ?? 0), 0);

  const Row = ({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #F2EFE9" }}>
      <div style={{ fontSize: 11, color: "#A89070" }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 500, color: value ? "#1A1A1A" : "#C8C0B0", textAlign: "right", maxWidth: 240, wordBreak: "break-word", fontFamily: mono && value ? MONO : undefined, fontVariantNumeric: mono ? "tabular-nums" : undefined }}>{value || "—"}</div>
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
          onDelete={() => del.mutate()}
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
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <IconButton icon={PencilSimple} title="Редактировать" size={28} iconSize={16} color="#C8C0B0" onClick={() => setEditing(true)} />
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 6 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}>
            <X size={16} />
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
                <div style={{ fontSize: 14, fontWeight: 700, color: s.c, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{s.v}</div>
              </div>
            ))}
          </div>
        )}

        {/* Contacts */}
        <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>КОНТАКТЫ</div>
        <Row label="ИНН"              value={customer.inn} mono />
        <Row label="Телефон"          value={customer.phone} mono />
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
                  <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(o.price_plan)}</span>
                  <span style={{ color: o.debt > 0 ? "#E8592A" : "#4A7C59", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{o.debt > 0 ? `долг ${fmt(o.debt)}` : "оплачен"}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <PayeeRulesSection entityType="customer" entityId={customerId} />
      </div>

      <NavigationGuardModal blocker={blocker} />
    </>
  );
}

// ── Master detail panel ────────────────────────────────────────────────────



// ── Main page ──────────────────────────────────────────────────────────────

export default function Customers() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [nameFilter, setNameFilter] = useState("");
  const clearFilters = () => { setNameFilter(""); setPage(0); };

  const { data: customers = [], isLoading: loadingC } = useQuery({
    queryKey: ["customers", search],
    queryFn: () => customersApi.list(search),
  });

  const rightOpen = !!id;
  const allItems = customers as any[];
  const uniqueNames = [...new Set(allItems.map((i: any) => i.name).filter(Boolean))].sort() as string[];
  const filteredItems = nameFilter ? allItems.filter((i: any) => i.name === nameFilter) : allItems;
  const totalCount = filteredItems.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageItems = filteredItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const isLoading = loadingC;

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

  const closeRight = () => navigate("/customers");

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
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Клиенты</div>
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

        </div>

        {(() => {
          const hasFilters = !!nameFilter;
          return (
            <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
                <span>{filteredItems.length} контактов</span>
              </div>
              <button onClick={hasFilters ? clearFilters : undefined} style={{ fontSize: 10, color: hasFilters ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: hasFilters ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
                <X size={10} /> Сбросить
              </button>
            </div>
          );
        })()}

        <div style={{ display: "grid", gridTemplateColumns: cols, padding: "8px 28px", borderBottom: "1px solid #F7F5F1", alignItems: "center" }}>
          <div />
          {!rightOpen ? (
            <>
              <div><ColumnFilter label="КЛИЕНТ" options={uniqueNames} value={nameFilter} onChange={(v) => { setNameFilter(v); setPage(0); }} /></div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>ТЕЛЕФОН</div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>
                ИНН
              </div>
            </>
          ) : <div />}
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {isLoading ? (
            <Loading compact />
          ) : pageItems.length === 0 ? (
            <EmptyState compact title="Ничего не найдено" />
          ) : pageItems.map((item: any) => {
            const isActive = id === item.id;
            return (
              <div key={item.id}
                onClick={() => {
                  navigate(isActive ? "/customers" : `/customers/${item.id}`);
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
                  background: isActive ? "rgba(255,255,255,0.25)" : "#F2EFE9",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", flexShrink: 0,
                  color: isActive ? "#fff" : "#1A1A1A",
                }}>{initials(item.name)}</div>

                <div style={{ fontSize: 12, fontWeight: 500, color: isActive ? "#fff" : "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.name}
                </div>

                {!rightOpen && (
                  <>
                    <div style={{ fontSize: 11, color: isActive ? "rgba(255,255,255,0.7)" : "#6B6355", fontFamily: MONO }}>
                      {item.phone || "—"}
                    </div>
                    <div style={{ fontSize: 11, color: isActive ? "rgba(255,255,255,0.7)" : "#6B6355", fontFamily: MONO }}>
                      {item.inn || "—"}
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
          {id && <CustomerDetail customerId={id} onClose={closeRight} />}
        </div>
      )}

      <style>{`
        @keyframes slideIn { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }
      `}</style>
    </div>
  );
}
