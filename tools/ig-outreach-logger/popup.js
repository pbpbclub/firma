// popup.js — UI расширения: собрать из инбокса → отфильтровать → превью → записать.

const $ = (id) => document.getElementById(id);
let filteredRows = []; // то, что уйдёт в таблицу после "Записать"
let lastResp = null;   // последний ответ скрапера — для кнопки "скопировать отладку"

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit' });
}

// Загрузка настроек по умолчанию.
chrome.storage.sync.get(['defaultHours', 'defaultMode'], (cfg) => {
  if (cfg.defaultHours) $('hours').value = cfg.defaultHours;
  if (cfg.defaultMode === 'period' || cfg.defaultMode === 'since') {
    document.querySelector('input[name=mode][value=period]').checked = true;
  }
});

// Запоминаем последний фильтр и лимит — чтобы не вводить каждый раз.
chrome.storage.local.get('ig_ui', (s) => {
  const ui = s.ig_ui || {};
  if (ui.limit) $('loginLimit').value = ui.limit;
  if (ui.hours) $('hours').value = ui.hours;
  if (ui.fromDate) $('fromDate').value = ui.fromDate;
  if (ui.toDate) $('toDate').value = ui.toDate;
  if (ui.mode) {
    const r = document.querySelector(`input[name=mode][value="${ui.mode}"]`);
    if (r) r.checked = true;
  }
});
function saveUi() {
  chrome.storage.local.set({ ig_ui: {
    mode: document.querySelector('input[name=mode]:checked').value,
    hours: $('hours').value, fromDate: $('fromDate').value, toDate: $('toDate').value,
    limit: $('loginLimit').value
  }});
}
// Выбор даты → автоматически включаем режим «период».
['fromDate', 'toDate'].forEach(id => $(id).addEventListener('change', () => {
  document.querySelector('input[name=mode][value="period"]').checked = true;
}));

// Восстановление собранного после перезагрузки IG (прогресс сохраняется во время обхода).
chrome.storage.local.get(['ig_collected', 'ig_collected_at'], (s) => {
  if (s.ig_collected && s.ig_collected.length && !filteredRows.length) {
    filteredRows = s.ig_collected;
    renderPreview(filteredRows);
    $('write').disabled = !filteredRows.some(r => r.username);
    $('copytsv').disabled = filteredRows.length === 0;
    const when = s.ig_collected_at ? new Date(s.ig_collected_at).toLocaleTimeString('ru-RU') : '';
    setStatus(`Восстановлено ${filteredRows.length} строк прошлого прогона (${when}). Можно ⬆/📋 или собрать заново.`);
  }
});

function currentFilter() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  if (mode === 'period') {
    const f = $('fromDate').value, t = $('toDate').value;
    const fromTs = f ? new Date(f + 'T00:00:00').getTime() : null;
    const toTs = t ? new Date(t + 'T23:59:59').getTime() : null;
    return { mode, fromTs, toTs };
  }
  const hours = +$('hours').value || 2;
  return { mode, fromTs: Date.now() - hours * 3600 * 1000, toTs: null };
}

function applyFilter(rows) {
  const { fromTs, toTs } = currentFilter();
  // Строки с нераспознанной датой (sent_at=null) оставляем, чтобы ничего не потерять молча.
  return rows.filter(r => {
    if (r.sent_at == null) return true;
    if (fromTs != null && r.sent_at < fromTs) return false;
    if (toTs != null && r.sent_at > toTs) return false;
    return true;
  });
}

function renderPreview(rows) {
  const t = $('preview');
  if (!rows.length) { t.innerHTML = ''; return; }
  const head = '<tr><th>Отправлено</th><th>Имя</th><th>@логин</th><th>Ответил</th><th>Чат</th></tr>';
  const body = rows.map(r => {
    const sent = r.sent_at ? fmtDate(r.sent_at) : '<span class="warn">?</span>';
    const name = (r.display_name || '').replace(/</g, '&lt;');
    const login = r.username ? ('@' + r.username) : '<span class="warn">—</span>';
    const rep = r.replied ? '<span class="ok">да</span>' : 'нет';
    const chat = r.chat_link ? `<a href="${r.chat_link}" target="_blank">↗</a>` : '—';
    return `<tr><td>${sent}</td><td>${name}</td><td>${login}</td><td>${rep}</td><td>${chat}</td></tr>`;
  }).join('');
  t.innerHTML = head + body;
}

