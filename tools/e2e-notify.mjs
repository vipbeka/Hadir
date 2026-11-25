// Owner live notifications UI against the MOCKED backend (tools/mock-backend.mjs):
// bell + unread badge, list newest first, filters, live row → toast + badge
// (Realtime), click → read + opens the right screen, mark all as read,
// settings card (toggles saved, Telegram status, test, device push, log),
// staff has no bell. Usage: node tools/e2e-notify.mjs [baseUrl] [shotDir]
import { createRequire } from 'node:module';
import { installMock, uiLogin, PEOPLE } from './mock-backend.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
const shots = process.argv[3];
let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const browser = await chromium.launch();
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ ...devices['Pixel 5'], colorScheme: scheme, permissions: ['notifications'] });
  await ctx.addInitScript(() => { localStorage.setItem('zh.lang', 'ar');
    // headless Chromium reports notifications as denied: act like a fresh phone (not asked yet)
    try { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); } catch { /* ignore */ } });
  const state = { pushDevices: 1 };
  await installMock(ctx, state);
  state.notifs.push(
    { id: 3, type: 'request', event: 'early_leave_request', employee_id: PEOPLE.staff.id, title_ar: 'طلب انصراف مبكر', body_ar: 'سارة طلب انصراف مبكر اليوم الساعة 2:00 م، السبب: موعد طبيب\nوقت الطلب: 11:20 ص — الأربعاء 25/11/2026', link: '#/owner/approvals', flags: {}, event_at: ago(5), created_at: ago(5), read_at: null },
    { id: 2, type: 'check_in', event: 'red_point', employee_id: PEOPLE.staff.id, title_ar: 'حضور متأخر', body_ar: 'محمد حضر الساعة 9:24 ص\nالأربعاء 25/11/2026\n⏰ متأخر 24 دقيقة (نقطة حمراء)', link: `#/owner/employee?id=${PEOPLE.staff.id}`, flags: { late_minutes: 24 }, event_at: ago(120), created_at: ago(120), read_at: null },
    { id: 1, type: 'absence', event: 'black_pending', employee_id: PEOPLE.staff.id, title_ar: 'غياب', body_ar: 'علي غاب اليوم\nالأربعاء 25/11/2026', link: '#/owner/approvals', flags: {}, event_at: ago(60 * 26), created_at: ago(60 * 26), read_at: ago(60 * 20) });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await uiLogin(page, base, '87654321');
  await page.waitForFunction(() => location.hash.startsWith('#/owner/dashboard'));
  await page.waitForFunction(() => document.querySelector('.bell__badge')?.textContent === '2', null, { timeout: 5000 }).catch(() => {});
  check(await page.locator('.topbar__bell .bell__badge').textContent() === '2', `[${scheme}] bell shows 2 unread`);

  // live event while on the dashboard → toast + badge
  await page.waitForTimeout(800);   // realtime joined
  state.addNotif({ type: 'check_out', event: 'check_out', title_ar: 'انصراف', body_ar: 'محمد انصرف الساعة 5:02 م\nالأربعاء 25/11/2026', link: `#/owner/employee?id=${PEOPLE.staff.id}` });
  await page.waitForSelector('.toast__body--action', { timeout: 5000 }).catch(() => {});
  check(await page.locator('.toast__title', { hasText: 'انصراف' }).count() === 1, `[${scheme}] live notification → toast`);
  check(await page.locator('.bell__badge').textContent() === '3', `[${scheme}] badge updated live (3) without refresh`);
  await page.locator('.toast__body--action').first().click();
  await page.waitForFunction(() => location.hash.startsWith('#/owner/notifications?id=4'));
  await page.waitForSelector('.notif');
  check(await page.locator('.notif').count() === 4, `[${scheme}] list has 4 notifications`);
  check((await page.locator('.notif__title').first().textContent()) === 'انصراف', `[${scheme}] newest first`);
  await page.waitForTimeout(300);
  check(!!state.notifs.find((r) => r.id === 4).read_at && (await page.locator('.bell__badge').textContent()) === '2', `[${scheme}] opened from the toast → marked read`);
  check(/الساعة 5:02 م/.test(await page.locator('.notif__body').first().textContent()), `[${scheme}] Arabic text with Cairo 12h time`);
  check(/قبل|منذ|الآن/.test(await page.locator('.notif__time').nth(1).textContent()) && /\d{1,2}:\d{2}/.test(await page.locator('.notif__time').nth(1).textContent()), `[${scheme}] relative + exact time`);
  check(await page.locator('.notif--unread').count() === 2, `[${scheme}] unread highlighted (2)`);
  if (shots) await page.screenshot({ path: `${shots}/notif-list-${scheme}.png` });

  // live row while ON the page → added at the top, no toast
  state.addNotif({ type: 'request', event: 'leave_request', title_ar: 'طلب غياب / إجازة', body_ar: 'علي طلب إجازة (غياب) يوم الخميس 26/11/2026، السبب: سفر', link: '#/owner/approvals' });
  await page.waitForFunction(() => document.querySelectorAll('.notif').length === 5, null, { timeout: 5000 }).catch(() => {});
  check(await page.locator('.notif').count() === 5 && await page.locator('.toast__title', { hasText: 'طلب غياب' }).count() === 0, `[${scheme}] live row added to the open list`);

  // filters
  await page.locator('.notif-filters .segmented__btn', { hasText: 'الطلبات' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.notif').length === 2);
  check(await page.locator('.notif').count() === 2, `[${scheme}] filter «الطلبات» → 2`);
  await page.locator('.notif-filters .segmented__btn', { hasText: 'الكل' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.notif').length === 5);

  // mark all as read
  await page.getByRole('button', { name: 'تحديد الكل كمقروء' }).click();
  await page.waitForFunction(() => document.querySelector('.bell__badge').hidden);
  check(await page.locator('.notif--unread').count() === 0 && state.notifs.every((r) => r.read_at), `[${scheme}] mark all as read → badge cleared`);

  // click a check-in → employee record
  await page.locator('.notif', { hasText: 'حضور متأخر' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/owner/employee?id='));
  check(true, `[${scheme}] check-in notification opens the employee record`);

  // settings card
  await page.goto(`${base}/index.html#/owner/settings`);
  await page.waitForSelector('#owner-alerts .alert-grid');
  check(await page.locator('#owner-alerts .alert-grid input[type=checkbox]').count() === 12, `[${scheme}] 4 types × 3 channels toggles`);
  check(await page.locator('#owner-alerts .alert-grid input:checked').count() === 12, `[${scheme}] all on by default`);
  check(await page.locator('#owner-alerts', { hasText: 'متصل' }).count() === 1, `[${scheme}] Telegram status shown`);
  const off = page.locator('#owner-alerts .alert-grid .switch').nth(3);   // check-out → Telegram
  await off.click();
  await page.locator('#owner-alerts').getByRole('button', { name: 'حفظ' }).click();
  await page.waitForFunction(() => document.querySelector('#owner-alerts .save-status')?.textContent);
  check(state.alertPrefs?.check_out?.telegram === false && state.alertPrefs?.check_in?.telegram === true, `[${scheme}] toggle saved (check-out Telegram off)`);
  await page.locator('#owner-alerts').getByRole('button', { name: 'إرسال إشعار تجريبي' }).click();
  await page.waitForSelector('.toast__title:has-text("تم إرسال الإشعار التجريبي")');
  check(state.notifs[0].type === 'test', `[${scheme}] test notification created`);
  check(await page.locator('#owner-alerts').getByRole('button', { name: 'تفعيل إشعارات الجهاز' }).count() === 1, `[${scheme}] «تفعيل إشعارات الجهاز» button`);
  check(await page.locator('#owner-alerts', { hasText: 'iOS 16.4' }).count() === 1, `[${scheme}] iPhone / Android guidance`);
  await page.locator('#owner-alerts summary').click();
  await page.waitForSelector('.notify-log li');
  check(await page.locator('.notify-log li').count() === 2, `[${scheme}] delivery log lists attempts`);
  if (shots) { await page.locator('#owner-alerts').scrollIntoViewIfNeeded(); await page.locator('#owner-alerts').screenshot({ path: `${shots}/notif-settings-${scheme}.png` }); }
  const m = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check(m, `[${scheme}] no horizontal overflow on the phone`);
  check(errors.length === 0, `[${scheme}] no page/console errors (${errors.join(' | ').slice(0, 200)})`);
  await ctx.close();
}

// Telegram not connected → says so with the steps (never silent)
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => localStorage.setItem('zh.lang', 'ar'));
  const state = { tgChat: false };
  await installMock(ctx, state);
  const page = await ctx.newPage();
  await uiLogin(page, base, '87654321');
  await page.waitForFunction(() => location.hash.startsWith('#/owner'));
  await page.goto(`${base}/index.html#/owner/settings`);
  await page.waitForSelector('#owner-alerts .alert-grid');
  check(await page.locator('#owner-alerts', { hasText: 'غير متصل' }).count() === 1 && await page.locator('#owner-alerts ol li').count() === 4, 'Telegram not connected → status + 4 connection steps');
  await ctx.close();
}
// staff: no bell, no access
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await installMock(ctx);
  const page = await ctx.newPage();
  await uiLogin(page, base, '12345678');
  await page.waitForFunction(() => location.hash.startsWith('#/staff'));
  check(await page.locator('.topbar__bell').count() === 0, 'staff has no notifications bell');
  await page.goto(`${base}/index.html#/owner/notifications`);
  await page.waitForFunction(() => location.hash.startsWith('#/staff'));
  check(true, 'staff opening #/owner/notifications is redirected');
  await ctx.close();
}
await browser.close();
console.log(fail ? `\n${fail} notification check(s) FAILED` : '\nAll notification UI checks passed');
process.exit(fail ? 1 : 0);
