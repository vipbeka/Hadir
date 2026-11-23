// UI quality check: renders each page at 320/360/390/430/768/1280/1440 px and
// phone landscape (844×390), in Arabic RTL and English LTR (light + dark at
// 360 and 1440). Phone/tablet sizes emulate touch. Fails on console errors,
// page errors, failed requests, horizontal overflow, raw values, touch targets
// under 44 px (touch sizes), clipped button text, and dialogs that don't fit.
// Usage: node tools/ui-check.mjs [baseUrl] [--shots dir]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // global install (NODE_PATH)
import { installMock, uiLogin } from './mock-backend.mjs';
import fs from 'node:fs';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const shotsIdx = process.argv.indexOf('--shots');
const shotsDir = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

// [name, url, login code (mock backend) or null]
const pages = [
  ['login', '/index.html#/login', null],
  ['staff-home', '/index.html#/staff/home', '12345678'],
  ['staff-attendance', '/index.html#/staff/attendance', '12345678'],
  ['staff-points', '/index.html#/staff/points', '12345678'],
  ['staff-leaderboard', '/index.html#/staff/leaderboard', '12345678'],
  ['staff-requests', '/index.html#/staff/requests', '12345678'],
  ['staff-account', '/index.html#/staff/account', '12345678'],
  ['owner-dashboard', '/index.html#/owner/dashboard', '87654321'],
  ['owner-approvals', '/index.html#/owner/approvals', '87654321'],
  ['owner-payroll', '/index.html#/owner/payroll', '87654321'],
  ['owner-payslip', '/index.html#/owner/payslip?e=00000000-0000-4000-a000-0000000000bb&m=2026-10', '87654321'],
  ['owner-employee', '/index.html#/owner/employee?id=00000000-0000-4000-a000-0000000000bb', '87654321'],
  ['owner-holidays', '/index.html#/owner/holidays', '87654321'],
  ['owner-settings', '/index.html#/owner/settings', '87654321'],
  ['owner-leaderboard', '/index.html#/owner/leaderboard', '87654321'],
  ['owner-employees', '/index.html#/owner/employees', '87654321'],
  ['owner-employee-dialog', '/index.html#/owner/employees', '87654321'],
  ['staff-leave-dialog', '/index.html#/staff/requests', '12345678'],
  ['owner-account', '/index.html#/owner/account', '87654321'],
  ['owner-announcements', '/index.html#/owner/announcements', '87654321'],
  ['staff-announcements', '/index.html#/staff/announcements', '12345678'],
  ['design', '/design/index.html', null],
];
const only = process.env.UI_SIZES ? process.env.UI_SIZES.split(',') : null;
const sizes = [[320, 720], [360, 900], [390, 844], [430, 932], [768, 1024], [1280, 800], [1440, 900], [844, 390, 'landscape']]
  .filter(([w, , l]) => !only || only.includes(l || String(w)));
const langs = ['ar', 'en'];
const themesFor = (w) => (w === 360 || w === 1440 ? ['light', 'dark'] : ['light']);

