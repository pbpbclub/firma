import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { UploadSimple, CheckCircle, WarningCircle, X, Plus } from "@phosphor-icons/react";
import { adminApi, authApi } from "../api";

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

// ── Users ────────────────────────────────────────────────────────────────────

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

export default function Admin() {
  return (
    <div style={{ padding: "40px 48px", maxWidth: 720, fontFamily: "inherit" }}>
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", color: "#1A1A1A" }}>
          Настройки
        </div>
      </div>

      <UploadSection />
      <SystemSection />
      <UsersSection />
      <PasswordSection />
    </div>
  );
}