$('write').addEventListener('click', async () => {
  const cfg = await chrome.storage.sync.get(['webhookUrl', 'ingestToken']);
  if (!cfg.webhookUrl) {
    setStatus('Не задан URL приёмника — открой Настройки.', 'warn');
    return;
  }
  if (!filteredRows.length) return;

  // В pbpb.club шлём только строки с @логином (без него лид бессмысленный, ключ — instagram).
  const rows = filteredRows.filter(r => r.username).map(r => ({
    username: r.username,
    display_name: r.display_name || '',
    sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null, // endpoint ждёт ISO-строку
    replied: !!r.replied,
    chat_link: r.chat_link || '',
    thread_id: r.thread_id || ''
  }));
  if (!rows.length) {
    setStatus('Нет строк с @логином — сначала «Собрать @логины».', 'warn');
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.ingestToken) headers['Authorization'] = 'Bearer ' + cfg.ingestToken;

  setStatus('Отправляю в pbpb.club…');
  $('write').disabled = true;
  try {
    const r = await fetch(cfg.webhookUrl, {
      method: 'POST', headers, body: JSON.stringify({ rows })
    });
    if (r.status === 401) {
      setStatus('401 — неверный ingest-токен. Проверь Настройки.', 'warn');
      $('write').disabled = false;
      return;
    }
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok || data.error) {
      setStatus('Ошибка приёмника: ' + (data.error || ('HTTP ' + r.status)), 'warn');
      $('write').disabled = false;
      return;
    }
    const created = data.created ?? data.added ?? '?';
    const updated = data.updated ?? '?';
    const errs = (data.errors && data.errors.length) ? `, ошибок ${data.errors.length}` : '';
    chrome.storage.local.remove(['ig_collected', 'ig_collected_at']); // отправлено — очищаем сохранённый прогресс
    setStatus(`Готово: добавлено ${created}, обновлено ${updated}${errs}.`, 'ok');
  } catch (e) {
    setStatus('Не удалось отправить: ' + String(e), 'warn');
    $('write').disabled = false;
  }
});

