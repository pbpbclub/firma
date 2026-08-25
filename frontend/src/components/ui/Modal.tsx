import { useEffect } from "react";
import { X, Trash } from "@phosphor-icons/react";
import { useIsMobile } from "./responsive";

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
  // Телефон: лист снизу на всю ширину, кнопки футера во всю ширину под палец.
  const isMobile = useIsMobile();

  const hasFooter = footerLeft || onDelete || onSave || onCancel;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Именно <form>, а не div: Enter в поле сохраняет форму, и это работает
          сразу во всех модалках. Раньше Enter не делал ничего в 20 формах из 26 —
          набрал сумму и обязан взять мышь. В <textarea> Enter по-прежнему переносит
          строку (нативное поведение формы), заметки и JSON не ломаются. */}
      <form
        onSubmit={e => { e.preventDefault(); if (onSave && !saving && canSave) onSave(); }}
        style={{ background: "#FFFFFF", width: isMobile ? "100%" : WIDTHS[size], maxWidth: isMobile ? "100%" : "95vw",
                 maxHeight: isMobile ? "92dvh" : "90vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.16)",
                 paddingBottom: isMobile ? "env(safe-area-inset-bottom)" : 0 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "16px 24px", borderBottom: "1px solid #EDEBE6", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>{eyebrow}</div>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070", display: "flex", alignItems: "center", padding: 4 }}
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
          <div style={{ padding: isMobile ? "12px 16px" : "14px 24px", borderTop: "1px solid #EDEBE6", display: "flex",
                        flexDirection: isMobile ? "column" : "row", gap: isMobile ? 10 : 0,
                        justifyContent: "space-between", alignItems: isMobile ? "stretch" : "center", flexShrink: 0 }}>
            <div>
              {footerLeft ?? (onDelete ? (
                <button type="button" onClick={onDelete}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#8B3A3A", display: "flex", alignItems: "center", gap: 5 }}>
                  <Trash size={13} /> {deleteLabel}
                </button>
              ) : null)}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {onCancel && (
                <button type="button" onClick={onCancel}
                  style={{ padding: isMobile ? "12px 16px" : "7px 16px", background: "#F2EFE9", border: "none", cursor: "pointer",
                           fontSize: isMobile ? 14 : 12, color: "#6B6355", flex: isMobile ? 1 : undefined }}>
                  Отмена
                </button>
              )}
              {onSave && (
                <button type="submit" disabled={saving || !canSave}
                  style={{
                    padding: isMobile ? "12px 20px" : "7px 20px", border: "none", fontSize: isMobile ? 14 : 12, fontWeight: 600,
                    flex: isMobile ? 1 : undefined,
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
      </form>
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
  const isMobile = useIsMobile();
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", padding: isMobile ? "24px 20px" : "28px 32px", maxWidth: "min(380px, calc(100vw - 32px))",
                 boxShadow: "0 8px 40px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ fontSize: 13, color: "#1A1A1A", lineHeight: 1.5 }}>{message}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} style={{ padding: isMobile ? "12px 16px" : "7px 16px", background: "#F2EFE9", border: "none", cursor: "pointer", fontSize: isMobile ? 14 : 12, color: "#6B6355", flex: isMobile ? 1 : undefined }}>
            Отмена
          </button>
          <button type="button" onClick={onConfirm} style={{ padding: isMobile ? "12px 16px" : "7px 16px", background: "#8B3A3A", border: "none", cursor: "pointer", fontSize: isMobile ? 14 : 12, color: "#fff", fontWeight: 600, flex: isMobile ? 1 : undefined }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
