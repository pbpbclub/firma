// content.js — скрапит список переписок Instagram Direct из DOM.
//
// Instagram присваивает CSS-классам случайные имена, не делает строки ссылками и
// не кладёт @логин в список — поэтому опираемся на СОДЕРЖИМОЕ: находим листовой
// элемент с временем («2 ч.»), поднимаемся к строке (первая текстовая строка — имя),
// разбираем имя / превью / время. Ключ дедупа — отображаемое имя.
//
// Список виртуализирован: в DOM только видимые строки. Поэтому при scroll=true
// сами прокручиваем список донизу, дособирая строки на каждом шаге.

const RU_MONTHS = {
  'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'мая': 4, 'май': 4, 'июн': 5,
  'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11
};

// ВАЖНО: «дн» (дни) раньше «д»; «г» — годы (старые диалоги IG показывает как «1 г.»).
const TIME_TOKEN = /(\d+\s*(?:мин|сек|нед|дн|ч|д|г|min|m|h|d|w|y)\.?|\d{1,2}\s*[а-я]{3}[а-я.]*(?:\s*\d{4})?)\s*$/i;
const TIME_TAIL = /\d+\s*(?:мин|сек|нед|дн|ч|д|г|min|sec|h|d|w|y)\.?\s*$/i;
const DATE_TAIL = /\d{1,2}\s*[а-я]{3}[а-я.]*\s*$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Разбор строки времени. ВАЖНО: без \b — в JS кириллица не \w, граница не работает.
function parseRelTime(text, now) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  let m;
  if ((m = t.match(/(\d+)\s*(?:мин|min)/)))            return { ts: now - (+m[1]) * 60 * 1000, approx: true };
  if ((m = t.match(/(\d+)\s*(?:сек|sec)/)))            return { ts: now - (+m[1]) * 1000, approx: true };
  if ((m = t.match(/(\d+)\s*(?:нед)/)))                return { ts: now - (+m[1]) * 7 * 86400 * 1000, approx: true };
  if ((m = t.match(/(\d+)\s*(?:ч|h)(?![а-яёa-z])/)))   return { ts: now - (+m[1]) * 3600 * 1000, approx: true };
  if ((m = t.match(/(\d+)\s*(?:дн|д|d)(?![а-яёa-z])/))) return { ts: now - (+m[1]) * 86400 * 1000, approx: true };
  if ((m = t.match(/(\d+)\s*(?:г|y)(?![а-яёa-z])/)))    return { ts: now - (+m[1]) * 365 * 86400 * 1000, approx: true };
  if ((m = t.match(/(\d+)\s*(?:w)(?![a-z])/)))         return { ts: now - (+m[1]) * 7 * 86400 * 1000, approx: true };

  // явная дата: "8 июн." / "8 июн. 2025"
  m = t.match(/(\d{1,2})\s*([а-я]{3})[а-я.]*\s*(\d{4})?/);
  if (m && RU_MONTHS[m[2]] !== undefined) {
    const year = m[3] ? +m[3] : new Date(now).getFullYear();
    const d = new Date(year, RU_MONTHS[m[2]], +m[1]);
    if (!m[3] && d.getTime() > now) d.setFullYear(year - 1);
    return { ts: d.getTime(), approx: true };
  }
  return null;
}

function isOwnPreview(preview) {
  if (!preview) return false;
  const p = preview.trim().toLowerCase();
  return p.startsWith('вы ') || p.startsWith('вы:') || p.startsWith('вы отправили') ||
         p.startsWith('you sent') || p.startsWith('you:');
}

function cleanLines(el) {
  return (el.innerText || '').trim().split('\n')
    .map(s => s.trim())
    .filter(l => l && l !== '·' && l !== '•');
}

function looksLikeName(l) {
  if (!l || l.length < 2) return false;
  if (TIME_TAIL.test(l) || DATE_TAIL.test(l)) return false;
  const low = l.toLowerCase();
  if (low.startsWith('вы ') || low.startsWith('вы:') || low.startsWith('вы отправили')) return false;
  if (low.startsWith('you ') || low.startsWith('you:')) return false;
  if (/^[·•\d]/.test(l)) return false;
  if (!/[a-zA-Zа-яёА-ЯЁ]/.test(l)) return false; // нет ни одной буквы → мусор (эмодзи-реакция и т.п.)
  return true;
}

