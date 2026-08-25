/**
 * Подпись «куда разнесено списание» под строкой транзакции.
 *
 * Один компонент на ДДС и личные финансы: до этого ДДС показывал только название
 * заказа (комментарий разноски — «за какие работы» — не был виден никогда), а
 * личные финансы не показывали ничего: разнесённая Яндекс-доставка выглядела
 * ровно как неразобранная. Данные — GET /api/expenses/map (inboxApi.map),
 * ключи "bank:<id>" | "zen:<id>".
 */
import { OrderLink } from "../ui/links";

const PURPOSE_LABELS: Record<string, string> = {
  stock: "Запас",
  sample: "Образцы",
  overhead: "Накладные",
  contractor_pay: "Аванс подрядчику",
  contractor_third_party: "Оплата за подрядчика",
};

export function AllocNote({ rows, onUndo }: {
  rows: any[];
  /** Есть group_id → показать «откатить» (разноска вернётся в инбокс). */
  onUndo?: (groupId: string) => void;
}) {
  if (!rows?.length) return null;
  const gid = rows.find((e: any) => e.group_id)?.group_id;
  return (
    <div style={{ fontSize: 10, color: "#6B6355", marginTop: 2 }}>
      {rows.map((e: any, i: number) => {
        const where = e.order_title || PURPOSE_LABELS[e.purpose] || e.purpose || "вне заказов";
        return (
          <span key={e.expense_id ?? e.id ?? i}>
            <OrderLink id={e.order_id} style={{ color: "#4A7C59" }}>{where}</OrderLink>
            {/* Комментарий разноски — то самое «за какие работы». Не дублируем,
                если он совпадает с названием заказа. */}
            {e.title && e.title !== where && (
              <span> — {e.title.length > 60 ? e.title.slice(0, 57) + "…" : e.title}</span>
            )}
            {i < rows.length - 1 ? " · " : ""}
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
