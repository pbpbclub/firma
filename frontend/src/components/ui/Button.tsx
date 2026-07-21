// Единая кнопка приложения. Углы строго прямые, инлайн-стили (канон проекта).
//   primary — оранжевый акцент, главное действие экрана/модалки;
//   ghost   — нейтральная с бордером, второстепенные действия;
//   danger  — бордовая, удаление/необратимое.
import React from "react";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
};

const VARIANTS: Record<string, React.CSSProperties> = {
  primary: { background: "#E8592A", color: "#FFFFFF", border: "1px solid #E8592A" },
  ghost:   { background: "#FFFFFF", color: "#1A1A1A", border: "1px solid #EDEBE6" },
  danger:  { background: "#8B3A3A", color: "#FFFFFF", border: "1px solid #8B3A3A" },
};

export function Button({ variant = "ghost", size = "md", style, disabled, children, ...rest }: Props) {
  return (
    <button
      {...rest}
      disabled={disabled}
      style={{
        ...VARIANTS[variant],
        padding: size === "sm" ? "5px 12px" : "7px 20px",
        fontSize: size === "sm" ? 12 : 13,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        borderRadius: 0,
        fontFamily: "inherit",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
