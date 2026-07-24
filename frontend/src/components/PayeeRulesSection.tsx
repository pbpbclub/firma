import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { payeeRulesApi } from "../api";
import { X, Tag } from "@phosphor-icons/react";

const MATCH_TYPE_LABELS: Record<string, string> = { exact: "точное", contains: "содержит", prefix: "с начала" };

export function PayeeRulesSection({ entityType, entityId }: { entityType: string; entityId: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ pattern: "", match_type: "exact", display_name: "" });

  const { data: rules = [] } = useQuery({
    queryKey: ["payee-rules", entityType, entityId],
    queryFn: () => payeeRulesApi.list({ entity_type: entityType, entity_id: entityId }),
  });

  const create = useMutation({
    mutationFn: () => payeeRulesApi.create({
      ...form,
      entity_type: entityType,
      entity_id: entityId,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payee-rules", entityType, entityId] });
      qc.invalidateQueries({ queryKey: ["zm-business"] });
      setAdding(false);
      setForm({ pattern: "", match_type: "exact", display_name: "" });
    },
  });

  const del = useMutation({
    mutationFn: (id: number) => payeeRulesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payee-rules", entityType, entityId] });
      qc.invalidateQueries({ queryKey: ["zm-business"] });
    },
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", fontSize: 11,
    border: "1px solid #EDEBE6", padding: "5px 8px", outline: "none", fontFamily: "inherit",
  };

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>
          ZENMONEY <span style={{ color: "#C8C0B0", fontWeight: 400 }}>· паттерны</span>
        </div>
        <button onClick={() => setAdding(v => !v)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", padding: 0, display: "flex", alignItems: "center" }}>
          <Tag size={12} />
        </button>
      </div>

      {(rules as any[]).length === 0 && !adding && (
        <div style={{ fontSize: 11, color: "#C8C0B0", paddingBottom: 6 }}>Нет привязанных паттернов</div>
      )}

      {(rules as any[]).map((r: any) => (
        <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #F2EFE9" }}>
          <div>
            <code style={{ fontSize: 10, background: "#F2EFE9", padding: "1px 4px" }}>{r.pattern}</code>
            <span style={{ fontSize: 10, color: "#A89070", marginLeft: 5 }}>{MATCH_TYPE_LABELS[r.match_type]}</span>
            {r.display_name && <span style={{ fontSize: 10, color: "#6B6355", marginLeft: 5 }}>→ {r.display_name}</span>}
          </div>
          <button onClick={() => del.mutate(r.id)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2 }}>
            <X size={11} />
          </button>
        </div>
      ))}

      {adding && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6, padding: "10px", background: "#FAF8F5", border: "1px solid #EDEBE6" }}>
          <div>
            <div style={{ fontSize: 9, color: "#A89070", marginBottom: 2 }}>ПАТТЕРН (нижний регистр)</div>
            <input value={form.pattern} onChange={e => setForm(f => ({ ...f, pattern: e.target.value }))}
              placeholder="имя в выписке" style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#A89070", marginBottom: 2 }}>ТИП</div>
            <select value={form.match_type} onChange={e => setForm(f => ({ ...f, match_type: e.target.value }))}
              style={{ ...inputStyle, cursor: "pointer" }}>
              <option value="exact">Точное</option>
              <option value="contains">Содержит</option>
              <option value="prefix">С начала</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#A89070", marginBottom: 2 }}>МЕТКА (необязательно)</div>
            <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
              placeholder="отображаемое имя" style={inputStyle} />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => create.mutate()} disabled={!form.pattern || create.isPending}
              style={{ flex: 1, background: "#1A1A1A", color: "#FFF", border: "none", padding: "5px 0", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
              {create.isPending ? "..." : "Сохранить"}
            </button>
            <button onClick={() => setAdding(false)}
              style={{ background: "none", border: "1px solid #EDEBE6", padding: "5px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#6B6355" }}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

