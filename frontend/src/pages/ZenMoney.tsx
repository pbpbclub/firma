import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { Briefcase, MagnifyingGlass, X, ArrowsClockwise, Tag, PencilSimple, Trash, LinkSimple } from "@phosphor-icons/react";
import { zenmoneyApi, payeeRulesApi, mastersApi, customersApi, financeApi } from "../api";
import { ColumnFilter, PeriodFilter, AmountFilter } from "../components/TableFilters";
import { Modal } from "../components/ui/Modal";
import { MONO } from "../components/ui/Num";
import { IconButton } from "../components/ui/IconButton";

// abs намеренный: направление операции показывают цвет/колонка, не знак
const fmt = (n: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.abs(n));

const BANK_MAP: Array<{ name: string; match: (t: string) => boolean; bg: string; text: string; color: string }> = [
  {
    name: "Т-Банк",
    match: t => ["all airlines", "black", "тинькофф платинум", "т-мобайл", "брокерский счёт"].includes(t)
              || t.includes("тинькофф") || t.includes("tinkoff"),
    bg: "#FFDD2D", text: "Т", color: "#1A1A1A",
  },
  {
    name: "Сбер",
    match: t => ["mastercard mass", "универсальный на 5 лет", "накопительный счёт",
                 "сберегательный счет", "кредитная сберкарта", "платёжный счёт"].includes(t)
              || t.includes("сбер") || t.includes("sber"),
    bg: "#21A038", text: "С", color: "#FFFFFF",
  },
  {
    name: "Альфа",
    match: t => t === "текущий счёт" || t.includes("альфа") || t.includes("alfa"),
    bg: "#EF3124", text: "А", color: "#FFFFFF",
  },
  {
    name: "Наличные",
    match: t => t === "cash" || t.includes("наличн"),
    bg: "#E8E4DA", text: "₽", color: "#6B6355",
  },
];

function detectBank(title: string): { name: string; bg: string; text: string; color: string } {
  const t = (title || "").toLowerCase().trim();
  const found = BANK_MAP.find(b => b.match(t));
  if (found) return { name: found.name, bg: found.bg, text: found.text, color: found.color };
  const letter = (title || "?")[0].toUpperCase();
  return { name: letter, bg: "#EDEBE6", text: letter, color: "#6B6355" };
}

function BankBadge({ title }: { title: string }) {
  const c = detectBank(title);
  return (
    <div style={{ width: 22, height: 22, borderRadius: "50%", background: c.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: c.color, flexShrink: 0 }} title={title}>
      {c.text}
    </div>
  );
}

