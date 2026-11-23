// Payroll v2 / payslip / statement / payments / deletion — browser checks
// against the mock backend (synthetic data). PDFs are saved and their TEXT
// is extracted (pdftotext) — a toast or a Blob is not proof of a file.
// Run: node tools/e2e-payroll.mjs http://127.0.0.1:8787 [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { installMock, uiLogin } from './mock-backend.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
const out = process.argv[3] || fs.mkdtempSync('/tmp/hadir-pay-');
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch();
let fails = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; };
const pdfText = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
const pdfPages = (file) => Number(/Pages:\s+(\d+)/.exec(execFileSync('python3', ['-c', `import pypdf,sys;print('Pages:',len(pypdf.PdfReader(sys.argv[1]).pages))`, file], { encoding: 'utf8' }))?.[1] || 0);

const STAFF = [
  { id: '00000000-0000-4000-a000-0000000000a1', full_name_ar: 'أمل حسن', full_name_en: 'Amal Hassan', role: 'staff', active: true, monthly_salary_piastres: 1000000, code_created_at: '2026-11-01T08:00:00Z' },
  { id: '00000000-0000-4000-a000-0000000000b2', full_name_ar: 'بلال محمود', full_name_en: 'Belal Mahmoud', role: 'staff', active: true, monthly_salary_piastres: 1000000, code_created_at: '2026-11-01T08:00:00Z' },
  { id: '00000000-0000-4000-a000-0000000000c3', full_name_ar: 'عبد الرحمن محمد إبراهيم السيد الطويل جدًا', full_name_en: 'Abdelrahman Mohamed Ibrahim El-Sayed (Long Name)', role: 'staff', active: false, monthly_salary_piastres: null, code_created_at: '2026-11-01T08:00:00Z' },
];
const OWNER = { id: '00000000-0000-4000-a000-000000000001', full_name_ar: 'المالك', full_name_en: 'Owner', role: 'owner', active: true, monthly_salary_piastres: null };
function freshState() {
  return { employees: [OWNER, ...STAFF.map((x) => ({ ...x }))], payrollStaff: null,
    rewards: { [STAFF[1].id]: [{ id: 'rw-b', kind: 'reward', status: 'paid', amount_piastres: 10000 }] } };
}
async function owner(w = 1280, state = freshState(), lang = 'ar', init) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript((l) => { localStorage.setItem('zh.lang', l); }, lang);
  if (init) await ctx.addInitScript(init);
  await installMock(ctx, state); state.payrollStaff = null;
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await uiLogin(page, base, '87654321'); await page.waitForFunction(() => !location.hash.includes('login'));
  return { ctx, page, state, errors };
}
async function download(page, click) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), click()]);
  const file = path.join(out, dl.suggestedFilename()); await dl.saveAs(file); return file;
}

// ---------------------------------------------------------------- payroll page = one calculation
{
  const { ctx, page, state, errors } = await owner();
  await page.goto(`${base}/index.html#/owner/payroll`); await page.fill('input[type="month"]', '2026-10');
  await page.click('button:has-text("إنشاء")'); await page.waitForSelector('.kv-grid');
  const text = await page.textContent('main');
  check(/10,050/.test(text), 'base 10,000 + approved reward 100 − deduction 50 = net 10,050');
  check(/9,950/.test(text), 'reward paid separately → remaining 9,950 (entitlement stays 10,050)');
  check(text.includes('غير مسجل — مطلوب مراجعة') && text.includes('موقوف'), 'missing salary = review (not 0); inactive labelled, still listed');
  await page.selectOption('[data-testid="pay-show"]', 'active'); await page.waitForTimeout(200);
  check(!(await page.textContent('main')).includes('عبد الرحمن محمد'), 'filter: active only hides the deactivated employee');
  await page.selectOption('[data-testid="pay-show"]', 'all');
  // existing PDF export uses the same figures
  const pdf = await download(page, () => page.click('.toolbar .btn:has-text("PDF")'));
  const t1 = pdfText(pdf);
  check(/10,050/.test(t1) && /9,950/.test(t1), `payroll PDF carries the same net/remaining (${path.basename(pdf)})`);
  execFileSync('pdftoppm', ['-r', '60', '-png', '-f', '1', '-l', '1', pdf, path.join(out, 'payroll-pdf')]);
  // payment: review → confirm; a double tap records once
  await page.click('.card:has-text("أمل حسن") button:has-text("تسجيل دفعة")'); await page.waitForSelector('dialog.modal[open]');
  await page.fill('dialog.modal[open] input[inputmode="decimal"]', '5,000.50');
  await page.click('dialog.modal[open] .modal__footer .btn--primary');
  check(await page.isVisible('dialog.modal[open] >> text=سيُسجَّل دفع'), 'payment needs an explicit confirmation step');
  await page.dblclick('dialog.modal[open] .modal__footer .btn--primary'); await page.waitForTimeout(800);
  check(state.payments?.length === 1 && state.payments[0].amount_piastres === 500050, `one payment, exact piastres (${state.payments?.[0]?.amount_piastres})`);
  check(new Set(state.paymentCalls.map((c) => c.idempotency_key)).size === 1, 'retries reuse one idempotency key');
  check(!errors.length, `no page errors (${errors.join('; ')})`);
  await ctx.close();
}

