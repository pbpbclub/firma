import { useEffect } from "react";
import { X, Trash } from "@phosphor-icons/react";

const WIDTHS = { sm: 380, md: 480, lg: 680 } as const;

// Единое модальное окно: overlay + центрированный белый контейнер,
// шапка-метка (eyebrow) + X, тело-скролл, опциональный футер действий.
// Esc и клик по фону = закрыть.
// Стек открытых окон: Esc закрывает ТОЛЬКО верхнее.
// Каждое окно вешало свой глобальный обработчик, и один Esc закрывал все сразу —
// подтверждение поверх формы уносило с собой и форму (24.08.2026).
const modalStack: symbol[] = [];

function useEscapeTop(onClose: () => void) {
  useEffect(() => {
    const token = Symbol("modal");
    modalStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modalStack[modalStack.length - 1] !== token) return;   // не верхнее — не наше дело
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
}

export function Modal({
  size = "md", eyebrow, onClose, children,
  footerLeft, onDelete, deleteLabel = "Удалить",
  onCancel, onSave, saveLabel = "Сохранить", saving, canSave = true,
  zIndex = 1000,
}: {
  size?: keyof typeof WIDTHS;
  eyebrow?: string;
  onClose: () => void;
  children: React.ReactNode;
  footerLeft?: React.ReactNode;
  onDelete?: () => void;
  deleteLabel?: string;
  onCancel?: () => void;
  onSave?: () => void;
  saveLabel?: string;
  saving?: boolean;
  canSave?: boolean;
  zIndex?: number;
}) {
  useEscapeTop(onClose);

  const hasFooter = footerLeft || onDelete || onSave || onCancel;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{ background: "#FFFFFF", width: WIDTHS[size], maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.16)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "16px 24px", borderBottom: "1px solid #EDEBE6", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>{eyebrow}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", display: "flex", alignItems: "center", padding: 4 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", flex: 1 }}>{children}</div>

        {/* Footer */}
        {hasFooter && (
          <div style={{ padding: "14px 24px", borderTop: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
            <div>
              {footerLeft ?? (onDelete ? (
                <button onClick={onDelete}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#8B3A3A", display: "flex", alignItems: "center", gap: 5 }}>
                  <Trash size={13} /> {deleteLabel}
                </button>
              ) : null)}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {onCancel && (
                <button onClick={onCancel}
                  style={{ padding: "7px 16px", background: "#F2EFE9", border: "none", cursor: "pointer", fontSize: 12, color: "#6B6355" }}>
                  Отмена
                </button>
              )}
              {onSave && (
                <button onClick={onSave} disabled={saving || !canSave}
                  style={{
                    padding: "7px 20px", border: "none", fontSize: 12, fontWeight: 600,
                    background: canSave ? "#E8592A" : "#EDEBE6",
                    color: canSave ? "#FFFFFF" : "#A89070",
                    cursor: canSave && !saving ? "pointer" : "default",
                  }}>
                  {saving ? "Сохраняем..." : saveLabel}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Подтверждение удаления (sm).
export function ConfirmModal({ message, confirmLabel = "Удалить безвозвратно", onConfirm, onCancel }: {
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Раньше подтверждение не закрывалось ни Esc, ни кликом мимо — в отличие от Modal.
  useEscapeTop(onCancel);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", padding: "28px 32px", maxWidth: 380, boxShadow: "0 8px 40px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ fontSize: 13, color: "#1A1A1A", lineHeight: 1.5 }}>{message}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{ padding: "7px 16px", background: "#F2EFE9", border: "none", cursor: "pointer", fontSize: 12, color: "#6B6355" }}>
            Отмена
          </button>
          <button onClick={onConfirm} style={{ padding: "7px 16px", background: "#8B3A3A", border: "none", cursor: "pointer", fontSize: 12, color: "#fff", fontWeight: 600 }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
