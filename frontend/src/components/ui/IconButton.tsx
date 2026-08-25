import { useState } from "react";
import { useIsMobile } from "./responsive";

// Единая иконка-кнопка: фикс-размер, цвет #6B6355 → hover #1A1A1A (danger → #8B3A3A),
// обязательный title (тултип). Заменяет разнобой инлайн-кнопок по проекту.
export function IconButton({
  icon: Icon, title, onClick, tone = "default", size = 28, iconSize, disabled, active, color,
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  tone?: "default" | "danger";
  size?: number;
  iconSize?: number;
  disabled?: boolean;
  active?: boolean;          // подсвечен (напр. привязано) — зелёным
  color?: string;            // явный базовый цвет (перебивает tone)
}) {
  const base = color ?? (active ? "#4A7C59" : tone === "danger" ? "#8B3A3A" : "#6B6355");
  const hover = tone === "danger" ? "#8B3A3A" : "#1A1A1A";
  const [hovered, setHovered] = useState(false);
  // Телефон: зона тапа не меньше 36px, иконка остаётся прежней.
  const isMobile = useIsMobile();
  if (isMobile) { iconSize = iconSize ?? Math.round(size * 0.5); size = Math.max(size, 36); }
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: size, height: size, padding: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "none", border: "none",
        cursor: disabled ? "default" : "pointer",
        color: disabled ? "#D0C8C0" : hovered ? hover : base,
        flexShrink: 0,
      }}
    >
      <Icon size={iconSize ?? Math.round(size * 0.5)} />
    </button>
  );
}
