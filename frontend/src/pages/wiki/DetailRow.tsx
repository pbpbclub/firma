import { MONO } from "../../components/ui/Num";

// Общая строка «метка — значение» в карточке вики (раньше 2 копии).
export function DetailRow({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #F2EFE9" }}>
      <div style={{ fontSize: 11, color: "#A89070" }}>{label}</div>
      <div style={{
        fontSize: 12, fontWeight: 500, color: value ? "#1A1A1A" : "#C8C0B0",
        textAlign: "right", maxWidth: 240, wordBreak: "break-word",
        fontFamily: mono && value ? MONO : undefined, fontVariantNumeric: mono ? "tabular-nums" : undefined,
      }}>{value || "—"}</div>
    </div>
  );
}
