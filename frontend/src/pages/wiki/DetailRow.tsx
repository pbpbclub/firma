import { useState } from "react";
import { MONO } from "../../components/ui/Num";

// Общая строка «метка — значение» в карточке вики. Метка — мета 11, значение —
// контент 13 (единый кегль контента по всей Вики). href — значение кликабельно
// (звонок, почта, переход в мессенджер).
export function DetailRow({ label, value, mono, href, valueColor }: {
  label: string; value?: string | null; mono?: boolean; href?: string; valueColor?: string;
}) {
  const [hover, setHover] = useState(false);
  const valueStyle: React.CSSProperties = {
    fontSize: 13, fontWeight: 500,
    color: !value ? "#C8C0B0" : href && hover ? "#E8592A" : valueColor || "#1A1A1A",
    textAlign: "right", maxWidth: 240, wordBreak: "break-word",
    fontFamily: mono && value ? MONO : undefined, fontVariantNumeric: mono ? "tabular-nums" : undefined,
  };
  const external = !!href && !/^(tel:|mailto:)/.test(href);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #F2EFE9" }}>
      <div style={{ fontSize: 11, color: "#A89070" }}>{label}</div>
      {href && value ? (
        <a href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
          style={{ ...valueStyle, textDecoration: "none", cursor: "pointer" }}>{value}</a>
      ) : (
        <div style={valueStyle}>{value || "—"}</div>
      )}
    </div>
  );
}
