// Staff & owner tools against the MOCKED backend (tools/mock-backend.mjs):
// staff — leave balance, permission (validation, over-limit flag, cancel),
// attendance correction (kinds, validation, server error kept in the
// dialog), leave balance error text, «كشف حسابي» (pay hidden / shown,
// deduction details, change log), home (personal day off, permission,
// points goal); owner — approvals (permission with deduction, correction
// rejected with a reason), dashboard tiles, employee schedule + leave
// balance + change log, settings card. Phone size, light + dark, no
// horizontal overflow, no console errors.
// Usage: node tools/e2e-staff-tools.mjs [baseUrl] [shotDir]
import { createRequire } from 'node:module';
import { installMock, uiLogin, PEOPLE } from './mock-backend.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
const shots = process.argv[3];
let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const browser = await chromium.launch();
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

async function newPage(scheme, state) {
  const ctx = await browser.newContext({ ...devices['Pixel 5'], colorScheme: scheme });
  await ctx.addInitScript(() => localStorage.setItem('zh.lang', 'ar'));
  await installMock(ctx, state);
  const page = await ctx.newPage();
  // (400s are the refusals this test provokes on purpose: balance, duplicate request)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of 400/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}
const dialog = (page) => page.locator('dialog[open]').last();
const submit = (page) => dialog(page).getByRole('button', { name: 'إرسال' });

for (const scheme of ['light', 'dark']) {
  // ============================================================ staff
  {
    const state = {};
    const { ctx, page, errors } = await newPage(scheme, state);
    await uiLogin(page, base, '12345678');
    await page.waitForFunction(() => location.hash.startsWith('#/staff'));
    await page.goto(`${base}/index.html#/staff/requests`);
    await page.waitForSelector('.balance-row');
    check(/16/.test(await page.locator('.balance-row__value').textContent()), `[${scheme}] leave balance shows 16 available`);
    check(await page.locator('.req-actions button').count() === 3, `[${scheme}] three request buttons (leave / permission / correction)`);

    // permission: validation, then 3 requests (3rd over the limit), cancel one
    await page.getByRole('button', { name: 'طلب إذن' }).click();
    await dialog(page).locator('input[type=time]').nth(0).fill('11:00');
    await dialog(page).locator('input[type=time]').nth(1).fill('10:00');
    await submit(page).click();
    check(await dialog(page).getByText('وقت النهاية لازم يكون بعد وقت البداية.').count() === 1 && !(state.permRows || []).length, `[${scheme}] permission: end before start → message, nothing sent`);
    for (const [a, b] of [['10:00', '11:00'], ['12:00', '12:30'], ['14:00', '15:30']]) {
      if (!(await dialog(page).count())) await page.getByRole('button', { name: 'طلب إذن' }).click();
      await dialog(page).locator('input[type=time]').nth(0).fill(a);
      await dialog(page).locator('input[type=time]').nth(1).fill(b);
      await dialog(page).locator('textarea').fill('مشوار بنك');
      await submit(page).click();
      await page.waitForFunction(() => !document.querySelector('dialog[open]'));
      await page.waitForTimeout(150);
    }
    check(state.permRows.length === 3 && state.permRows[0].minutes === 90, `[${scheme}] three permissions saved`);
    await page.waitForSelector('text=فوق الحد الشهري');
    check(await page.getByText('فوق الحد الشهري').count() === 1, `[${scheme}] the 3rd permission is flagged «فوق الحد الشهري»`);
    check(await page.getByText('90 دقيقة').count() === 1, `[${scheme}] permission length shown (90 min)`);
    await page.locator('.card', { hasText: 'الأذونات' }).getByRole('button', { name: 'إلغاء' }).first().click();
    await dialog(page).getByRole('button', { name: /تأكيد|إلغاء الطلب|نعم/ }).last().click();
    await page.waitForFunction(() => document.body.textContent.includes('ملغى'));
    check(state.permRows.some((r) => r.status === 'cancelled'), `[${scheme}] employee cancels a pending permission`);

    // correction: kinds, validation, save, duplicate → server message stays in the dialog
    await page.getByRole('button', { name: 'تصحيح حضور' }).click();
    const times = dialog(page).locator('.form-grid .field');
    check(await times.nth(0).isHidden() && await times.nth(1).isVisible(), `[${scheme}] correction «الانصراف فقط» shows only the check-out time`);
    await dialog(page).locator('select').selectOption('both');
    check(await times.nth(0).isVisible() && await times.nth(1).isVisible(), `[${scheme}] «الحضور والانصراف» shows both times`);
    await dialog(page).locator('input[type=time]').nth(0).fill('09:00');
    await dialog(page).locator('input[type=time]').nth(1).fill('17:00');
    await submit(page).click();
    check(await dialog(page).getByText('مطلوب سبب').count() + await dialog(page).locator('.field__error:not(:empty)').count() >= 1 && !(state.corrRows || []).length, `[${scheme}] correction without a reason → message, nothing sent`);
    await dialog(page).locator('textarea').fill('النت كان فاصل');
    await submit(page).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    check(state.corrRows?.length === 1 && state.corrRows[0].kind === 'both' && state.corrRows[0].check_in_time === '09:00:00', `[${scheme}] correction saved (both times)`);
    await page.getByRole('button', { name: 'تصحيح حضور' }).click();
    await dialog(page).locator('select').selectOption('both');
    await dialog(page).locator('input[type=time]').nth(0).fill('09:00');
    await dialog(page).locator('input[type=time]').nth(1).fill('17:00');
    await dialog(page).locator('textarea').fill('تاني');
    await submit(page).click();
    await page.waitForTimeout(400);
    check(await dialog(page).count() === 1 && /بانتظار|مسبق|قيد/.test(await dialog(page).textContent()), `[${scheme}] duplicate correction → server message, dialog stays open`);
    await dialog(page).getByRole('button', { name: 'إلغاء' }).first().click();

    // leave: balance error with numbers
    state.hook = (a) => (a === 'request_leave' ? { error: 'leave_balance_insufficient', detail: { requested: 3, available: 2 } } : null);
    await page.getByRole('button', { name: 'طلب إجازة' }).click();
    check(await dialog(page).getByText('متاح لك 16 يوم إجازة شخصية').count() === 1, `[${scheme}] leave dialog shows the available balance`);
    await dialog(page).locator('input[type=date]').nth(0).fill('2026-12-01');
    await dialog(page).locator('input[type=date]').nth(1).fill('2026-12-03');
    await submit(page).click();
    await page.waitForSelector('text=رصيدك لا يكفي: طلبت 3 يوم والمتاح 2.');
    check(true, `[${scheme}] balance error explains requested vs available`);
    state.hook = null;
    await dialog(page).getByRole('button', { name: 'إلغاء' }).first().click();
    check(await noOverflow(page), `[${scheme}] requests page: no horizontal overflow`);
    if (shots) await page.screenshot({ path: `${shots}/tools-requests-${scheme}.png`, fullPage: true });

    // «كشف حسابي»
    await page.goto(`${base}/index.html#/staff/statement`);
    await page.waitForSelector('.change-log li');
    check(await page.getByText('الراتب والصافي يظهران هنا فقط').count() === 1 && await page.getByText('الراتب الأساسي').count() === 0, `[${scheme}] my statement: salary hidden by default`);
    check(await page.locator('.card', { hasText: 'تفاصيل الخصومات' }).locator('li').count() === 3, `[${scheme}] deduction details (warning / deducted / pending)`);
    check(await page.locator('.change-log li').count() === 3 && await page.getByText('السبب: مش مسجّل في الكاميرا').count() === 1, `[${scheme}] change log with the owner's reason`);
    check(await noOverflow(page), `[${scheme}] statement page: no horizontal overflow`);
    if (shots) await page.screenshot({ path: `${shots}/tools-statement-${scheme}.png`, fullPage: true });
    state.payVisible = true;
    await page.reload(); await page.waitForSelector('text=الراتب الأساسي');
    check(await page.getByText('الصافي المتوقع حتى الآن').count() === 1, `[${scheme}] salary + expected net shown when the owner allows it`);

    // home: personal day off, permission today, points goal
    state.dayOff = true; state.todayPerms = [{ id: 1, from_time: '10:00:00', to_time: '11:00:00', status: 'approved' }];
    await page.goto(`${base}/index.html#/staff/home`);
    await page.waitForSelector('.status-card');
    check(await page.getByText('يوم راحتك حسب جدولك').count() === 1, `[${scheme}] home: personal day off`);
    check(await page.getByText(/إذنك اليوم من .* إلى .* مقبول/).count() === 1, `[${scheme}] home: today's approved permission`);
    check(await page.getByText('باقي لك 23 نقطة خضراء و18 يوم عمل فقط — صعب هذا الشهر').count() >= 1, `[${scheme}] points goal: 23 points with 18 work days left → «صعب هذا الشهر»`);
    state.workDaysLeft = 25; await page.reload(); await page.waitForSelector('.month-card');
    check(await page.getByText('باقي لك 23 نقطة خضراء و25 يوم عمل في الشهر').count() >= 1, `[${scheme}] points goal reachable: 23 points, 25 work days left`);
    check(errors.length === 0, `[${scheme}] staff: no page/console errors (${errors.join(' | ').slice(0, 200)})`);
    await ctx.close();
  }

  // ============================================================ owner
  {
    const state = {};
    const { ctx, page, errors } = await newPage(scheme, state);
    await uiLogin(page, base, '87654321');
    await page.waitForFunction(() => location.hash.startsWith('#/owner/dashboard'));
    await page.waitForSelector('.stats-grid');
    check(await page.locator('.stats-grid', { hasText: 'أذونات' }).count() === 1 && await page.locator('.stats-grid', { hasText: 'تصحيح حضور' }).count() === 1, `[${scheme}] dashboard: permission + correction tiles`);

    await page.goto(`${base}/index.html#/owner/approvals?permission`);
    await page.waitForSelector('.approval-row');
    check(await page.getByText('أذونات هذا الشهر: 4').count() === 1 && await page.getByText('فوق الحد الشهري').count() === 1, `[${scheme}] approvals: permission with month count + over-limit`);
    await page.getByRole('button', { name: 'قبول مع خصم' }).click();
    await dialog(page).getByRole('button', { name: 'قبول مع خصم' }).click();
    await page.waitForFunction(() => document.querySelector('.toast'));
    check(state.decisions?.[0]?.action === 'decide_permission' && state.decisions[0].deduct === true && state.decisions[0].approve === true, `[${scheme}] approve with deduction sent`);
    await page.locator('.tabs button', { hasText: 'تصحيح الحضور' }).click();
    await page.waitForSelector('text=النت كان فاصل');
    await page.locator('.approval-row').getByRole('button', { name: 'رفض' }).click();
    await dialog(page).locator('textarea').fill('مش موجود في الكاميرا');
    await dialog(page).getByRole('button', { name: 'حفظ' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.toast').length >= 1);
    await page.waitForTimeout(200);
    check(state.decisions.some((d) => d.action === 'decide_correction' && d.approve === false && d.comment === 'مش موجود في الكاميرا'), `[${scheme}] correction rejected with a reason`);
    check(await noOverflow(page), `[${scheme}] approvals (7 tabs): no horizontal overflow`);
    if (shots) await page.screenshot({ path: `${shots}/tools-approvals-${scheme}.png`, fullPage: true });

    // employee page: schedule, balance, change log
    await page.goto(`${base}/index.html#/owner/employee?id=${PEOPLE.staff.id}`);
    await page.waitForSelector('.sched-row');
    check(await page.locator('.sched-row').count() === 7, `[${scheme}] schedule: 7 days`);
    check(await page.locator('.sched-row[data-dow="5"] input[type=checkbox]').isDisabled(), `[${scheme}] company day off cannot be switched on`);
    await page.locator('.sched-row[data-dow="0"] .switch').click();                 // Sunday → personal day off
    const mon = page.locator('.sched-row[data-dow="1"]');
    await mon.locator('input[type=time]').nth(0).fill('12:00');
    const saveSched = page.locator('.card', { hasText: 'جدول الدوام الخاص' }).getByRole('button', { name: 'حفظ' });
    await saveSched.click();
    check(await mon.getByText('اكتب البداية والنهاية معًا').count() === 1 && !state.scheduleSaves, `[${scheme}] schedule: start without end → message, nothing saved`);
    await mon.locator('input[type=time]').nth(1).fill('20:00');
    await saveSched.click();
    await page.waitForFunction(() => document.querySelector('.toast'));
    const sv = state.scheduleSaves?.[0]?.days || [];
    check(sv.find((d) => d.day_of_week === 0)?.is_work_day === false && sv.find((d) => d.day_of_week === 1)?.start_time === '12:00' && !sv.some((d) => d.day_of_week === 5),
      `[${scheme}] schedule saved (Sunday off, Monday 12:00–20:00, company days off untouched)`);
    const bal = page.locator('.card', { hasText: 'رصيد الإجازات' });
    await bal.locator('input[type=number]').fill('1.3');
    await bal.getByRole('button', { name: 'حفظ' }).click();
    check(await bal.getByText('من 0 إلى 365').count() === 1 && !state.balanceSaves, `[${scheme}] balance: 1.3 refused (half days only)`);
    await bal.locator('input[type=number]').fill('18.5');
    await bal.getByRole('button', { name: 'حفظ' }).click();
    await page.waitForFunction(() => document.body.textContent.includes('رصيد خاص بهذا الموظف'));
    check(state.balanceSaves?.[0]?.entitled_days === 18.5, `[${scheme}] balance 18.5 saved`);
    await page.locator('summary', { hasText: 'عرض السجل' }).click();
    await page.waitForSelector('.change-log li');
    check(await page.locator('.change-log li').count() === 3, `[${scheme}] owner sees the employee's change log`);
    check(await noOverflow(page), `[${scheme}] employee page: no horizontal overflow`);
    if (shots) await page.locator('.card', { hasText: 'جدول الدوام الخاص' }).screenshot({ path: `${shots}/tools-schedule-${scheme}.png` });

    // settings card
    await page.goto(`${base}/index.html#/owner/settings`);
    await page.waitForSelector('#staff-tools input[type=number]');
    const st = page.locator('#staff-tools');
    await st.locator('input[data-key="permission_monthly_limit"]').fill('99');
    await st.getByRole('button', { name: 'حفظ' }).click();
    check(await st.getByText('من 0 إلى 31.').count() === 1 && !state.staffTools?.permission_monthly_limit?.toString().startsWith('99'), `[${scheme}] settings: 99 refused`);
    await st.locator('input[data-key="permission_monthly_limit"]').fill('4');
    await st.locator('.switch', { hasText: 'إظهار الراتب' }).click();
    await st.getByRole('button', { name: 'حفظ' }).click();
    await page.waitForFunction(() => document.querySelector('#staff-tools .save-status')?.textContent);
    check(state.staffTools.permission_monthly_limit === 4 && state.staffTools.staff_pay_visible === true && state.staffTools.annual_leave_days === 21, `[${scheme}] settings saved`);
    check(await noOverflow(page), `[${scheme}] settings: no horizontal overflow`);
    if (shots) await st.screenshot({ path: `${shots}/tools-settings-${scheme}.png` });
    check(errors.length === 0, `[${scheme}] owner: no page/console errors (${errors.join(' | ').slice(0, 200)})`);
    await ctx.close();
  }
}
await browser.close();
console.log(fail ? `\n${fail} staff-tools check(s) FAILED` : '\nAll staff & owner tools UI checks passed');
process.exit(fail ? 1 : 0);
