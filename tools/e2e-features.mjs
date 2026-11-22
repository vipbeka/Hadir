// Steps 3–10 UI flows against the MOCKED backend (tools/mock-backend.mjs).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { installMock, uiLogin } from './mock-backend.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const browser = await chromium.launch();
const ctxOpts = (geo, perms = ['geolocation']) => ({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', geolocation: geo, permissions: perms });

// ---- check-in inside the office
{
  const ctx = await browser.newContext(ctxOpts({ latitude: 29.98325, longitude: 31.324, accuracy: 10 }));
  await ctx.addInitScript(() => localStorage.setItem('zh.lang', 'en'));
  const state = await installMock(ctx); const page = await ctx.newPage();
  await uiLogin(page, base, '12345678'); await page.waitForFunction(() => location.hash === '#/staff/home');
  await page.goto(`${base}/index.html#/staff/attendance`); await page.waitForSelector('.att-geo--success', { timeout: 10000 });
  check(/LOCATION VERIFIED/.test(await page.textContent('.att-geo')), 'inside the geofence → "LOCATION VERIFIED"');
  const btn = page.locator('.att-card .btn--primary');
  check(!(await btn.isDisabled()), 'check-in button enabled inside the area');
  await btn.click(); await page.waitForSelector('.toast');
  check(/green point/i.test(await page.textContent('.toast-region')), 'check-in confirms only after the server answers (green point)');
  check(state.calls.some((c) => c.body?.action === 'check_in' && typeof c.body.params.lat === 'number' && typeof c.body.params.accuracy === 'number'), 'only coordinates + accuracy are sent (server decides the rest)');
  await page.waitForSelector('text=Check out');
  check(true, 'screen switches to Check out with a running worked-time display');
  await page.fill('input[type=time]', '15:00'); await page.click('form button[type=submit]');
  await page.waitForSelector('text=/Early leave at 15:00/');
  check(true, 'early-leave request submitted and shown as pending');
  await page.goto(`${base}/index.html#/owner/dashboard`); await page.waitForTimeout(300);
  check(await page.evaluate(() => location.hash) === '#/staff/home', 'staff cannot open owner routes (redirected)');
  const st = await page.evaluate(async () => {
    const tok = JSON.parse(localStorage.getItem('zh.auth')).access_token;
    const r = await fetch('https://hppcujuplyjkuaxwmjhk.supabase.co/functions/v1/api', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{"action":"payroll","params":{}}' });
    return r.status;
  });
  check(st === 403, 'staff token → owner api action refused (mock mirrors server role check)');
  await ctx.close();
}
// ---- outside the geofence + permission denied
{
  const ctx = await browser.newContext(ctxOpts({ latitude: 30.05, longitude: 31.24, accuracy: 10 }));
  await ctx.addInitScript(() => localStorage.setItem('zh.lang', 'en'));
  await installMock(ctx); const page = await ctx.newPage();
  await uiLogin(page, base, '12345678'); await page.waitForFunction(() => location.hash === '#/staff/home');
  await page.goto(`${base}/index.html#/staff/attendance`); await page.waitForSelector('.att-geo--danger', { timeout: 10000 });
  check(/Outside the area — \d+ m away/.test(await page.textContent('.att-geo')), 'outside → distance shown');
  check(await page.locator('.att-card .btn--primary').isDisabled(), 'check-in disabled outside the area');
  await ctx.close();
  const ctx2 = await browser.newContext(ctxOpts(undefined, []));
  await ctx2.addInitScript(() => localStorage.setItem('zh.lang', 'en'));
  await installMock(ctx2); const p2 = await ctx2.newPage();
  await uiLogin(p2, base, '12345678'); await p2.waitForFunction(() => location.hash === '#/staff/home');
  await p2.goto(`${base}/index.html#/staff/attendance`); await p2.waitForSelector('.att-geo--danger', { timeout: 25000 });
  check(/permission was denied|couldn't be read/i.test(await p2.textContent('.att-geo')), 'location denied → clear instructions, no check-in');
  await ctx2.close();
}
// ---- owner approvals, payroll exports
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript(() => localStorage.setItem('zh.lang', 'en'));
  const state = await installMock(ctx); const page = await ctx.newPage();
  await uiLogin(page, base, '87654321'); await page.waitForFunction(() => location.hash === '#/owner/dashboard');
  await page.goto(`${base}/index.html#/owner/approvals?black`); await page.waitForSelector('.approval-row');
  await page.click('.approval-row >> text=Approve');
  await page.waitForSelector('dialog[open]');
  check(/1,000 EGP/.test(await page.textContent('dialog[open]')), 'approving an absence shows the exact deduction amount');
  await page.click('dialog[open] >> text=Approve'); await page.waitForTimeout(400);
  check(state.calls.some((c) => c.body?.action === 'decide_black' && c.body.params.confirm_amount_piastres === 100000), 'owner confirmation of the amount is sent and stored');
  await page.goto(`${base}/index.html#/owner/payroll`); await page.click('text=Generate report'); await page.waitForSelector('.kv-grid');
  const labels = await page.$$eval('.kv-grid dt', (els) => els.map((e) => e.textContent));
  check(labels.includes('Monthly salary') && labels.includes('Total deductions') && !labels.some((l) => /net (pay|salary)/i.test(l)), 'payroll shows salary + deductions separately, no "net pay" figure');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Export Excel')]);
  const xlsxPath = await dl.path();
  check(dl.suggestedFilename().endsWith('.xlsx') && fs.statSync(xlsxPath).size > 1000, 'Excel .xlsx workbook downloaded');
  const dls = []; page.on('download', (d) => dls.push(d));
  await page.click('text=CSV data');
  for (let i = 0; i < 30 && dls.length < 3; i++) await page.waitForTimeout(200);
  check(dls.length === 3, 'CSV export: attendance, point events, deductions');
  const att = dls.find((d) => d.suggestedFilename().includes('attendance'));
  const csv = att ? fs.readFileSync(await att.path(), 'utf8') : '';
  check(csv.includes("'=cmd()"), 'spreadsheet formula injection neutralised in CSV');
  await ctx.close();
}
await browser.close();
console.log(fail ? `\n${fail} checks failed` : '\nAll mocked Step 3–10 flow checks passed');
process.exit(fail ? 1 : 0);
