/**
 * Кнопка «выгрузить карточку PDF».
 *
 * Карточки собирает бэкенд тем же движком, которым делается КП (card.py финагента),
 * поэтому шрифты и вёрстка совпадают с тем, что Юре присылает финагент в Telegram.
 * Здесь только состояние «собираем…» и честная ошибка вместо молчания: рендер идёт
 * через headless Chrome и занимает пару секунд.
 */
import { useState } from "react";
import { FilePdf } from "@phosphor-icons/react";
import { Button } from "./ui/Button";
import { downloadBlob } from "./ui/download";

export function CardButton({ label, filename, fetcher, style }: {
  label: string;
  filename: string;
  fetcher: () => Promise<Blob>;
  style?: React.CSSProperties;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      downloadBlob(await fetcher(), filename);
    } catch (e: any) {
      // detail приходит blob'ом (responseType: "blob"), текст из него не достать
      // синхронно — показываем короткое человеческое сообщение.
      setError(e?.response?.status === 503
        ? "Рендер карточек недоступен"
        : "Не удалось собрать карточку");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, ...style }}>
      <Button size="sm" onClick={run} disabled={busy}>
        <FilePdf size={13} /> {busy ? "Собираем…" : label}
      </Button>
      {error && <span style={{ fontSize: 11, color: "#8B3A3A" }}>{error}</span>}
    </span>
  );
}
