/**
 * Ссылки между экранами.
 *
 * В восьми местах системы название заказа было напечатано текстом, хотя order_id
 * лежал рядом в том же ответе: из карточки клиента, подрядчика, обязательства и
 * накладных приходилось искать заказ руками через список. Стиль ссылки один на
 * всю систему — подчёркивание по наведению, цвет не меняется (пёстрые синие
 * ссылки в этой сетке читаются хуже, чем сам текст).
 */
import { useNavigate } from "react-router-dom";

function LinkText({ to, title, children, onDark, style }: {
  to: string; title?: string; children: React.ReactNode; onDark?: boolean; style?: React.CSSProperties;
}) {
  const navigate = useNavigate();
  return (
    <span
      title={title}
      onClick={(e) => { e.stopPropagation(); navigate(to); }}
      style={{ cursor: "pointer", borderBottom: "1px solid transparent", transition: "border-color 0.1s", ...style }}
      onMouseEnter={(e) => (e.currentTarget.style.borderBottomColor = onDark ? "rgba(255,255,255,0.6)" : "#C8C0B0")}
      onMouseLeave={(e) => (e.currentTarget.style.borderBottomColor = "transparent")}
    >
      {children}
    </span>
  );
}

/** Заказ по id. Без id — просто текст (заказ мог быть удалён, а строка остаться). */
export function OrderLink({ id, children, onDark, style }: {
  id?: string | null; children: React.ReactNode; onDark?: boolean; style?: React.CSSProperties;
}) {
  if (!id) return <span style={style}>{children}</span>;
  return <LinkText to={`/orders/${id}`} title="Открыть заказ" onDark={onDark} style={style}>{children}</LinkText>;
}

/** Клиент по id (карточка в вики). */
export function CustomerLink({ id, children, onDark, style }: {
  id?: string | null; children: React.ReactNode; onDark?: boolean; style?: React.CSSProperties;
}) {
  if (!id) return <span style={style}>{children}</span>;
  return <LinkText to={`/wiki/clients/${id}`} title="Открыть клиента" onDark={onDark} style={style}>{children}</LinkText>;
}

/** Подрядчик по id (карточка в вики). */
export function MasterLink({ id, children, onDark, style }: {
  id?: string | null; children: React.ReactNode; onDark?: boolean; style?: React.CSSProperties;
}) {
  if (!id) return <span style={style}>{children}</span>;
  return <LinkText to={`/wiki/contractors/${id}`} title="Открыть подрядчика" onDark={onDark} style={style}>{children}</LinkText>;
}