function Checkbox({ checked, indeterminate = false, onChange }: {
  checked: boolean; indeterminate?: boolean; onChange: () => void;
}) {
  return (
    <div onClick={e => { e.stopPropagation(); onChange(); }} style={{
      width: 14, height: 14, flexShrink: 0, cursor: "pointer",
      border: `1.5px solid ${checked || indeterminate ? "#E8592A" : "#D0C8C0"}`,
      background: checked ? "#E8592A" : "transparent",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {checked && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3L3 5.5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      {!checked && indeterminate && <div style={{ width: 8, height: 1.5, background: "#E8592A" }} />}
    </div>
  );
}

const MONTHS_RU = ["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];

function getMonthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return `${MONTHS_RU[parseInt(m) - 1]} ${y.slice(2)}`;
}

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const MATCH_TYPE_LABELS: Record<string, string> = {
  exact: "точное",
  contains: "содержит",
  prefix: "с начала",
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  contractor: "Подрядчик",
  customer: "Клиент",
  master: "Мастер",
  label: "Метка",
  skip: "Игнорировать",
};

function EntityPicker({ entityType, value, onChange }: {
  entityType: string;
  value: { id: string; name: string };
  onChange: (id: string, name: string) => void;
}) {
  const [q, setQ] = useState("");
  const { data: masters = [] } = useQuery({ queryKey: ["masters"], queryFn: mastersApi.list, enabled: entityType === "master" || entityType === "contractor" });
  const { data: customers = [] } = useQuery({ queryKey: ["customers", ""], queryFn: () => customersApi.list(""), enabled: entityType === "customer" });

  const items: { id: string; name: string }[] = entityType === "customer"
    ? (customers as any[]).map((c: any) => ({ id: c.id, name: c.name }))
    : (masters as any[]).map((m: any) => ({ id: m.id, name: m.name }));

  const filtered = q ? items.filter(i => i.name.toLowerCase().includes(q.toLowerCase())) : items;

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", fontSize: 11,
    border: "1px solid #EDEBE6", padding: "5px 8px", outline: "none", fontFamily: "inherit", background: "#FAFAFA",
  };

  return (
    <div>
      <div style={{ fontSize: 10, color: "#A89070", marginBottom: 2 }}>
        {entityType === "customer" ? "КЛИЕНТ" : "МАСТЕР / ПОДРЯДЧИК"}
      </div>
      {value.name && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, padding: "4px 8px", background: "#FFF3EF", border: "1px solid #F0D8D0" }}>
          <span style={{ fontSize: 11, flex: 1, color: "#1A1A1A" }}>{value.name}</span>
          <button onClick={() => onChange("", "")} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#A89070" }}>
            <X size={11} />
          </button>
        </div>
      )}
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск..." style={inputStyle} />
      {q && (
        <div style={{ border: "1px solid #EDEBE6", borderTop: "none", maxHeight: 140, overflowY: "auto", background: "#FFF" }}>
          {filtered.length === 0 && (
            <div style={{ padding: "6px 8px", fontSize: 11, color: "#A89070" }}>Не найдено</div>
          )}
          {filtered.map(item => (
            <div key={item.id} onClick={() => { onChange(item.id, item.name); setQ(""); }}
              style={{ padding: "6px 8px", fontSize: 11, cursor: "pointer", borderBottom: "1px solid #F2EFE9" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              {item.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PayeeRulePopup({ payee, ruleId, onClose }: {
  payee: string;
  ruleId: number | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(!ruleId);
  const [form, setForm] = useState({
    pattern: payee.toLowerCase(),
    match_type: "exact",
    display_name: "",
    entity_type: "label",
    entity_id: "",
    entity_name: "",
    category: "",
  });

  const { data: existingRule } = useQuery({
    queryKey: ["payee-rule", ruleId],
    queryFn: () => ruleId ? payeeRulesApi.list({}).then((rules: any[]) => rules.find((r: any) => r.id === ruleId)) : null,
    enabled: !!ruleId,
  });

  useEffect(() => {
    if (existingRule) {
      setForm({
        pattern: existingRule.pattern || payee.toLowerCase(),
        match_type: existingRule.match_type || "exact",
        display_name: existingRule.display_name || "",
        entity_type: existingRule.entity_type || "label",
        entity_id: existingRule.entity_id || "",
        entity_name: existingRule.entity_name || "",
        category: existingRule.category || "",
      });
    }
  }, [existingRule]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  const save = useMutation({
    mutationFn: () => ruleId && existingRule
      ? payeeRulesApi.update(ruleId, form)
      : payeeRulesApi.create(form),
    onSuccess: async () => {
      onClose();
      await qc.invalidateQueries({ queryKey: ["zm-transactions"] });
      await qc.invalidateQueries({ queryKey: ["zm-business"] });
      await qc.invalidateQueries({ queryKey: ["payee-rules"] });
    },
  });

  const del = useMutation({
    mutationFn: () => payeeRulesApi.delete(ruleId!),
    onSuccess: async () => {
      onClose();
      await qc.invalidateQueries({ queryKey: ["zm-transactions"] });
      await qc.invalidateQueries({ queryKey: ["zm-business"] });
      await qc.invalidateQueries({ queryKey: ["payee-rules"] });
    },
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", fontSize: 11,
    border: "1px solid #EDEBE6", padding: "5px 8px",
    outline: "none", fontFamily: "inherit", background: "#FAFAFA",
  };
  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

  return (
    <div ref={ref} style={{
      position: "absolute", zIndex: 400, top: "calc(100% + 4px)", left: 0,
      background: "#FFFFFF", border: "1px solid #EDEBE6",
      boxShadow: "0 4px 20px rgba(0,0,0,0.12)", width: 280, padding: 14,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#1A1A1A" }}>
          {ruleId && !editing ? "Правило сопоставления" : ruleId ? "Редактировать правило" : "Создать правило"}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {ruleId && !editing && (
            <>
              <IconButton icon={PencilSimple} title="Редактировать" size={22} iconSize={13} onClick={() => setEditing(true)} />
              <IconButton icon={Trash} title="Удалить" tone="danger" size={22} iconSize={13} onClick={() => del.mutate()} />
            </>
          )}
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "#A89070" }}>
            <X size={13} />
          </button>
        </div>
      </div>

      {/* View mode */}
      {ruleId && !editing && existingRule && (
        <div style={{ fontSize: 11, color: "#1A1A1A" }}>
          <div style={{ marginBottom: 5 }}>
            <span style={{ color: "#A89070" }}>Паттерн: </span>
            <code style={{ background: "#F2EFE9", padding: "1px 4px", fontSize: 10 }}>{existingRule.pattern}</code>
            <span style={{ color: "#A89070", marginLeft: 6 }}>{MATCH_TYPE_LABELS[existingRule.match_type]}</span>
          </div>
          {existingRule.display_name && (
            <div style={{ marginBottom: 4 }}><span style={{ color: "#A89070" }}>Метка: </span>{existingRule.display_name}</div>
          )}
          {existingRule.category && (
            <div style={{ marginBottom: 4 }}><span style={{ color: "#A89070" }}>Категория: </span>{existingRule.category}</div>
          )}
          {existingRule.entity_type && (
            <div><span style={{ color: "#A89070" }}>Тип: </span>{ENTITY_TYPE_LABELS[existingRule.entity_type] || existingRule.entity_type}
              {existingRule.entity_name && <span> — {existingRule.entity_name}</span>}
            </div>
          )}
        </div>
      )}

      {/* Edit/Create mode */}
      {(!ruleId || editing) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 2 }}>ПАТТЕРН</div>
            <input value={form.pattern} onChange={e => setForm(f => ({ ...f, pattern: e.target.value }))}
              style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 2 }}>ТИП СОВПАДЕНИЯ</div>
            <select value={form.match_type} onChange={e => setForm(f => ({ ...f, match_type: e.target.value }))}
              style={selectStyle}>
              <option value="exact">Точное</option>
              <option value="contains">Содержит</option>
              <option value="prefix">С начала строки</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 2 }}>ОТОБРАЖАЕМОЕ ИМЯ</div>
            <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
              placeholder="Яндекс.Доставка" style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 2 }}>КАТЕГОРИЯ</div>
            <input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              placeholder="Доставка, Еда..." style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 2 }}>ПРИВЯЗАТЬ К</div>
            <select value={form.entity_type} onChange={e => setForm(f => ({ ...f, entity_type: e.target.value }))}
              style={selectStyle}>
              <option value="label">Только метка</option>
              <option value="contractor">Подрядчик</option>
              <option value="customer">Клиент</option>
              <option value="master">Мастер</option>
              <option value="skip">Игнорировать</option>
            </select>
          </div>
          {["contractor", "customer", "master"].includes(form.entity_type) && (
            <EntityPicker
              entityType={form.entity_type}
              value={{ id: form.entity_id, name: form.entity_name }}
              onChange={(id, name) => setForm(f => ({ ...f, entity_id: id, entity_name: name }))}
            />
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
            <button onClick={() => save.mutate()} disabled={save.isPending || !form.pattern}
              style={{
                flex: 1, background: "#1A1A1A", color: "#FFFFFF", border: "none",
                padding: "6px 0", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
              }}>
              {save.isPending ? "Сохраняем..." : "Сохранить"}
            </button>
            {editing && ruleId && (
              <button onClick={() => setEditing(false)}
                style={{ background: "none", border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#6B6355" }}>
                Отмена
              </button>
            )}
          </div>
          {save.isError && (
            <div style={{ fontSize: 10, color: "#8B3A3A" }}>Ошибка сохранения</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Модал: привязать ZenMoney транзакцию к обязательству ─────────────────

function LinkZenModal({ tx, creditorByZenTx, onClose }: {
  tx: any;
  creditorByZenTx: Map<string, any>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const { data: suggested = [], isFetching } = useQuery({
    queryKey: ["suggest-creditors-zen", tx.id],
    queryFn: () => financeApi.suggestCreditors(tx.payee || tx.comment || "", tx.outcome || 0),
  });

  const link = useMutation({
    mutationFn: ({ creditorId, txId }: { creditorId: string; txId: string | null }) => {
      const patch: any = { zenmoney_tx_id: txId };
      if (txId !== null) patch.paid = tx.outcome;
      return financeApi.updateCreditor(creditorId, patch);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors-all"] }); onClose(); },
  });

  const currentCreditor = creditorByZenTx.get(String(tx.id));
  const items: any[] = suggested as any[];
  const filtered = search
    ? items.filter((c: any) => (c.name || "").toLowerCase().includes(search.toLowerCase()))
    : items;

  function fmtAmt(n: number) {
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
  }

  return (
    <Modal size="md" eyebrow="ПРИВЯЗАТЬ К ОБЯЗАТЕЛЬСТВУ" onClose={onClose}>
        <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid #F2EFE9" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>{tx.payee || tx.comment || "—"}</div>
          <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{tx.date} · −{fmtAmt(tx.outcome)}</div>
        </div>
        {currentCreditor && (
          <div style={{ padding: "8px 20px", background: "#F2FDF5", borderBottom: "1px solid #D0EDD8", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "#4A7C59" }}><LinkSimple size={11} style={{ marginRight: 4 }} />Привязано: <strong>{currentCreditor.name}</strong></div>
            <button onClick={() => link.mutate({ creditorId: currentCreditor.id, txId: null })}
              style={{ fontSize: 11, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Отвязать</button>
          </div>
        )}
        <div style={{ padding: "8px 20px", borderBottom: "1px solid #F2EFE9" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по обязательству..."
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 10px", fontSize: 12, outline: "none" }} />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {isFetching && <Loading compact />}
          {!isFetching && filtered.length === 0 && <EmptyState compact title="Обязательства не найдены" />}
          {!isFetching && filtered.map((c: any) => {
            const isLinked = currentCreditor?.id === c.id;
            return (
              <div key={c.id}
                onClick={() => link.mutate({ creditorId: c.id, txId: String(tx.id) })}
                style={{ display: "grid", gridTemplateColumns: "1fr 100px 80px", padding: "9px 20px", borderBottom: "1px solid #F2EFE9", cursor: "pointer", background: isLinked ? "#F2FDF5" : "transparent", alignItems: "center", gap: 10 }}
                onMouseEnter={e => { if (!isLinked) e.currentTarget.style.background = "#FAF8F5"; }}
                onMouseLeave={e => { if (!isLinked) e.currentTarget.style.background = "transparent"; }}
              >
                <div>
                  <div style={{ fontSize: 12, color: "#1A1A1A", fontWeight: 500 }}>{c.name}</div>
                  {c.description && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{c.description}</div>}
                </div>
                <div style={{ fontSize: 11, color: "#8B3A3A", textAlign: "right" }}>долг {fmtAmt(c.debt)}</div>
                <div style={{ fontSize: 11, color: "#A89070", textAlign: "right" }}>
                  {fmtAmt(c.total)}{isLinked && <LinkSimple size={10} style={{ color: "#4A7C59", marginLeft: 4 }} />}
                </div>
              </div>
            );
          })}
        </div>
    </Modal>
  );
}

const DIR_FILTERS = [
  { v: "", l: "Все" },
  { v: "in", l: "Поступления" },
  { v: "out", l: "Списания" },
];

// ── Регулярные траты: подписки / связь / услуги банка (личные карты) /
// комиссии банка (ИП). Из Разноски скрыты автоматом — контроль объёмов здесь.
function RecurringSection() {
  const { data } = useQuery({ queryKey: ["finance-recurring"], queryFn: financeApi.recurring });
  const cats = (data?.categories ?? []).filter((c: any) => c.count > 0);
  if (!cats.length) return null;
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>
        РЕГУЛЯРНЫЕ ТРАТЫ <span style={{ letterSpacing: 0, color: "#C8C0B0" }}>· скрыты из Разноски</span>
      </div>
      {cats.map((c: any) => (
        <div key={c.key} style={{ padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 12, color: "#6B6355" }}>{c.label}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
              {fmt(c.month_avg)} ₽<span style={{ fontSize: 10, fontWeight: 400, color: "#A89070" }}>/мес</span>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#A89070", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
            <span>в этом месяце <span style={{ fontFamily: MONO }}>{fmt(c.current_month)} ₽</span></span>
            <span>всего <span style={{ fontFamily: MONO }}>{fmt(c.total)} ₽</span> · {c.count}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Личные траты (для Юры лично): переводы на Райффайзен (ZM-оттоки на карты вне
// ZenMoney) + всё, что помечено «Личное» в Разноске. Личный счётчик, на бизнес не влияет.
function PersonalSpendingSection() {
  const { data } = useQuery({ queryKey: ["personal-spending"], queryFn: financeApi.personalSpending });
  const cats = (data?.categories ?? []).filter((c: any) => c.count > 0);
  if (!cats.length) return null;
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>
        ЛИЧНЫЕ ТРАТЫ <span style={{ letterSpacing: 0, color: "#C8C0B0" }}>· для меня</span>
      </div>
      {cats.map((c: any) => (
        <div key={c.key} style={{ padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 12, color: "#6B6355" }}>{c.label}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
              {fmt(c.month_avg)} ₽<span style={{ fontSize: 10, fontWeight: 400, color: "#A89070" }}>/мес</span>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#A89070", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
            <span>в этом месяце <span style={{ fontFamily: MONO }}>{fmt(c.current_month)} ₽</span></span>
            <span>всего <span style={{ fontFamily: MONO }}>{fmt(c.total)} ₽</span> · {c.count}</span>
          </div>
        </div>
      ))}
      {cats.length > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 0 0", fontVariantNumeric: "tabular-nums" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#1A1A1A" }}>Итого личных</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1A1A", fontFamily: MONO }}>{fmt(data?.total ?? 0)} ₽</span>
        </div>
      )}
    </div>
  );
}

export default function ZenMoneyPage() {
  const queryClient = useQueryClient();
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonth);
  const [showBusiness, setShowBusiness] = useState(false);

  const syncMutation = useMutation({
    mutationFn: zenmoneyApi.sync,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["zm-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["zm-cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["zm-report"] });
      queryClient.invalidateQueries({ queryKey: ["zm-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["zm-business"] });
    },
  });
  const [activePayeePopup, setActivePayeePopup] = useState<{ txId: string; payee: string; ruleId: number | null } | null>(null);
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState(""); // "" | "in" | "out" — подвкладки Все/Поступления/Списания
  const [catFilter, setCatFilter] = useState("");
  const [payeeFilter, setPayeeFilter] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [bankFilter, setBankFilter] = useState("");
  const clearFilters = () => { setBankFilter(""); setCatFilter(""); setPayeeFilter(""); setAmountMin(""); setAmountMax(""); setDateFrom(""); setDateTo(""); setDirection(""); setSelectedIds(new Set()); };

  /** Переключение «Все» ↔ «Бизнес» — это смена набора данных целиком.
   *
   *  Подвкладки Все/Поступления/Списания в режиме «Бизнес» не рисуются, а фильтр
   *  direction применялся всё равно: «Списания» → «Бизнес» молча урезали ленту, и
   *  снять это было нечем — контрола на экране нет. Категории и контрагенты из
   *  личной ленты в бизнес-ленте тоже бессмысленны. Сбрасываем всё. */
  const switchFeed = (business: boolean) => {
    setShowBusiness(business);
    setDirection("");
    setCatFilter(""); setPayeeFilter(""); setBankFilter("");
    setSelectedIds(new Set());
  };
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [linkModal, setLinkModal] = useState<any>(null);
  const ZM_GRID = "28px 80px 36px 1fr 110px 100px 28px";

  const { data: allCreditors } = useQuery({
    queryKey: ["creditors-all"],
    queryFn: () => financeApi.creditors("all"),
  });
  const creditorByZenTx = useMemo(() => {
    const m = new Map<string, any>();
    for (const c of (allCreditors?.items ?? []) as any[]) {
      if (c.zenmoney_tx_id) m.set(String(c.zenmoney_tx_id), c);
    }
    return m;
  }, [allCreditors]);

  const { data: accounts = [] } = useQuery({
    queryKey: ["zm-accounts"],
    queryFn: zenmoneyApi.accounts,
  });

  const { data: cashflow = [] } = useQuery({
    queryKey: ["zm-cashflow"],
    queryFn: () => zenmoneyApi.cashflow(6),
  });

  const { data: report } = useQuery({
    queryKey: ["zm-report", selectedMonth],
    queryFn: () => zenmoneyApi.report(selectedMonth),
  });

  const { data: allTransactions = [] } = useQuery({
    queryKey: ["zm-transactions", selectedMonth, search],
    queryFn: () =>
      zenmoneyApi.transactions({
        month: selectedMonth,
        ...(search ? { search } : {}),
        limit: 300,
      }),
    enabled: !showBusiness,
  });

  const { data: businessTx = [] } = useQuery({
    queryKey: ["zm-business"],
    queryFn: () => zenmoneyApi.business(3),
    enabled: showBusiness,
  });

  const monthOptions = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });
  }, []);

  // Exclude transfers
  const transactions = (allTransactions as any[]).filter(
    (t: any) => !(t.income > 0 && t.outcome > 0)
  );

  const displayTx: any[] = showBusiness ? (businessTx as any[]) : transactions;

  const uniqueCats = useMemo(
    () => [...new Set(displayTx.map((t: any) => t.display_category || t.tags?.[0]).filter(Boolean))].sort() as string[],
    [displayTx]
  );
  const uniquePayees = useMemo(
    () => [...new Set(displayTx.map((t: any) => t.payee || t.comment).filter(Boolean))].sort() as string[],
    [displayTx]
  );
  const uniqueBanks = useMemo(() => {
    const isExpense = (t: any) => t.outcome > 0 && t.income === 0;
    const names = displayTx.map((t: any) =>
      detectBank(isExpense(t) ? (t.outcome_account || "") : (t.income_account || "")).name
    );
    return [...new Set(names)].sort() as string[];
  }, [displayTx]);

  const filteredTx = useMemo(() => {
    let result = displayTx;
    if (direction === "in") result = result.filter((t: any) => t.income > 0);
    if (direction === "out") result = result.filter((t: any) => t.outcome > 0);
    if (bankFilter) result = result.filter((t: any) => {
      const isExp = t.outcome > 0 && t.income === 0;
      return detectBank(isExp ? (t.outcome_account || "") : (t.income_account || "")).name === bankFilter;
    });
    if (catFilter) result = result.filter((t: any) => (t.display_category || t.tags?.[0]) === catFilter);
    if (payeeFilter) result = result.filter((t: any) => (t.payee || t.comment) === payeeFilter);
    if (amountMin || amountMax) {
      result = result.filter((t: any) => {
        const amount = t.outcome > 0 ? t.outcome : t.income;
        if (amountMin && amount < parseFloat(amountMin)) return false;
        if (amountMax && amount > parseFloat(amountMax)) return false;
        return true;
      });
    }
    if (dateFrom) result = result.filter((t: any) => t.date >= dateFrom);
    if (dateTo) result = result.filter((t: any) => t.date <= dateTo);
    return result;
  }, [displayTx, direction, bankFilter, catFilter, payeeFilter, amountMin, amountMax, dateFrom, dateTo]);

  // Chart
  const maxVal = Math.max(...(cashflow as any[]).map((r: any) => Math.max(r.incomes, r.expenses)), 1);
  const CHART_H = 60;

  // Total balance
  const totalBalance = (accounts as any[]).reduce((s: number, a: any) => s + (a.balance || 0), 0);

  // Business stats
  const bizExpense = (businessTx as any[])
    .filter((t: any) => t.outcome > 0 && t.income === 0)
    .reduce((s: number, t: any) => s + t.outcome, 0);
  const bizIncome = (businessTx as any[])
    .filter((t: any) => t.income > 0 && t.outcome === 0)
    .reduce((s: number, t: any) => s + t.income, 0);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>

      {/* ── Left: transactions panel ──────────────────────────── */}
      <div style={{
        flex: "1 1 0",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        borderRight: "1px solid #EDEBE6",
      }}>
        {/* Header */}
        <div style={{ padding: "24px 28px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
              Личные финансы
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              {/* Sync button */}
              <button
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                title="Синхронизировать с ZenMoney"
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  background: "none", border: "1px solid #EDEBE6",
                  padding: "4px 10px", cursor: syncMutation.isPending ? "default" : "pointer",
                  fontSize: 12, color: syncMutation.isError ? "#8B3A3A" : syncMutation.isSuccess ? "#4A7C59" : "#6B6355",
                  opacity: syncMutation.isPending ? 0.6 : 1,
                }}
              >
                <ArrowsClockwise
                  size={13}
                  style={{ animation: syncMutation.isPending ? "spin 1s linear infinite" : "none" }}
                />
                {syncMutation.isPending ? "Синхронизация..." : syncMutation.isError ? "Ошибка" : "Синхронизировать"}
              </button>
              {/* Month picker */}
              {!showBusiness && (
                <select
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                  style={{
                    fontSize: 12,
                    border: "1px solid #EDEBE6",
                    background: "none",
                    color: "#1A1A1A",
                    padding: "4px 8px",
                    cursor: "pointer",
                    outline: "none",
                  }}
                >
                  {monthOptions.map((m) => (
                    <option key={m} value={m}>{getMonthLabel(m)}</option>
                  ))}
                </select>
              )}

              {/* Search */}
              {!showBusiness && (
                <div style={{ position: "relative" }}>
                  <MagnifyingGlass
                    size={12}
                    style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#A89070" }}
                  />
                  <input
                    type="text"
                    placeholder="Поиск..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{
                      border: "1px solid #EDEBE6",
                      paddingLeft: 26,
                      paddingRight: 8,
                      paddingTop: 4,
                      paddingBottom: 4,
                      fontSize: 12,
                      color: "#1A1A1A",
                      background: "none",
                      outline: "none",
                      width: 160,
                    }}
                  />
                </div>
              )}

              {/* Toggle */}
              <button
                onClick={() => switchFeed(false)}
                style={{
                  padding: "4px 12px", fontSize: 12,
                  border: "1px solid #EDEBE6",
                  background: !showBusiness ? "#1A1A1A" : "none",
                  color: !showBusiness ? "#FFFFFF" : "#A89070",
                  cursor: "pointer",
                }}
              >
                Все
              </button>
              <button
                onClick={() => switchFeed(true)}
                style={{
                  padding: "4px 12px", fontSize: 12,
                  border: `1px solid ${showBusiness ? "#E8592A" : "#EDEBE6"}`,
                  background: showBusiness ? "#E8592A" : "none",
                  color: showBusiness ? "#FFFFFF" : "#A89070",
                  cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 5,
                }}
              >
                <Briefcase size={12} />
                Бизнес
              </button>
            </div>
          </div>

          {/* Direction sub-tabs: Все / Поступления / Списания */}
          {!showBusiness && (
            <div style={{ display: "flex", gap: 24, borderBottom: "1px solid #EDEBE6", marginBottom: 16 }}>
              {DIR_FILTERS.map((f) => (
                <button
                  key={f.v}
                  onClick={() => { setDirection(f.v); setSelectedIds(new Set()); }}
                  style={{
                    fontSize: 13, padding: "0 0 12px",
                    border: "none", background: "none", cursor: "pointer",
                    color: direction === f.v ? "#1A1A1A" : "#A89070",
                    fontWeight: direction === f.v ? 600 : 400,
                    borderBottom: direction === f.v ? "2px solid #E8592A" : "2px solid transparent",
                    marginBottom: -1,
                  }}
                >
                  {f.l}
                </button>
              ))}
            </div>
          )}

          {/* Month summary strip */}
          {!showBusiness && report && (
            <div style={{
              display: "flex", gap: 32, marginBottom: 16,
              paddingBottom: 16, borderBottom: "1px solid #EDEBE6",
            }}>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>РАСХОДЫ</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#8B3A3A" }}>
                  {fmt(report.expenses)} ₽
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ДОХОДЫ</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#4A7C59" }}>
                  {fmt(report.incomes)} ₽
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ЧИСТЫЙ ПОТОК</div>
                <div style={{
                  fontSize: 18, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: "tabular-nums",
                  color: report.incomes - report.expenses >= 0 ? "#4A7C59" : "#8B3A3A",
                }}>
                  {report.incomes - report.expenses >= 0 ? "+" : "−"}
                  {fmt(report.incomes - report.expenses)} ₽
                </div>
              </div>
              <div style={{ marginLeft: "auto", alignSelf: "center" }}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ОПЕРАЦИЙ</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#1A1A1A" }}>{displayTx.length}</div>
              </div>
            </div>
          )}

          {/* Business summary strip */}
          {showBusiness && (
            <div style={{
              display: "flex", gap: 32, marginBottom: 16,
              paddingBottom: 16, borderBottom: "1px solid #EDEBE6",
            }}>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ПОТРАЧЕНО НА БИЗНЕС</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#8B3A3A" }}>{fmt(bizExpense)} ₽</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ПОЛУЧЕНО ОТ ИП</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#4A7C59" }}>{fmt(bizIncome)} ₽</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ОПЕРАЦИЙ</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#1A1A1A" }}>{displayTx.length}</div>
              </div>
              <div style={{ marginLeft: "auto", alignSelf: "center", fontSize: 11, color: "#A89070" }}>
                за последние 3 месяца
              </div>
            </div>
          )}

          {/* Filter / selection bar — always visible to prevent layout shift */}
          {(() => {
            const hasFilters = !!(bankFilter || catFilter || payeeFilter || amountMin || amountMax || dateFrom || dateTo);
            const canClear = hasFilters || selectedIds.size > 0;
            const exp = filteredTx.reduce((s: number, t: any) => s + (t.outcome > 0 && t.income === 0 ? t.outcome : 0), 0);
            const inc = filteredTx.reduce((s: number, t: any) => s + (t.income > 0 && t.outcome === 0 ? t.income : 0), 0);
            const selItems = filteredTx.filter((t: any) => selectedIds.has(String(t.id)));
            const selExp = selItems.reduce((s: number, t: any) => s + (t.outcome > 0 && t.income === 0 ? t.outcome : 0), 0);
            const selInc = selItems.reduce((s: number, t: any) => s + (t.income > 0 && t.outcome === 0 ? t.income : 0), 0);
            const selNet = selInc - selExp;
            const net = inc - exp;
            return (
              <div style={{ padding: "10px 0", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
                  {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
                  {selectedIds.size > 0 && selExp > 0 && <span style={{ color: "#8B3A3A" }}>−{fmt(selExp)}</span>}
                  {selectedIds.size > 0 && selInc > 0 && <span style={{ color: "#4A7C59" }}>+{fmt(selInc)}</span>}
                  {selectedIds.size > 0 && (selExp > 0 || selInc > 0) && <span style={{ color: selNet >= 0 ? "#4A7C59" : "#8B3A3A", fontWeight: 600 }}>{selNet >= 0 ? "+" : "−"}{fmt(Math.abs(selNet))}</span>}
                  {selectedIds.size === 0 && <span>{filteredTx.length} операций</span>}
                  {selectedIds.size === 0 && hasFilters && exp > 0 && <span style={{ color: "#8B3A3A" }}>−{fmt(exp)}</span>}
                  {selectedIds.size === 0 && hasFilters && inc > 0 && <span style={{ color: "#4A7C59" }}>+{fmt(inc)}</span>}
                  {selectedIds.size === 0 && hasFilters && (exp > 0 || inc > 0) && <span style={{ color: net >= 0 ? "#4A7C59" : "#8B3A3A", fontWeight: 600 }}>{net >= 0 ? "+" : "−"}{fmt(Math.abs(net))}</span>}
                </div>
                <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
                  <X size={10} /> Сбросить
                </button>
              </div>
            );
          })()}

          {/* Table header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: ZM_GRID,
            padding: "10px 0 6px",
            borderBottom: "1px solid #EDEBE6",
            alignItems: "center",
          }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <Checkbox
                checked={filteredTx.length > 0 && filteredTx.every((t: any) => selectedIds.has(String(t.id)))}
                indeterminate={filteredTx.some((t: any) => selectedIds.has(String(t.id))) && !filteredTx.every((t: any) => selectedIds.has(String(t.id)))}
                onChange={() => {
                  const allSel = filteredTx.every((t: any) => selectedIds.has(String(t.id)));
                  setSelectedIds(allSel ? new Set() : new Set(filteredTx.map((t: any) => String(t.id))));
                }}
              />
            </div>
            <div><PeriodFilter label="ДАТА" from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} /></div>
            <div style={{ display: "flex", alignItems: "center" }}>
              <ColumnFilter label="БАНК" options={uniqueBanks} value={bankFilter} onChange={setBankFilter} />
            </div>
            <div><ColumnFilter label="ПОЛУЧАТЕЛЬ" options={uniquePayees} value={payeeFilter} onChange={setPayeeFilter} maxHeight={220} /></div>
            <div><ColumnFilter label="КАТЕГОРИЯ" options={uniqueCats} value={catFilter} onChange={setCatFilter} /></div>
            <div><AmountFilter label="СУММА" min={amountMin} max={amountMax} onChange={(mn, mx) => { setAmountMin(mn); setAmountMax(mx); }} align="right" /></div>
            <div />
          </div>
        </div>

        {/* Transactions scroll area */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 28px 24px" }}>
          {filteredTx.length === 0 && (
            <EmptyState title="Нет операций" />
          )}
          {filteredTx.slice(0, 200).map((tx: any) => {
            const isExpense = tx.outcome > 0 && tx.income === 0;
            const isIncome = tx.income > 0 && tx.outcome === 0;
            const amount = isExpense ? tx.outcome : tx.income;
            const isBiz = !!tx.matched_contractor || tx.is_business_income;

            return (
              <div
                key={tx.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: ZM_GRID,
                  padding: "7px 0",
                  borderBottom: "1px solid #F2EFE9",
                  background: selectedIds.has(String(tx.id)) ? "#FFF8F5" : isBiz ? "#FFFBF5" : "transparent",
                  alignItems: "start",
                }}
              >
                <div style={{ paddingTop: 2 }}>
                  <Checkbox checked={selectedIds.has(String(tx.id))} onChange={() => toggleSelect(String(tx.id))} />
                </div>
                <div style={{ fontSize: 11, color: "#6B6355", paddingTop: 1, fontFamily: MONO }}>{tx.date?.slice(5)}</div>
                <div style={{ paddingTop: 1 }}>
                  <BankBadge title={isExpense ? (tx.outcome_account || "") : (tx.income_account || "")} />
                </div>
                <div style={{ position: "relative" }}>
                  {/* Кликабельный payee */}
                  <div
                    onClick={() => {
                      const payeeVal = (tx.payee || tx.comment || "").trim();
                      if (!payeeVal) return;
                      const isOpen = activePayeePopup?.txId === String(tx.id);
                      setActivePayeePopup(isOpen ? null : { txId: String(tx.id), payee: payeeVal, ruleId: tx.rule_id ?? null });
                    }}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 4,
                      fontSize: 12, color: "#1A1A1A", cursor: "pointer",
                    }}
                    title="Создать/редактировать правило сопоставления"
                  >
                    <span>{tx.payee || tx.comment || "—"}</span>
                    <Tag size={10} style={{ color: tx.rule_id ? "#E8592A" : "#C8C0B0", flexShrink: 0 }} />
                  </div>
                  {tx.payee && tx.comment && (
                    <div style={{ fontSize: 10, color: "#A89070" }}>{tx.comment}</div>
                  )}
                  {isBiz && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                      {tx.matched_contractor && (
                        <span style={{
                          fontSize: 9, background: tx.matched_via === "rule" ? "#EFF5F1" : "#FFF3EF",
                          color: tx.matched_via === "rule" ? "#4A7C59" : "#E8592A",
                          padding: "1px 5px",
                          border: `1px solid ${tx.matched_via === "rule" ? "#D0E0D4" : "#F0D8D0"}`,
                        }}>
                          {tx.matched_contractor}
                        </span>
                      )}
                      {tx.is_business_income && (
                        <span style={{
                          fontSize: 9, background: "#EFF5F1", color: "#4A7C59",
                          padding: "1px 5px", border: "1px solid #D0E0D4",
                        }}>
                          от ИП
                        </span>
                      )}
                    </div>
                  )}
                  {activePayeePopup?.txId === String(tx.id) && (
                    <PayeeRulePopup
                      payee={activePayeePopup.payee}
                      ruleId={activePayeePopup.ruleId}
                      onClose={() => setActivePayeePopup(null)}
                    />
                  )}
                </div>
                <div style={{ fontSize: 10, color: "#A89070", paddingTop: 1 }}>
                  {tx.display_category || (tx.tags as string[])?.[0] || ""}
                </div>
                <div>
                  <div style={{
                    fontSize: 12, fontWeight: 500, paddingTop: 1,
                    color: isIncome ? "#4A7C59" : "#1A1A1A",
                    fontFamily: MONO, fontVariantNumeric: "tabular-nums",
                  }}>
                    {isIncome ? "+" : "−"}{fmt(amount)} ₽
                  </div>
                  {creditorByZenTx.has(String(tx.id)) && (
                    <div style={{ fontSize: 10, color: "#4A7C59", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {creditorByZenTx.get(String(tx.id))?.name}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "center", paddingTop: 1 }}>
                  {isExpense && (
                    <IconButton icon={LinkSimple} title="Привязать к обязательству" size={24} iconSize={12}
                      color={creditorByZenTx.has(String(tx.id)) ? "#4A7C59" : "#C8C0B0"}
                      onClick={e => { e.stopPropagation(); setLinkModal(tx); }} />
                  )}
                </div>
              </div>
            );
          })}
          {linkModal && (
            <LinkZenModal
              tx={linkModal}
              creditorByZenTx={creditorByZenTx}
              onClose={() => setLinkModal(null)}
            />
          )}
        </div>
      </div>

      {/* ── Right: stats panel ───────────────────────────────── */}
      <div style={{
        width: 320,
        minWidth: 320,
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        padding: "24px 24px",
        gap: 0,
      }}>

        {/* Total balance */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>ИТОГО</div>
          <div style={{
            fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em",
            color: totalBalance >= 0 ? "#1A1A1A" : "#8B3A3A",
            fontFamily: MONO, fontVariantNumeric: "tabular-nums",
          }}>
            {totalBalance < 0 ? "−" : ""}{fmt(totalBalance)} ₽
          </div>
        </div>

        {/* Accounts */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>СЧЕТА</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {(accounts as any[])
              .filter((a: any) => a.balance !== 0)
              .map((acc: any) => (
                <div
                  key={acc.id}
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "7px 0",
                    borderBottom: "1px solid #F2EFE9",
                  }}
                >
                  <div style={{ fontSize: 12, color: "#6B6355" }}>{acc.title}</div>
                  <div style={{
                    fontSize: 13, fontWeight: 600,
                    color: acc.balance >= 0 ? "#1A1A1A" : "#8B3A3A",
                    fontFamily: MONO, fontVariantNumeric: "tabular-nums",
                  }}>
                    {acc.balance < 0 ? "−" : ""}{fmt(acc.balance)} ₽
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* Регулярные траты — раздельная статистика (подписки/связь/услуги карт/
            комиссии ИП): из Разноски они скрыты автоматом, объёмы видны здесь. */}
        <RecurringSection />

        {/* Личные траты: Райффайзен-переводы + помеченное «Личное» — счётчик для Юры */}
        <PersonalSpendingSection />

        {/* Cashflow chart */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14 }}>
            КЭШФЛОУ — 6 МЕС
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4 }}>
            {(cashflow as any[]).map((r: any) => {
              const incH = Math.max(Math.round((r.incomes / maxVal) * CHART_H), 2);
              const expH = Math.max(Math.round((r.expenses / maxVal) * CHART_H), 2);
              const [, m] = r.month.split("-");
              return (
                <div
                  key={r.month}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: 1 }}
                >
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: CHART_H }}>
                    <div
                      style={{ width: 10, height: incH, background: "#4A7C59" }}
                      title={`Доходы: ${fmt(r.incomes)} ₽`}
                    />
                    <div
                      style={{ width: 10, height: expH, background: "#EDEBE6" }}
                      title={`Расходы: ${fmt(r.expenses)} ₽`}
                    />
                  </div>
                  <div style={{ fontSize: 8, color: "#A89070" }}>{MONTHS_RU[parseInt(m) - 1]}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 8, height: 8, background: "#4A7C59" }} />
              <span style={{ fontSize: 10, color: "#A89070" }}>Доходы</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 8, height: 8, background: "#EDEBE6", border: "1px solid #CCC8C0" }} />
              <span style={{ fontSize: 10, color: "#A89070" }}>Расходы</span>
            </div>
          </div>
        </div>

        {/* Category breakdown */}
        {report && report.categories?.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>
              КАТЕГОРИИ · {getMonthLabel(selectedMonth).toUpperCase()}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {(report.categories as any[]).slice(0, 10).map((cat: any, i: number) => {
                const pct = report.expenses > 0
                  ? Math.round((cat.total / report.expenses) * 100)
                  : 0;
                const barW = Math.max(pct, 1);
                return (
                  <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #F2EFE9" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ fontSize: 11, color: "#1A1A1A" }}>{cat.category}</div>
                      <div style={{ fontSize: 11, color: "#8B3A3A", fontWeight: 500, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                        {fmt(cat.total)} ₽
                      </div>
                    </div>
                    <div style={{ height: 2, background: "#F2EFE9" }}>
                      <div style={{ height: 2, width: `${barW}%`, background: "#E8592A" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
