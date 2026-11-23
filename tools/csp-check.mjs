// Runs key flows with the PRODUCTION Content-Security-Policy from firebase.json
// and fails on any CSP violation (map tiles, PDF/XLSX export, fonts).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { installMock, uiLogin } from './mock-backend.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
const csp = JSON.parse(fs.readFileSync(new URL('../firebase.json', import.meta.url))).hosting.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const browser = await chromium.launch(); let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
async function ctxWithCsp(extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true, geolocation: { latitude: 29.98325, longitude: 31.324, accuracy: 10 }, permissions: ['geolocation'], ...extra });
  await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); localStorage.setItem('zh.lang', 'ar'); });
  await installMock(ctx);
  await ctx.route(`${base}/index.html`, async (route) => { const r = await route.fetch(); route.fulfill({ response: r, headers: { ...r.headers(), 'content-security-policy': csp } }); });
  return ctx;
}
{
  const ctx = await ctxWithCsp(); const page = await ctx.newPage();
  const tiles = []; page.on('request', (r) => { if (r.url().includes('tile.openstreetmap.org')) tiles.push(r.url()); });
  await uiLogin(page, base, '12345678'); await page.waitForFunction(() => location.hash === '#/staff/home');
  await page.goto(`${base}/index.html#/staff/attendance`); await page.waitForTimeout(2500);
  const v = await page.evaluate(() => window.__csp);
  check(tiles.length > 0 && !v.some((x) => /img-src/.test(x)), `map tiles allowed by CSP (${tiles.length} tile requests; violations: ${v.join(', ') || 'none'})`);
  await ctx.close();
}
{
  const ctx = await ctxWithCsp(); const page = await ctx.newPage();
  await uiLogin(page, base, '87654321'); await page.waitForFunction(() => location.hash === '#/owner/dashboard');
  await page.goto(`${base}/index.html#/owner/payroll`); await page.click('.toolbar .btn--primary');
  await page.waitForFunction(() => [...document.querySelectorAll('.toolbar .btn')].some((b) => /PDF/.test(b.textContent) && !b.disabled));
  for (const label of ['PDF', 'Excel']) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.locator('.toolbar .btn', { hasText: label }).first().click()]);
    check(!!dl && fs.statSync(await dl.path()).size > 5000, `${label} export works under the production CSP`);
  }
  const v = await page.evaluate(() => window.__csp);
  check(!v.length, `no CSP violations on payroll (${v.join(', ') || 'none'})`);
  await ctx.close();
}
await browser.close();
console.log(fail ? `\n${fail} checks failed` : '\nAll CSP checks passed');
process.exit(fail ? 1 : 0);