function rowFromLeaf(leaf) {
  // Поднимаемся до наименьшего контейнера, где есть span[title] с именем диалога.
  // Так имя всегда = title профиля; текст сообщения («Очень смешно, Юра») именем не станет,
  // а мусорные строки без имени отсеются.
  let el = leaf;
  for (let i = 0; i < 12 && el && el.parentElement; i++) {
    el = el.parentElement;
    const titleEl = el.querySelector && el.querySelector('span[title]');
    if (!titleEl) continue;
    const title = (titleEl.getAttribute('title') || '').trim();
    if (!looksLikeName(title)) continue;
    if ((el.innerText || '').length < 800) return el;
  }
  return null;
}

function parseRow(rowEl, now) {
  const lines = cleanLines(rowEl);
  if (lines.length < 2 || !looksLikeName(lines[0])) return null;

  // Имя берём из title профиля (точное, без обрезаний), иначе — первая строка.
  const titleEl = rowEl.querySelector && rowEl.querySelector('span[title]');
  const titleName = titleEl && titleEl.getAttribute('title');
  const displayName = (titleName && titleName.trim() && looksLikeName(titleName.trim()))
    ? titleName.trim() : lines[0];

  let timeIdx = -1, relTime = '';
  for (let i = lines.length - 1; i >= 1; i--) {
    if (TIME_TAIL.test(lines[i]) || DATE_TAIL.test(lines[i])) { timeIdx = i; break; }
  }
  if (timeIdx >= 0) {
    const tm = lines[timeIdx].match(TIME_TOKEN);
    relTime = tm ? tm[1].trim() : '';
  }

  const upto = timeIdx >= 0 ? timeIdx + 1 : lines.length;
  let preview = lines.slice(1, upto).join(' ');
  if (relTime) preview = preview.replace(relTime, '');
  preview = preview.replace(/[·•]/g, '').replace(/\s+/g, ' ').trim();

  const parsed = parseRelTime(relTime, now);

  return {
    thread_id: '',
    display_name: displayName,
    preview: preview,
    rel_time: relTime,
    sent_at: parsed ? parsed.ts : null,
    sent_at_approx: parsed ? parsed.approx : false,
    replied: !isOwnPreview(preview),
    chat_link: '',
    username: '', // в списке входящих @логина нет — берётся позже, на этапе 2
    dedup_key: displayName.toLowerCase().trim(),
    _raw: (rowEl.innerText || '').trim()
  };
}

function findTimeLeaves() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
  const leaves = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.childElementCount !== 0) continue;
    const t = (n.textContent || '').trim();
    if (!t || t.length > 40) continue;
    if (TIME_TAIL.test(t) || DATE_TAIL.test(t)) leaves.push(n);
  }
  return leaves;
}

// Строки списка вместе с их DOM-элементами (нужно для кликов при обходе чатов).
function collectRowEls(now) {
  const leaves = findTimeLeaves();
  const seen = new Set();
  const out = [];
  for (const leaf of leaves) {
    const row = rowFromLeaf(leaf);
    if (!row || seen.has(row)) continue;
    seen.add(row);
    const d = parseRow(row, now);
    if (d) out.push({ el: row, data: d });
  }
  return out;
}

function collectRows(now) {
  return collectRowEls(now).map(x => x.data);
}

// Совпадает ли имя строки с именем открытого чата (защита от сдвига).
// Сравниваем по 20 символам — у дизайнеров имена часто начинаются одинаково
// («Дизайн интерьера …»), коротких 14 не хватало → ловило чужой чат.
function nmeq(displayName, hint) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
  const a = norm(displayName), b = norm(hint);
  if (a.length < 6 || b.length < 6) return false;
  const n = Math.min(20, a.length);
  return b.indexOf(a.slice(0, n)) >= 0 || a.indexOf(b.slice(0, n)) >= 0;
}

