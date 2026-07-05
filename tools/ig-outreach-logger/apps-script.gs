// apps-script.gs — вставить в редактор Apps Script Google-таблицы.
//
// Установка: таблица → Расширения → Apps Script → вставить весь этот код →
// Развернуть → Создать развёртывание → тип "Веб-приложение":
//   - "Запуск от имени": я,
//   - "У кого есть доступ": Все (или "Все, у кого есть ссылка").
// Скопировать URL вида https://script.google.com/macros/s/…/exec
// и вставить в Настройки расширения.
//
// Лист "Рассылка" создаётся автоматически. Дедуп — по thread_id (колонка G).

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var data = JSON.parse(e.postData.contents);
    var rows = data.rows || [];

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Рассылка');
    if (!sheet) sheet = ss.insertSheet('Рассылка');
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Записано', 'Отправлено', '@логин', 'Имя',
                       'Ссылка на чат', 'Ответил', 'thread_id']);
    }

    // Существующие ключи дедупа (колонка G = thread_id).
    var existing = {};
    var last = sheet.getLastRow();
    if (last > 1) {
      var keys = sheet.getRange(2, 7, last - 1, 1).getValues();
      for (var i = 0; i < keys.length; i++) existing[String(keys[i][0])] = true;
    }

    var added = 0, skipped = 0;
    var now = new Date();
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var key = String(r.thread_id || r.username || '');
      if (key && existing[key]) { skipped++; continue; }
      if (key) existing[key] = true;
      sheet.appendRow([
        now,
        r.sent_at ? new Date(r.sent_at) : '',
        r.username || '',
        r.display_name || '',
        r.chat_link || '',
        r.replied ? 'да' : 'нет',
        r.thread_id || ''
      ]);
      added++;
    }

    return ContentService
      .createTextOutput(JSON.stringify({ added: added, skipped: skipped }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Проверка, что развёртывание живо (открой /exec в браузере — увидишь "ok").
function doGet() {
  return ContentService.createTextOutput('IG Outreach Logger webhook: ok');
}
