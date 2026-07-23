// Единый скелет правой панели Вики: шапка (аватар + заголовок + статус-бейдж +
// правка/закрытие) → опц. полоса метрик-плиток → скролл-тело с секциями.
// Все 5 категорий рендерятся через него — расходится только содержимое (metrics,
// секции), а вид (типографика, отступы, крестик) единый.
import type { ReactNode } from "react";
import { PencilSimple, X } from "@phosphor-icons/react";
import { IconButton } from "../../components/ui/IconButton";
import { MONO } from "../../components/ui/Num";
import { T, PAD } from "../../components/ui/type";
import { initials } from "./helpers";

export type DetailMetric = { label: string; value: ReactNode; color?: string };

type Avatar =
  | { kind: "initials"; name: string; tint?: string }
  | { kind: "colorDot"; color: string }
  | null;

export function DetailShell({
  title, subtitle, status, avatar = null, metrics, onEdit, onClose, children,
}: {
  title: string;
  subtitle?: string | null;
  status?: { label: string; color?: string } | null;
  avatar?: Avatar;
  metrics?: DetailMetric[];
  onEdit?: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {/* Шапка */}
      <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
          {avatar && (avatar.kind === "colorDot" ? (
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: avatar.color, flexShrink: 0 }} />
          ) : (
            <div style={{
              width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
              background: avatar.tint || "#F2EFE9", display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: "#1A1A1A",
            }}>{initials(avatar.name)}</div>
          ))}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ ...T.detailTitle, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
              {status && (
                <span style={{
                  fontSize: 11, fontWeight: 600, color: status.color || "#A89070",
                  border: `1px solid ${status.color || "#EDEBE6"}`, padding: "2px 7px",
                  letterSpacing: "0.02em", flexShrink: 0, whiteSpace: "nowrap",
                }}>{status.label}</span>
              )}
            </div>
            {subtitle && <div style={{ ...T.bodyMuted, marginTop: 3 }}>{subtitle}</div>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
          {onEdit && <IconButton icon={PencilSimple} title="Редактировать" size={28} iconSize={16} color="#C8C0B0" onClick={onEdit} />}
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 6 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}>
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Тело */}
      <div style={{ flex: 1, overflowY: "auto", padding: PAD.panel }}>
        {metrics && metrics.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${metrics.length}, 1fr)`, gap: 10, marginBottom: 20 }}>
            {metrics.map((m, i) => (
              <div key={i} style={{ background: "#FAF8F5", padding: "9px 11px" }}>
                <div style={{ ...T.metricLabel, marginBottom: 3 }}>{m.label}</div>
                <div style={{ ...T.metricValue, color: m.color || "#1A1A1A" }}>{m.value}</div>
              </div>
            ))}
          </div>
        )}
        {children}
      </div>
    </>
  );
}

// Заголовок секции внутри детали — единый вид (T.sectionLabel).
export function DetailSection({ label, extra, children, first }: {
  label: string; extra?: ReactNode; children: ReactNode; first?: boolean;
}) {
  return (
    <div style={{ marginTop: first ? 0 : 20 }}>
      <div style={{ ...T.sectionLabel, marginBottom: 10 }}>
        {label}{extra != null && <span style={{ color: "#C8C0B0", fontWeight: 400, letterSpacing: 0 }}> {extra}</span>}
      </div>
      {children}
    </div>
  );
}

// Заметка-блок — единый вид (тонированная подложка + рельс).
export function NoteBlock({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: 8, padding: "10px 12px", background: "#FAF8F5", fontSize: 13, color: "#1A1A1A", lineHeight: 1.7, borderLeft: "3px solid #EDEBE6" }}>
      {children}
    </div>
  );
}

export { MONO };
