const { chromium } = require('./node_modules/playwright');
const crypto = require('crypto');
const fs = require('fs');

// Self-mint a fresh firma_token on every run, so the screenshot tool never
// needs a token pasted from DevTools and never expires-out.
// The secret lives only in backend/.env (FIRMA_SECRET_KEY, вне git; чтение —
// через ACL для claude-runner). Env FIRMA_SECRET overrides if set. ALGORITHM=HS256.
// The secret is never hardcoded here and never printed.
const ENV_FILE = '/opt/firma/backend/.env';
function readSecret() {
  if (process.env.FIRMA_SECRET) return process.env.FIRMA_SECRET;
  const src = fs.readFileSync(ENV_FILE, 'utf8');
  const m = src.match(/^FIRMA_SECRET_KEY=(.+)$/m);
  if (!m) throw new Error('FIRMA_SECRET_KEY not found in ' + ENV_FILE);
  return m[1].trim();
}
const SECRET_KEY = readSecret();
const EMAIL = 'yuranek@pbpb.club';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function mintToken(email, days = 30) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const payload = { sub: email, exp };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SECRET_KEY).update(signingInput).digest());
  return signingInput + '.' + sig;
}

// Page to capture: arg 1 = path (default /orders), arg 2 = output png.
const route = process.argv[2] || '/orders';
const out = process.argv[3] || '/tmp/firma_page.png';

(async () => {
  const token = mintToken(EMAIL);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto('http://localhost:5173');
  await page.evaluate((tok) => {
    localStorage.setItem('firma_token', tok);
    localStorage.setItem('firma_user', JSON.stringify({ email: 'yuranek@pbpb.club', role: 'admin', name: 'Юра' }));
  }, token);

  await page.goto('http://localhost:5173' + route);
  await page.waitForTimeout(3000);
  console.log('URL:', page.url());
  await page.screenshot({ path: out });
  console.log('Saved:', out);
  await browser.close();
})();
