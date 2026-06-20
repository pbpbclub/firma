import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { brandsApi, financeApi, businessUnitsApi, ordersApi } from "../api";
import { X, Plus, Trash } from "@phosphor-icons/react";

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n || 0) + " ₽";
}

const RAL_PALETTE = [
  { name: "vinyl",        ral: "RAL 9005", hex: "#0A0A0A" },
  { name: "cocoa",        ral: "RAL 8025", hex: "#755C48" },
  { name: "glaze",        ral: "RAL 4009", hex: "#A18594" },
  { name: "sky",          ral: "RAL 5024", hex: "#5B9BD5" },
  { name: "concrete",     ral: "RAL 7004", hex: "#9EA0A1" },
  { name: "wine",         ral: "RAL 3011", hex: "#781F19" },
  { name: "aperol",       ral: "RAL 2004", hex: "#E75B12" },
  { name: "powder",       ral: "RAL 1015", hex: "#E6D2B5" },
  { name: "cotton candy", ral: "RAL 3015", hex: "#E8A0B5" },
  { name: "matcha",       ral: "RAL 6011", hex: "#6C7C59" },
  { name: "lagoon",       ral: "RAL 5005", hex: "#1E4B8C" },
  { name: "porcelain",    ral: "RAL 9003", hex: "#F4F4F4" },
  { name: "mint",         ral: "RAL 6019", hex: "#BDECB6" },
  { name: "limoncello",   ral: "RAL 1018", hex: "#F8F32B" },
  { name: "salmon",       ral: "RAL 3022", hex: "#D56D56" },
];

const FIELDS: { key: string; label: string; type?: string }[] = [
  { key: "name", label: "Название" },
  { key: "description", label: "Описание", type: "textarea" },
  { key: "positioning", label: "Позиционирование", type: "textarea" },
  { key: "notes", label: "Заметки", type: "textarea" },
];

