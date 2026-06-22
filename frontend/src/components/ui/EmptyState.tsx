// Единое пустое состояние списка/раздела: по центру, сдержанно,
// опционально иконка, подсказка и кнопка-действие (CTA).
export function EmptyState({ title, hint, icon: Icon, action, compact }: {
  title: string;
  hint?: string;
  icon?: React.ComponentType<{ size?: number }>;
  action?: { label: string; onClick: () => void };
  compact?: boolean;
}) {
  return (
    <div style={{
      padding: compact ? "28px 20px" : "56px 24px",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center",
    }}>
      {Icon && <div style={{ color: "#D0C8C0", marginBottom: 2 }}><Icon size={28} /></div>}
      <div style={{ fontSize: 13, color: "#A89070" }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: "#C8C0B0", maxWidth: 320, lineHeight: 1.5 }}>{hint}</div>}
      {action && (
        <button
          onClick={action.onClick}
          style={{ marginTop: 6, padding: "7px 16px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
        >{action.label}</button>
      )}
    </div>
  );
}
