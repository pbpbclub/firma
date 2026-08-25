// Мобильные сценарии ввода: лист формы расхода, разноска, фильтр-лист, «Ещё», смета.
const { chromium, devices } = require('/home/claude-runner/firma/node_modules/playwright');
const crypto = require('crypto'), fs = require('fs');
const SECRET = fs.readFileSync('/opt/firma/backend/.env','utf8').match(/^FIRMA_SECRET_KEY=(.+)$/m)[1].trim();
const b64 = b => Buffer.from(b).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const si = b64(JSON.stringify({alg:'HS256',typ:'JWT'})) + '.' + b64(JSON.stringify({sub:'yuranek@pbpb.club', exp: Math.floor(Date.now()/1000)+86400}));
const token = si + '.' + b64(crypto.createHmac('sha256', SECRET).update(si).digest());
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const ORD = '2bed643b-df55-4d55-b60d-5f59635b60d1';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP firma.yuranek.com 127.0.0.1'] });
  const ctx = await browser.newContext({ ...devices['iPhone 14'], defaultBrowserType: undefined, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  await page.goto('https://firma.yuranek.com/login');
  await page.evaluate(t => { localStorage.setItem('firma_token', t);
    localStorage.setItem('firma_user', JSON.stringify({email:'yuranek@pbpb.club',role:'admin',name:'Юра'})); }, token);
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, animations: 'disabled' });

  // 1. Форма расхода — лист снизу
  await page.goto(`https://firma.yuranek.com/orders/${ORD}`); await page.waitForTimeout(3000);
  await page.getByText('Добавить расход', { exact: false }).first().click(); await page.waitForTimeout(800);
  await shot('flow_expense_modal'); console.log('расход: лист открыт:', await page.getByText('ЧЕМ ЗАКРЫТО', { exact: false }).count() > 0);
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);

  // 2. Разноска — раскрыть строку
  await page.goto('https://firma.yuranek.com/expenses'); await page.waitForTimeout(3000);
  const row = page.getByText('Оплата по счету', { exact: false }).first();
  await row.click(); await page.waitForTimeout(1500);
  await shot('flow_alloc_open'); console.log('разноска: ПОЛУЧАТЕЛЬ виден:', await page.getByText('ПОЛУЧАТЕЛЬ', { exact: true }).count() > 0);

  // 3. Фильтр-лист
  await page.getByText('КОНТРАГЕНТ / НАЗНАЧЕНИЕ', { exact: true }).first().click(); await page.waitForTimeout(600);
  await shot('flow_filter_sheet');
  const pop = await page.evaluate(() => { const el = [...document.querySelectorAll('input[placeholder="Поиск..."]')].pop(); const r = el && el.closest('div[style*="fixed"]')?.getBoundingClientRect(); return r ? {l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom)} : null; });
  console.log('фильтр-лист:', JSON.stringify(pop));
  await page.keyboard.press('Escape'); await page.mouse.click(10, 300); await page.waitForTimeout(400);

  // 4. «Ещё»
  await page.getByText('Ещё', { exact: true }).click(); await page.waitForTimeout(600);
  await shot('flow_more'); console.log('«Ещё»: разделы:', await page.getByText('Обязательства', { exact: true }).count() > 0);
  await page.getByText('Обязательства', { exact: true }).click(); await page.waitForTimeout(2000);
  console.log('переход из «Ещё» →', page.url().replace('https://firma.yuranek.com',''));

  // 5. Смета read-only
  await page.goto(`https://firma.yuranek.com/orders/${ORD}/estimate`); await page.waitForTimeout(3500);
  await shot('flow_estimate'); console.log('смета: read-only вид:', await page.getByText('Редактирование сметы — с компьютера', { exact: false }).count() > 0);

  // 6. Вики: список → деталь
  await page.goto('https://firma.yuranek.com/wiki/clients'); await page.waitForTimeout(3000);
  await shot('flow_wiki_list');
  await page.getByText('ЛОРО', { exact: false }).first().click(); await page.waitForTimeout(2000);
  await shot('flow_wiki_detail'); console.log('вики: деталь открыта, список скрыт:', page.url().includes('/wiki/clients/'));

  console.log(errs.length ? 'ERRORS: ' + errs.slice(0,5).join(' | ') : 'console clean');
  await browser.close();
})();
