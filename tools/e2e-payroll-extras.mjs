// Advances, overtime, selfie at check-in, backup download, dashboard stats
// against the MOCKED backend. Phone size, light + dark, no overflow, no errors.
// Usage: node tools/e2e-payroll-extras.mjs [baseUrl] [shotDir]
import { createRequire } from 'node:module';
import { installMock, uiLogin, PEOPLE } from './mock-backend.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
const shots = process.argv[3];
let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const browser = await chromium.launch();
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const dialog = (page) => page.locator('dialog[open]').last();
// a real 8×8 PNG for the camera picker
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64');

async function newPage(scheme, state, geo = false) {
  const ctx = await browser.newContext({ ...devices['Pixel 5'], colorScheme: scheme,
    ...(geo ? { geolocation: { latitude: 29.98325, longitude: 31.324, accuracy: 10 }, permissions: ['geolocation'] } : {}) });
  await ctx.addInitScript(() => localStorage.setItem('zh.lang', 'ar'));
  await installMock(ctx, state);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of 400/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}

for (const scheme of ['light', 'dark']) {
  // ============================================================ staff
  {
    const state = { selfie: true };
    const { ctx, page, errors } = await newPage(scheme, state, true);
    await uiLogin(page, base, '12345678');
    await page.waitForFunction(() => location.hash.startsWith('#/staff'));
    // advance request
    await page.goto(`${base}/index.html#/staff/requests`); await page.waitForSelector('.req-actions');
    await page.getByRole('button', { name: 'طلب سلفة' }).click();
    await dialog(page).locator('input[type=number]').fill('0');
    await dialog(page).getByRole('button', { name: 'إرسال' }).click();
    check(await dialog(page).getByText('اكتب مبلغًا صحيحًا').count() === 1 && !(state.advRows || []).length, `[${scheme}] advance: invalid amount → message, nothing sent`);
    await dialog(page).locator('input[type=number]').fill('1500');
    await dialog(page).locator('select').selectOption('3');
    await dialog(page).getByRole('button', { name: 'إرسال' }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    check(state.advRows?.[0]?.amount_piastres === 150000 && state.advRows[0].installments === 3, `[${scheme}] advance request sent (1,500 EGP / 3)`);
    await page.waitForSelector('.card:has-text("السُلف") .event-row');
    check(await page.locator('.card', { hasText: 'السُلف' }).getByText('3 قسط').count() >= 1, `[${scheme}] advance listed with its installments`);
    // my statement shows the installment and the overtime
    await page.goto(`${base}/index.html#/staff/statement`); await page.waitForSelector('.kv-grid');
    check(await page.getByText('القسط 1 من 3 · قسط سلفة').count() === 1 && await page.getByText(/^ساعات إضافية ·/).count() === 1, `[${scheme}] my statement: advance installment + overtime lines`);
    // selfie at check-in
    await page.goto(`${base}/index.html#/staff/attendance`);
    const btn = page.getByRole('button', { name: 'تسجيل الحضور', exact: true });
    await btn.waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'تسجيل الحضور' && !b.disabled), null, { timeout: 15000 });
    await btn.click();
    await page.waitForSelector('dialog[open] .selfie');
    check(await dialog(page).getByRole('button', { name: 'استخدم الصورة وسجّل الحضور' }).isDisabled(), `[${scheme}] selfie required: dialog opens, «use» disabled until a photo`);
    await dialog(page).locator('input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('dialog[open] .selfie__preview:not([hidden])');
    if (shots) await page.screenshot({ path: `${shots}/selfie-${scheme}.png` });
    await dialog(page).getByRole('button', { name: 'استخدم الصورة وسجّل الحضور' }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.waitForTimeout(500);
    check(state.uploads?.length === 1 && state.uploads[0].startsWith(`${PEOPLE.staff.id}/`) && state.checkInSelfie === state.uploads[0],
      `[${scheme}] photo uploaded to the employee's own folder, check-in sent with its path`);
    check(errors.length === 0, `[${scheme}] staff: no page/console errors (${errors.join(' | ').slice(0, 200)})`);
    await ctx.close();
  }
  // ============================================================ owner
  {
    const state = {};
    const { ctx, page, errors } = await newPage(scheme, state);
    const downloads = []; page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await uiLogin(page, base, '87654321');
    await page.waitForFunction(() => location.hash.startsWith('#/owner/dashboard'));
    await page.waitForSelector('.stat-bars');
    check(await page.locator('.stats-grid', { hasText: 'سُلف' }).count() === 1 && await page.locator('.stats-grid', { hasText: 'ساعات إضافية' }).count() === 1, `[${scheme}] dashboard tiles: advances, overtime`);
    check(await page.locator('.stat-bars .stat-bars__fill').count() === 12 && await page.locator('.stat-bars title').count() === 12, `[${scheme}] stats: one bar + tooltip per work day`);
    check(await page.getByText('الأكثر التزامًا').count() === 1 && await page.getByText('3 غياب', { exact: true }).count() === 1, `[${scheme}] stats: most committed + absences by weekday`);
    await page.locator('.switch', { hasText: 'طلب صورة سيلفي' }).click();
    await page.waitForFunction(() => document.querySelector('.toast'));
    check(state.staffTools?.selfie_required === true, `[${scheme}] selfie switch on the dashboard saves`);
    await page.getByRole('button', { name: 'عرض صورة الحضور' }).first().click();
    await page.waitForSelector('dialog[open] img.selfie__preview');
    check(true, `[${scheme}] owner opens an employee's check-in photo`);
    await dialog(page).getByRole('button', { name: 'إغلاق' }).last().click();
    if (shots) await page.screenshot({ path: `${shots}/dashboard-stats-${scheme}.png`, fullPage: true });
    check(await noOverflow(page), `[${scheme}] dashboard: no horizontal overflow`);
    // approvals
    await page.goto(`${base}/index.html#/owner/approvals?advance`); await page.waitForSelector('.approval-row');
    await page.locator('.approval-row').getByRole('button', { name: 'موافقة' }).click();
    await dialog(page).locator('select').nth(1).selectOption('6');
    await dialog(page).getByRole('button', { name: 'موافقة' }).click();
    await page.waitForFunction(() => document.querySelector('.toast'));
    const d1 = state.decisions?.find((x) => x.action === 'decide_advance');
    check(d1?.approve === true && d1.installments === 6 && /^\d{4}-\d{2}-01$/.test(d1.start_month), `[${scheme}] advance approved with start month + 6 installments`);
    await page.waitForLoadState('networkidle'); await page.waitForTimeout(600);   // the list redraws after the decision
    await page.locator('.tabs button', { hasText: 'الساعات الإضافية' }).click();
    const otRow = page.locator('.approval-row', { hasText: '90' });
    await otRow.waitFor({ timeout: 8000 }).catch(async () => { console.log('DEBUG main:', (await page.locator('main').innerText()).slice(-300).replace(/\n/g, ' | '), 'dialogs:', await page.locator('dialog[open]').count()); });
    await otRow.getByRole('button', { name: 'موافقة' }).click();
    await dialog(page).locator('input[type=number]').fill('60');
    await dialog(page).getByRole('button', { name: 'موافقة' }).click();
    await page.waitForTimeout(400);
    check(state.decisions.some((x) => x.action === 'decide_overtime' && x.approve && x.minutes === 60), `[${scheme}] overtime approved for 60 minutes`);
    // employee page: record an advance
    await page.goto(`${base}/index.html#/owner/employee?id=${PEOPLE.staff.id}`);
    const card = page.locator('.card', { hasText: 'تسجيل سلفة' }); await card.waitFor();
    await card.locator('input[type=number]').fill('900');
    await card.getByRole('button', { name: 'تسجيل سلفة' }).click();
    await page.waitForTimeout(400);
    check(state.decisions.some((x) => x.action === 'create_advance' && x.amount_egp === 900 && x.employee_id === PEOPLE.staff.id), `[${scheme}] owner records an advance for the employee`);
    // settings: overtime + backup download
    await page.goto(`${base}/index.html#/owner/settings`); await page.waitForSelector('#staff-tools input[data-key="overtime_rate_egp"]');
    const st = page.locator('#staff-tools');
    await st.locator('.switch', { hasText: 'احسب الساعات الإضافية' }).click();
    await st.locator('input[data-key="overtime_rate_egp"]').fill('60');
    await st.getByRole('button', { name: 'حفظ' }).click();
    await page.waitForFunction(() => document.querySelector('#staff-tools .save-status')?.textContent);
    check(state.staffTools.overtime_enabled === true && state.staffTools.overtime_rate_egp === 60 && state.staffTools.backup_time === '21:00', `[${scheme}] settings saved (overtime on, 60 EGP/h, backup time kept)`);
    await st.getByRole('button', { name: 'تنزيل نسخة احتياطية الآن' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast__title')].some((x) => x.textContent.includes('تم تنزيل')));
    check(state.backups === 1 && downloads.some((n) => /^hadir-backup-\d{4}-\d{2}-\d{2}\.json$/.test(n)), `[${scheme}] backup downloaded as a JSON file`);
    check(await noOverflow(page), `[${scheme}] settings: no horizontal overflow`);
    check(errors.length === 0, `[${scheme}] owner: no page/console errors (${errors.join(' | ').slice(0, 200)})`);
    await ctx.close();
  }
}
await browser.close();
console.log(fail ? `\n${fail} payroll-extras check(s) FAILED` : '\nAll advances / overtime / selfie / backup / stats checks passed');
process.exit(fail ? 1 : 0);
