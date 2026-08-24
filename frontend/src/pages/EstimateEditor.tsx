import { fmtMoneyDash as fmt } from "../components/ui/format";
import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "../components/ui/EmptyState";
import { ordersApi, estimatesApi, catalogApi, mastersApi, workTypesApi, materialsApi } from "../api";
import { useNavigationGuard, NavigationGuardModal } from "../components/NavigationGuard";
import { CostingBlock } from "../components/CostingBlock";
import { MediaGallery } from "../components/MediaGallery";
import { Modal, ConfirmModal } from "../components/ui/Modal";
import { CalcHeader, CalcSection, CalcRow, CalcFooter } from "../components/ui/Calc";
import { BrandSelect, EditableText } from "../components/ui/Selects";
import { markupToPct, pctToMarkup, clientPrice, cashFromClient, taxFor } from "../components/ui/priceMath";
import { Breadcrumbs } from "../components/ui/Breadcrumbs";
import { MONO } from "../components/ui/Num";

const SANS = "inherit";
import {
  Plus, Trash, Package, Cube,
  FileText, DotsSixVertical, PencilSimple, FloppyDisk, ListChecks, CheckCircle, Circle,
  Article } from "@phosphor-icons/react";


// sale_price храним с копейками: введённое клиентское «к оплате» первично, и
// round(sale × (1+банк%)) обязан воспроизводить его точно. Округление sale до
// целого рубля теряло рубль на обратном пересчёте (15300×3 → 45899).
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Порог маржи: если наценка (sale/cost) ниже ×1.8 — тонкая маржа, предупреждаем.
const LOW_MARKUP = 1.8;

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

