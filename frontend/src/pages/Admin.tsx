import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { UploadSimple, CheckCircle, WarningCircle, X, Plus, ArrowsClockwise } from "@phosphor-icons/react";
import { adminApi, authApi, zenmoneyApi, payeeRulesApi, mastersApi, customersApi } from "../api";
import { ConfirmModal } from "../components/ui/Modal";
import { CostingRefsSection } from "../components/CostingRefsSection";

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("ru-RU").format(n);
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function initials(name: string | undefined) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 16 }}>
    {children}
  </div>
);

// ── Upload Sberbank ──────────────────────────────────────────────────────────

function UploadSection() {
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; output: string; filename?: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const upload = async (file: File) => {
    setUploading(true);
    setResult(null);
    try {
      const res = await adminApi.uploadSber(file);
      setResult(res);
      if (res.ok) {
        qc.invalidateQueries({ queryKey: ["admin-system"] });
        qc.invalidateQueries({ queryKey: ["transactions"] });
        qc.invalidateQueries({ queryKey: ["balance"] });
      }
    } catch (e: any) {
      setResult({ ok: false, output: e?.response?.data?.detail || String(e) });
    } finally {
      setUploading(false);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) upload(file);
  }, []);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(file);
    e.target.value = "";
  };

  return (
    <div style={{ marginBottom: 40 }}>
      <SectionLabel>ЗАГРУЗКА ВЫПИСКИ — СБЕРБАНК</SectionLabel>

      <div
        onClick={() => !uploading && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${dragging ? "#E8592A" : "#EDEBE6"}`,
          padding: "36px 24px",
          textAlign: "center",
          cursor: uploading ? "default" : "pointer",
          background: dragging ? "#FFF8F5" : "#FAF8F5",
          transition: "all 0.15s",
          userSelect: "none",
        }}
      >
        <input ref={inputRef} type="file" accept=".csv,.xml,.txt" style={{ display: "none" }} onChange={onFile} />
        <UploadSimple size={28} color={dragging ? "#E8592A" : "#C8C0B0"} style={{ marginBottom: 10 }} />
        {uploading ? (
          <div style={{ fontSize: 13, color: "#A89070" }}>Загружаем и импортируем...</div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "#1A1A1A", fontWeight: 500, marginBottom: 4 }}>
              Перетащите файл выписки или нажмите для выбора
            </div>
            <div style={{ fontSize: 11, color: "#A89070" }}>CSV, XML (1C), TXT — форматы Сбербанка</div>
          </>
        )}
      </div>

      {result && (
        <div style={{
          marginTop: 12,
          padding: "12px 16px",
          background: result.ok ? "#EFF5F1" : "#FFF0F0",
          border: `1px solid ${result.ok ? "#D0E0D4" : "#F0D0D0"}`,
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}>
          {result.ok
            ? <CheckCircle size={18} color="#4A7C59" weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />
            : <WarningCircle size={18} color="#8B3A3A" weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />}
          <div>
            {result.filename && (
              <div style={{ fontSize: 11, color: "#A89070", marginBottom: 4 }}>{result.filename}</div>
            )}
            <pre style={{ fontSize: 12, color: result.ok ? "#2D5A3A" : "#6B2020", margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
              {result.output || (result.ok ? "Импорт выполнен успешно" : "Ошибка импорта")}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ── System Info ──────────────────────────────────────────────────────────────

function SystemSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-system"],
    queryFn: adminApi.system,
  });

  const rows = [
    { label: "Транзакции (finance.db)", value: fmt(data?.tx_count), sub: data?.tx_last_date ? `последняя: ${fmtDate(data.tx_last_date)}` : "" },
    { label: "Заказы (production.db)", value: fmt(data?.orders_count), sub: data?.customers_count != null ? `клиентов: ${data.customers_count}` : "" },
    {
      label: "Последний импорт Сбера",
      value: data?.last_import?.imported_at ? fmtDate(data.last_import.imported_at) : "—",
      sub: data?.last_import?.filename
        ? `${data.last_import.filename} · +${data.last_import.rows_added} строк`
        : (data?.last_import?.source || ""),
    },
  ];

  return (
    <div style={{ marginBottom: 40 }}>
      <SectionLabel>СИСТЕМА</SectionLabel>
      {isLoading ? (
        <div style={{ color: "#A89070", fontSize: 13 }}>Загружаем...</div>
      ) : (
        <div style={{ border: "1px solid #EDEBE6" }}>
          {rows.map((r, i) => (
            <div
              key={i}
              style={{
                display: "grid", gridTemplateColumns: "1fr auto",
                padding: "12px 16px",
                borderBottom: i < rows.length - 1 ? "1px solid #F2EFE9" : "none",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontSize: 12, color: "#1A1A1A" }}>{r.label}</div>
                {r.sub && <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>{r.sub}</div>}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>{r.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ZenMoney Sync ─────────────────────────────────────────────────────────────

function ZenMoneySyncSection() {
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: zenmoneyApi.sync,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zm-accounts"] });
      qc.invalidateQueries({ queryKey: ["zm-cashflow"] });
      qc.invalidateQueries({ queryKey: ["zm-report"] });
      qc.invalidateQueries({ queryKey: ["zm-transactions"] });
      qc.invalidateQueries({ queryKey: ["zm-business"] });
    },
  });

  return (
    <div style={{ marginBottom: 40 }}>
      <SectionLabel>ZENMONEY — ЛИЧНЫЕ ФИНАНСЫ</SectionLabel>
      <div style={{ border: "1px solid #EDEBE6", padding: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 13, color: "#1A1A1A", marginBottom: 3 }}>Синхронизация с ZenMoney</div>
            <div style={{ fontSize: 11, color: "#A89070" }}>
              Автоматически раз в час. Кнопка — принудительно сейчас.
            </div>
            {sync.isError && (
              <div style={{ fontSize: 11, color: "#8B3A3A", marginTop: 6 }}>
                {(sync.error as any)?.message || "Ошибка синхронизации"}
              </div>
            )}
            {sync.isSuccess && (sync.data as any)?.ok === false && (
              <div style={{ fontSize: 11, color: "#8B3A3A", marginTop: 6 }}>
                {(sync.data as any)?.error}
              </div>
            )}
            {sync.isSuccess && (sync.data as any)?.ok === true && (
              <div style={{ fontSize: 11, color: "#4A7C59", marginTop: 6 }}>Готово</div>
            )}
          </div>
          <button
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              background: sync.isPending ? "#F2EFE9" : "#1A1A1A",
              color: sync.isPending ? "#A89070" : "#FFFFFF",
              border: "none", padding: "8px 16px",
              cursor: sync.isPending ? "default" : "pointer",
              fontSize: 12, fontFamily: "inherit",
            }}
          >
            <ArrowsClockwise
              size={13}
              style={{ animation: sync.isPending ? "spin 1s linear infinite" : "none" }}
            />
            {sync.isPending ? "Синхронизация..." : "Синхронизировать"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Users ─────────────────────────────────────────────────────────────────────

function UsersSection() {
  const qc = useQueryClient();
  const { data: users = [] } = useQuery({ queryKey: ["admin-users"], queryFn: authApi.users });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "viewer" });
  const [formError, setFormError] = useState("");

  const addUser = useMutation({
    mutationFn: () => authApi.addUser(form as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setAdding(false);
      setForm({ email: "", name: "", password: "", role: "viewer" });
      setFormError("");
    },
    onError: (e: any) => setFormError(e?.response?.data?.detail || "Ошибка"),
  });

  // Сброс пароля: генерим здесь и показываем ОДИН раз — сервер хранит только hash
  const resetPwd = useMutation({
    mutationFn: ({ id, pwd }: { id: number; pwd: string }) => authApi.resetPassword(id, pwd),
  });
  const [shownPwd, setShownPwd] = useState<{ id: number; pwd: string } | null>(null);
  const doReset = (u: any) => {
    if (!confirm(`Выдать новый пароль для ${u.name}? Старый перестанет работать.`)) return;
    const pwd = Array.from(crypto.getRandomValues(new Uint8Array(9)), b => "abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKMNPQRSTUVWXYZ"[b % 54]).join("");
    resetPwd.mutate({ id: u.id, pwd }, { onSuccess: () => setShownPwd({ id: u.id, pwd }) });
  };

  const deleteUser = useMutation({
    mutationFn: (id: number) => authApi.deleteUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    border: "1px solid #EDEBE6", padding: "7px 10px",
    fontSize: 12, outline: "none",
  };

  return (
    <div style={{ marginBottom: 40 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <SectionLabel>ПОЛЬЗОВАТЕЛИ</SectionLabel>
        <div style={{ flex: 1 }} />
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "1px solid #EDEBE6", padding: "4px 10px", fontSize: 11, cursor: "pointer", color: "#6B6355" }}
          >
            <Plus size={11} /> Добавить
          </button>
        )}
      </div>

      {shownPwd && (
        <div style={{ border: "1px solid #B8860B", background: "#FFFBF2", padding: "10px 14px", marginBottom: 10, fontSize: 12 }}>
          Новый пароль для {(users as any[]).find((u: any) => u.id === shownPwd.id)?.name}:
          {" "}<b style={{ fontFamily: "monospace", fontSize: 13 }}>{shownPwd.pwd}</b>
          <div style={{ fontSize: 10, color: "#A89070", marginTop: 3 }}>Показан один раз — скопируй и передай. После закрытия страницы восстановить нельзя.</div>
        </div>
      )}
      <div style={{ border: "1px solid #EDEBE6" }}>
        {(users as any[]).map((u: any, i: number) => (
          <div
            key={u.id}
            style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "10px 16px",
              borderBottom: i < (users as any[]).length - 1 ? "1px solid #F2EFE9" : "none",
            }}
          >
            <div style={{
              width: 32, height: 32, background: "#E8E4DA",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700, color: "#6B6355", flexShrink: 0,
            }}>
              {initials(u.name)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{u.name}</div>
              <div style={{ fontSize: 11, color: "#A89070" }}>{u.email}</div>
            </div>
            <div style={{
              fontSize: 10, fontWeight: 600, letterSpacing: "0.06em",
              color: u.role === "admin" ? "#E8592A" : "#A89070",
            }}>
              {u.role.toUpperCase()}
            </div>
            <button
              onClick={() => doReset(u)}
              disabled={resetPwd.isPending}
              style={{ background: "none", border: "1px solid #EDEBE6", cursor: "pointer", color: "#6B6355", padding: "3px 8px", fontSize: 10, fontFamily: "inherit" }}
              title="Выдать новый пароль (старый восстановить нельзя — хранится только хэш)">
              сбросить пароль
            </button>
            <button
              onClick={() => deleteUser.mutate(u.id)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 4 }}
              title="Удалить пользователя"
              onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
              onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}
            >
              <X size={14} />
            </button>
          </div>
        ))}

        {adding && (
          <div style={{ padding: "16px", borderTop: (users as any[]).length > 0 ? "1px solid #EDEBE6" : "none", background: "#FAF8F5" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>EMAIL *</div>
                <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inputStyle} placeholder="ivan@company.com" />
              </div>
              <div>
                <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ИМЯ *</div>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} placeholder="Иван Иванов" />
              </div>
              <div>
                <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ПАРОЛЬ *</div>
                <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} style={inputStyle} placeholder="••••••••" />
              </div>
              <div>
                <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>РОЛЬ</div>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} style={{ ...inputStyle, background: "#fff" }}>
                  <option value="viewer">viewer</option>
                  <option value="admin">admin</option>
                </select>
              </div>
            </div>
            {formError && <div style={{ fontSize: 11, color: "#8B3A3A", marginBottom: 8 }}>{formError}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => addUser.mutate()}
                disabled={addUser.isPending || !form.email || !form.name || !form.password}
                style={{ padding: "6px 16px", background: "#E8592A", border: "none", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
              >
                {addUser.isPending ? "Создаём..." : "Создать"}
              </button>
              <button
                onClick={() => { setAdding(false); setFormError(""); }}
                style={{ padding: "6px 12px", background: "none", border: "1px solid #EDEBE6", fontSize: 12, cursor: "pointer", color: "#6B6355" }}
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Import History ───────────────────────────────────────────────────────────

function ImportsSection() {
  const qc = useQueryClient();
  const { data: imports = [], isLoading } = useQuery({
    queryKey: ["admin-imports"],
    queryFn: adminApi.imports,
  });

  const [confirmId, setConfirmId] = useState<number | null>(null);
  const confirmImport = confirmId != null ? (imports as any[]).find((i: any) => i.id === confirmId) : null;

  const deleteImport = useMutation({
    mutationFn: (id: number) => adminApi.deleteImport(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-imports"] });
      qc.invalidateQueries({ queryKey: ["admin-system"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["balance"] });
      setConfirmId(null);
    },
  });

  const SOURCE_LABELS: Record<string, string> = {
    sber_1c:   "Сбер (1С)",
    sber_csv:  "Сбер (CSV)",
    tbank_api: "Т-Банк (API)",
  };

  function fmtDatetime(s: string) {
    if (!s) return "—";
    const d = new Date(s);
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })
      + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div style={{ marginBottom: 40 }}>
      <SectionLabel>ИСТОРИЯ ИМПОРТОВ</SectionLabel>

      {isLoading ? (
        <div style={{ color: "#A89070", fontSize: 13 }}>Загружаем...</div>
      ) : (imports as any[]).length === 0 ? (
        <div style={{ color: "#A89070", fontSize: 13 }}>Нет загруженных выписок</div>
      ) : (
        <div style={{ border: "1px solid #EDEBE6" }}>
          {(imports as any[]).map((imp: any, i: number) => (
            <div
              key={imp.id}
              style={{
                display: "grid", gridTemplateColumns: "1fr auto auto auto",
                padding: "11px 16px", gap: 16, alignItems: "center",
                borderBottom: i < (imports as any[]).length - 1 ? "1px solid #F2EFE9" : "none",
              }}
            >
              <div>
                <div style={{ fontSize: 12, color: "#1A1A1A", fontWeight: 500 }}>
                  {imp.filename || SOURCE_LABELS[imp.source] || imp.source}
                </div>
                <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>
                  {fmtDatetime(imp.imported_at)}
                  {imp.date_from && imp.date_to && imp.date_from !== imp.imported_at?.slice(0,10) && (
                    <span> · {imp.date_from === imp.date_to ? imp.date_from : `${imp.date_from} — ${imp.date_to}`}</span>
                  )}
                </div>
              </div>
              <div style={{ fontSize: 11, color: "#A89070", whiteSpace: "nowrap" }}>
                {SOURCE_LABELS[imp.source] || imp.source}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#4A7C59", whiteSpace: "nowrap" }}>
                +{imp.rows_added} строк
              </div>
              <button
                onClick={() => setConfirmId(imp.id)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 4 }}
                title="Удалить выписку"
                onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Confirmation modal */}
      {confirmImport && (
        <ConfirmModal
          message={`«${confirmImport.filename || SOURCE_LABELS[confirmImport.source] || confirmImport.source}» (загружена ${fmtDatetime(confirmImport.imported_at)}, ${confirmImport.rows_added} транзакций). Все транзакции этой выписки будут удалены из базы. Отменить нельзя.`}
          confirmLabel={deleteImport.isPending ? "Удаляем..." : "Да, удалить"}
          onConfirm={() => deleteImport.mutate(confirmImport.id)}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}

// ── Payee Rules ──────────────────────────────────────────────────────────────

const MATCH_TYPE_LABELS_ADM: Record<string, string> = { exact: "точное", contains: "содержит", prefix: "с начала" };
const ENTITY_TYPE_LABELS_ADM: Record<string, string> = {
  contractor: "Подрядчик", customer: "Клиент", master: "Мастер", label: "Метка", skip: "Игнор",
};

function EntityPickerAdmin({ entityType, value, onChange }: {
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

  const inputSt: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "6px 8px", fontSize: 12, outline: "none", fontFamily: "inherit" };

  return (
    <div>
      <div style={{ fontSize: 10, color: "#A89070", marginBottom: 3 }}>
        {entityType === "customer" ? "КЛИЕНТ" : "МАСТЕР / ПОДРЯДЧИК"}
      </div>
      {value.name ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", border: "1px solid #EDEBE6", marginBottom: 4, background: "#F9F6F2" }}>
          <span style={{ flex: 1, fontSize: 12, color: "#1A1A1A" }}>{value.name}</span>
          <button onClick={() => onChange("", "")} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", padding: 0, fontSize: 14 }}>✕</button>
        </div>
      ) : (
        <div style={{ position: "relative" }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Начните вводить имя..." style={inputSt} />
          {q && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100, border: "1px solid #EDEBE6", borderTop: "none", background: "#FFF", maxHeight: 160, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
              {filtered.length === 0 && <div style={{ padding: "7px 10px", fontSize: 12, color: "#A89070" }}>Не найдено</div>}
              {filtered.map(item => (
                <div key={item.id} onClick={() => { onChange(item.id, item.name); setQ(""); }}
                  style={{ padding: "7px 10px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid #F2EFE9" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                  {item.name}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PayeeRulesSection() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ pattern: "", match_type: "exact", display_name: "", entity_type: "label", entity_id: "", entity_name: "" });

  const { data: rules = [] } = useQuery({ queryKey: ["payee-rules"], queryFn: () => payeeRulesApi.list({}) });

  const save = useMutation({
    mutationFn: () => editId ? payeeRulesApi.update(editId, form) : payeeRulesApi.create(form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payee-rules"] }); qc.invalidateQueries({ queryKey: ["zm-business"] }); setAdding(false); setEditId(null); setForm({ pattern: "", match_type: "exact", display_name: "", entity_type: "label", entity_id: "", entity_name: "" }); },
  });

  const del = useMutation({
    mutationFn: (id: number) => payeeRulesApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payee-rules"] }); qc.invalidateQueries({ queryKey: ["zm-business"] }); },
  });

  const startEdit = (r: any) => {
    setEditId(r.id);
    setForm({ pattern: r.pattern, match_type: r.match_type, display_name: r.display_name || "", entity_type: r.entity_type || "label", entity_id: r.entity_id || "", entity_name: r.entity_name || "" });
    setAdding(true);
  };

  const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "6px 8px", fontSize: 12, outline: "none", fontFamily: "inherit" };

  return (
    <div style={{ marginBottom: 40 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <SectionLabel>ПРАВИЛА СОПОСТАВЛЕНИЯ ПЛАТЕЖЕЙ</SectionLabel>
        <button onClick={() => { setEditId(null); setForm({ pattern: "", match_type: "exact", display_name: "", entity_type: "label", entity_id: "", entity_name: "" }); setAdding(v => !v); }}
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, background: "none", border: "1px solid #EDEBE6", padding: "4px 10px", fontSize: 11, cursor: "pointer", color: "#6B6355", fontFamily: "inherit" }}>
          <Plus size={11} /> Добавить
        </button>
      </div>

      {adding && (
        <div style={{ border: "1px solid #EDEBE6", padding: 16, marginBottom: 16, background: "#FAF8F5" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8, marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", marginBottom: 3 }}>ПАТТЕРН</div>
              <input value={form.pattern} onChange={e => setForm(f => ({ ...f, pattern: e.target.value.toLowerCase() }))}
                placeholder="yandex*доставка или имя в выписке" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", marginBottom: 3 }}>ТИП</div>
              <select value={form.match_type} onChange={e => setForm(f => ({ ...f, match_type: e.target.value }))} style={{ ...inputStyle, cursor: "pointer" }}>
                <option value="exact">Точное</option>
                <option value="contains">Содержит</option>
                <option value="prefix">С начала</option>
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 1fr", gap: 8, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", marginBottom: 3 }}>МЕТКА (DISPLAY NAME)</div>
              <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                placeholder="Яндекс.Доставка" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", marginBottom: 3 }}>СУЩНОСТЬ</div>
              <select value={form.entity_type} onChange={e => setForm(f => ({ ...f, entity_type: e.target.value }))} style={{ ...inputStyle, cursor: "pointer" }}>
                <option value="label">Метка</option>
                <option value="contractor">Подрядчик</option>
                <option value="customer">Клиент</option>
                <option value="master">Мастер</option>
                <option value="skip">Игнорировать</option>
              </select>
            </div>
            {["contractor", "customer", "master"].includes(form.entity_type) && (
              <EntityPickerAdmin
                entityType={form.entity_type}
                value={{ id: form.entity_id, name: form.entity_name }}
                onChange={(id, name) => setForm(f => ({ ...f, entity_id: id, entity_name: name }))}
              />
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => save.mutate()} disabled={!form.pattern || save.isPending}
              style={{ background: "#1A1A1A", color: "#FFF", border: "none", padding: "7px 20px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              {save.isPending ? "Сохраняем..." : editId ? "Обновить" : "Создать"}
            </button>
            <button onClick={() => { setAdding(false); setEditId(null); }}
              style={{ background: "none", border: "1px solid #EDEBE6", padding: "7px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: "#6B6355" }}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {(rules as any[]).length === 0 && !adding && (
        <div style={{ color: "#A89070", fontSize: 13 }}>Правил пока нет</div>
      )}

      {(rules as any[]).length > 0 && (
        <div style={{ border: "1px solid #EDEBE6" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 120px 100px 60px", padding: "8px 12px", borderBottom: "1px solid #EDEBE6", background: "#FAF8F5" }}>
            {["ПАТТЕРН", "ТИП", "МЕТКА", "СУЩНОСТЬ", ""].map((h, i) => (
              <div key={i} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em" }}>{h}</div>
            ))}
          </div>
          {(rules as any[]).map((r: any) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr 80px 120px 100px 60px", padding: "9px 12px", borderBottom: "1px solid #F2EFE9", alignItems: "center" }}>
              <code style={{ fontSize: 11 }}>{r.pattern}</code>
              <div style={{ fontSize: 11, color: "#6B6355" }}>{MATCH_TYPE_LABELS_ADM[r.match_type] || r.match_type}</div>
              <div style={{ fontSize: 11, color: "#1A1A1A" }}>{r.display_name || "—"}</div>
              <div style={{ fontSize: 11, color: "#6B6355" }}>
                {ENTITY_TYPE_LABELS_ADM[r.entity_type] || r.entity_type || "—"}
                {r.entity_name && <span style={{ color: "#A89070" }}> · {r.entity_name}</span>}
              </div>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button onClick={() => startEdit(r)} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", padding: 2 }} title="Редактировать">✎</button>
                <button onClick={() => del.mutate(r.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2 }} title="Удалить">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Change Password ──────────────────────────────────────────────────────────

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (next !== repeat) { setMsg({ ok: false, text: "Новые пароли не совпадают" }); return; }
    if (next.length < 6) { setMsg({ ok: false, text: "Пароль минимум 6 символов" }); return; }
    setSaving(true);
    setMsg(null);
    try {
      await authApi.changePassword({ current_password: current, new_password: next });
      setMsg({ ok: true, text: "Пароль успешно изменён" });
      setCurrent(""); setNext(""); setRepeat("");
    } catch (e: any) {
      setMsg({ ok: false, text: e?.response?.data?.detail || "Ошибка" });
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    border: "1px solid #EDEBE6", padding: "8px 10px",
    fontSize: 13, outline: "none",
  };

  return (
    <div style={{ marginBottom: 40 }}>
      <SectionLabel>СМЕНА ПАРОЛЯ</SectionLabel>
      <div style={{ maxWidth: 360, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ТЕКУЩИЙ ПАРОЛЬ</div>
          <input type="password" value={current} onChange={e => setCurrent(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>НОВЫЙ ПАРОЛЬ</div>
          <input type="password" value={next} onChange={e => setNext(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ПОВТОР ПАРОЛЯ</div>
          <input type="password" value={repeat} onChange={e => setRepeat(e.target.value)} style={inputStyle}
            onKeyDown={e => e.key === "Enter" && save()} />
        </div>
        {msg && (
          <div style={{ fontSize: 12, color: msg.ok ? "#4A7C59" : "#8B3A3A", display: "flex", alignItems: "center", gap: 6 }}>
            {msg.ok
              ? <CheckCircle size={14} weight="fill" />
              : <WarningCircle size={14} weight="fill" />}
            {msg.text}
          </div>
        )}
        <button
          onClick={save}
          disabled={saving || !current || !next || !repeat}
          style={{
            padding: "8px 20px", border: "none",
            background: current && next && repeat ? "#E8592A" : "#EDEBE6",
            color: current && next && repeat ? "#fff" : "#A89070",
            fontSize: 13, fontWeight: 600, cursor: current && next && repeat ? "pointer" : "default",
            alignSelf: "flex-start",
          }}
        >
          {saving ? "Сохраняем..." : "Сохранить"}
        </button>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

// Вкладки: 8 секций одним полотном не читались (просьба Юры 01.08.2026).
const ADMIN_TABS = [
  { id: "bank",    label: "Банк и импорт" },
  { id: "rules",   label: "Правила платежей" },
  { id: "costing", label: "Справочники цен" },
  { id: "access",  label: "Доступ" },
  { id: "system",  label: "Система" },
] as const;

export default function Admin() {
  const [tab, setTab] = useState<(typeof ADMIN_TABS)[number]["id"]>("bank");
  return (
    <div style={{ padding: "24px 28px", maxWidth: 720, fontFamily: "inherit" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", color: "#1A1A1A" }}>
          Настройки
        </div>
      </div>

      <div style={{ display: "flex", gap: 22, borderBottom: "1px solid #EDEBE6", marginBottom: 28 }}>
        {ADMIN_TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit",
              padding: "0 0 10px", fontSize: 13,
              fontWeight: tab === t.id ? 700 : 400,
              color: tab === t.id ? "#1A1A1A" : "#A89070",
              borderBottom: tab === t.id ? "2px solid #E8592A" : "2px solid transparent",
              marginBottom: -1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "bank" && (<><UploadSection /><ImportsSection /><ZenMoneySyncSection /></>)}
      {tab === "rules" && <PayeeRulesSection />}
      {tab === "costing" && <CostingRefsSection />}
      {tab === "access" && (<><UsersSection /><PasswordSection /></>)}
      {tab === "system" && <SystemSection />}
    </div>
  );
}
