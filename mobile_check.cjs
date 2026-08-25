// Снимки всех роутов на десктопе (1500×900) и iPhone 14 (390). Десктопные PNG
// сравниваются побайтно до/после; на мобиле — проверка переполнений и мелких мишеней.
const { chromium, devices } = require('/home/claude-runner/firma/node_modules/playwright');
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const SECRET = fs.readFileSync('/opt/firma/backend/.env','utf8').match(/^FIRMA_SECRET_KEY=(.+)$/m)[1].trim();
const b64 = b => Buffer.from(b).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const si = b64(JSON.stringify({alg:'HS256',typ:'JWT'})) + '.' + b64(JSON.stringify({sub:'yuranek@pbpb.club', exp: Math.floor(Date.now()/1000)+86400}));
const token = si + '.' + b64(crypto.createHmac('sha256', SECRET).update(si).digest());
const BASE = 'https://firma.yuranek.com';
const [outDir, which = 'both', only] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });

const ORD = '2bed643b-df55-4d55-b60d-5f59635b60d1';           // ORD-023
const MASTER = 'cd944ae3-6ff3-47e3-b9e5-5badab341f63';
const ROUTES = ['/', '/orders', '/orders?mode=silent', '/orders?mode=ready', '/orders?mode=summary',
  `/orders/${ORD}`, `/orders/${ORD}/estimate`, '/finance', '/debtors', '/expenses',
  '/wiki/clients', `/wiki/contractors/${MASTER}`, '/catalog', '/taxes', '/funds', '/zenmoney',
  '/general-expenses', '/admin'];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP firma.yuranek.com 127.0.0.1'] });
  const profiles = [];
  if (which !== 'mobile') profiles.push(['d1500', { viewport: { width: 1500, height: 900 } }]);
  if (which !== 'desktop') profiles.push(['m390', { ...devices['iPhone 14'], defaultBrowserType: undefined }]);
  for (const [name, opts] of profiles) {
    const ctx = await browser.newContext({ ...opts, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
    await page.goto(BASE + '/login');
    await page.evaluate(t => { localStorage.setItem('firma_token', t);
      localStorage.setItem('firma_user', JSON.stringify({email:'yuranek@pbpb.club',role:'admin',name:'Юра'})); }, token);
    for (const r of ROUTES) {
      if (only && !r.includes(only)) continue;
      await page.goto(BASE + r);
      await page.waitForTimeout(3000);
      const file = path.join(outDir, `${name}${r.replace(/[\/?=]/g, '_').replace(/-[0-9a-f-]{20,}/g,'')}.png`);
      let report = '';
      if (name === 'm390') {
        const o = await page.evaluate(() => {
          const bad = [];
          if (document.documentElement.scrollWidth > innerWidth) bad.push('document:' + document.documentElement.scrollWidth);
          const main = document.querySelector('main');
          if (main && main.scrollWidth > main.clientWidth) bad.push('main:' + main.scrollWidth + '>' + main.clientWidth);
          for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (el.scrollWidth > el.clientWidth + 1 && !/auto|scroll|hidden|clip/.test(cs.overflowX) && el.clientWidth > 0)
              bad.push(el.tagName + '.' + (el.textContent || '').trim().slice(0, 25).replace(/\s+/g,' '));
          }
          const small = [...document.querySelectorAll('button, a, [role=button]')]
            .filter(e => { const b = e.getBoundingClientRect(); return b.width && b.height && (b.width < 36 || b.height < 36); }).length;
          return { bad: [...new Set(bad)].slice(0, 8), small };
        });
        report = ` bad=${o.bad.length ? JSON.stringify(o.bad) : '[]'} small=${o.small}`;
      }
      await page.screenshot({ path: file, animations: 'disabled' });
      console.log(`${name} ${r}${report}`);
    }
    if (errs.length) console.log('ERRORS:', errs.slice(0, 5).join(' | '));
    await ctx.close();
  }
  await browser.close();
})();
