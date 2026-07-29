// Честная ошибка загрузки вместо экрана с нулями. Бэк с 29.07 отвечает 503,
// когда база недоступна, — раньше приходил 200 с нулями, и «на счетах 0 ₽»
// было неотличимо от «база не открылась» (обманчиво в плохой день).
import { Warning } from "@phosphor-icons/react";

export function QueryError({ error, what = "данные" }: { error?: unknown; what?: string }) {
  const detail = (error as any)?.response?.data?.detail || (error as any)?.message || "";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, margin: "18px 28px",
                  border: "1px solid #EDEBE6", borderLeft: "3px solid #8B3A3A",
                  background: "#FAF8F5", padding: "12px 16px" }}>
      <Warning size={15} style={{ color: "#8B3A3A", flexShrink: 0, marginTop: 1 }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>
          Не удалось загрузить {what}
        </div>
        <div style={{ fontSize: 11, color: "#6B6355", marginTop: 3, lineHeight: 1.5 }}>
          Цифры не показаны, чтобы не врать нулями. Обнови страницу; если не помогло —
          база временно недоступна, попробуй через минуту.
        </div>
        {detail && (
          <div style={{ fontSize: 10, color: "#A89070", marginTop: 4, fontFamily: "monospace" }}>{String(detail).slice(0, 160)}</div>
        )}
      </div>
    </div>
  );
}
