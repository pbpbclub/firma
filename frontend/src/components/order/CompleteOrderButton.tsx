/**
 * Кнопка «Завершить» для подсказки «похоже, заказ завершён» (ТЗ 03.09.2026, п.2):
 * карточка заказа и плашка на экране денег. Тот же путь, что у StatusPicker:
 * PATCH status=completed, на 409 obligations_unpaid — окно построчного решения
 * с дельтой сальдо подрядчиков, затем повтор с close_obligations.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ordersApi } from "../../api";
import { Button } from "../ui/Button";
import { fmtMoneyDash as fmt } from "../ui/format";
import { ObligationsConfirmModal, type Unpaid, type LedgerDelta } from "./ObligationsConfirmModal";

export function CompleteOrderButton({ orderId, label = "Завершить", onDone, size = "sm" }: {
  orderId: string; label?: string; onDone?: () => void; size?: "sm" | "md";
}) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{ items: Unpaid[]; total: number; delta?: LedgerDelta } | null>(null);

  const finish = () => {
    qc.invalidateQueries({ queryKey: ["order-detail", orderId] });
    qc.invalidateQueries({ queryKey: ["orders-v2"] });
    qc.invalidateQueries({ queryKey: ["creditors"] });
    qc.invalidateQueries({ queryKey: ["ledger-balances"] });
    qc.invalidateQueries({ queryKey: ["debtors"] });
    onDone?.();
  };

  const run = async (opts?: { close_obligations: boolean; only_ids: string[] }) => {
    setSaving(true);
    try {
      await ordersApi.updateStatus(orderId, "completed", opts);
      setConfirm(null);
      finish();
    } catch (err: any) {
      const d = err?.response?.data?.detail;
      if (err?.response?.status === 409 && d?.code === "obligations_unpaid") {
        setConfirm({ items: d.items || [], total: d.unpaid_total || 0, delta: d.ledger_delta });
      } else {
        throw err;
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {confirm && (
        <ObligationsConfirmModal
          eyebrow="ЗАВЕРШИТЬ ЗАКАЗ" saveLabel="Завершить заказ"
          intro={<>По заказу остались обязательства из сметы, не закрытые фактом — всего <b>{fmt(confirm.total)}</b>.
            Завершение считает расчёты законченными: остатки спишутся. Сними галочку у строки,
            если подрядчику действительно не заплачено — она останется долгом.</>}
          items={confirm.items} total={confirm.total} saving={saving}
          previewReason="order_completed" initialDelta={confirm.delta}
          onConfirm={ids => run({ close_obligations: true, only_ids: ids })}
          onCancel={() => setConfirm(null)}
        />
      )}
      <Button size={size} variant="primary" disabled={saving} onClick={e => { e.stopPropagation(); run(); }} style={{ fontSize: 11 }}>
        {saving ? "..." : label}
      </Button>
    </>
  );
}
