import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MONO } from "../../components/ui/Num";
import { Modal } from "../../components/ui/Modal";
import { IconButton } from "../../components/ui/IconButton";
import { brandsApi, ordersApi } from "../../api";
import { Trash, PencilSimple, X } from "@phosphor-icons/react";
import { fmt } from "./helpers";
import { DetailRow as Row } from "./DetailRow";

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

// Панель бренда (единый вид с остальными категориями). Правка — через BrandModal по карандашу.
export function BrandDetail({ row, onClose }: { row: any; onClose: () => void }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const b = row;
  const fin = b?._fin;
  const { data: brandOrders = [] } = useQuery({
    queryKey: ["orders", "brand", b?.name],
    queryFn: () => ordersApi.list({ brand: b.name }),
    enabled: !!b?.name,
  });
  if (!b) return null;

  return (
    <>
      {editing && <BrandModal row={b} onClose={() => setEditing(false)} />}

      <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 14, height: 14, borderRadius: "50%", background: b.color || "#A89070", flexShrink: 0, border: (b.color || "").toLowerCase() === "#f4f4f4" ? "1px solid #EDEBE6" : "none" }} />
          <div style={{ fontSize: 21, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em", fontFamily: MONO }}>{b.name}</div>
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
        {fin && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 20 }}>
            {[
              { l: "Доход",   v: fmt(fin.income), c: "#4A7C59" },
              { l: "Прибыль", v: fmt(fin.profit), c: fin.profit < 0 ? "#8B3A3A" : "#1A1A1A" },
            ].map(s => (
              <div key={s.l} style={{ background: "#FAF8F5", padding: "9px 11px" }}>
                <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 3 }}>{s.l.toUpperCase()}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: s.c, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{s.v}</div>
              </div>
            ))}
          </div>
        )}

        {(b.positioning || b.description) && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>ПРОФИЛЬ</div>
            {b.positioning && <Row label="Позиционирование" value={b.positioning} />}
            {b.description && (
              <div style={{ marginTop: 8, padding: "10px 12px", background: "#FAF8F5", fontSize: 12, color: "#1A1A1A", lineHeight: 1.7, borderLeft: "3px solid #EDEBE6" }}>
                {b.description}
              </div>
            )}
          </>
        )}

        {b.notes && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 20 }}>ЗАМЕТКИ</div>
            <div style={{ padding: "10px 12px", background: "#FAF8F5", fontSize: 12, color: "#1A1A1A", lineHeight: 1.7, borderLeft: "3px solid #EDEBE6" }}>{b.notes}</div>
          </>
        )}

        {(brandOrders as any[]).length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>
              ЗАКАЗЫ <span style={{ color: "#C8C0B0", fontWeight: 400 }}>· {(brandOrders as any[]).length}</span>
            </div>
            {(brandOrders as any[]).map((o: any) => (
              <div key={o.id}
                onClick={() => navigate(`/orders/${o.id}/estimate`)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid #F2EFE9", cursor: "pointer" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                <span style={{ flex: 1, fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.title}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(o.price_plan || 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// Бренд редактируется модалкой (row={} — создание). Богатой панели не требует.
export function BrandModal({ row, onClose }: { row: any; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const brand = row;
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
      qc.invalidateQueries({ queryKey: ["wiki", "brands"] });
      qc.invalidateQueries({ queryKey: ["finance-by-brand"] });
      onClose();
    } finally { setSaving(false); }
  };

  const del = async () => {
    setDeleting(true);
    try {
      await brandsApi.delete(brand.id);
      qc.invalidateQueries({ queryKey: ["wiki", "brands"] });
      onClose();
    } finally { setDeleting(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6",
    padding: "7px 10px", fontSize: 13, outline: "none",
  };

  return (
    <Modal
      size="md"
      eyebrow={isNew ? "НОВЫЙ БРЕНД" : "РЕДАКТИРОВАТЬ БРЕНД"}
      onClose={onClose}
      onCancel={onClose}
      onSave={save}
      saveLabel="Сохранить"
      saving={saving}
      canSave={!!form.name.trim()}
      footerLeft={!isNew ? (
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
      ) : undefined}
    >
        <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
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
          <div>
            <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>ЦВЕТ</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {RAL_PALETTE.map(c => {
                const selected = (form.color || "").toLowerCase() === c.hex.toLowerCase();
                return (
                  <button key={c.hex} type="button" title={`${c.name} · ${c.ral}`}
                    onClick={() => set("color", c.hex)}
                    style={{
                      width: 28, height: 28, background: c.hex, cursor: "pointer",
                      border: c.hex.toLowerCase() === "#f4f4f4" ? "1px solid #EDEBE6" : "none",
                      outline: selected ? "2px solid #1A1A1A" : "none", outlineOffset: 2, padding: 0,
                    }} />
                );
              })}
            </div>
          </div>
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
                      <span style={{ flex: 1, fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.title}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(o.price_plan || 0)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
    </Modal>
  );
}
