// Owner reports card + announcement scheduling: AR/EN, mobile/desktop (mock backend only).
// Run: node tools/e2e-reports.mjs [screenshotDir]
import { createRequire } from 'node:module';
import { installMock, uiLogin } from './mock-backend.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] && !process.argv[2].startsWith('http') ? process.argv[2] : null; const b = await chromium.launch(); const BASE = 'http://127.0.0.1:8787';
const log = []; const ok = (c, m) => log.push(`${c ? 'PASS' : 'FAIL'} ${m}`);
for (const [lang, w] of [['ar', 390], ['en', 390], ['ar', 1280], ['en', 1280]]) {
  const state = { chatVerified: true };
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  await ctx.addInitScript((l) => { localStorage.setItem('zh.lang', l); }, lang);
  await installMock(ctx, state); const page = await ctx.newPage();
  page.on('pageerror', (e) => log.push(`pageerror ${e.message}`));
  await uiLogin(page, BASE, '87654321'); await page.waitForFunction(() => !location.hash.includes('login'));
  await page.goto(`${BASE}/index.html#/owner/settings`); await page.waitForSelector('.window-row'); await page.waitForTimeout(700);
  const rep = page.locator('.card', { has: page.locator('text=' + (lang === 'ar' ? 'تقارير تيليجرام للمالك' : 'Owner Telegram reports')) }).first();
  await rep.scrollIntoViewIfNeeded(); if (out) await rep.screenshot({ path: `${out}/reports-${lang}-${w}.png` });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${lang}-${w}: settings no horizontal scroll`);
  // toggles off by default; save sends explicit values
  const sw = rep.locator('.switch__input');
  ok((await sw.evaluateAll((xs) => xs.map((x) => x.checked))).every((c) => !c), `${lang}-${w}: all report features off by default`);
  await sw.nth(0).check({ force: true }); await rep.locator('.card__footer .btn').click(); await page.waitForTimeout(500);
  const sent = state.reportSaves?.at(-1);
  ok(sent?.sunday_summary_enabled === true && sent?.payroll_summary_enabled === false && sent?.payroll_summary_time === '10:00', `${lang}-${w}: save sends explicit settings`);
  // scheduling modal
  await page.goto(`${BASE}/index.html#/owner/announcements`); await page.waitForSelector('.ann-watch'); await page.waitForTimeout(400);
  await page.click('.page-header .btn--primary, header .btn--primary'); await page.waitForSelector('dialog.modal[open]');
  await page.fill('dialog.modal[open] textarea', lang === 'ar' ? 'اجتماع الفريق يوم الأحد' : 'Team meeting on Sunday');
  await page.selectOption('dialog.modal[open] select >> nth=1', 'later');
  await page.selectOption('dialog.modal[open] select >> nth=0', 'owner_telegram');
  await page.waitForTimeout(200);
  const disabled72 = await page.$eval('dialog.modal[open] select >> nth=2', (s) => [...s.options].filter((o) => o.disabled).map((o) => o.value));
  ok(disabled72.includes('4320') && disabled72.includes('10080'), `${lang}-${w}: Telegram hides >47 h deletion (${disabled72})`);
  if (out) await (await page.$('dialog.modal[open]')).screenshot({ path: `${out}/schedule-${lang}-${w}.png` });
  await page.click('dialog.modal[open] .modal__footer .btn--primary'); await page.waitForTimeout(600);
  ok((state.sched || []).length === 1 && state.sched[0].destination === 'owner_telegram' && /T\d{2}:\d{2}$/.test(state.sched[0].publish_local), `${lang}-${w}: scheduled with Cairo local time`);
  ok(await page.isVisible('.ann-item [data-id], li.ann-item[data-id="s1"]') || (await page.$$('li.ann-item[data-id="s1"]')).length === 1, `${lang}-${w}: shows in the scheduled list`);
  if (out) await page.screenshot({ path: `${out}/ann-page-${lang}-${w}.png`, fullPage: true });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${lang}-${w}: announcements no horizontal scroll`);
  await ctx.close();
}
// unverified chat: Telegram destination is not selectable
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => localStorage.setItem('zh.lang', 'ar'));
  await installMock(ctx, { chatVerified: false }); const page = await ctx.newPage();
  await uiLogin(page, BASE, '87654321'); await page.waitForFunction(() => !location.hash.includes('login'));
  await page.goto(`${BASE}/index.html#/owner/announcements`); await page.waitForSelector('.ann-watch'); await page.waitForTimeout(500);
  await page.click('.page-header .btn--primary, header .btn--primary'); await page.waitForSelector('dialog.modal[open]');
  ok(await page.$eval('dialog.modal[open] option[value="owner_telegram"]', (o) => o.disabled), 'unverified chat: Telegram destination disabled');
  await ctx.close();
}
await b.close(); console.log(log.join('\n'));
const failed = log.filter((l) => !l.startsWith('PASS')).length;
console.log(failed ? `${failed} report-screen check(s) FAILED` : 'All report-screen checks passed');
process.exit(failed ? 1 : 0);
