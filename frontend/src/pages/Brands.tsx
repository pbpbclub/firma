import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { brandsApi, financeApi } from "../api";
import { X, Plus, Trash } from "@phosphor-icons/react";

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n || 0) + " ₽";
}

const FIELDS: { key: string; label: string; type?: string }[] = [
  { key: "name", label: "Название" },
  { key: "color", label: "Цвет (hex)" },
  { key: "full_name", label: "Юр. лицо / полное название" },
  { key: "inn", label: "ИНН" },
  { key: "account", label: "Расчётный счёт" },
  { key: "description", label: "Описание", type: "textarea" },
  { key: "positioning", label: "Позиционирование", type: "textarea" },
  { key: "notes", label: "Заметки", type: "textarea" },
];

function BrandModal({ brand, onClose }: { brand: any; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = !brand?.id;
  const [form, setForm] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {};
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
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input value={form[f.key]} onChange={e => set(f.key, e.target.value)} style={inputStyle}
                    autoFocus={f.key === "name" && isNew} />
                  {f.key === "color" && form.color && <div style={{ width: 24, height: 24, flexShrink: 0, background: form.color, border: "1px solid #EDEBE6" }} />}
                </div>
              )}
            </div>
          ))}
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

export default function Brands() {
  const [editBrand, setEdit] = useState<any>(null);
  const { data: brands = [], isLoading } = useQuery({ queryKey: ["brands"], queryFn: brandsApi.list });
  const { data: byBrand = [] } = useQuery({ queryKey: ["finance-by-brand"], queryFn: financeApi.byBrand });

  const finOf = (name: string) => (byBrand as any[]).find((b: any) => b.brand === name);

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box", overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Бренды</div>
          <div style={{ fontSize: 12, color: "#A89070", marginTop: 2 }}>Направления бизнеса и их финансы</div>
        </div>
        <button onClick={() => setEdit({})}
          style={{ width: 32, height: 32, background: "#E8592A", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Plus size={16} color="#FFFFFF" weight="bold" />
        </button>
      </div>

      {isLoading ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
          {(brands as any[]).map((b: any) => {
            const fin = finOf(b.name);
            return (
              <div key={b.id} onClick={() => setEdit(b)}
                style={{ border: "1px solid #EDEBE6", cursor: "pointer", background: "#fff", transition: "box-shadow 0.15s", display: "flex", flexDirection: "column" }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 2px 16px rgba(0,0,0,0.08)")}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = "none")}>
                <div style={{ height: 4, background: b.color || "#A89070" }} />
                <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: b.color || "#A89070" }} />
                    <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>{b.name}</span>
                  </div>
                  {b.description && <div style={{ fontSize: 12, color: "#6B6355", lineHeight: 1.5 }}>{b.description}</div>}
                  {fin && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: "auto", paddingTop: 10, borderTop: "1px solid #F2EFE9" }}>
                      <div>
                        <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.04em" }}>ДОХОД</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59" }}>{fmt(fin.income)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.04em" }}>РАСХОД</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#8B3A3A" }}>{fmt(fin.expense)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.04em" }}>ПРИБЫЛЬ</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: fin.profit >= 0 ? "#1A1A1A" : "#8B3A3A" }}>{fmt(fin.profit)}</div>
                      </div>
                    </div>
                  )}
                  {fin && (
                    <div style={{ fontSize: 10, color: "#A89070" }}>{fin.orders_count} заказов · план {fmt(fin.price_plan)}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editBrand && <BrandModal brand={editBrand} onClose={() => setEdit(null)} />}
    </div>
  );
}
