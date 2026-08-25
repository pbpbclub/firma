// Выбор контрагента-получателя: одна картотека, роль различает подрядчика,
// мастера и поставщика. Умеет завести нового прямо на месте — из Разноски
// платёж новому поставщику не должен требовать похода в Вики.
import { useState } from "react";
import { useIsMobile } from "./responsive";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Plus, X } from "@phosphor-icons/react";
import { mastersApi, customersApi } from "../../api";

export const PAYEE_ROLES = ["Поставщик", "Подрядчик", "Мастер"];

// Банк пишет получателя капсом и полным наименованием — предлагаем короткую форму.
export function prettifyPayee(raw?: string | null): string {
  let s = (raw || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  const forms: Array<[RegExp, string]> = [
    [/^ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ\s*/i, 'ООО '],
    [/^АКЦИОНЕРНОЕ ОБЩЕСТВО\s*/i, 'АО '],
    [/^ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО\s*/i, 'ПАО '],
    [/^ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ\s*/i, 'ИП '],
  ];
  for (const [re, short] of forms) if (re.test(s)) { s = s.replace(re, short); break; }
  // ВЕСЬ КАПС → Первые Буквы Заглавные (аббревиатуры и кавычки не трогаем)
  const body = s.replace(/^(ООО|АО|ПАО|ИП)\s+/i, "");
  if (body && body === body.toUpperCase() && /[А-ЯЁ]{4,}/.test(body)) {
    const pretty = body.replace(/[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z]*/g, w =>
      w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase());
    s = s.slice(0, s.length - body.length) + pretty;
  }
  return s;
}

export function PayeePicker({ value, onChange, suggestName, placeholder = "— контрагент —", style, highlight }: {
  value: string;
  onChange: (masterId: string) => void;
  suggestName?: string | null;      // имя из платежа — подставится в форму создания
  placeholder?: string;
  style?: React.CSSProperties;
  highlight?: boolean;              // рамка-акцент (например, когда сработала подсказка)
}) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const { data: masters = [] } = useQuery({ queryKey: ["masters"], queryFn: mastersApi.list });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("Поставщик");

  const create = useMutation({
    mutationFn: () => mastersApi.create({ name: name.trim(), role }),
    onSuccess: (m: any) => {
      qc.invalidateQueries({ queryKey: ["masters"] });
      qc.invalidateQueries({ queryKey: ["wiki", "contractors"] });
      // Инбокс тоже: новый контрагент должен сразу попасть в подсказки других строк
      qc.invalidateQueries({ queryKey: ["expenses-inbox"] });
      onChange(m.id);                 // дедуп по имени вернёт существующего — тоже выберется
      setAdding(false); setName("");
    },
  });

  const list = masters as any[];
  const byRole = (r: string) => list.filter(m => (m.role || "") === r);
  const rest = list.filter(m => !PAYEE_ROLES.includes(m.role || ""));

  if (adding) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", ...style }}>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="название контрагента"
          style={{ border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 12, outline: "none", minWidth: isMobile ? "100%" : 220, flex: 1, fontFamily: "inherit" }} />
        <div style={{ display: "flex" }}>
          {PAYEE_ROLES.map(r => (
            <button type="button" key={r} onClick={() => setRole(r)}
              style={{ fontSize: 10.5, padding: "4px 9px", cursor: "pointer", fontFamily: "inherit", marginLeft: -1,
                       border: `1px solid ${role === r ? "#E8592A" : "#EDEBE6"}`,
                       background: role === r ? "#FFF4EE" : "#fff",
                       color: role === r ? "#E8592A" : "#6B6355", fontWeight: role === r ? 600 : 400 }}>
              {r}
            </button>
          ))}
        </div>
        <button type="button" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}
          style={{ fontSize: 11, padding: "5px 10px", border: "none", fontFamily: "inherit", fontWeight: 600,
                   background: name.trim() ? "#E8592A" : "#EDEBE6", color: name.trim() ? "#fff" : "#A89070",
                   cursor: name.trim() ? "pointer" : "default" }}>
          {create.isPending ? "..." : "Создать"}
        </button>
        <button type="button" onClick={() => { setAdding(false); setName(""); }}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2, display: "flex" }}>
          <X size={11} />
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", ...style }}>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ flex: 1, border: `1px solid ${highlight && value ? "#E8592A" : "#EDEBE6"}`,
                 padding: "5px 8px", fontSize: 12, outline: "none", background: "#fff",
                 cursor: "pointer", fontFamily: "inherit", minWidth: 0 }}>
        <option value="">{placeholder}</option>
        {PAYEE_ROLES.map(r => {
          const items = byRole(r);
          if (!items.length) return null;
          return (
            <optgroup key={r} label={r === "Мастер" ? "Мастера" : r === "Подрядчик" ? "Подрядчики" : "Поставщики"}>
              {items.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </optgroup>
          );
        })}
        {rest.length > 0 && (
          <optgroup label="Без роли">
            {rest.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </optgroup>
        )}
      </select>
      <button type="button" onClick={() => { setName(prettifyPayee(suggestName)); setAdding(true); }}
        title="Завести нового контрагента"
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, padding: "5px 9px",
                 border: "1px solid #EDEBE6", background: "#fff", color: "#6B6355",
                 cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }}>
        <Plus size={11} /> новый
      </button>
    </div>
  );
}

// Плательщик поступления — это КЛИЕНТ (не подрядчик), поэтому отдельный список.
// Тот же вид и та же логика «выбрать или завести на месте».
export function CustomerPicker({ value, onChange, suggestName, placeholder = "— клиент —", style, highlight }: {
  value: string;
  onChange: (customerId: string) => void;
  suggestName?: string | null;
  placeholder?: string;
  style?: React.CSSProperties;
  highlight?: boolean;
}) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const { data: customers = [] } = useQuery({ queryKey: ["customers", ""], queryFn: () => customersApi.list("") });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => customersApi.create({ name: name.trim() }),
    onSuccess: (c: any) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["wiki", "clients"] });
      qc.invalidateQueries({ queryKey: ["expenses-inbox"] });
      onChange(c.id);
      setAdding(false); setName("");
    },
  });

  if (adding) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", ...style }}>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="название клиента"
          style={{ border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 12, outline: "none", minWidth: isMobile ? "100%" : 220, flex: 1, fontFamily: "inherit" }} />
        <button type="button" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}
          style={{ fontSize: 11, padding: "5px 10px", border: "none", fontFamily: "inherit", fontWeight: 600,
                   background: name.trim() ? "#E8592A" : "#EDEBE6", color: name.trim() ? "#fff" : "#A89070",
                   cursor: name.trim() ? "pointer" : "default" }}>
          {create.isPending ? "..." : "Создать"}
        </button>
        <button type="button" onClick={() => { setAdding(false); setName(""); }}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2, display: "flex" }}>
          <X size={11} />
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", ...style }}>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ flex: 1, border: `1px solid ${highlight && value ? "#E8592A" : "#EDEBE6"}`,
                 padding: "5px 8px", fontSize: 12, outline: "none", background: "#fff",
                 cursor: "pointer", fontFamily: "inherit", minWidth: 0 }}>
        <option value="">{placeholder}</option>
        {(customers as any[]).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button type="button" onClick={() => { setName(prettifyPayee(suggestName)); setAdding(true); }}
        title="Завести нового клиента"
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, padding: "5px 9px",
                 border: "1px solid #EDEBE6", background: "#fff", color: "#6B6355",
                 cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }}>
        <Plus size={11} /> новый
      </button>
    </div>
  );
}
