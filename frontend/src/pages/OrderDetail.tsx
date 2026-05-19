import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { ordersApi } from "../api";
import { ArrowLeft, Phone } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  estimate: "bg-yellow-100 text-yellow-700",
  project: "bg-blue-100 text-blue-700",
  in_production: "bg-indigo-100 text-indigo-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-red-100 text-red-500",
};

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU");
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: order, isLoading } = useQuery({
    queryKey: ["order", id],
    queryFn: () => ordersApi.get(id!),
  });

  const { data: estimates } = useQuery({
    queryKey: ["estimate", id],
    queryFn: () => ordersApi.estimate(id!),
  });

  if (isLoading) return <div className="p-6 text-gray-400">Загружаем...</div>;
  if (!order || order.error) return <div className="p-6 text-gray-400">Заказ не найден</div>;

  const pct = order.price_plan > 0 ? (order.paid_total / order.price_plan) * 100 : 0;

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <button onClick={() => navigate(-1)} className="btn-ghost mb-4 -ml-2">
        <ArrowLeft size={16} /> Назад
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-gray-900">{order.title}</h1>
            <span className={`badge ${STATUS_COLORS[order.status] || "bg-gray-100 text-gray-600"}`}>
              {order.status_label}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
        {/* Finance card */}
        <div className="card col-span-2">
          <div className="text-sm font-semibold text-gray-700 mb-4">Финансы</div>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <div className="text-xs text-gray-400 mb-1">Стоимость заказа</div>
              <div className="text-xl font-bold text-gray-900">{fmt(order.price_plan)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-1">Оплачено</div>
              <div className="text-xl font-bold text-emerald-600">{fmt(order.paid_total)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-1">Долг</div>
              <div className={`text-xl font-bold ${order.debt > 0 ? "text-orange-500" : "text-gray-400"}`}>
                {order.debt > 0 ? fmt(order.debt) : "Оплачен"}
              </div>
            </div>
          </div>
          {/* Progress bar */}
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <div className="text-xs text-gray-400 mt-1">{Math.round(pct)}% оплачено</div>
        </div>

        {/* Client card */}
        <div className="card">
          <div className="text-sm font-semibold text-gray-700 mb-3">Клиент</div>
          <div className="font-medium text-gray-900">{order.customer_name || "—"}</div>
          {order.customer_phone && (
            <div className="flex items-center gap-1.5 text-sm text-gray-500 mt-1">
              <Phone size={13} />
              {order.customer_phone}
            </div>
          )}
          {order.deadline && (
            <div className="mt-3 text-xs text-gray-400">
              Дедлайн: <span className="text-gray-700 font-medium">{fmtDate(order.deadline)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Payments */}
      {order.payments?.length > 0 && (
        <div className="card mb-4">
          <div className="text-sm font-semibold text-gray-700 mb-3">Платежи</div>
          <div className="space-y-2">
            {order.payments.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between text-sm">
                <div>
                  <span className="font-medium text-emerald-600">{fmt(p.amount)}</span>
                  <span className="text-gray-400 ml-2">{p.note || "оплата"}</span>
                </div>
                <div className="text-xs text-gray-400">{fmtDate(p.paid_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Estimates */}
      {estimates && estimates.length > 0 && (
        <div className="card mb-4">
          <div className="text-sm font-semibold text-gray-700 mb-4">Смета</div>
          {estimates.map((set: any) => (
            <div key={set.id} className="mb-4">
              <div className="text-xs text-gray-400 mb-2">
                {set.title || ""}
              </div>
              {set.items?.map((item: any) => (
                <div key={item.id} className="mb-3 pl-3 border-l-2 border-gray-100">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-sm font-medium text-gray-800">{item.title}</div>
                    <div className="text-sm font-bold text-gray-900">{fmt(item.sale_price)}</div>
                  </div>
                  {item.lines?.map((line: any) => (
                    <div key={line.id} className="flex items-center justify-between text-xs text-gray-500 py-0.5">
                      <span>{line.title}</span>
                      <span>
                        {line.qty} {line.unit} × {fmt(line.unit_price)} = {fmt(line.line_total)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Stages */}
      {order.stages?.length > 0 && (
        <div className="card">
          <div className="text-sm font-semibold text-gray-700 mb-3">Этапы</div>
          <div className="space-y-2">
            {order.stages.map((s: any) => (
              <div key={s.id} className="flex items-center gap-3 text-sm">
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    s.status === "completed"
                      ? "bg-emerald-500"
                      : s.status === "in_progress"
                      ? "bg-brand-500"
                      : "bg-gray-200"
                  }`}
                />
                <span className="text-gray-700">{s.title}</span>
                <span className="text-gray-400 text-xs ml-auto">{s.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
