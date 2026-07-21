import type { ComponentType, ReactNode } from "react";
import { User, Wrench, Truck, Palette, Buildings } from "@phosphor-icons/react";
import { customersApi, mastersApi, suppliersApi, brandsApi, businessUnitsApi, financeApi } from "../../api";
import { MONO } from "../../components/ui/Num";
import type { FieldDef } from "../../components/EditModal";
import { fmt } from "./helpers";
import { ClientDetail, CLIENT_FIELDS } from "./ClientDetail";
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
    { key: "name",  label: "КЛИЕНТ",  width: "2fr", filter: true },
    { key: "phone", label: "ТЕЛЕФОН", width: "130px", render: (r) => <span style={{ fontFamily: MONO }}>{r.phone || "—"}</span> },
    { key: "inn",   label: "ИНН",     width: "150px", render: (r) => <span style={{ fontFamily: MONO }}>{r.inn || "—"}</span> },
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
    { key: "name", label: "ИМЯ", width: "1.6fr", render: (r) => (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
        {r.status && <div style={{ fontSize: 9, color: STATUS_COLORS[r.status] || "#A89070", marginTop: 1 }}>{CONTRACTOR_STATUS_LABELS[r.status] || r.status}</div>}
      </div>
    ) },
    { key: "specialization", label: "СПЕЦИАЛИЗАЦИЯ", width: "1.2fr", render: (r) => <span style={{ fontSize: 11, color: "#6B6355" }}>{r.specialization || "—"}</span> },
    { key: "role", label: "РОЛЬ", width: "120px", filter: true, render: (r) => <span style={{ fontSize: 11, color: "#A89070" }}>{r.role || "—"}</span> },
    { key: "pay_label", label: "СХЕМА", width: "110px", render: (r) => <span style={{ fontSize: 10, color: r.pay_label ? "#1A1A1A" : "#C8C0B0" }}>{r.pay_label || "—"}</span> },
    { key: "paid_total", label: "ВЫПЛАЧЕНО", width: "110px", align: "right", render: (r) => <span style={{ fontSize: 12, color: r.paid_total > 0 ? "#4A7C59" : "#C8C0B0", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{r.paid_total > 0 ? fmt(r.paid_total) : "—"}</span> },
    { key: "debt", label: "ДОЛГ", width: "90px", align: "right", render: (r) => <span style={{ fontSize: 12, fontWeight: 600, color: r.debt > 0 ? "#8B3A3A" : "#C8C0B0", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{r.debt > 0 ? fmt(r.debt) : "—"}</span> },
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
    { key: "category", label: "КАТЕГОРИЯ", width: "150px", render: (r) => <span style={{ fontSize: 11, color: "#6B6355" }}>{r.category || "—"}</span> },
    { key: "phone", label: "ТЕЛЕФОН", width: "130px", render: (r) => <span style={{ fontFamily: MONO }}>{r.phone || "—"}</span> },
    { key: "price_supplier", label: "ПРАЙС", width: "110px", render: (r) => <span style={{ fontSize: 10, color: r.price_supplier ? "#E8592A" : "#C8C0B0" }}>{PRICE_SUPPLIER_LABELS[r.price_supplier] || "—"}</span> },
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
    { key: "name", label: "НАЗВАНИЕ", width: "1.4fr", filter: true, render: (r) => <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO }}>{r.name}</span> },
    { key: "description", label: "ОПИСАНИЕ", width: "2fr", render: (r) => <span style={{ fontSize: 12, color: "#6B6355", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", paddingRight: 16 }}>{r.description || "—"}</span> },
    { key: "_income", label: "ДОХОД", width: "120px", align: "right", render: (r) => <span style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{r._fin ? fmt(r._fin.income) : "—"}</span> },
    { key: "_profit", label: "ПРИБЫЛЬ", width: "120px", align: "right", render: (r) => <span style={{ fontSize: 13, fontWeight: 700, color: r._fin && r._fin.profit < 0 ? "#8B3A3A" : "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{r._fin ? fmt(r._fin.profit) : "—"}</span> },
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
    { key: "name", label: "НАЗВАНИЕ", width: "1.4fr", filter: true, render: (r) => <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{r.name}</span> },
    { key: "kind", label: "ТИП", width: "90px", filter: true, render: (r) => <span style={{ fontSize: 12, color: "#6B6355" }}>{r.kind || "—"}</span> },
    { key: "inn", label: "ИНН", width: "130px", render: (r) => <span style={{ fontSize: 12, color: "#A89070", fontFamily: MONO }}>{r.inn || "—"}</span> },
    { key: "accounts", label: "СЧЕТА", width: "1.6fr", render: (r) => (
      <span style={{ fontSize: 11, color: "#6B6355" }}>
        {(r.accounts || []).length === 0 ? "—" : (r.accounts || []).map((a: any) => (
          <span key={a.id} style={{ display: "inline-block", marginRight: 10 }}>{a.name} <span style={{ color: "#A89070", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(a.balance || 0)}</span></span>
        ))}
      </span>
    ) },
    { key: "balance_total", label: "БАЛАНС", width: "120px", align: "right", render: (r) => <span style={{ fontSize: 14, fontWeight: 700, color: r.balance_total >= 0 ? "#1A1A1A" : "#8B3A3A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(r.balance_total || 0)}</span> },
  ],
};

export const WIKI_CATEGORIES: WikiCategory[] = [clients, contractors, suppliers, brands, units];

export function findCategory(key: string | undefined): WikiCategory {
  return WIKI_CATEGORIES.find(c => c.key === key) || WIKI_CATEGORIES[0];
}