function ItemModal({ item, onClose, onRefetch, initialReadOnly }: {
  item: any;
  onClose: () => void;
  onRefetch: () => void;
  initialReadOnly?: boolean;
}) {
  const lines: any[] = item.lines ?? [];
  const [readOnly, setReadOnly] = useState(!!initialReadOnly);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const [masters, setMasters] = useState<any[]>([]);
  const [workTypes, setWorkTypes] = useState<any[]>([]);

  const { data: etalonItem } = useQuery({
    queryKey: ["catalog-item", item.catalog_item_id],
    queryFn: () => catalogApi.items.get(item.catalog_item_id),
    enabled: !!item.catalog_item_id,
  });

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
    if (!readOnly && lines.length === 0) {
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

  const materialLines = lines.filter((l: any) => l.type === "material");
  const laborLines = lines.filter((l: any) => l.type === "labor" || l.type === "service");
  const deliveryLines = lines.filter((l: any) => l.type === "delivery");
  const perUnitCost = lines.reduce((s: number, l: any) => s + (l.line_total || 0), 0);

  const addLine = (type: string) =>
    save(() => estimatesApi.addLine(item.id, { type, title: "", qty: 1, unit: type === "labor" ? "ч" : "шт", unit_price: 0 }));

  const changeQty = (v: string) => {
    const newQty = parseInt(v) || 1;
    const oldQty = item.quantity || 1;
    const costUnit = (item.cost_total || 0) / oldQty;
    const saleUnit = (item.sale_price || 0) / oldQty;
    const payload: any = { quantity: newQty, sale_price: round2(saleUnit * newQty) };
    if ((item.lines?.length ?? 0) === 0) payload.cost_total = Math.round(costUnit * newQty);
    save(() => estimatesApi.updateItem(item.id, payload));
  };

  const renderRow = (line: any) => (
    <CalcRow
      key={line.id}
      line={line}
      isMaterial={line.type === "material"}
      withContractor
      withAutocomplete={line.type === "material"}
      materialsFetch={materialsApi.search}
      workTypes={workTypes}
      masters={masters}
      readOnly={readOnly}
      onPatch={p => save(() => estimatesApi.updateLine(line.id, p))}
      onRemove={() => save(() => estimatesApi.deleteLine(line.id))}
      onPickMaterial={m => save(() => estimatesApi.updateLine(line.id, {
        title: m.name, unit: m.unit || "шт", unit_price: m.price || 0,
        material_code: m.id, price_supplier: m.supplier, price_date: m.price_date,
      }))}
      onPickWorkType={wt => save(() => estimatesApi.updateLine(line.id, { work_type_id: wt?.id }))}
      onCreateWorkType={name => createWorkType(line, name)}
      onPickMaster={mid => pickMaster(line, mid)}
      onCreateMaster={name => createMaster(line, name)}
    />
  );

  const fieldLabel: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 };

  const syncBtn = (
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
  );

  const editBtn = (
    <button
      onClick={() => setReadOnly(false)}
      style={{ fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1px solid #E8592A", background: "transparent", color: "#E8592A", padding: "4px 12px", display: "flex", alignItems: "center", gap: 5 }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#E8592A"; (e.currentTarget as HTMLElement).style.color = "#fff"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "#E8592A"; }}
    >
      <PencilSimple size={12} /> Редактировать
    </button>
  );

  return (
    <Modal size="lg" eyebrow={readOnly ? "ПОЗИЦИЯ СМЕТЫ · ПРОСМОТР" : "ПОЗИЦИЯ СМЕТЫ"} onClose={onClose} footerLeft={readOnly ? editBtn : syncBtn} onSave={onClose} saveLabel="ОК">
      <div style={{ padding: "16px 24px 0" }}>
        <div style={fieldLabel}>НАЗВАНИЕ</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1A1A" }}>
          {readOnly
            ? (item.title || <span style={{ color: "#C8C0B0" }}>Без названия</span>)
            : <EditableText value={item.title} placeholder="Название позиции"
                onSave={v => save(() => estimatesApi.updateItem(item.id, { title: v }))} />}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 16, marginTop: 14, alignItems: "end" }}>
          <div>
            <div style={fieldLabel}>КОЛ-ВО</div>
            <div style={{ fontSize: 13, color: "#1A1A1A", width: 70, borderBottom: readOnly ? "none" : "1px solid #EDEBE6" }}>
              {readOnly ? (item.quantity ?? 1) : <EditableText value={item.quantity ?? 1} numeric onSave={changeQty} />}
            </div>
          </div>
          <div>
            <div style={fieldLabel}>БРЕНД</div>
            {readOnly
              ? <span style={{ fontSize: 13, color: item.brand ? "#1A1A1A" : "#C8C0B0", fontFamily: MONO }}>{item.brand || "—"}</span>
              : <BrandSelect value={item.brand ?? null}
                  onChange={b => save(() => estimatesApi.updateItem(item.id, { brand: b }))} />}
          </div>
        </div>

        {item.catalog_item_id ? (
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#FAF8F5", borderLeft: "2px solid #E8592A" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>
              <span style={{ color: "#E8592A" }}>●</span> ЭТАЛОН ИЗ КАТАЛОГА
              {etalonItem?.title && <span style={{ color: "#6B6355" }}>· «{etalonItem.title}»</span>}
            </div>
            {etalonItem?.cost_total != null && (() => {
              const et = etalonItem.cost_total as number;
              const curUnit = lines.length ? perUnitCost : (item.cost_total || 0) / (item.quantity || 1);
              const dev = et ? Math.round((curUnit - et) / et * 100) : null;
              return (
                <div style={{ marginTop: 6, fontSize: 12, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#1A1A1A" }}>
                  эталон {fmt(et)}/шт · текущий {fmt(curUnit)}/шт
                  {dev != null && <span style={{ color: curUnit <= et ? "#4A7C59" : "#8B3A3A", marginLeft: 6 }}>Δ {dev > 0 ? "+" : ""}{dev}%</span>}
                </div>
              );
            })()}
            <div style={{ marginTop: 4, fontSize: 10, color: "#A89070" }}>Правки этой позиции попадут в историю карточки</div>
          </div>
        ) : (
          <div style={{ marginTop: 14, fontSize: 10, color: "#C8C0B0" }}>Не из каталога — правки не копятся в историю карточки</div>
        )}

        <div style={{ marginTop: 18 }}><CalcHeader withContractor /></div>
        <CalcSection label="Материалы" addLabel="Добавить материал" readOnly={readOnly} onAdd={() => addLine("material")}>
          {materialLines.map(renderRow)}
        </CalcSection>
        <CalcSection label="Работы" addLabel="Добавить работу" readOnly={readOnly} onAdd={() => addLine("labor")}>
          {laborLines.map(renderRow)}
        </CalcSection>
        <CalcSection label="Доставка" addLabel="Добавить доставку" readOnly={readOnly} onAdd={() => addLine("delivery")}>
          {deliveryLines.map(renderRow)}
        </CalcSection>

        {/* Картинки позиции — переопределение для этого заказа: разовый МАФ каталога
            не имеет и получает картинку сюда, ничего не засоряя в каталоге. */}
        <MediaGallery estimateItemId={item.id} readOnly={readOnly} compact />
      </div>

      {/* Двусторонний ввод: коэффициент → цена, цена (за шт) → коэффициент.
          Якорь = цена: при изменении состава цена держится, markup подстроит сервер. */}
      <CalcFooter
        cost={perUnitCost}
        pct={markupToPct(item.markup, 1)}
        price={item.sale_price > 0 ? item.sale_price / (item.quantity || 1) : null}
        withQuantity
        quantity={item.quantity ?? 1}
        onPctChange={readOnly ? undefined : (pct) => {
          const markup = pctToMarkup(pct);
          const payload: any = { markup };
          if (perUnitCost > 0) payload.sale_price = round2(perUnitCost * (item.quantity || 1) * markup);
          save(() => estimatesApi.updateItem(item.id, payload));
        }}
        onPriceChange={readOnly ? undefined : (priceUnit) => {
          const qty = item.quantity || 1;
          const payload: any = { sale_price: round2(priceUnit * qty) };
          if (perUnitCost > 0) payload.markup = Math.round((priceUnit / perUnitCost) * 1000) / 1000;
          save(() => estimatesApi.updateItem(item.id, payload));
        }}
      />
    </Modal>
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
    <Modal size="sm" eyebrow="ИЗ КАТАЛОГА" onClose={onClose}>
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
            <EmptyState compact title="Каталог пуст" />
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
    </Modal>
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
    <div style={{ display: "grid", gridTemplateColumns: cols, padding: "7px 28px", gap: 12, alignItems: "center", borderBottom: "1px solid #F2EFE9", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
      <div />
      <div style={{ fontFamily: SANS }}>
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
  const [open, setOpen] = useState<{ id: string; readOnly: boolean } | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  const [obligating, setObligating] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  // Утверждение и рассогласование — через свои защищённые ручки, а не через
  // PUT {status}. Раньше кнопка шла в updateSet и проходила мимо гейта нулевых цен
  // (цена заказа молча становилась 0 ₽), а «снять» меняло одну надпись.
  const [approveForce, setApproveForce] = useState<string | null>(null);   // текст 409 от бэка
  const [unapprove, setUnapprove] = useState<any>(null);                   // последствия отката
  const [setBusy, setSetBusy] = useState(false);
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

  // superseded — исторические версии, в табах не показываем (одна активная смета на заказ)
  const visibleSets = (sets as any[]).filter((s: any) => s.status !== "superseded");
  const activeSetId = selectedSetId ?? (visibleSets[0]?.id ?? (sets as any[])[0]?.id ?? null);
  const activeSet   = (sets as any[]).find((s: any) => s.id === activeSetId) ?? null;
  const isApproved  = activeSet?.status === "approved";
  useEffect(() => { if (isApproved && editMode) setEditMode(false); }, [isApproved]);
  const { data: priceCheck } = useQuery({
    queryKey: ["estimate-price-check", activeSetId, activeSet?.updated_at],
    queryFn: () => estimatesApi.priceCheck(activeSetId!),
    enabled: !!activeSetId,
  });
  const items: any[] = activeSet?.items ?? [];
  const openItem    = open ? (items.find((it: any) => it.id === open.id) ?? null) : null;

  const totalCost   = items.reduce((s: number, it: any) => s + (it.cost_total || 0), 0);
  const totalSale   = items.reduce((s: number, it: any) => s + (it.sale_price || 0), 0);
  const totalDelta  = totalSale - totalCost;
  const totalQty    = items.reduce((s: number, it: any) => s + (it.quantity || 1), 0);
  const totalFact   = items.reduce((s: number, it: any) => s + (it.actual_paid || 0), 0);
  const avgMarkup   = totalCost > 0 ? totalSale / totalCost : 0;
  const bankPct    = activeSet?.bank_pct ?? 13;
  const isBank     = activeSet?.payment_type === "bank";
  const isTransit  = activeSet?.payment_type === "transit";
  // Удержание банка — свойство сметы (см. money.py): позиционный bank_pct в расчёте
  // не участвует, там в данных мусор.
  const clientPriceForItem = (it: any) => clientPrice(it.sale_price || 0, isBank, bankPct);
  const totalClient  = items.reduce((s: number, it: any) => s + clientPriceForItem(it), 0);
  const grandTotal   = isBank ? totalClient : totalSale;
  // УСН и у транзита: деньги проходят через р/с, налог со всей суммы счёта —
  // та же логика, что orders._margin. Раньше редактор считал транзит без налога
  // и показывал прибыль выше, чем карточка того же заказа.
  const taxes        = taxFor(activeSet?.payment_type, grandTotal);

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

  const doApprove = async (force = false) => {
    if (!activeSetId) return;
    setSetBusy(true);
    try {
      await estimatesApi.approveSet(activeSetId, force);
      setApproveForce(null);
      refetch();
    } catch (e: any) {
      // 409 — «в смете нет продажных цен»: спрашиваем, а не утверждаем молча.
      if (e?.response?.status === 409) setApproveForce(String(e.response.data?.detail || "Утвердить всё равно?"));
      else alert(e?.response?.data?.detail || "Не удалось утвердить смету");
    } finally { setSetBusy(false); }
  };

  const doUnapprove = async (confirm = false) => {
    if (!activeSetId) return;
    setSetBusy(true);
    try {
      await estimatesApi.unapproveSet(activeSetId, confirm);
      setUnapprove(null);
      refetch();
    } catch (e: any) {
      const d = e?.response?.data?.detail;
      if (e?.response?.status === 409 && d?.code === "unapprove_confirm") setUnapprove(d);
      else alert(typeof d === "string" ? d : "Не удалось снять согласование");
    } finally { setSetBusy(false); }
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
    setOpen({ id: it.id, readOnly: false });
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

  const [kping, setKping] = useState(false);
  const generateKp = async () => {
    if (!activeSetId) return;
    setKping(true);
    try {
      const blob = await estimatesApi.kp(activeSetId);
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (e: any) {
      alert("Ошибка генерации КП: " + (e?.response?.data?.detail ?? ""));
    } finally {
      setKping(false);
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

        {/* Left fixed: крошки Заказы › {заказ} › Смета — каждый уровень кликабелен */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Breadcrumbs items={[
            { label: "Заказы", to: "/orders" },
            { label: order?.title ?? String(orderId), to: `/orders/${orderId}` },
            { label: "Смета" },
          ]} />
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
              {visibleSets.map((s: any, i: number) => {
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
                {[{ v: "cash", l: "Нал" }, { v: "bank", l: "Безнал" }, { v: "transit", l: "Транзит" }].map(pt => (
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

              {/* Признак расчёта словами: раньше «нал/безнал» был виден только чипом,
                  и расхождение сметы со счётом ловилось вручную (ТЗ 27.07, п.2.2) */}
              <span style={{ fontSize: 10, color: isBank || isTransit ? "#E8592A" : "#A89070", whiteSpace: "nowrap" }}>
                {isTransit
                  ? `транзит — счёт не пересчитывается, ${bankPct}% удерживаются, остальное уходит контрагенту`
                  : isBank
                  ? `безнал — из суммы счёта удерживается ${bankPct}%`
                  : "цены за наличный расчёт"}
              </span>

              {/* Банк % */}
              {isBank && (
                <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <span style={{ fontSize: 11, color: "#A89070" }}>Банк</span>
                  {editMode ? (
                    <input
                      key={activeSet.bank_pct}
                      defaultValue={activeSet.bank_pct ?? 13}
                      onBlur={e => updateSet({ bank_pct: Number.isFinite(parseFloat(e.target.value)) ? parseFloat(e.target.value) : 13 })}
                      style={{ width: 30, border: "1px solid #EDEBE6", background: "transparent", fontSize: 11, textAlign: "center", padding: "3px 2px", outline: "none" }}
                    />
                  ) : (
                    <span style={{ fontSize: 11, color: "#A89070" }}>{bankPct}%</span>
                  )}
                </div>
              )}

              {/* A10: контур себестоимости — legacy-сметы считались по ценам,
                  которых больше нет; их маржу нельзя сравнивать с новой */}
              {activeSet.costing_version === "legacy" && (
                <span title="Смета до costing-движка (22.07.2026): цены старого образца, маржу с новыми сметами не сравнивать"
                  style={{ fontSize: 9, color: "#8B3A3A", background: "#F7EDED", padding: "2px 6px", letterSpacing: "0.05em" }}>
                  СТАРЫЙ КОНТУР ЦЕН
                </span>
              )}

              <div style={{ width: 1, height: 18, background: "#EDEBE6", margin: "0 2px" }} />

              {/* Согласовать */}
              <button
                onClick={() => (activeSet.status === "approved" ? doUnapprove(false) : doApprove(false))}
                disabled={setBusy}
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

              {/* КП — генератор фин-агента (kp.py), шаблон один на систему */}
              <button
                onClick={generateKp}
                disabled={kping}
                title="Сгенерировать КП (коммерческое предложение)"
                style={{
                  width: 28, height: 28, padding: 0, cursor: kping ? "default" : "pointer",
                  border: "1px solid #EDEBE6", background: "transparent",
                  color: kping ? "#C8C0B0" : "#6B6355",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
                onMouseEnter={e => { if (!kping) { (e.currentTarget as HTMLElement).style.borderColor = "#1A1A1A"; (e.currentTarget as HTMLElement).style.color = "#1A1A1A"; } }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; (e.currentTarget as HTMLElement).style.color = kping ? "#C8C0B0" : "#6B6355"; }}
              >
                <Article size={16} />
              </button>

              <div style={{ width: 1, height: 18, background: "#EDEBE6", margin: "0 2px" }} />

              {/* Утверждённая смета заморожена — правки только новой версией */}
              {isApproved ? (
                <button
                  onClick={async () => {
                    const nv = await estimatesApi.newVersion(activeSet.id);
                    await refetch();
                    setSelectedSetId(nv.id);
                    setEditMode(true);
                  }}
                  title="Смета согласована и заморожена. Создать редактируемую версию"
                  style={{ padding: "5px 12px", border: "1px solid #EDEBE6", background: "transparent", color: "#6B6355", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#1A1A1A"; (e.currentTarget as HTMLElement).style.color = "#1A1A1A"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#EDEBE6"; (e.currentTarget as HTMLElement).style.color = "#6B6355"; }}
                >
                  <PencilSimple size={14} /> Новая версия
                </button>
              ) : editMode ? (
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

          {/* ─ Алерт протухшей сметы (возраст >14 дней или металл подорожал >5%) ─ */}
          {priceCheck?.stale && (
            <div style={{ margin: "8px 28px 0", padding: "9px 12px", background: "#FFF4EE", borderLeft: "2px solid #E8592A", display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#8B3A3A", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "#E8592A" }}>⚠</span> Пересчитать перед выставлением счёта
              </div>
              {priceCheck.stale_age && (
                <div style={{ fontSize: 11, color: "#6B6355" }}>
                  Смета не обновлялась {priceCheck.age_days} дн. (порог 14) — цены могли устареть.
                </div>
              )}
              {priceCheck.risen?.map((r: any) => (
                <div key={r.line_id} style={{ fontSize: 11, color: "#6B6355", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                  «{r.title}»: в смете {fmt(r.frozen_price)} → сейчас {fmt(r.current_price)} ({r.supplier})
                  <span style={{ color: "#8B3A3A", fontWeight: 600, marginLeft: 6 }}>+{r.pct}%</span>
                </div>
              ))}
            </div>
          )}

          {/* ─ Себестоимость: заполнить из каталога/прайсов/ставок или спросить ─ */}
          {activeSet && (
            <CostingBlock
              setId={activeSet.id}
              editable={activeSet.status !== "approved"}
              onChanged={() => refetch()}
            />
          )}

          {/* ─ Table: horizontally scrollable, vertically flex ───────────── */}
          <div style={{ flex: 1, overflowX: "auto", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ minWidth: 1020, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>

          {/* ─ Column headers ─────────────────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: colsMain, padding: "7px 28px", gap: 12, borderBottom: "1px solid #EDEBE6", flexShrink: 0 }}>
            {/* per-unit колонки вводятся В РЕЖИМЕ ПРАВКИ (карандаш): итог = ввод × кол-во */}
            {["", "Позиция", "Кол-во", "Наценка", "Себест./шт", "Себест.", "Факт", isBank ? "К опл./шт" : "Клиент./шт", isBank ? "К оплате" : "Клиенту", "Δ Доход", ""].map((h, i) => (
              <div key={i}
                title={i === 4 || i === 7 ? "Вводится за штуку в режиме правки (карандаш) — итог посчитается сам (× кол-во)" : undefined}
                style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", textAlign: i >= 4 ? "right" : "left" }}>{h}</div>
            ))}
          </div>

          {/* ─ Item rows ──────────────────────────────────────────────────── */}
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {items.length === 0 && (
              <EmptyState title="Добавьте позиции в смету" />
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
                  fontFamily: MONO, fontVariantNumeric: "tabular-nums",
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
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A", fontFamily: SANS }} onClick={e => e.stopPropagation()}>
                  {(item.lines?.length ?? 0) > 0 ? (
                    <span
                      onClick={() => setOpen({ id: item.id, readOnly: true })}
                      title="Открыть калькулятор (просмотр)"
                      style={{ cursor: "pointer", borderBottom: "1px dashed #C8C0B0" }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#E8592A")}
                      onMouseLeave={e => (e.currentTarget.style.color = "#1A1A1A")}
                    >
                      {item.title || "Без названия"}
                    </span>
                  ) : editMode ? (
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
                        const payload: any = { quantity: newQty, sale_price: round2(saleUnit * newQty) };
                        if ((item.lines?.length ?? 0) === 0) payload.cost_total = Math.round(costUnit * newQty);
                        estimatesApi.updateItem(item.id, payload).then(() => refetch());
                      }}
                    />
                  ) : (
                    item.quantity ?? 1
                  )}
                </div>

                {/* Наценка — производная (sale/cost). Красная + ⚠, если ниже 1.8 */}
                {(() => {
                  // У транзита низкая наценка — норма, а не тревога: удержание Юры
                  // и есть 13%, наценка тут производная и ни о чём не сигналит.
                  const lowMargin = !isTransit && (item.cost_total || 0) > 0 && (item.markup || 0) < LOW_MARKUP;
                  const col = lowMargin ? "#8B3A3A" : "#6B6355";
                  return (
                    <div style={{ fontSize: 12, color: col }} title={lowMargin ? `Наценка ниже ×${LOW_MARKUP} — тонкая маржа` : undefined}>
                      {editMode ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 2, color: col }}>
                          +<EditCell
                            value={markupToPct(item.markup)}
                            numeric
                            style={{ color: col }}
                            onSave={v => {
                              const markup = pctToMarkup(parseFloat(v) || 0);
                              const cost = item.cost_total || 0;
                              const payload: any = { markup };
                              if (cost > 0) payload.sale_price = round2(cost * markup);
                              estimatesApi.updateItem(item.id, payload).then(() => refetch());
                            }}
                          />%
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4 }}>
                          {lowMargin && <span style={{ fontSize: 11 }} title={`ниже ×${LOW_MARKUP}`}>⚠</span>}
                          <span>+{markupToPct(item.markup)}%</span>
                          <span style={{ fontSize: 10, color: "#C8C0B0" }}>×{pctToMarkup(markupToPct(item.markup))}</span>
                        </span>
                      )}
                    </div>
                  );
                })()}

                {/* Себест./шт — редактируемо только у позиций без калькулятора; со строками — правка в кубе */}
                {(() => {
                  const qty = item.quantity || 1;
                  const costUnit = Math.round((item.cost_total || 0) / qty);
                  if (editMode && (item.lines?.length ?? 0) === 0) {
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
                  // «За штуку» определено всегда (qty=1 → равно итогу): прочерк
                  // читался как «не указывается» и заставлял считать руками.
                  const fromLines = (item.lines?.length ?? 0) > 0;
                  return (
                    <div style={{ fontSize: 11, color: qty > 1 ? "#A89070" : "#C8C0B0", textAlign: "right" }}
                         title={fromLines ? "Считается из состава — правь в калькуляторе (куб)" : undefined}>
                      {costUnit > 0 ? fmt(costUnit) : <span style={{ color: "#EDEBE6" }}>—</span>}
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
                            // Введённое «к оплате/шт» — первичный показатель: итог = ввод × qty,
                            // банковский % — производная (sale без округления до рубля).
                            const clientTotal = newPriceUnit * qty;
                            const sale_new = isBank
                              ? round2(cashFromClient(clientTotal, true, bankPct))
                              : round2(clientTotal);
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
                    <div style={{ fontSize: 11, color: isBank ? "#E8592A" : (qty > 1 ? "#A89070" : "#C8C0B0"), textAlign: "right", opacity: 0.7 }}>
                      {priceUnit > 0 ? fmt(priceUnit) : <span style={{ color: "#EDEBE6" }}>—</span>}
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
                  {(item.lines?.length ?? 0) > 0 ? (
                    <span title="Рассчитано — откройте по названию позиции" style={{ color: "#4A7C59", padding: 2, display: "flex", cursor: "default" }}>
                      <Cube size={13} weight="fill" />
                    </span>
                  ) : (
                    <button
                      onClick={e => { e.stopPropagation(); setOpen({ id: item.id, readOnly: false }); }}
                      title="Заполнить калькулятор"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2, display: "flex" }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#6B6355")}
                      onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}
                    >
                      <Cube size={13} />
                    </button>
                  )}
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
            <div style={{ display: "grid", gridTemplateColumns: colsMain, padding: "7px 28px", gap: 12, alignItems: "center", borderBottom: "1px solid #F2EFE9", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
              <div />
              <div style={{ fontSize: 11, color: "#A89070", fontFamily: SANS }}>Итого</div>
              <div style={{ fontSize: 12, color: "#6B6355" }}>{totalQty}</div>
              <div style={{ fontSize: 12, color: avgMarkup > 0 && avgMarkup < LOW_MARKUP ? "#8B3A3A" : "#6B6355" }}
                title={avgMarkup > 0 && avgMarkup < LOW_MARKUP ? `Средняя наценка ниже ×${LOW_MARKUP}` : undefined}>
                {(() => { const p = markupToPct(avgMarkup); const low = !isTransit && avgMarkup > 0 && avgMarkup < LOW_MARKUP; return `${low ? "⚠ " : ""}${p >= 0 ? "+" : ""}${p}%`; })()}
              </div>
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
          initialReadOnly={open?.readOnly}
          onClose={() => setOpen(null)}
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
      <ConfirmModal
        message={`Смета «${activeSet?.title || `Смета ${(sets as any[]).findIndex((s: any) => s.id === activeSetId) + 1}`}» и все её позиции будут удалены без возможности восстановления.`}
        confirmLabel="Удалить"
        onConfirm={async () => {
          const remaining = (sets as any[]).filter((s: any) => s.id !== activeSetId);
          await estimatesApi.deleteSet(activeSetId!);
          setConfirmDeleteSet(false);
          setEditMode(false);
          setSelectedSetId(remaining[0]?.id ?? null);
          refetch();
        }}
        onCancel={() => setConfirmDeleteSet(false)}
      />
    )}

    {/* Confirm revert obligations */}
    {confirmRevert && (
      <ConfirmModal
        message="Все обязательства, созданные по этой смете, будут удалены. Если по ним уже зафиксированы оплаты — они тоже пропадут."
        confirmLabel="Удалить обязательства"
        onConfirm={async () => {
          setConfirmRevert(false);
          await estimatesApi.deleteObligations(activeSetId!);
          refetch();
        }}
        onCancel={() => setConfirmRevert(false)}
      />
    )}

    {/* Утверждение сметы без продажных цен — только осознанно */}
    {approveForce && (
      <ConfirmModal
        message={approveForce}
        confirmLabel="Всё равно утвердить"
        onConfirm={() => doApprove(true)}
        onCancel={() => setApproveForce(null)}
      />
    )}

    {/* Рассогласование: показываем последствия ДО нажатия */}
    {unapprove && (
      <Modal size="md" eyebrow="СНЯТЬ СОГЛАСОВАНИЕ" onClose={() => setUnapprove(null)}
             onCancel={() => setUnapprove(null)} onSave={() => doUnapprove(true)}
             saving={setBusy} saveLabel="Снять согласование">
        <div style={{ fontSize: 12, color: "#1A1A1A", lineHeight: 1.7 }}>
          Смета вернётся в черновики, признак основной будет снят, план заказа пересчитается
          по новой активной смете.
        </div>
        <div style={{ marginTop: 14, fontSize: 12, color: "#6B6355", lineHeight: 1.9 }}>
          {unapprove.restore_sets > 0 && (
            <div>· Вернётся в черновики других смет: <b>{unapprove.restore_sets}</b></div>
          )}
          {unapprove.obligations_delete?.length > 0 && (
            <div>· Будет удалено обязательств (по ним не было денег): <b>{unapprove.obligations_delete.length}</b></div>
          )}
          {unapprove.obligations_keep?.length > 0 && (
            <div style={{ color: "#8B3A3A" }}>
              · Останутся — по ним уже прошли деньги: <b>{unapprove.obligations_keep.length}</b>
            </div>
          )}
        </div>
        {unapprove.obligations_keep?.length > 0 && (
          <div style={{ marginTop: 12, padding: "10px 12px", background: "#FFF4EE", borderLeft: "2px solid #8B3A3A" }}>
            {unapprove.obligations_keep.map((o: any) => (
              <div key={o.id} style={{ fontSize: 11, color: "#6B6355", lineHeight: 1.7 }}>
                {o.name} — признано {fmt(o.paid || o.covered)}
              </div>
            ))}
            <div style={{ fontSize: 10, color: "#A89070", marginTop: 6, lineHeight: 1.6 }}>
              Такие обязательства не удаляем: на них держится факт себестоимости заказа.
            </div>
          </div>
        )}
      </Modal>
    )}

    {/* Confirm switching estimate while in edit mode */}
    {pendingSwitchId && (
      <ConfirmModal
        message="Если перейти на другую смету сейчас, все незаписанные изменения будут потеряны."
        confirmLabel="Перейти без сохранения"
        onConfirm={() => { setSelectedSetId(pendingSwitchId); setEditMode(false); setPendingSwitchId(null); }}
        onCancel={() => setPendingSwitchId(null)}
      />
    )}
    </>
  );
}
