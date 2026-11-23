// PWA check: manifest + service worker meet Chromium's install criteria,
// all precached files exist, the app shell loads offline, and the
// offline page is served for unknown navigations.
import { createRequire } from 'node:module';
import { installMock } from './mock-backend.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await installMock(ctx);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/index.html#/login`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker.ready.then(() => true), null, { timeout: 15000 });
await page.reload({ waitUntil: 'networkidle' });
check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker installed and controlling the page');
const cdp = await ctx.newCDPSession(page);
const man = await cdp.send('Page.getAppManifest');
check(man.errors.length === 0, `manifest parses without errors ${JSON.stringify(man.errors)}`);
const inst = await cdp.send('Page.getInstallabilityErrors');
check(inst.installabilityErrors.length === 0, `no installability errors ${JSON.stringify(inst.installabilityErrors)}`);
const parsed = JSON.parse(man.data);
check(parsed.name === 'حاضر' && parsed.display === 'standalone', 'name "حاضر", display standalone');
for (const src of [...parsed.icons, ...parsed.screenshots].map((i) => i.src)) {
  const r = await page.request.get(`${base}/${src}`);
  check(r.ok(), `asset reachable: ${src}`);
}
const sw = await (await page.request.get(`${base}/sw.js`)).text();
const list = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]);
let missing = [];
for (const f of list) { const r = await page.request.get(`${base}/${f}`); if (!r.ok()) missing.push(f); }
check(missing.length === 0, `all ${list.length} precached files exist ${missing.join(', ')}`);
// offline
await ctx.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[name=code]', { timeout: 8000 });
check(true, 'app shell (login) loads with the network OFF');
const p2 = await ctx.newPage();
await p2.goto(`${base}/some/unknown/page`, { waitUntil: 'domcontentloaded' }).catch(() => {});
{ const c = await p2.content(); check(c.includes('حاضر') && !/ERR_INTERNET_DISCONNECTED/.test(c), 'unknown navigation offline is served by the app (not the browser error page)'); }
await ctx.setOffline(false);
check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
// iOS meta
check(await page.evaluate(() => document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content === 'yes'), 'iOS standalone meta present');
await browser.close();
console.log(fail ? `\n${fail} PWA checks failed` : '\nAll PWA checks passed');
process.exit(fail ? 1 : 0);
