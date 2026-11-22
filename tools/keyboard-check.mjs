// Keyboard & interaction check: tab order reaches every control with a
// visible focus ring; language switch flips dir via keyboard; modal
// opens/closes with keyboard and returns focus; drawer opens on mobile.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { installMock, uiLogin } from './mock-backend.mjs';
const base = process.argv[2] || 'http://127.0.0.1:8787';
const browser = await chromium.launch();
let fail = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };

async function tabWalk(page, max) {
  const seen = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const visibleRing = cs.boxShadow !== 'none' || (cs.outlineStyle !== 'none' && cs.outlineColor !== 'rgba(0, 0, 0, 0)' && cs.outlineWidth !== '0px');
      return { tag: el.tagName.toLowerCase(), text: (el.getAttribute('aria-label') || el.textContent || el.name || '').trim().slice(0, 30), visibleRing, onScreen: r.width > 0 && r.height > 0 };
    });
    if (!info) continue;
    seen.push(info);
  }
  return seen;
}

for (const lang of ['ar', 'en']) {
  // ---- login (phone) ----
  let ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  await ctx.addInitScript((l) => localStorage.setItem('zh.lang', l), lang);
  let page = await ctx.newPage();
  await page.goto(`${base}/index.html#/login`, { waitUntil: 'networkidle' });
  check(await page.evaluate(() => document.activeElement?.name === 'code'), `[${lang}] login autofocuses the code field`);
  check(await page.evaluate(() => { const i = document.querySelector('input[name=code]'); return i.inputMode === 'numeric' && i.autocomplete === 'off'; }), `[${lang}] code field uses numeric keypad, autocomplete off`);
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => !document.querySelector('.field__error').hidden), `[${lang}] empty submit shows inline error`);
  await page.keyboard.type('12ab34');
  check(await page.evaluate(() => document.querySelector('input[name=code]').value === '1234'), `[${lang}] non-digits stripped`);
  const walk = await tabWalk(page, 8);
  check(walk.length >= 6 && walk.every((w) => w.visibleRing && w.onScreen), `[${lang}] login tab order (${walk.map((w) => w.text || w.tag).join(' → ')}) all with visible focus`);
  // language switch by keyboard
  const target = lang === 'ar' ? 'en' : 'ar';
  await page.focus(`.segmented__btn[lang="${target}"]`);
  await page.keyboard.press('Enter');
  await page.waitForFunction((t) => document.documentElement.lang === t, target);
  await page.waitForTimeout(150);
  check(await page.evaluate((t) => document.documentElement.dir === (t === 'ar' ? 'rtl' : 'ltr'), target), `[${lang}] keyboard language switch flips dir to ${target}`);
  check(await page.evaluate((t) => document.activeElement?.getAttribute('lang') === t, target), `[${lang}] focus stays on the language switcher after re-render`);
  await ctx.close();

  // ---- shell (desktop) ----
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((l) => localStorage.setItem('zh.lang', l), lang);
  await installMock(ctx);
  page = await ctx.newPage();
  await uiLogin(page, base, '87654321');
  await page.waitForFunction(() => location.hash === '#/owner/dashboard');
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => document.activeElement?.blur());
  const sw = await tabWalk(page, 14);
  check(sw[0]?.tag === 'a' && /content|المحتوى/i.test(sw[0].text), `[${lang}] skip link is first tab stop`);
  check(sw.filter((w) => !w.visibleRing).length === 0, `[${lang}] shell: every focused control shows a focus ring (${sw.length} stops)`);
  await page.keyboard.press('Shift+Tab');
  await page.evaluate(() => document.querySelector('.nav__link[href="#/owner/settings"]').focus());
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#/owner/settings');
  check(await page.evaluate(() => document.querySelector('.nav__link[aria-current="page"]')?.getAttribute('href') === '#/owner/settings'), `[${lang}] nav via keyboard sets aria-current`);
  await ctx.close();

  // ---- drawer (phone) ----
  ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  await ctx.addInitScript((l) => localStorage.setItem('zh.lang', l), lang);
  await installMock(ctx);
  page = await ctx.newPage();
  await uiLogin(page, base, '87654321');
  await page.waitForFunction(() => location.hash === '#/owner/dashboard');
  await page.waitForTimeout(200);
  await page.focus('.topbar .btn');
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => document.querySelector('.drawer').open), `[${lang}] mobile drawer opens from keyboard`);
  check(await page.evaluate(() => document.querySelector('.drawer').contains(document.activeElement)), `[${lang}] focus moves into the drawer`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => !document.querySelector('.drawer').open), `[${lang}] Escape closes the drawer`);
  await ctx.close();

  // ---- modal on /design ----
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((l) => localStorage.setItem('zh.lang', l), lang);
  page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/design/index.html`, { waitUntil: 'networkidle' });
  const opener = page.locator('#modal .cluster .btn--primary');
  await opener.focus();
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => !!document.querySelector('dialog.modal[open]')), `[${lang}] modal opens via keyboard`);
  check(await page.evaluate(() => document.querySelector('dialog.modal[open]').contains(document.activeElement)), `[${lang}] focus is inside the modal`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => !document.querySelector('dialog.modal[open]')), `[${lang}] Escape closes the modal`);
  check(await page.evaluate(() => document.activeElement?.closest('#modal') !== null), `[${lang}] focus returns to the opener`);
  // loading button + toast
  await page.locator('#live-save').click();
  check(await page.evaluate(() => document.querySelector('#live-save').getAttribute('aria-busy') === 'true'), `[${lang}] live button enters loading state`);
  await page.waitForSelector('.toast-region .toast', { timeout: 3000 });
  check(true, `[${lang}] toast appears after save`);
  check(errs.length === 0, `[${lang}] no page errors on /design (${errs.join('; ')})`);
  await ctx.close();
}
await browser.close();
console.log(fail ? `\n${fail} checks failed` : '\nAll keyboard/interaction checks passed');
process.exit(fail ? 1 : 0);