// ---------------------------------------------------------------- payslip: draft, issue, PDF, print, batch
{
  const { ctx, page, state, errors } = await owner();
  await page.goto(`${base}/index.html#/owner/payslip?e=${STAFF[1].id}&m=2026-10`); await page.waitForSelector('.print-doc.payslip');
  check(await page.isVisible('.doc-watermark'), 'draft carries a DRAFT watermark');
  check((await page.textContent('.print-doc')).includes('لا تعني أن الموظف استلم'), 'a printed draft never claims money was received');
  await page.screenshot({ path: path.join(out, 'payslip-draft-1280.png'), fullPage: true });
  const pdf = await download(page, () => page.click('.doc-toolbar .btn:has-text("PDF")'));
  const t = pdfText(pdf);
  check(t.includes('DRAFT-202610-EMP-000000B2') && /10,050/.test(t) && /9,950/.test(t), 'payslip PDF: identity, net, remaining');
  execFileSync('pdftoppm', ['-r', '80', '-png', pdf, path.join(out, 'payslip-pdf')]);
  await page.click('button:has-text("إصدار نسخة نهائية")'); await page.waitForFunction(() => location.hash.includes('&v=1'));
  await page.waitForSelector('.print-doc.payslip');
  check(!(await page.$('.doc-watermark')) && (await page.textContent('.print-doc')).includes('PS-202610-EMP-000000B2-V1'), 'issued version: slip number, no watermark');
  // print isolation: only the document is printed
  await page.evaluate(() => { window.print = () => {}; });
  await page.click('.doc-toolbar .btn:has-text("طباعة")');
  await page.emulateMedia({ media: 'print' });
  const vis = await page.evaluate(() => [...document.body.children].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id || el.className));
  check(vis.length === 1 && vis[0] === 'print-root', `print shows only the document (${vis.join(',')})`);
  await page.screenshot({ path: path.join(out, 'payslip-print-media.png'), fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  // batch
  await page.goto(`${base}/index.html#/owner/payroll`); await page.fill('input[type="month"]', '2026-10');
  await page.click('button:has-text("إنشاء")'); await page.waitForSelector('.pick');
  const picks = await page.$$('.pick'); await picks[0].check(); await (await page.$$('.pick'))[1].check();
  const batch = await download(page, () => page.click('button:has-text("قسائم المحددين PDF")'));
  check(pdfPages(batch) >= 2 && /أمل|Amal|000000A1/.test(pdfText(batch)) && /000000B2/.test(pdfText(batch)), `batch PDF: each employee on its own page (${pdfPages(batch)} pages)`);
  check(!errors.length, `no page errors (${errors.join('; ')})`);
  await ctx.close();
}

// ---------------------------------------------------------------- English + phone width
{
  const { ctx, page, errors } = await owner(390, freshState(), 'en');
  await page.goto(`${base}/index.html#/owner/payslip?e=${STAFF[0].id}&m=2026-10`); await page.waitForSelector('.print-doc.payslip');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: payslip page has no horizontal scroll');
  await page.screenshot({ path: path.join(out, 'payslip-en-390.png'), fullPage: true });
  const pdf = await download(page, () => page.click('.doc-toolbar .btn:has-text("PDF")'));
  check(/Payslip/.test(pdfText(pdf)) && /10,050/.test(pdfText(pdf)), 'English payslip PDF');
  check(!errors.length, `no page errors (${errors.join('; ')})`);
  await ctx.close();
}

// ---------------------------------------------------------------- installed iPhone app: no download trap
{
  const { ctx, page } = await owner(390, freshState(), 'ar', () => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
  await page.goto(`${base}/index.html#/owner/payslip?e=${STAFF[0].id}&m=2026-10`); await page.waitForSelector('.print-doc.payslip');
  let downloaded = false; page.on('download', () => { downloaded = true; });
  await page.click('.doc-toolbar .btn:has-text("PDF")'); await page.waitForSelector('button:has-text("فتح / مشاركة الملف")', { timeout: 15000 });
  check(!downloaded, 'iOS standalone: no download link followed (no trap); a tap-to-share/open button is offered');
  await ctx.close();
}

// ---------------------------------------------------------------- statement
{
  const { ctx, page, errors } = await owner();
  await page.goto(`${base}/index.html#/owner/employee?id=${STAFF[0].id}`); await page.waitForSelector('.statement');
  await page.fill('input[type="date"] >> nth=0', '2026-09-01'); await page.fill('input[type="date"] >> nth=1', '2026-10-31');
  await page.click('button:has-text("عرض الكشف")'); await page.waitForSelector('.pager');
  const rows = await page.$$eval('.statement tbody tr', (r) => r.length);
  check(rows === 31 && (await page.textContent('.pager')).includes('61 يوم'), `61-day range paginated (31 rows, totals over all 61)`);
  const txt = await page.textContent('.statement');
  await page.click('button:has-text("التالي")');
  const t2 = txt + await page.textContent('.statement');
  check(t2.includes('عطلة أسبوعية') && t2.includes('متأخر'), 'weekends and late days labelled');
  check(t2.includes('عيد القوات المسلحة') && t2.includes('لم يسجّل انصرافًا') && t2.includes('انصراف يوم'), 'holiday, missing check-out (no invented time), overnight check-out');
  check(t2.includes('لا يوجد سجل') && !t2.includes('غائب (معتمد)'), 'a day without a record is not shown as an absence');
  await page.click('button:has-text("السابق")');
  await page.selectOption('[data-testid="st-filter"]', 'late'); await page.waitForTimeout(200);
  check(await page.$$eval('.statement tbody tr', (r) => r.every((x) => x.textContent.includes('متأخر'))), 'status filter');
  await page.selectOption('[data-testid="st-filter"]', 'all');
  const pdf = await download(page, () => page.click('.doc-toolbar .btn:has-text("PDF")'));
  const pt = pdfText(pdf);
  check(pdfPages(pdf) >= 2 && pt.includes('EMP-000000A1') && /\d{2}\/\d{2}\/2026/.test(pt), `statement PDF: multi-page, identity, dates (${pdfPages(pdf)} pages)`);
  execFileSync('pdftoppm', ['-r', '70', '-png', '-f', '1', '-l', '2', pdf, path.join(out, 'statement-pdf')]);
  const csv = await download(page, () => page.click('.doc-toolbar .btn:has-text("CSV")'));
  check(fs.readFileSync(csv, 'utf8').split('\n').length >= 62, 'statement CSV: one line per day');
  await page.screenshot({ path: path.join(out, 'statement-1280.png'), fullPage: true });
  check(!errors.length, `no page errors (${errors.join('; ')})`);
  await ctx.close();
}

// ---------------------------------------------------------------- deletion (two-step)
{
  const { ctx, page, state, errors } = await owner();
  await page.goto(`${base}/index.html#/owner/employees`); await page.waitForSelector('table');
  await page.click('tr:has-text("عبد الرحمن") button:has-text("تعديل")'); await page.waitForSelector('dialog.modal[open]');
  check(!(await page.$('dialog.modal[open] .detail-section:has-text("حذف نهائي") >> nth=1')), 'one delete section');
  await page.click('dialog.modal[open] button:has-text("حذف الموظف نهائيًا")'); await page.waitForSelector('dialog.modal[open] .del-counts');
  const counts = await page.textContent('dialog.modal[open] .del-counts');
  check(counts.includes('ملفات مخزنة') && counts.includes('نسخ قسائم الراتب'), 'preview lists every record type, zeros included');
  check((await page.locator('dialog.modal[open]').last().textContent()).includes('permanently erases'), 'Arabic and English warning');
  await page.fill('dialog.modal[open] [data-testid="del-name"] input, dialog.modal[open] input[data-testid="del-name"]', 'غلط');
  await page.click('dialog.modal[open] .modal__footer .btn--danger');
  check(await page.isVisible('dialog.modal[open] >> text=الاسم غير مطابق'), 'typed-name mismatch blocks');
  check(!state.deleteCalls, 'nothing sent on mismatch');
  await page.fill('dialog.modal[open] input[data-testid="del-name"]', STAFF[2].full_name_ar);
  await page.click('dialog.modal[open] .modal__footer .btn--danger');
  check(await page.isVisible('dialog.modal[open] >> text=التأكيد الأخير'), 'distinct final confirmation');
  await page.dblclick('dialog.modal[open] .modal__footer .btn--danger'); await page.waitForTimeout(800);
  check(state.deleteCalls?.length === 1 && !state.employees.some((e) => e.id === STAFF[2].id), 'one delete request; employee gone from the list');
  check(!(await page.textContent('main')).includes('عبد الرحمن محمد'), 'list refreshed');
  // owners have no delete action
  await page.click('tr:has-text("المالك") button:has-text("تعديل")'); await page.waitForSelector('dialog.modal[open]');
  check(!(await page.$('dialog.modal[open] button:has-text("حذف الموظف نهائيًا")')), 'no delete for an owner (also refused server-side)');
  check(!errors.length, `no page errors (${errors.join('; ')})`);
  await ctx.close();
}
{
  const { ctx, page, state } = await owner(1280, { ...freshState(), deleteChanged: true });
  await page.goto(`${base}/index.html#/owner/employees`); await page.waitForSelector('table');
  await page.click('tr:has-text("بلال") button:has-text("تعديل")'); await page.waitForSelector('dialog.modal[open]');
  await page.click('dialog.modal[open] button:has-text("حذف الموظف نهائيًا")'); await page.waitForSelector('dialog.modal[open] .del-counts');
  await page.fill('dialog.modal[open] input[data-testid="del-name"]', STAFF[1].full_name_en);
  await page.click('dialog.modal[open] .modal__footer .btn--danger'); await page.click('dialog.modal[open] .modal__footer .btn--danger'); await page.waitForTimeout(600);
  check(await page.isVisible('dialog.modal[open] >> text=تغيّرت سجلات الموظف'), 'records changed since preview → new counts, confirm again');
  check(state.employees.some((e) => e.id === STAFF[1].id), 'nothing deleted beyond what was reviewed');
  await ctx.close();
}

// ---------------------------------------------------------------- settings badge + dashboard filter
{
  const { ctx, page } = await owner();
  await page.goto(`${base}/index.html#/owner/settings`); await page.waitForSelector('.window-row'); await page.waitForTimeout(400);
  check(await page.$eval('.chip--warning', (e) => getComputedStyle(e).display === 'none'), 'clean load: «تعديلات غير محفوظة» not visible');
  await page.fill('.window-row [data-k="end"] >> nth=0', '08:30'); await page.waitForTimeout(100);
  check(await page.$eval('.chip--warning', (e) => getComputedStyle(e).display !== 'none'), 'after an edit the badge shows');
  await page.goto(`${base}/index.html#/owner/dashboard`); await page.waitForSelector('table');
  check(!(await page.textContent('table')).includes('عبد الرحمن محمد'), 'dashboard hides deactivated staff by default');
  await page.click('button:has-text("إظهار الموقوفين")'); await page.waitForTimeout(300);
  check((await page.textContent('table')).includes('عبد الرحمن محمد'), '…and shows them on request, labelled');
  await ctx.close();
}

await b.close();
console.log(`artifacts: ${out}`);
console.log(fails ? `${fails} payroll check(s) FAILED` : 'All payroll/payslip/statement/deletion checks passed');
process.exit(fails ? 1 : 0);
