// Вид прибыли — справочник-ярлык (решение Юры 11.09.2026): производство, транзит,
// проектные работы, … Модели затрат у вида нет — это фильтр для заказов, сводки П/Ф и
// машинного времени. Код (activities.code) задаётся при создании и не меняется: на нём
// висят заказы.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash } from "@phosphor-icons/react";
import { MONO } from "../../components/ui/Num";
import { Modal } from "../../components/ui/Modal";
import { activitiesApi, ordersApi } from "../../api";
import { fmt } from "./helpers";
import { DetailRow as Row } from "./DetailRow";
import { DetailShell, DetailSection, NoteBlock } from "./DetailShell";

const PALETTE = ["#1A1A1A", "#E8592A", "#B8860B", "#4A7C59", "#8B3A3A", "#5B9BD5", "#755C48", "#A18594", "#6C7C59", "#1E4B8C"];

export function ActivityDetail({ row, onClose }: { row: any; onClose: () => void }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const a = row;
  const { data: orders = [] } = useQuery({
    queryKey: ["orders", "activity", a?.code],
    queryFn: () => ordersApi.list({ activity: a.code }),
    enabled: !!a?.code,
  });
  if (!a) return null;
  const list = orders as any[];
  const revenue = list.reduce((s, o) => s + (o.price_plan || 0), 0);
  return (
    <>
      {editing && <ActivityModal row={a} onClose={() => setEditing(false)} />}
      <DetailShell
        title={a.name}
        avatar={{ kind: "colorDot", color: a.color || "#A89070" }}
        metrics={[
          { label: "Заказов", value: String(list.length), color: "#1A1A1A" },
          { label: "Цена заказов", value: fmt(revenue), color: "#1A1A1A" },
        ]}
        onEdit={() => setEditing(true)}
        onClose={onClose}
      >
        <DetailSection label="ПРОФИЛЬ" first>
          <Row label="Код" value={a.code} />
          {a.is_default ? <Row label="По умолчанию" value="да — новые заказы получают этот вид" /> : null}
          {a.description && <NoteBlock>{a.description}</NoteBlock>}
        </DetailSection>
        {list.length > 0 && (
          <DetailSection label="ЗАКАЗЫ" extra={`· ${list.length}`}>
            {list.map((o: any) => (
              <div key={o.id} onClick={() => navigate(`/orders/${o.id}`)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid #F2EFE9", cursor: "pointer" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                <span style={{ flex: 1, fontSize: 13, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.title}</span>
                <span style={{ fontSize: 11, color: "#A89070" }}>{o.status_label}</span>
                <span style={{ fontSize: 13, fontWeight: 600, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(o.price_plan || 0)}</span>
              </div>
            ))}
          </DetailSection>
        )}
      </DetailShell>
    </>
  );
}

export function ActivityModal({ row, onClose }: { row: any; onClose: () => void }) {
  const qc = useQueryClient();
  const a = row;
  const isNew = !a?.id;
  const [form, setForm] = useState<Record<string, string>>({
    name: a?.name ?? "", code: a?.code ?? "", color: a?.color ?? "", description: a?.description ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setForm(prev => ({ ...prev, [k]: v }));
  const done = () => { qc.invalidateQueries({ queryKey: ["wiki", "activities"] }); qc.invalidateQueries({ queryKey: ["activities"] }); onClose(); };
  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true); setError(null);
    try {
      const payload: Record<string, any> = { name: form.name.trim(), color: form.color || null, description: form.description.trim() || null };
      if (isNew) await activitiesApi.create({ ...payload, code: form.code.trim() || undefined });
      else await activitiesApi.update(a.id, payload);
      done();
    } catch (e: any) { setError(e?.response?.data?.detail || "Не сохранилось"); }
    finally { setSaving(false); }
  };
  const del = async () => {
    try { await activitiesApi.delete(a.id); done(); }
    catch (e: any) { setError(e?.response?.data?.detail || "Не удалилось"); setConfirmDel(false); }
  };
  const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" };
  const lbl = { fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 };
  return (
    <Modal size="md" eyebrow={isNew ? "НОВЫЙ ВИД ПРИБЫЛИ" : "РЕДАКТИРОВАТЬ ВИД ПРИБЫЛИ"} onClose={onClose} onCancel={onClose}
      onSave={save} saveLabel="Сохранить" saving={saving} canSave={!!form.name.trim()}
      footerLeft={!isNew && !a.is_default ? (confirmDel ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#8B3A3A" }}>Удалить?</span>
          <button type="button" onClick={del} style={{ fontSize: 11, color: "#fff", background: "#8B3A3A", border: "none", padding: "4px 10px", cursor: "pointer" }}>Да</button>
          <button type="button" onClick={() => setConfirmDel(false)} style={{ fontSize: 11, color: "#6B6355", background: "none", border: "none", cursor: "pointer" }}>Нет</button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirmDel(true)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#8B3A3A", display: "flex", alignItems: "center", gap: 5 }}>
          <Trash size={13} /> Удалить
        </button>
      )) : undefined}>
      <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={lbl}>НАЗВАНИЕ</div>
          <input value={form.name} onChange={e => set("name", e.target.value)} style={inp} autoFocus={isNew} placeholder="Реселлинг мебели" />
        </div>
        <div>
          <div style={lbl}>КОД {isNew ? "(латиницей, необязательно — сделается из названия)" : "— не меняется, на нём заказы"}</div>
          <input value={form.code} onChange={e => set("code", e.target.value)} style={{ ...inp, fontFamily: MONO }} disabled={!isNew} />
        </div>
        <div>
          <div style={lbl}>ОПИСАНИЕ</div>
          <textarea value={form.description} onChange={e => set("description", e.target.value)} rows={2} style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />
        </div>
        <div>
          <div style={{ ...lbl, marginBottom: 6 }}>ЦВЕТ</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {PALETTE.map(c => (
              <div key={c} onClick={() => set("color", c)} title={c}
                style={{ width: 22, height: 22, background: c, cursor: "pointer", outline: form.color === c ? "2px solid #E8592A" : "1px solid #EDEBE6", outlineOffset: 2 }} />
            ))}
          </div>
        </div>
        {error && <div style={{ fontSize: 11, color: "#8B3A3A" }}>{String(error)}</div>}
      </div>
    </Modal>
  );
}