function BrandModal({ brand, onClose }: { brand: any; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isNew = !brand?.id;
  const { data: brandOrders = [] } = useQuery({
    queryKey: ["orders", "brand", brand?.name],
    queryFn: () => ordersApi.list({ brand: brand.name }),
    enabled: !isNew && !!brand?.name,
  });
  const [form, setForm] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = { color: brand?.color ?? "" };
    for (const fl of FIELDS) f[fl.key] = brand?.[fl.key] ?? "";
    return f;
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const set = (k: string, v: string) => setForm(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(form)) payload[k] = v.trim() || null;
      if (isNew) await brandsApi.create(payload);
      else await brandsApi.update(brand.id, payload);
      qc.invalidateQueries({ queryKey: ["brands"] });
      qc.invalidateQueries({ queryKey: ["finance-by-brand"] });
      onClose();
    } finally { setSaving(false); }
  };

  const del = async () => {
    setDeleting(true);
    try {
      await brandsApi.delete(brand.id);
      qc.invalidateQueries({ queryKey: ["brands"] });
      onClose();
    } finally { setDeleting(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6",
    padding: "7px 10px", fontSize: 13, outline: "none",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", width: 480, maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 24px 14px", borderBottom: "1px solid #EDEBE6" }}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>{isNew ? "НОВЫЙ БРЕНД" : "РЕДАКТИРОВАТЬ БРЕНД"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070" }}><X size={16} /></button>
        </div>
        <div style={{ padding: "16px 24px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          {FIELDS.map(f => (
            <div key={f.key}>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>{f.label.toUpperCase()}</div>
              {f.type === "textarea" ? (
                <textarea value={form[f.key]} onChange={e => set(f.key, e.target.value)} rows={2}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
              ) : (
                <input value={form[f.key]} onChange={e => set(f.key, e.target.value)} style={inputStyle}
                  autoFocus={f.key === "name" && isNew} />
              )}
            </div>
          ))}
          {/* Цвет — палитра RAL pbpb */}
          <div>
            <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>ЦВЕТ</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {RAL_PALETTE.map(c => {
                const selected = (form.color || "").toLowerCase() === c.hex.toLowerCase();
                return (
                  <button
                    key={c.hex}
                    type="button"
                    title={`${c.name} · ${c.ral}`}
                    onClick={() => set("color", c.hex)}
                    style={{
                      width: 28, height: 28, background: c.hex, cursor: "pointer",
                      border: c.hex.toLowerCase() === "#f4f4f4" ? "1px solid #EDEBE6" : "none",
                      outline: selected ? "2px solid #1A1A1A" : "none",
                      outlineOffset: 2,
                      padding: 0,
                    }}
                  />
                );
              })}
            </div>
          </div>
          {/* Заказы бренда */}
          {!isNew && (
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>ЗАКАЗЫ</div>
              {(brandOrders as any[]).length === 0 ? (
                <div style={{ fontSize: 12, color: "#C8C0B0" }}>Заказов нет</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", border: "1px solid #F2EFE9" }}>
                  {(brandOrders as any[]).map((o: any) => (
                    <div key={o.id}
                      onClick={() => { onClose(); navigate(`/orders/${o.id}/estimate`); }}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderBottom: "1px solid #F2EFE9", cursor: "pointer" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                      <span style={{ fontSize: 10, color: "#A89070", minWidth: 56 }}>{o.number}</span>
                      <span style={{ flex: 1, fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.title}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{fmt(o.price_plan || 0)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", borderTop: "1px solid #EDEBE6" }}>
          {!isNew ? (
            confirmDel ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#8B3A3A" }}>Удалить?</span>
                <button onClick={del} disabled={deleting} style={{ fontSize: 11, color: "#fff", background: "#8B3A3A", border: "none", padding: "4px 10px", cursor: "pointer" }}>Да</button>
                <button onClick={() => setConfirmDel(false)} style={{ fontSize: 11, color: "#6B6355", background: "none", border: "none", cursor: "pointer" }}>Нет</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDel(true)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#8B3A3A", display: "flex", alignItems: "center", gap: 5 }}>
                <Trash size={13} /> Удалить
              </button>
            )
          ) : <div />}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ padding: "7px 16px", background: "#F2EFE9", border: "none", cursor: "pointer", fontSize: 12, color: "#6B6355" }}>Отмена</button>
            <button onClick={save} disabled={saving || !form.name.trim()}
              style={{ padding: "7px 18px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: saving || !form.name.trim() ? 0.5 : 1 }}>
              {saving ? "..." : "Сохранить"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const ACCOUNT_SOURCES = [
  { v: "bank", l: "Банк (р/с)" },
  { v: "zenmoney", l: "ZenMoney (личные)" },
  { v: "cash", l: "Наличные" },
  { v: "manual", l: "Вручную" },
];

function BusinessUnitModal({ unit, onClose }: { unit: any; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = !unit?.id;
  const [form, setForm] = useState<Record<string, string>>({
    name: unit?.name ?? "", kind: unit?.kind ?? "ИП", inn: unit?.inn ?? "",
    full_name: unit?.full_name ?? "", notes: unit?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const accounts: any[] = unit?.accounts ?? [];
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));
  const refresh = () => qc.invalidateQueries({ queryKey: ["business-units"] });

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(form)) payload[k] = v.trim() || null;
      if (isNew) await businessUnitsApi.create(payload);
      else await businessUnitsApi.update(unit.id, payload);
      refresh();
      onClose();
    } finally { setSaving(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6",
    padding: "7px 10px", fontSize: 13, outline: "none",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", width: 520, maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 24px 14px", borderBottom: "1px solid #EDEBE6" }}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>{isNew ? "НОВАЯ БИЗНЕС-ЕДИНИЦА" : "БИЗНЕС-ЕДИНИЦА"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070" }}><X size={16} /></button>
        </div>
        <div style={{ padding: "16px 24px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>НАЗВАНИЕ</div>
              <input value={form.name} onChange={e => set("name", e.target.value)} style={inputStyle} autoFocus={isNew} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ТИП</div>
              <select value={form.kind} onChange={e => set("kind", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                <option value="ИП">ИП</option>
                <option value="Физлицо">Физлицо</option>
                <option value="ООО">ООО</option>
              </select>
            </div>
          </div>
          {[
            { k: "full_name", l: "ПОЛНОЕ НАЗВАНИЕ" },
            { k: "inn", l: "ИНН" },
            { k: "notes", l: "ЗАМЕТКИ" },
          ].map(f => (
            <div key={f.k}>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>{f.l}</div>
              <input value={form[f.k]} onChange={e => set(f.k, e.target.value)} style={inputStyle} />
            </div>
          ))}

          {/* Счета */}
          {!isNew && (
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>СЧЕТА</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {accounts.map((a: any) => (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #F2EFE9", padding: "7px 10px" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: "#1A1A1A" }}>{a.name}</div>
                      <div style={{ fontSize: 10, color: "#A89070" }}>
                        {ACCOUNT_SOURCES.find(s => s.v === a.source)?.l || a.source}{a.number ? ` · ${a.number}` : ""}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{fmt(a.balance || 0)}</div>
                    <button onClick={async () => { await businessUnitsApi.deleteAccount(a.id); refresh(); onClose(); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#D0C8C0", padding: 0, display: "flex" }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                      onMouseLeave={e => (e.currentTarget.style.color = "#D0C8C0")}>
                      <Trash size={13} />
                    </button>
                  </div>
                ))}
                <AddAccountRow unitId={unit.id} onAdded={() => { refresh(); onClose(); }} />
              </div>
            </div>
          )}
          {isNew && <div style={{ fontSize: 11, color: "#A89070" }}>Счета можно добавить после создания.</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", borderTop: "1px solid #EDEBE6" }}>
          {!isNew ? (
            confirmDel ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#8B3A3A" }}>Удалить?</span>
                <button onClick={async () => { await businessUnitsApi.delete(unit.id); refresh(); onClose(); }} style={{ fontSize: 11, color: "#fff", background: "#8B3A3A", border: "none", padding: "4px 10px", cursor: "pointer" }}>Да</button>
                <button onClick={() => setConfirmDel(false)} style={{ fontSize: 11, color: "#6B6355", background: "none", border: "none", cursor: "pointer" }}>Нет</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDel(true)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#8B3A3A", display: "flex", alignItems: "center", gap: 5 }}>
                <Trash size={13} /> Удалить
              </button>
            )
          ) : <div />}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ padding: "7px 16px", background: "#F2EFE9", border: "none", cursor: "pointer", fontSize: 12, color: "#6B6355" }}>Закрыть</button>
            <button onClick={save} disabled={saving || !form.name.trim()}
              style={{ padding: "7px 18px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: saving || !form.name.trim() ? 0.5 : 1 }}>
              {saving ? "..." : "Сохранить"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddAccountRow({ unitId, onAdded }: { unitId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [source, setSource] = useState("bank");
  const [number, setNumber] = useState("");
  const inputStyle: React.CSSProperties = { boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "6px 9px", fontSize: 12, outline: "none" };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ background: "none", border: "1px dashed #EDEBE6", cursor: "pointer", fontSize: 12, color: "#A89070", padding: "7px 10px", display: "flex", alignItems: "center", gap: 5 }}>
        <Plus size={11} /> Добавить счёт
      </button>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", border: "1px solid #E8592A", padding: "7px 10px" }}>
      <input placeholder="Название" value={name} onChange={e => setName(e.target.value)} style={{ ...inputStyle, flex: 1 }} autoFocus />
      <select value={source} onChange={e => setSource(e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
        {ACCOUNT_SOURCES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
      </select>
      {source === "bank" && <input placeholder="№ счёта" value={number} onChange={e => setNumber(e.target.value)} style={{ ...inputStyle, width: 130 }} />}
      <button disabled={!name.trim()} onClick={async () => {
        await businessUnitsApi.addAccount({ business_unit_id: unitId, name: name.trim(), source, number: number.trim() || null });
        onAdded();
      }} style={{ padding: "6px 12px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: name.trim() ? 1 : 0.5 }}>OK</button>
    </div>
  );
}

const buCols = "1.4fr 90px 130px 1.6fr 120px";
const brandCols = "1.4fr 2fr 120px 120px";

export default function Brands() {
  const [editBrand, setEdit] = useState<any>(null);
  const [editUnit, setEditUnit] = useState<any>(null);
  const { data: brands = [] } = useQuery({ queryKey: ["brands"], queryFn: brandsApi.list });
  const { data: byBrand = [] } = useQuery({ queryKey: ["finance-by-brand"], queryFn: financeApi.byBrand });
  const { data: units = [] } = useQuery({ queryKey: ["business-units"], queryFn: businessUnitsApi.list });

  const finOf = (name: string) => (byBrand as any[]).find((b: any) => b.brand === name);
  const th: React.CSSProperties = { fontSize: 11, color: "#A89070", letterSpacing: "0.04em" };
  const rowStyle: React.CSSProperties = { padding: "13px 28px", borderBottom: "1px solid #F2EFE9", alignItems: "center", cursor: "pointer", transition: "background 0.1s" };

  return (
    <div style={{ padding: "24px 0 40px", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box", overflowY: "auto" }}>
      <div style={{ padding: "0 28px", marginBottom: 22 }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Бренды и бизнес-единицы</div>
        <div style={{ fontSize: 12, color: "#A89070", marginTop: 2 }}>Юр.лица со счетами и направления бизнеса</div>
      </div>

      {/* ── Бизнес-единицы ─────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 28px 8px" }}>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>БИЗНЕС-ЕДИНИЦЫ</div>
        <button onClick={() => setEditUnit({})} title="Новая бизнес-единица"
          style={{ width: 26, height: 26, background: "#E8592A", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Plus size={14} color="#FFFFFF" weight="bold" />
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: buCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", borderTop: "1px solid #EDEBE6" }}>
        <div style={th}>НАЗВАНИЕ</div><div style={th}>ТИП</div><div style={th}>ИНН</div><div style={th}>СЧЕТА</div>
        <div style={{ ...th, textAlign: "right" }}>БАЛАНС</div>
      </div>
      {(units as any[]).map((u: any) => (
        <div key={u.id} onClick={() => setEditUnit(u)} style={{ display: "grid", gridTemplateColumns: buCols, ...rowStyle }}
          onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{u.name}</div>
          <div style={{ fontSize: 12, color: "#6B6355" }}>{u.kind || "—"}</div>
          <div style={{ fontSize: 12, color: "#A89070" }}>{u.inn || "—"}</div>
          <div style={{ fontSize: 11, color: "#6B6355" }}>
            {(u.accounts || []).length === 0 ? "—" : (u.accounts || []).map((a: any) => (
              <span key={a.id} style={{ display: "inline-block", marginRight: 10 }}>{a.name} <span style={{ color: "#A89070" }}>{fmt(a.balance || 0)}</span></span>
            ))}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: u.balance_total >= 0 ? "#1A1A1A" : "#8B3A3A", textAlign: "right" }}>{fmt(u.balance_total || 0)}</div>
        </div>
      ))}

      {/* ── Бренды ─────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "28px 28px 8px" }}>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>БРЕНДЫ</div>
        <button onClick={() => setEdit({})} title="Новый бренд"
          style={{ width: 26, height: 26, background: "#E8592A", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Plus size={14} color="#FFFFFF" weight="bold" />
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: brandCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", borderTop: "1px solid #EDEBE6" }}>
        <div style={th}>НАЗВАНИЕ</div><div style={th}>ОПИСАНИЕ</div>
        <div style={{ ...th, textAlign: "right" }}>ДОХОД</div><div style={{ ...th, textAlign: "right" }}>ПРИБЫЛЬ</div>
      </div>
      {(brands as any[]).map((b: any) => {
        const fin = finOf(b.name);
        return (
          <div key={b.id} onClick={() => setEdit(b)} style={{ display: "grid", gridTemplateColumns: brandCols, ...rowStyle }}
            onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: b.color || "#A89070", flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{b.name}</span>
            </div>
            <div style={{ fontSize: 12, color: "#6B6355", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 16 }}>{b.description || "—"}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", textAlign: "right" }}>{fin ? fmt(fin.income) : "—"}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: fin && fin.profit < 0 ? "#8B3A3A" : "#1A1A1A", textAlign: "right" }}>{fin ? fmt(fin.profit) : "—"}</div>
          </div>
        );
      })}

      {editBrand && <BrandModal brand={editBrand} onClose={() => setEdit(null)} />}
      {editUnit && <BusinessUnitModal unit={editUnit} onClose={() => setEditUnit(null)} />}
    </div>
  );
}
