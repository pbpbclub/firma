import type { ComponentType, ReactNode } from "react";
import { User, Wrench, Truck, Palette, Buildings } from "@phosphor-icons/react";
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
};

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
