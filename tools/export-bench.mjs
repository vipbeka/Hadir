// Generates PDF / XLSX / CSV in a real browser for empty, current and large
// reports and records timing + size. Usage: node tools/export-bench.mjs [base] [outDir]
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path';
import { installMock, uiLogin, PEOPLE } from './mock-backend.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787'; const out = process.argv[3] || '.';
const browser = await chromium.launch(); const results = [];
const staff = (n) => Array.from({ length: n }, (_, i) => ({ ...PEOPLE.staff, id: `s${i}`, full_name_ar: i % 2 ? `محمد أحمد ${i}` : `سارة علي ${i}`, full_name_en: `Staff ${i}`, job_title_ar: 'محاسب', job_title_en: 'Accountant', monthly_salary_piastres: 800000 }));
for (const [label, n, raw, lang] of [['empty', 0, 0, 'ar'], ['current', 2, 40, 'ar'], ['current-en', 2, 40, 'en'], ['large', 150, 5000, 'ar']]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true, isMobile: true, hasTouch: true });
  await ctx.addInitScript((l) => localStorage.setItem('zh.lang', l), lang);
  const state = await installMock(ctx, { payrollStaff: staff(n), rawRows: raw }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await uiLogin(page, base, '87654321'); await page.waitForFunction(() => location.hash === '#/owner/dashboard');
  await page.goto(`${base}/index.html#/owner/payroll`);
  await page.click('.toolbar .btn--primary'); await page.waitForFunction(() => [...document.querySelectorAll('.toolbar .btn')].some((b) => /PDF/.test(b.textContent) && !b.disabled), null, { timeout: 30000 });
  for (const [fmt, sel, csvWhich] of [['pdf', 'PDF'], ['xlsx', 'Excel'], ['csv', 'CSV', 'attendance']]) {
    if (csvWhich) await page.selectOption('.toolbar select', csvWhich);
    const btn = page.locator('.toolbar .btn', { hasText: new RegExp(sel) }).first();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), btn.click()]);
    const file = path.join(out, `${label}-${dl.suggestedFilename()}`); await dl.saveAs(file);
    await page.waitForFunction(() => document.querySelector('main').dataset.lastExport, null, { timeout: 5000 });
    const m = JSON.parse(await page.evaluate(() => document.querySelector('main').dataset.lastExport));
    await page.evaluate(() => { delete document.querySelector('main').dataset.lastExport; });
    results.push({ report: label, staff: n, rawRows: raw, format: fmt, ms: m.ms, bytes: fs.statSync(file).size, file: path.basename(file) });
  }
  if (errors.length) console.log('page errors', label, errors);
  await ctx.close();
}
await browser.close();
console.table(results);
fs.writeFileSync(path.join(out, 'bench.json'), JSON.stringify(results, null, 2));
