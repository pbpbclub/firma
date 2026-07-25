import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { User, Wrench, Truck, Palette, Buildings, Plus, LinkSimple, X } from "@phosphor-icons/react";
import { customersApi, mastersApi, suppliersApi, brandsApi, businessUnitsApi, financeApi } from "../../api";
import { MONO } from "../../components/ui/Num";
import { T } from "../../components/ui/type";
import type { FieldDef } from "../../components/EditModal";
import { fmt } from "./helpers";

// ── Общие ячейки колонок (единые размеры вместо ручных 12/13/14) ──────────────
const ell = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" } as const;
// Имя строки — всегда 13/500 (Onest).
const nameCell = (name?: string) => <span style={{ ...T.body, fontWeight: 500, ...ell }}>{name || "—"}</span>;
// Денежная ячейка — всегда T.num (Space Grotesk 13, tabular). tone — цвет, bold — 700.
const numCell = (v: number, tone = "#1A1A1A", opts?: { bold?: boolean; dashZero?: boolean }) =>
  <span style={{ ...T.num, fontWeight: opts?.bold ? 700 : 400, color: opts?.dashZero && !v ? "#C8C0B0" : tone }}>
    {opts?.dashZero && !v ? "—" : fmt(v)}
  </span>;
// Текст-значение в ячейке (специализация/описание/тип) — тот же кегль 13, что имя.
const subCell = (text?: string, color = "#6B6355") =>
  <span style={{ ...T.body, color, ...ell, paddingRight: 12 }}>{text || "—"}</span>;
// Моно-значение (телефон/ИНН) — 13, tabular, без переноса. Без явного размера раньше
// наследовало браузерные 16px («гигантские» телефоны/ИНН).
const numText = (text?: string) =>
  <span style={{ ...T.num, ...ell }}>{text || "—"}</span>;
// Статус-бейдж (клиент/подрядчик) — цветная рамка, кегль как у меток. Цвет передаём
// напрямую: у разных сущностей карты цветов ключуются по-своему (raw vs метка).
const statusCell = (label?: string, color?: string) =>
  label
    ? <span style={{ fontSize: 11, fontWeight: 600, color: color || "#A89070", border: `1px solid ${color || "#EDEBE6"}`, padding: "2px 7px", letterSpacing: "0.02em", whiteSpace: "nowrap" }}>{label}</span>
    : <span style={{ color: "#C8C0B0" }}>—</span>;
import { ClientDetail, CLIENT_FIELDS, CUSTOMER_STATUS_COLORS, customerStatusLabel } from "./ClientDetail";
import { ContractorDetail, CONTRACTOR_FIELDS, STATUS_COLORS, CONTRACTOR_STATUS_LABELS } from "./ContractorDetail";
import { SupplierDetail, SUPPLIER_FIELDS, PRICE_SUPPLIER_LABELS } from "./SupplierDetail";
import { BrandDetail, BrandModal } from "./BrandDetail";
import { UnitDetail, UnitModal } from "./UnitDetail";

export type WikiColumn = {
  key: string;
  label: string;
  width: string;              // фрагмент grid-template
  align?: "right";
  filter?: boolean;           // повесить ColumnFilter по уникальным значениям key
  render?: (row: any) => ReactNode;
};

export type WikiCategory = {
  key: string;                // slug в url
  label: string;
  singular: string;           // «клиента», «поставщика» — для «Новый …»
  icon: ComponentType<any>;
  adapter: {
    list: (search?: string) => Promise<any[]>;
    create: (data: Record<string, any>) => Promise<any>;
    serverSearch: boolean;
  };
  searchFields?: string[];    // клиентский поиск (когда serverSearch=false)
  columns: WikiColumn[];
  // Левая 32px-колонка: круг с инициалами или цветная точка (бренды). Нет → без аватара.
  avatar?: { kind: "initials" | "colorDot"; debtTint?: boolean };
  // Панельная карточка — у ВСЕХ категорий (единая навигация).
  Detail: ComponentType<any>;
  // Создание: либо форма EditModal по полям, либо своя модалка (бренды/юрлица — палитра/счета).
  createFields?: FieldDef[];
  createModal?: ComponentType<{ row: any; onClose: () => void }>;
  // Доп. блок под списком (напр. «только в вики» у подрядчиков). Виден в полном списке.
  footer?: ComponentType;
};

