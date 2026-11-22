// UI quality check (Step 1+): renders each page at 360px and 1440px, in
// Arabic RTL and English LTR, in light and dark themes. Fails on console
// errors, page errors, failed requests, horizontal overflow, or tokens
// not used (hard-coded colors are checked separately by lint-tokens).
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
  ['owner-holidays', '/index.html#/owner/holidays', '87654321'],
  ['owner-settings', '/index.html#/owner/settings', '87654321'],
  ['owner-leaderboard', '/index.html#/owner/leaderboard', '87654321'],
  ['owner-employees', '/index.html#/owner/employees', '87654321'],
  ['owner-employee-dialog', '/index.html#/owner/employees', '87654321'],
  ['owner-account', '/index.html#/owner/account', '87654321'],
  ['design', '/design/index.html', null],
];
const widths = [360, 1440];
const langs = ['ar', 'en'];
const themes = ['light', 'dark'];

const browser = await chromium.launch();
let failures = 0;
for (const [name, url, code] of pages) {
  for (const width of widths) {
    for (const lang of langs) {
      for (const theme of themes) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block',
          geolocation: { latitude: 29.98325, longitude: 31.32400, accuracy: 12 }, permissions: ['geolocation'] });
        await ctx.addInitScript(([l, th]) => { localStorage.setItem('zh.lang', l); localStorage.setItem('zh.theme', th); }, [lang, theme]);
        const page = await ctx.newPage();
        const problems = [];
        page.on('console', (m) => { if (/Service Worker registration blocked/.test(m.text())) return; if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
        page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
        page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
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
        const info = await page.evaluate(() => {
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
          return { dir: de.dir, lang: de.lang, theme: de.dataset.theme, overflowX, offenders, title: document.title, leak: leak ? leak[2] : null };
        });
        if (info.dir !== (lang === 'ar' ? 'rtl' : 'ltr')) problems.push(`dir=${info.dir}`);
        if (info.theme !== theme) problems.push(`theme=${info.theme}`);
        if (info.leak) problems.push(`raw value shown to the user: "${info.leak}"`);
        if (info.overflowX) problems.push(`horizontal overflow: ${info.offenders.join(' | ')}`);
        if (!info.title.includes('Zintra حاضر')) problems.push(`title missing product name: ${info.title}`);
        const tag = `${name} ${width} ${lang} ${theme}`;
        if (problems.length) { failures++; console.log(`FAIL ${tag}\n  ${problems.join('\n  ')}`); }
        else console.log(`ok   ${tag}`);
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}-${width}-${lang}-${theme}.png`), fullPage: name !== 'design' || width === 360 ? true : true });
        await ctx.close();
      }
    }
  }
}
await browser.close();
console.log(failures ? `\n${failures} failing combinations` : '\nAll combinations passed');
process.exit(failures ? 1 : 0);
