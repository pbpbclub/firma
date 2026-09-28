// Кнопка-действие «иконка + подпись» с рамкой — явная кликабельность, не серый
// текст (правило Юры 24.07.2026). Образец — ActionChip разноски (ExpensesInbox).
import { useState, type ReactNode } from "react";

export function ActionChip({ icon, label, title, onClick, disabled }:
  { icon: ReactNode; label: string; title?: string; onClick: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false);
  const hot = hover && !disabled;
  return (
    <button type="button" onClick={onClick} title={title} disabled={disabled}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, lineHeight: 1,
        padding: "4px 9px", cursor: disabled ? "default" : "pointer", fontFamily: "inherit",
        border: `1px solid ${hot ? "#E8592A" : "#EDEBE6"}`,
        background: hot ? "#FFF4EE" : "#fff", color: hot ? "#E8592A" : "#6B6355",
        opacity: disabled ? 0.5 : 1,
      }}>
      {icon} {label}
    </button>
  );
}