// ── «Только в вики»: контрагенты в вики фин-агента без пары в картотеке ────────
// Они невидимы в списках (нет строки в masters). Кнопка заводит мастера и
// связывает пару в вики (POST /masters проставляет mes_master_id).
function WikiOnlyContractors() {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({ queryKey: ["wiki-only"], queryFn: mastersApi.wikiOnly });
  const { data: masters = [] } = useQuery({ queryKey: ["wiki", "contractors"], queryFn: () => mastersApi.list() });
  const [linkFor, setLinkFor] = useState<number | null>(null);   // contractor_id, для которого открыт селект
  const [pick, setPick] = useState("");
  const done = () => {
    qc.invalidateQueries({ queryKey: ["wiki-only"] });
    qc.invalidateQueries({ queryKey: ["wiki", "contractors"] });
    setLinkFor(null); setPick("");
  };
  // Создаём мастера: contractor_id — чтобы привязка легла в ЭТУ строку вики,
  // а не в совпадение по имени (имена как раз и расходятся).
  const add = useMutation({
    mutationFn: (w: any) => mastersApi.create({
      name: w.name, specialization: w.specialization || undefined, contractor_id: w.contractor_id,
    }),
    onSuccess: done,
  });
  // Привязка к уже существующему подрядчику — вместо создания дубля.
  const link = useMutation({
    mutationFn: (p: { contractor_id: number; master_id: string }) => mastersApi.wikiLink(p),
    onSuccess: done,
  });
  const list = items as any[];
  if (!list.length) return null;

  return (
    <div style={{ padding: "18px 28px 24px", borderTop: "1px solid #EDEBE6", marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span style={{ ...T.sectionLabel }}>ТОЛЬКО В ВИКИ</span>
        <span style={{ fontSize: 11, color: "#C8C0B0" }}>· {list.length}</span>
      </div>
      <div style={{ fontSize: 11, color: "#A89070", marginBottom: 12 }}>
        Есть в вики фин-агента, но нет в картотеке — поэтому не видны в списках выше.
        Если такой подрядчик уже заведён под другим именем — привяжите, а не создавайте заново.
      </div>
      {list.map((w: any) => (
        <div key={w.contractor_id || w.name}
          style={{ display: "grid", gridTemplateColumns: "1.4fr 1.4fr 120px auto", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid #F2EFE9" }}>
          <span style={{ ...T.body, fontWeight: 500, ...ell }}>{w.name}</span>
          <span style={{ ...T.body, color: "#6B6355", ...ell }}>{w.specialization || "—"}</span>
          <span style={{ ...T.body, color: w.pay_label ? "#1A1A1A" : "#C8C0B0", ...ell }}>{w.pay_label || "—"}</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
            {linkFor === w.contractor_id ? (
              <>
                <select value={pick} onChange={e => setPick(e.target.value)} autoFocus
                  style={{ border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 11, outline: "none", background: "#fff", fontFamily: "inherit", maxWidth: 220 }}>
                  <option value="">— кто это в картотеке —</option>
                  {(masters as any[]).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <button disabled={!pick || link.isPending}
                  onClick={() => link.mutate({ contractor_id: w.contractor_id, master_id: pick })}
                  style={{ fontSize: 11, padding: "5px 10px", border: "none", background: pick ? "#E8592A" : "#EDEBE6", color: pick ? "#fff" : "#A89070", cursor: pick ? "pointer" : "default", fontFamily: "inherit", fontWeight: 600 }}>
                  {link.isPending ? "..." : "Привязать"}
                </button>
                <button onClick={() => { setLinkFor(null); setPick(""); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2, display: "flex" }}>
                  <X size={11} />
                </button>
              </>
            ) : (
              <>
                {/* Кандидат из картотеки: похоже, это он же под другим именем */}
                {w.suggested_master && (
                  <button
                    onClick={() => link.mutate({ contractor_id: w.contractor_id, master_id: w.suggested_master.id })}
                    disabled={link.isPending}
                    title={`Привязать к существующему подрядчику «${w.suggested_master.name}» — дубль не создаётся`}
                    style={{ fontSize: 11, fontWeight: 600, color: "#4A7C59", background: "transparent", border: "1px solid #4A7C59", padding: "5px 12px", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", maxWidth: 260, overflow: "hidden" }}>
                    <LinkSimple size={11} /> Это «{w.suggested_master.name}»
                  </button>
                )}
                <button onClick={() => { setLinkFor(w.contractor_id); setPick(""); }}
                  title="Привязать к существующему подрядчику"
                  style={{ fontSize: 11, color: "#6B6355", background: "#fff", border: "1px solid #EDEBE6", padding: "5px 10px", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
                  <LinkSimple size={11} /> Привязать
                </button>
                <button
                  onClick={() => add.mutate(w)} disabled={add.isPending}
                  title="Завести нового подрядчика в картотеке"
                  style={{ fontSize: 11, fontWeight: 600, color: "#E8592A", background: "transparent", border: "1px solid #E8592A", padding: "5px 12px", cursor: add.isPending ? "default" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}
                  onMouseEnter={e => { if (!add.isPending) { e.currentTarget.style.background = "#E8592A"; e.currentTarget.style.color = "#fff"; } }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#E8592A"; }}>
                  <Plus size={11} /> В картотеку
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── категории ─────────────────────────────────────────────────────────────
const clients: WikiCategory = {
  key: "clients", label: "Клиенты", singular: "клиента", icon: User,
  adapter: { list: (s?: string) => customersApi.list(s), create: (d) => customersApi.create(d as any), serverSearch: true },
  Detail: ClientDetail,
  createFields: CLIENT_FIELDS,
  avatar: { kind: "initials" },
  columns: [
    { key: "name",   label: "КЛИЕНТ",  width: "2fr", filter: true },
    { key: "phone",  label: "ТЕЛЕФОН", width: "150px", render: (r) => numText(r.phone) },
    { key: "inn",    label: "ИНН",     width: "150px", render: (r) => numText(r.inn) },
    { key: "status", label: "СТАТУС",  width: "120px", filter: true, render: (r) => statusCell(customerStatusLabel(r.status) || undefined, CUSTOMER_STATUS_COLORS[customerStatusLabel(r.status)]) },
  ],
};

const contractors: WikiCategory = {
  key: "contractors", label: "Подрядчики", singular: "подрядчика", icon: Wrench,
  adapter: { list: () => mastersApi.list(), create: (d) => mastersApi.create(d as any), serverSearch: false },
  searchFields: ["name", "specialization", "phone"],
  Detail: ContractorDetail,
  createFields: CONTRACTOR_FIELDS,
  avatar: { kind: "initials", debtTint: true },
  footer: WikiOnlyContractors,
  columns: [
    { key: "name", label: "ИМЯ", width: "1.6fr", render: (r) => nameCell(r.name) },
    { key: "status", label: "СТАТУС", width: "120px", filter: true, render: (r) => statusCell(r.status ? (CONTRACTOR_STATUS_LABELS[r.status] || r.status) : undefined, STATUS_COLORS[r.status]) },
    { key: "specialization", label: "СПЕЦИАЛИЗАЦИЯ", width: "1.2fr", render: (r) => subCell(r.specialization) },
    { key: "role", label: "РОЛЬ", width: "120px", filter: true, render: (r) => subCell(r.role, "#A89070") },
    { key: "pay_label", label: "СХЕМА", width: "110px", render: (r) => <span style={{ ...T.body, color: r.pay_label ? "#1A1A1A" : "#C8C0B0", ...ell }}>{r.pay_label || "—"}</span> },
    { key: "paid_total", label: "ВЫПЛАЧЕНО", width: "110px", align: "right", render: (r) => numCell(r.paid_total, "#4A7C59", { dashZero: true }) },
    { key: "debt", label: "ДОЛГ", width: "90px", align: "right", render: (r) => numCell(r.debt, "#8B3A3A", { bold: true, dashZero: true }) },
  ],
};

const suppliers: WikiCategory = {
  key: "suppliers", label: "Поставщики", singular: "поставщика", icon: Truck,
  adapter: { list: () => suppliersApi.list(), create: suppliersApi.create, serverSearch: false },
  searchFields: ["name", "category", "phone"],
  Detail: SupplierDetail,
  createFields: SUPPLIER_FIELDS,
  avatar: { kind: "initials" },
  columns: [
    { key: "name", label: "ПОСТАВЩИК", width: "2fr", filter: true },
    { key: "category", label: "КАТЕГОРИЯ", width: "150px", render: (r) => subCell(r.category) },
    { key: "phone", label: "ТЕЛЕФОН", width: "150px", render: (r) => numText(r.phone) },
    { key: "price_supplier", label: "ПРАЙС", width: "110px", render: (r) => <span style={{ ...T.body, color: r.price_supplier ? "#E8592A" : "#C8C0B0", ...ell }}>{PRICE_SUPPLIER_LABELS[r.price_supplier] || "—"}</span> },
  ],
};

const brands: WikiCategory = {
  key: "brands", label: "Бренды", singular: "бренд", icon: Palette,
  adapter: {
    // Обогащаем строки доходом/прибылью из finance/by-brand — чтобы не потерять фичу.
    list: async () => {
      const [bs, byBrand] = await Promise.all([brandsApi.list(), financeApi.byBrand()]);
      const fin = (name: string) => (byBrand as any[]).find((b: any) => b.brand === name);
      return (bs as any[]).map((b: any) => ({ ...b, _fin: fin(b.name) }));
    },
    create: brandsApi.create, serverSearch: false,
  },
  searchFields: ["name", "description"],
  Detail: BrandDetail,
  createModal: BrandModal,
  avatar: { kind: "colorDot" },
  columns: [
    { key: "name", label: "НАЗВАНИЕ", width: "1.4fr", filter: true, render: (r) => nameCell(r.name) },
    { key: "description", label: "ОПИСАНИЕ", width: "2fr", render: (r) => subCell(r.description) },
    { key: "_income", label: "ДОХОД", width: "120px", align: "right", render: (r) => r._fin ? numCell(r._fin.income, "#4A7C59") : subCell("—", "#C8C0B0") },
    { key: "_profit", label: "ПРИБЫЛЬ", width: "120px", align: "right", render: (r) => r._fin ? numCell(r._fin.profit, r._fin.profit < 0 ? "#8B3A3A" : "#1A1A1A", { bold: true }) : subCell("—", "#C8C0B0") },
  ],
};

const units: WikiCategory = {
  key: "units", label: "Юрлица", singular: "юрлицо", icon: Buildings,
  adapter: { list: () => businessUnitsApi.list(), create: businessUnitsApi.create, serverSearch: false },
  searchFields: ["name", "inn"],
  Detail: UnitDetail,
  createModal: UnitModal,
  avatar: { kind: "initials" },
  columns: [
    { key: "name", label: "НАЗВАНИЕ", width: "1.4fr", filter: true, render: (r) => nameCell(r.name) },
    { key: "kind", label: "ТИП", width: "90px", filter: true, render: (r) => subCell(r.kind) },
    { key: "inn", label: "ИНН", width: "130px", render: (r) => <span style={{ ...T.num, color: "#A89070" }}>{r.inn || "—"}</span> },
    { key: "accounts", label: "СЧЕТА", width: "1.6fr", render: (r) => (
      <span style={{ ...T.body, color: "#6B6355" }}>
        {(r.accounts || []).length === 0 ? "—" : (r.accounts || []).map((a: any) => (
          <span key={a.id} style={{ display: "inline-block", marginRight: 10 }}>{a.name} <span style={{ color: "#A89070", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(a.balance || 0)}</span></span>
        ))}
      </span>
    ) },
    { key: "balance_total", label: "БАЛАНС", width: "120px", align: "right", render: (r) => numCell(r.balance_total || 0, r.balance_total >= 0 ? "#1A1A1A" : "#8B3A3A", { bold: true }) },
  ],
};

export const WIKI_CATEGORIES: WikiCategory[] = [clients, contractors, suppliers, brands, units];

export function findCategory(key: string | undefined): WikiCategory {
  return WIKI_CATEGORIES.find(c => c.key === key) || WIKI_CATEGORIES[0];
}