async function runCollect(batched) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/https:\/\/www\.instagram\.com\/direct\//.test(tab.url || '')) {
    setStatus('Открой instagram.com/direct/inbox в активной вкладке.', 'warn');
    return;
  }
  const limit = batched ? (+$('batchSize').value || 50) : (+$('loginLimit').value || 1000);
  const { fromTs, toTs, mode } = currentFilter();
  // Режим блоков = «старые диалоги старше ~1 года» (IG их все показывает как «1 г.»).
  // Свежее года ПРОЛИСТЫВАЕМ без открытия (через toTs-порог, как в фильтре периода),
  // открываем только старые — блоками, с памятью обработанных.
  const OLD_THRESHOLD = Date.now() - 360 * 24 * 3600 * 1000; // ~1 год назад
  const f = batched ? null : fromTs;
  const t = batched ? OLD_THRESHOLD : toTs;
  const cfg = await chrome.storage.sync.get(['ownAccount']);
  saveUi();

  const head = batched
    ? `Старые (>1 года): блок до ${limit}. Пролистываю свежие БЕЗ открытия, собираю старые…`
    : ((mode === 'period'
        ? `Период ${$('fromDate').value || '—'} … ${$('toDate').value || '—'}. `
        : `Не старше ${$('hours').value} ч. `) + `Захожу в чаты (до ${limit})…`);
  setStatus(head + ' не закрывай окно. Прогресс сохраняется.');
  $('write').disabled = true;
  filteredRows = [];

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'COLLECT_LOGINS', limit, fromTs: f, toTs: t, batched, ownAccount: cfg.ownAccount || 'pbpb.furn'
    });
  } catch (e) {
    setStatus('Контент-скрипт не ответил. Обнови инбокс (Cmd+R) и повтори.', 'warn');
    return;
  }

  lastResp = resp;
  $('copydbg').hidden = false;
  if (!resp || !resp.ok) {
    const sk = resp && resp.debug && resp.debug.skipped_out_of_range;
    const stoppedDate = resp && resp.stopped_by_date;
    if (batched) {
      const tot = (resp && resp.debug && resp.debug.processed_total) || 0;
      setStatus(`Новых старых диалогов не нашлось (всего обработано ${tot}). Похоже, дошли до конца списка.`, 'warn');
    } else if (sk) {
      setStatus(`Все ${sk} чатов НОВЕЕ выбранного периода — расширь даты (особенно «по») или «не старше N ч».`, 'warn');
    } else if (stoppedDate) {
      setStatus(`В окне переписок нет — свежайшая старше срока. Увеличь «не старше N ч» (напр. 168) или возьми период.`, 'warn');
    } else {
      setStatus('Логины собрать не вышло — жми «Скопировать отладку» и пришли.', 'warn');
    }
    return;
  }

  // В режиме блоков НЕ фильтруем по дате — показываем всё собранное в блоке.
  filteredRows = batched ? resp.rows : applyFilter(resp.rows);
  renderPreview(filteredRows);
  $('write').disabled = !filteredRows.some(r => r.username);
  $('copytsv').disabled = filteredRows.length === 0;
  if (batched) {
    const tot = (resp.debug && resp.debug.processed_total) || resp.count;
    setStatus(`Блок: собрано ${resp.count} (с @логином ${resp.with_login}). Всего обработано: ${tot}. Жми ⬆/📋, затем «блок» ещё раз для следующих.`);
  } else {
    const stop = resp.stopped_by_date ? ' (остановлено по сроку)' : '';
    setStatus(`Обойдено: ${resp.count}, с @логином: ${resp.with_login}.${stop} Жми ⬆ или 📋.`);
  }
}

$('logins').addEventListener('click', () => runCollect(false));
$('loginsAll').addEventListener('click', () => runCollect(true));
$('resetBatch').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.storage.local.remove('ig_processed_keys', () => {
    setStatus('Память блоков сброшена — следующий «блок» начнётся с начала списка.', 'ok');
  });
});

$('copytsv').addEventListener('click', async () => {
  if (!filteredRows.length) return;
  const fmt = (ts) => ts ? new Date(ts).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const header = ['Отправлено', '@логин', 'Имя', 'Ответил', 'Ссылка на чат'].join('\t');
  const lines = filteredRows.map(r => [
    fmt(r.sent_at),
    r.username ? '@' + r.username : '',
    (r.display_name || '').replace(/\t/g, ' '),
    r.replied ? 'да' : 'нет',
    r.chat_link || ''
  ].join('\t'));
  const tsv = [header, ...lines].join('\n');
  try {
    await navigator.clipboard.writeText(tsv);
    setStatus(`Скопировано ${filteredRows.length} строк — открой Google-таблицу и вставь (Cmd+V).`, 'ok');
  } catch (e) {
    $('raw').hidden = false;
    $('raw').textContent = tsv;
    setStatus('Не вышло в буфер — выдели текст ниже и скопируй вручную.', 'warn');
  }
});

$('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('copydbg').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!lastResp) return;
  const payload = {
    debug: lastResp.debug,
    sample_rows: (lastResp.rows || []).slice(0, 5).map(r => ({
      display_name: r.display_name, preview: r.preview, rel_time: r.rel_time,
      sent_at: r.sent_at, replied: r.replied, raw: r._raw
    }))
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setStatus('Отладка скопирована — вставь её в чат Клоду.', 'ok');
  } catch (err) {
    // запасной путь: показать текст, чтобы скопировать руками
    $('raw').hidden = false;
    $('raw').textContent = JSON.stringify(payload, null, 2);
    setStatus('Не вышло в буфер — выдели текст ниже и скопируй вручную.', 'warn');
  }
});