// @логин контакта из ОТКРЫТОЙ переписки: ссылка на профиль, не наша и не системная.
function currentThreadUsername(ownAccount) {
  const m = location.pathname.match(/\/direct\/t\/(\d+)/);
  if (!m) return null;
  const own = (ownAccount || 'pbpb.furn').toLowerCase().replace(/\//g, '');
  const sys = /^(direct|explore|reels|stories|accounts|about|legal|p|s|reel|tv)$/;
  const links = Array.from(document.querySelectorAll('a[href^="/"]'))
    .map(a => ({ u: (a.getAttribute('href') || '').replace(/\//g, ''), text: (a.innerText || '').trim() }))
    .filter(x => /^[A-Za-z0-9._]{1,40}$/.test(x.u) && x.u.toLowerCase() !== own && !sys.test(x.u));
  if (!links.length) return null;
  // У контакта в шапке ссылка с именем (длиннее текста), берём её.
  links.sort((a, b) => b.text.length - a.text.length);
  return { username: links[0].u, name_hint: links[0].text, thread_id: m[1] };
}

// «Настоящий» клик: IG навигует по pointer/mouse-событиям, не по голому .click().
function realClick(el) {
  const r = el.getBoundingClientRect();
  const base = {
    bubbles: true, cancelable: true, view: window,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
  };
  const fire = (Ctor, type) => { try { el.dispatchEvent(new Ctor(type, base)); } catch (e) {} };
  fire(MouseEvent, 'mouseover');
  fire(PointerEvent, 'pointerdown');
  fire(MouseEvent, 'mousedown');
  fire(PointerEvent, 'pointerup');
  fire(MouseEvent, 'mouseup');
  fire(MouseEvent, 'click');
  if (typeof el.click === 'function') { try { el.click(); } catch (e) {} }
}

// Обход: кликаем по строкам, заходим в чат, читаем @логин, идём дальше.
// Период [fromTs..toTs]: новее toTs — пролистываем БЕЗ открытия; старее fromTs — стоп.
async function collectLogins(limit, fromTs, toTs, ownAccount, batched) {
  const results = new Map(); // ключ = имя из списка → строка с добытым логином
  const skipped = new Set();  // строки новее периода — пролистали без открытия
  const usedTids = new Set(); // id уже прочитанных чатов — чтобы не записать дважды
  let stoppedByDate = false;
  let openedCount = 0;        // сколько чатов реально открыли (для пауз-«отдыха»)
  let noProgress = 0;         // подряд безрезультатных попыток долистать (для определения дна)

  // Режим блоков (старые диалоги): помним между запусками, что уже обработано,
  // и пропускаем это, продолжая с того места. Дата при этом не применяется.
  let processed = new Set();
  if (batched) {
    try {
      const s = await chrome.storage.local.get('ig_processed_keys');
      processed = new Set(s.ig_processed_keys || []);
    } catch (e) {}
  }

  const curTid = () => (location.pathname.match(/\/direct\/t\/(\d+)/) || [])[1] || '';
  // Сохраняем прогресс в память расширения (переживёт перезагрузку вкладки IG).
  // ВАЖНО: память блоков (processed) пишем здесь же, а не только в конце — IG может
  // перезагрузиться посреди обхода, и тогда «уже обработанные» не должны теряться,
  // иначе следующий блок заново открывает те же чаты (было: блок 2 повторял блок 1).
  const persist = () => {
    try {
      const data = {
        ig_collected: [...results.values()].map(r => ({
          username: r.username, display_name: r.display_name, sent_at: r.sent_at,
          replied: r.replied, chat_link: r.chat_link, thread_id: r.thread_id, dedup_key: r.dedup_key
        })),
        ig_collected_at: Date.now()
      };
      if (batched) data.ig_processed_keys = [...processed];
      chrome.storage.local.set(data);
    } catch (e) {}
  };
  const attempts = [];

  for (let pass = 0; pass < 40000 && results.size < limit; pass++) {
    const items = collectRowEls(Date.now());

    let target = null;
    for (const it of items) {
      const k = it.data.dedup_key;
      if (!results.has(k) && !skipped.has(k) && !processed.has(k)) { target = it; break; }
    }

    if (!target) {
      // Всё видимое обработано/пропущено — долистываем список МАЛЫМ шагом.
      const scroller = findScroller();
      if (!scroller) {
        // Список мог временно не отрисоваться (IG догружает порцию) — ждём и повторяем,
        // НЕ обрываемся с первого пустого кадра (раньше из-за этого стоп после ~1 дня).
        if (++noProgress >= 6) break;
        await sleep(1000);
        continue;
      }
      const before = scroller.scrollTop;
      scroller.scrollTop = before + Math.max(200, scroller.clientHeight * 0.7);
      await sleep(900); // даём IG подгрузить более старые переписки
      const moreLoaded = collectRowEls(Date.now()).some(it =>
        !results.has(it.data.dedup_key) && !skipped.has(it.data.dedup_key));
      const movedScroll = scroller.scrollTop > before + 2;
      if (moreLoaded || movedScroll) noProgress = 0;
      else if (++noProgress >= 4) break; // реально дно (несколько попыток без прогресса)
      continue;
    }
    noProgress = 0; // нашли строку — прогресс есть

    const sa = target.data.sent_at;
    // Старее начала периода → ниже всё ещё старее, дальше нет смысла.
    if (fromTs != null && sa != null && sa < fromTs) { stoppedByDate = true; break; }
    // Новее конца периода → выше периода: пролистываем БЕЗ открытия чата.
    if (toTs != null && sa != null && sa > toTs) { skipped.add(target.data.dedup_key); continue; }

    let info = null, gotTid = '';
    // Один клик → ждём, пока нужный чат появится в шапке. НЕ перекликиваем, если адрес
    // чата уже сменился: тяжёлая переписка просто долго рендерится, а повторный клик
    // перезапустил бы загрузку (отсюда были простои 20–60 сек). Повторный клик — только
    // если перехода вообще не случилось (промах мимо строки). Имя сверяем строгим nmeq,
    // id чата — через usedTids, поэтому чужой/предыдущий чат не примем.
    {
      const startTid = curTid();
      try { target.el.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(50);
      const doClick = () => {
        const nameEl = (target.el.querySelector && target.el.querySelector('span[title]')) || target.el;
        const rr = nameEl.getBoundingClientRect();
        const hit = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2) || nameEl;
        realClick(hit);
      };
      doClick();
      let clicks = 1, lastClickAt = Date.now();
      const deadline = Date.now() + 9000;    // бюджет на чат (хватает и тяжёлым)
      while (Date.now() < deadline && !info) {
        await sleep(70);
        const tid = curTid();
        if (tid && !usedTids.has(tid)) {
          const c = currentThreadUsername(ownAccount);
          if (c && nmeq(target.data.display_name, c.name_hint)) { info = c; gotTid = tid; break; }
        }
        // адрес не сменился ~2.5 сек → клик, видимо, мимо: один повторный
        if (!info && tid === startTid && clicks < 2 && (Date.now() - lastClickAt) > 2500) {
          doClick(); clicks++; lastClickAt = Date.now();
        }
      }
    }

    if (info) usedTids.add(gotTid);
    attempts.push({
      name: (target.data.display_name || '').slice(0, 28),
      navigated: !!info, got: info ? info.username : '',
      hint: info ? (info.name_hint || '').replace(/\n/g, ' ').slice(0, 26) : '',
      matched: !!info
    });

    const row = Object.assign({}, target.data);
    if (info) {
      row.username = info.username;
      row.thread_id = info.thread_id || gotTid;
      row.chat_link = 'https://www.instagram.com/direct/t/' + (info.thread_id || gotTid);
      row.dedup_key = info.username; // дедуп по логину — надёжнее
    }
    results.set(target.data.dedup_key, row);
    if (batched) processed.add(target.data.dedup_key); // помечаем как обработанный (для следующего блока)
    openedCount++;
    // В режиме блоков сохраняем после КАЖДОГО чата (IG может перезагрузиться в любой момент).
    if (batched || openedCount % 5 === 0) persist();

    await sleep(350); // пауза между чатами, чтобы IG не ругался
    // «Отдых» каждые 25 чатов — меньше похоже на бота, меньше шанс перезагрузки IG.
    if (openedCount % 25 === 0) await sleep(12000);
  }

  persist();
  if (batched) {
    try { chrome.storage.local.set({ ig_processed_keys: [...processed] }); } catch (e) {}
  }
  const rows = [...results.values()];
  const dbg = buildDebug('logins', rows);
  dbg.attempts = attempts;
  dbg.with_login = rows.filter(r => r.username).length;
  dbg.skipped_out_of_range = skipped.size;
  dbg.batched = !!batched;
  dbg.processed_total = processed.size;
  // Какой период применился — чтобы видеть, не отсекает ли «по» свежие чаты.
  dbg.period_from = fromTs ? new Date(fromTs).toLocaleString('ru-RU') : null;
  dbg.period_to = toTs ? new Date(toTs).toLocaleString('ru-RU') : null;
  return {
    ok: rows.length > 0,
    count: rows.length,
    rows: rows,
    mode: 'logins',
    stopped_by_date: stoppedByDate,
    with_login: rows.filter(r => r.username).length,
    debug: dbg,
    url: location.href
  };
}

// Прокручиваемый контейнер списка переписок.
function findScroller() {
  // Стартуем от НАСТОЯЩЕЙ строки-инбокса (с именем), а не от таймстампа сообщения
  // в открытом чате — иначе пролистывали бы панель сообщений и грузили старую историю.
  const leaves = findTimeLeaves();
  let startEl = null;
  for (const lf of leaves) { const r = rowFromLeaf(lf); if (r) { startEl = r; break; } }
  if (!startEl) return null;
  let el = startEl;
  while (el && el.parentElement) {
    el = el.parentElement;
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
  }
  return null;
}

// Сигналы для добычи @логина из ОТКРЫТОЙ переписки (URL /direct/t/<id>):
// кандидаты-ссылки на профиль и alt аватарок. Нужно, чтобы понять, откуда брать @username.
function threadSignals() {
  const m = location.pathname.match(/\/direct\/t\/(\d+)/);
  const anchors = Array.from(document.querySelectorAll('a[href^="/"]'))
    .map(a => ({ href: a.getAttribute('href') || '', text: (a.innerText || '').trim().slice(0, 40) }))
    .filter(x => /^\/[A-Za-z0-9._]{1,40}\/?$/.test(x.href) &&
                 !/^\/(direct|explore|reels|stories|accounts|p|s|about|legal)\b/.test(x.href));
  const seen = new Set();
  const profile_links = [];
  for (const a of anchors) { if (!seen.has(a.href)) { seen.add(a.href); profile_links.push(a); } }
  const img_alts = Array.from(document.querySelectorAll('img[alt]'))
    .map(i => (i.getAttribute('alt') || '').trim()).filter(Boolean).slice(0, 15);
  return {
    in_thread: !!m,
    thread_id: m ? m[1] : '',
    profile_links: profile_links.slice(0, 15),
    img_alts: img_alts
  };
}

function buildDebug(strategy, rows) {
  const leaves = findTimeLeaves();
  const dbg = {
    version: (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : '?',
    thread: threadSignals(),
    strategy: strategy,
    found: rows.length,
    a_direct_t: document.querySelectorAll('a[href*="/direct/t/"]').length,
    role_button: document.querySelectorAll('[role="button"]').length,
    time_leaves: leaves.length,
    has_scroller: !!findScroller()
  };
  if (leaves.length) {
    const row = rowFromLeaf(leaves[0]);
    const el = row || leaves[0];
    dbg.sample_html = (el.outerHTML || '').slice(0, 1800);
    dbg.sample_lines = row ? cleanLines(row) : [];
  }
  return dbg;
}

async function scrapeInbox(scroll, untilTs) {
  const all = new Map(); // dedup_key -> row
  const merge = () => {
    for (const r of collectRows(Date.now())) {
      if (!all.has(r.dedup_key)) all.set(r.dedup_key, r);
    }
  };
  // Инбокс отсортирован свежие→старые. Как только появилась переписка СТАРШЕ
  // фильтра — ниже всё старее, дальше листать смысла нет.
  const reachedOld = () => untilTs != null &&
    [...all.values()].some(r => r.sent_at != null && r.sent_at < untilTs);

  merge();
  let rounds = 0, stoppedByDate = false;
  if (scroll && !reachedOld()) {
    const scroller = findScroller();
    if (scroller) {
      let prevSize = all.size, noGrowth = 0;
      for (rounds = 1; rounds <= 80; rounds++) {
        const beforeTop = scroller.scrollTop;
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(550);
        merge();
        if (reachedOld()) { stoppedByDate = true; break; }
        const atBottom = scroller.scrollTop <= beforeTop + 2;
        noGrowth = (all.size === prevSize) ? noGrowth + 1 : 0;
        prevSize = all.size;
        if (atBottom && noGrowth >= 2) break;
        if (noGrowth >= 5) break;
      }
    }
  } else if (reachedOld()) {
    stoppedByDate = true;
  }

  const rows = [...all.values()];
  return {
    ok: rows.length > 0,
    count: rows.length,
    rows: rows,
    strategy: 'time-leaves',
    scrolled: !!scroll,
    rounds: rounds,
    stopped_by_date: stoppedByDate,
    debug: buildDebug('time-leaves', rows),
    url: location.href
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'SCRAPE') {
    (async () => {
      try { sendResponse(await scrapeInbox(!!msg.scroll, msg.untilTs)); }
      catch (e) { sendResponse({ ok: false, count: 0, rows: [], error: String(e) }); }
    })();
    return true;
  }
  if (msg && msg.type === 'COLLECT_LOGINS') {
    (async () => {
      try { sendResponse(await collectLogins(msg.limit || 100, msg.fromTs != null ? msg.fromTs : msg.untilTs, msg.toTs, msg.ownAccount, !!msg.batched)); }
      catch (e) { sendResponse({ ok: false, count: 0, rows: [], error: String(e) }); }
    })();
    return true;
  }
});