const browser = await chromium.launch();
let failures = 0;
const onlyPages = process.env.UI_PAGES ? process.env.UI_PAGES.split(',') : null;
for (const [name, url, code] of pages.filter(([n]) => !onlyPages || onlyPages.includes(n))) {
  for (const [width, height, orient] of sizes) {
    const touch = width <= 1024 && width !== 1280;
    for (const lang of langs) {
      for (const theme of themesFor(width)) {
        const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block', hasTouch: touch, isMobile: touch && width < 768,
          geolocation: { latitude: 29.98325, longitude: 31.32400, accuracy: 12 }, permissions: ['geolocation'] });
        await ctx.addInitScript(([l, th]) => { localStorage.setItem('zh.lang', l); localStorage.setItem('zh.theme', th); }, [lang, theme]);
        const page = await ctx.newPage();
        const problems = [];
        page.on('console', (m) => { if (/Service Worker registration blocked/.test(m.text())) return; if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
        page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
        page.on('requestfailed', (r) => { if (/tile\.openstreetmap\.org/.test(r.url()) && /ABORTED/.test(r.failure()?.errorText || '')) return; problems.push(`requestfailed: ${r.url()}`); });
        page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
        await installMock(ctx);
        if (code) { await uiLogin(page, base, code); await page.waitForFunction(() => !location.hash.includes('login')); }
        await page.goto(base + url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(250);
        if (name === 'owner-payroll') { await page.click('text=/إنشاء التقرير|Generate report/'); await page.waitForTimeout(400); }
        if (name === 'staff-attendance') await page.waitForTimeout(800);
        if (name === 'owner-employee-dialog') {
          await page.locator('tbody tr').nth(1).locator('button').click();
          await page.waitForSelector('.session-item');
          await page.waitForTimeout(300);
        }
        if (name === 'staff-leave-dialog') { await page.click('text=/طلب إجازة|Request leave/'); await page.waitForSelector('dialog.modal[open]'); await page.waitForTimeout(400); }
        const info = await page.evaluate((touch) => {
          const de = document.documentElement;
          const vw = de.clientWidth;
          const overflowX = de.scrollWidth > vw + 1;
          const offenders = [];
          if (overflowX) {
            for (const el of document.querySelectorAll('body *')) {
              const r = el.getBoundingClientRect();
              if (r.width && (r.right > vw + 1 || r.left < -1) && !el.closest('.table-wrap') && getComputedStyle(el).position !== 'fixed') {
                offenders.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} [${Math.round(r.left)},${Math.round(r.right)}]`);
                if (offenders.length > 6) break;
              }
            }
          }
          const leak = /(^|\s)(null|undefined|NaN|\[object Object\])(\s|$)/.exec(document.body.innerText);
          const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[inert],[aria-hidden=true],dialog:not([open])'); };
          const small = [];
          if (touch) {
            const sel = 'button, a.btn, [role=button], input:not([type=hidden]), select, summary, .nav__link, .switch, .leaflet-control a';
            for (const el of document.querySelectorAll(sel)) {
              if (!visible(el) || el.closest('.leaflet-control-attribution, .design-only, .skip-link')) continue;
              const target = el.matches('input[type=checkbox], input[type=radio]') ? (el.closest('label') || el) : el;
              const r = target.getBoundingClientRect();
              if (Math.round(r.height) < 44 || Math.round(r.width) < 44) small.push(`${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}"${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 18)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
              if (small.length > 5) break;
            }
          }
          const clipped = [...document.querySelectorAll('.btn, .badge, .nav__link')].filter((el) => visible(el) && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible').slice(0, 4)
            .map((el) => `${el.className.split(' ')[0]}"${el.textContent.trim().slice(0, 18)}"`);
          let dialog = null;
          const dl = document.querySelector('dialog.modal[open]');
          if (dl) {
            const r = dl.getBoundingClientRect(); const x = dl.querySelector('.modal__header button');
            const xr = x?.getBoundingClientRect();
            dialog = { fits: r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= innerHeight + 1, close: !!xr && xr.top >= 0 && xr.bottom <= innerHeight && xr.left >= 0 && xr.right <= vw,
              scrolls: [...dl.querySelectorAll('.modal__body')].some((b) => getComputedStyle(b).overflowY !== 'visible') };
          }
          return { dir: de.dir, lang: de.lang, theme: de.dataset.theme, overflowX, offenders, title: document.title, leak: leak ? leak[2] : null, small, clipped, dialog };
        }, touch);
        if (info.dir !== (lang === 'ar' ? 'rtl' : 'ltr')) problems.push(`dir=${info.dir}`);
        if (info.theme !== theme) problems.push(`theme=${info.theme}`);
        if (info.leak) problems.push(`raw value shown to the user: "${info.leak}"`);
        if (info.overflowX) problems.push(`horizontal overflow: ${info.offenders.join(' | ')}`);
        if (!info.title.includes('حاضر') || /Zintra/.test(info.title)) problems.push(`title missing product name: ${info.title}`);
        if (info.small.length && name !== 'design') problems.push(`touch targets < 44px: ${info.small.join(' | ')}`);
        if (info.clipped.length) problems.push(`clipped text: ${info.clipped.join(' | ')}`);
        if (info.dialog && !(info.dialog.fits && info.dialog.close && info.dialog.scrolls)) problems.push(`dialog: ${JSON.stringify(info.dialog)}`);
        const tag = `${name} ${orient || width} ${lang} ${theme}`;
        if (problems.length) { failures++; console.log(`FAIL ${tag}\n  ${problems.join('\n  ')}`); }
        else console.log(`ok   ${tag}`);
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}-${orient || width}-${lang}-${theme}.png`), fullPage: name !== 'design' || width === 360 ? true : true });
        await ctx.close();
      }
    }
  }
}
await browser.close();
console.log(failures ? `\n${failures} failing combinations` : '\nAll combinations passed');
process.exit(failures ? 1 : 0);
