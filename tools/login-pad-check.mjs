// Login keypad (phone, touch) against the MOCKED backend: on-screen pad
// drives the real field, no system keyboard, wrong code → shake + message +
// cleared, right code → signs in. Also fits small phones without scrolling.
// Usage: node tools/login-pad-check.mjs [baseUrl] [shotDir]
import { createRequire } from 'node:module';
import { installMock } from './mock-backend.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
const shots = process.argv[3];
let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const browser = await chromium.launch();
const tap = async (page, digits) => { for (const d of digits) await page.tap(`.cp-key[data-k="${d}"]`); };

for (const lang of ['ar', 'en']) {
  const ctx = await browser.newContext({ ...devices['Pixel 5'] });
  await ctx.addInitScript((l) => localStorage.setItem('zh.lang', l), lang);
  await installMock(ctx);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/index.html#/login`, { waitUntil: 'networkidle' });
  const inp = page.locator('input[name=code]');
  check(await inp.getAttribute('inputmode') === 'none', `[${lang}] phone: system keyboard suppressed (pad used)`);
  check(await page.evaluate(() => document.activeElement?.name !== 'code'), `[${lang}] phone: no autofocus (no keyboard pop)`);
  check(await page.locator('.cp-box').count() === 8, `[${lang}] 8 code boxes`);
  check(await page.locator('form button[type=submit]').isDisabled(), `[${lang}] submit disabled while empty`);
  await tap(page, '1234');
  check(await inp.inputValue() === '1234', `[${lang}] pad taps fill the real field`);
  check(await page.locator('.cp-box--filled').count() === 4, `[${lang}] 4 boxes filled`);
  check(!(await page.locator('.cp-row').textContent()).includes('1'), `[${lang}] digits masked by default`);
  await page.tap('.cp-key--eye');
  check((await page.locator('.cp-row').textContent()).includes('1234'), `[${lang}] eye reveals digits`);
  await page.tap('.cp-key--eye');
  await page.tap('.cp-key--back');
  check(await inp.inputValue() === '123', `[${lang}] backspace deletes one digit`);
  await tap(page, '456789012');
  check(await inp.inputValue() === '123456789012' && await page.locator('.cp-box').count() === 12, `[${lang}] grows to 12 boxes, max 12 digits`);
  await page.tap('.cp-key[data-k="5"]');
  check(await inp.inputValue() === '123456789012', `[${lang}] no 13th digit`);
  // long-press backspace clears
  const b = await page.locator('.cp-key--back').boundingBox();
  await page.mouse.move(b.x + 10, b.y + 10); await page.mouse.down(); await page.waitForTimeout(800); await page.mouse.up();
  check(await inp.inputValue() === '', `[${lang}] long-press backspace clears all`);
  // wrong code
  await tap(page, '99999999');
  await page.tap('form button[type=submit]');
  await page.waitForSelector('.cp-status--err');
  check(await inp.inputValue() === '', `[${lang}] wrong code: field cleared`);
  check(await page.locator('.cp-box--filled').count() === 0, `[${lang}] wrong code: boxes cleared`);
  check((await page.textContent('.cp-status')).length > 5, `[${lang}] wrong code: message shown`);
  if (shots) await page.screenshot({ path: `${shots}/login-phone-${lang}-error.png` });
  // layout: fits without scrolling, keys ≥44px, no horizontal overflow
  const m = await page.evaluate(() => ({ sh: document.documentElement.scrollWidth, w: innerWidth,
    btn: document.querySelector('form button[type=submit]').getBoundingClientRect().bottom, h: innerHeight,
    keys: [...document.querySelectorAll('.cp-key')].map((k) => k.getBoundingClientRect()).every((r) => r.width >= 44 && r.height >= 44) }));
  check(m.sh <= m.w, `[${lang}] no horizontal overflow`);
  check(m.btn <= m.h, `[${lang}] submit visible without scrolling (${Math.round(m.btn)} ≤ ${m.h})`);
  check(m.keys, `[${lang}] every key ≥ 44×44`);
  // right code (staff)
  await tap(page, '1234');
  if (shots) await page.screenshot({ path: `${shots}/login-phone-${lang}.png` });
  await tap(page, '5678');
  await page.tap('form button[type=submit]');
  await page.waitForFunction(() => location.hash.startsWith('#/staff'), null, { timeout: 8000 }).catch(() => {});
  check(await page.evaluate(() => location.hash.startsWith('#/staff')), `[${lang}] right code via pad → signed in`);
  check(errors.length === 0, `[${lang}] no page errors (${errors.join(' | ')})`);
  await ctx.close();
}
// small phone 360×640
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => localStorage.setItem('zh.lang', 'ar'));
  const page = await ctx.newPage();
  await page.goto(`${base}/index.html#/login`, { waitUntil: 'networkidle' });
  const r = await page.evaluate(() => ({ b: document.querySelector('form button[type=submit]').getBoundingClientRect().bottom, sw: document.documentElement.scrollWidth }));
  check(r.b <= 640 && r.sw <= 360, `360×640: submit visible (${Math.round(r.b)}), no h-overflow`);
  if (shots) await page.screenshot({ path: `${shots}/login-phone-small.png` });
  await ctx.close();
}
// desktop: typing + Enter still works
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await installMock(ctx);
  const page = await ctx.newPage();
  await page.goto(`${base}/index.html#/login`, { waitUntil: 'networkidle' });
  check(await page.locator('input[name=code]').getAttribute('inputmode') === 'numeric', 'desktop: inputmode numeric, autofocus');
  await page.keyboard.type('87654321'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.startsWith('#/owner'), null, { timeout: 8000 }).catch(() => {});
  check(await page.evaluate(() => location.hash.startsWith('#/owner')), 'desktop: typed code + Enter → signed in');
  if (shots) { await page.goto(`${base}/index.html#/login`); await page.evaluate(() => { localStorage.clear(); }); }
  await ctx.close();
  if (shots) { const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const p2 = await c2.newPage();
    await p2.goto(`${base}/index.html#/login`, { waitUntil: 'networkidle' }); await p2.screenshot({ path: `${shots}/login-desktop.png` }); await c2.close(); }
}
await browser.close();
console.log(fail ? `\n${fail} login pad check(s) FAILED` : '\nAll login pad checks passed');
process.exit(fail ? 1 : 0);
