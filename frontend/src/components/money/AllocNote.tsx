/**
 * Подпись «чем разнесена транзакция» под строкой ленты (ДДС, личные финансы).
 *
 * Данные — единая карта GET /api/finance/alloc-map (financeApi.allocMap), ключи
 * "bank:<id>" | "zen:<id>", значения — заметки {kind, label, …}. До 11.09.2026 экран
 * читал только расходы (expenses.map): выплаты через лицевой счёт (Малафеев, Спектр),
 * привязки фин-агента, платежи заказчика без ссылки, переводы себе — выглядели
 * неразнесёнными, хотя всё было разложено. Виды: expense | payment | ledger |
 * zm_link | creditor | accountable | receivable | dismissed | self_transfer | service.
 */
import { OrderLink, MasterLink } from "../ui/links";

const TONE: Record<string, string> = {
  expense: "#4A7C59", payment: "#4A7C59", ledger: "#4A7C59", zm_link: "#4A7C59",
  creditor: "#4A7C59", accountable: "#4A7C59", receivable: "#4A7C59",
  dismissed: "#A89070", self_transfer: "#A89070", service: "#A89070",
};

export function AllocNote({ rows, onUndo, exclude }: {
  rows: any[];
  /** Есть group_id у расхода/платежа → показать «откатить» (вернётся в инбокс). */
  onUndo?: (groupId: string) => void;
  /** Виды, которые экран уже показывает сам (например, payment в ДДС). */
  exclude?: string[];
}) {
  const notes = (rows || []).filter((n: any) => !exclude?.includes(n.kind));
  if (!notes.length) return null;
  // Сигнал «перевод себе не записан» — только если ничем другим не разнесено
  const shown = notes.some((n: any) => !["self_transfer", "service"].includes(n.kind))
    ? notes.filter((n: any) => !(n.kind === "self_transfer" && n.unrecorded)) : notes;
  const gid = shown.find((n: any) => n.group_id && (n.kind === "expense" || n.kind === "payment"))?.group_id;
  return (
    <div style={{ fontSize: 10, color: "#6B6355", marginTop: 2 }}>
      {shown.map((n: any, i: number) => {
        const tone = n.unrecorded ? "#B8860B" : (TONE[n.kind] || "#6B6355");
        const where = n.order_title
          ? <OrderLink id={n.order_id} style={{ color: tone }}>{n.order_title}</OrderLink>
          : n.master_id
            ? <MasterLink id={n.master_id} style={{ color: tone }}>{n.master_name}</MasterLink>
            : <span style={{ color: tone }}>{n.master_name || n.label}</span>;
        // Вид — мелкой подписью, когда сам по себе не очевиден (лицевой счёт, фин-агент,
        // обязательство); у расхода и оплаты заказ говорит сам за себя.
        const kindNote = ["ledger", "zm_link", "creditor", "accountable", "receivable"].includes(n.kind)
          || (n.kind === "expense" && n.purpose) || (n.kind === "payment" && n.extra_id)
          ? n.label : null;
        const title = n.title && n.title !== n.order_title && n.title !== n.master_name
          && !(n.label && String(n.title).toLowerCase().startsWith(String(n.label).toLowerCase())) ? n.title : null;
        return (
          <span key={n.expense_id ?? n.payment_id ?? n.ledger_id ?? n.creditor_id ?? i}>
            {where}
            {kindNote && (n.order_title || n.master_id || n.master_name) && <span style={{ color: "#A89070" }}> · {kindNote}</span>}
            {title && <span> — {title.length > 60 ? title.slice(0, 57) + "…" : title}</span>}
            {i < shown.length - 1 ? " · " : ""}
          </span>
        );
      })}
      {gid && onUndo && (
        <button type="button" onClick={ev => { ev.stopPropagation(); onUndo(gid); }}
          title="Откатить разноску целиком — транзакция вернётся в «Разноску»"
          style={{ marginLeft: 6, fontSize: 10, color: "#8B3A3A", background: "none",
                   border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
          откатить
        </button>
      )}
    </div>
  );
}
