import { chromium } from './node_modules/playwright/index.js';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1400, height: 900 });

await page.goto('http://localhost:5173/login');
await page.waitForTimeout(800);
await page.fill('input[type="email"]', 'yuranek@pbpb.club');
await page.fill('input[type="password"]', 'admin');
await page.click('button[type="submit"]');
await page.waitForTimeout(1500);

await page.goto('http://localhost:5173/orders');
await page.waitForTimeout(2000);

await page.screenshot({ path: '/tmp/orders_page.png' });
console.log('Done. URL:', page.url());
await browser.close();
