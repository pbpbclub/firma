/**
 * Сохранить полученный с бэка PDF файлом.
 *
 * Раньше кнопки КП и счёта делали window.open(URL.createObjectURL(blob)):
 * документ открывался вкладкой БЕЗ имени файла — «blob:https://…» и в заголовке,
 * и при сохранении. Плюс objectURL никто не освобождал.
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Отзываем не сразу: браузер должен успеть начать скачивание.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
