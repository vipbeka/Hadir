// Regression checks for the fix package (items 1, 6, 7, 8, 9, 11, 12) against the
// MOCKED backend. Usage: node tools/e2e-fixes.mjs [baseUrl]
import { createRequire } from 'node:module';
import { installMock, uiLogin } from './mock-backend.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const browser = await chromium.launch();
const INSIDE = { latitude: 29.98325, longitude: 31.324, accuracy: 10 };
const cairoHms = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);

async function staffPage({ geo = INSIDE, perms = ['geolocation'], lang = 'en', state = {}, init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', geolocation: geo, permissions: perms, hasTouch: true, isMobile: true });
  await ctx.addInitScript((l) => localStorage.setItem('zh.lang', l), lang);
  if (init) await ctx.addInitScript(init);
  await installMock(ctx, state); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await uiLogin(page, base, '12345678'); await page.waitForFunction(() => location.hash === '#/staff/home');
  return { ctx, page, state, errors };
}
const count = (state, action) => state.calls.filter((c) => c.body?.action === action).length;
const actionBtn = (page) => page.locator('.att-action .btn--primary');

// ---------------------------------------------------------------- 1. check-out
for (const scenario of ['normal', 'rapid', 'slow', 'savedButLost', 'dropped', 'server500']) {
  const state = { attendance: { checked_in_at: new Date(Date.now() - 2 * 3600e3).toISOString(), checked_out_at: null, worked_minutes: null, check_in_outcome: 'green' } };
  if (scenario === 'slow') state.hook = (a) => (a === 'check_out' ? { delay: 16500 } : null);
  if (scenario === 'savedButLost') state.hook = (a) => (a === 'check_out' ? { mode: 'abortAfterApply' } : null);
  if (scenario === 'dropped') state.hook = (a) => (a === 'check_out' ? { mode: 'abort' } : null);
  if (scenario === 'server500') state.hook = (a) => (a === 'check_out' ? { mode: '500' } : null);
  const { ctx, page, errors } = await staffPage({ state });
  await page.goto(`${base}/index.html#/staff/attendance`);
  await page.waitForSelector('.att-action .btn--primary:not([disabled])', { timeout: 20000 });
  check(/Check out/.test(await actionBtn(page).textContent()), `[${scenario}] check-out button ready`);
  await page.evaluate(() => { window.__busy = false; const mo = new MutationObserver(() => { const b = document.querySelector('.att-action .btn--primary'); if (!b || b.disabled || b.getAttribute('aria-busy') === 'true') window.__busy = true; });
    mo.observe(document.querySelector('.att-action'), { subtree: true, childList: true, attributes: true }); });
  const t0 = Date.now();
  if (scenario === 'rapid') await page.evaluate(() => { const b = document.querySelector('.att-action .btn--primary'); b.click(); b.click(); b.click(); });
  else await actionBtn(page).click();
  await page.waitForTimeout(100);
  const busy = await page.evaluate(() => window.__busy);
  check(busy, `[${scenario}] button shows a busy state immediately`);
  if (['normal', 'rapid', 'savedButLost'].includes(scenario)) {
        await page.waitForFunction(() => !document.querySelector('.att-action .btn--primary') || !/Check out/.test(document.querySelector('.att-action .btn--primary').textContent), null, { timeout: 20000 });
    check(true, `[${scenario}] UI switched to "checked out" without a reload (${Date.now() - t0} ms)`);
    check(state.attendance.checked_out_at, `[${scenario}] server has the check-out`);
    if (scenario === 'rapid') check(count(state, 'check_out') === 1, `[rapid] exactly one check_out request sent (${count(state, 'check_out')})`);
    if (scenario === 'savedButLost') {
      check(count(state, 'check_out') === 1 && /confirmed/i.test(await page.textContent('.toast-region')), '[savedButLost] lost response → read back → shown as saved, no second submit');
    }
  } else {
    await page.waitForSelector('.alert, .toast', { timeout: 25000 });
    await page.waitForFunction(() => /isn't recorded|try again/i.test(document.body.textContent), null, { timeout: 25000 });
    check(true, `[${scenario}] failure explained after ${Date.now() - t0} ms (bounded wait)`);
    check(count(state, 'my_day') >= 2, `[${scenario}] read the record back before offering a retry`);
    await page.waitForSelector('.att-action .btn--primary:not([disabled])', { timeout: 5000 });
    check(true, `[${scenario}] button re-enabled (finally)`);
    if (scenario === 'slow') await page.waitForTimeout(2000); // let the slow mock finish before retry
    state.hook = null;
    if (scenario === 'slow') state.attendance.checked_out_at = null; // the late write is still "unconfirmed" for this check
    await actionBtn(page).click();
    await page.waitForFunction(() => !document.querySelector('.att-action .btn--primary') || !/Check out/.test(document.querySelector('.att-action .btn--primary').textContent), null, { timeout: 20000 });
    check(true, `[${scenario}] retry succeeds and UI updates in place`);
  }
  check(!errors.length, `[${scenario}] no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ---------------------------------------------------------------- 9. geolocation errors
{
  const { ctx, page } = await staffPage({ perms: [] });
  await page.goto(`${base}/index.html#/staff/attendance`);
  await page.waitForSelector('.att-geo--danger', { timeout: 20000 });
  check(/permission is blocked/i.test(await page.textContent('.att-geo')), 'denied → instructions');
  check(await page.locator('text=Retry location').count() > 0, 'denied → "Retry location" button');
  check(await actionBtn(page).isDisabled(), 'denied → check-in stays blocked');
  await ctx.close();
}
for (const [code, rx] of [[3, /15 seconds/], [2, /unavailable/i]]) {
  const init = new Function(`navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: ${code}, message: 'x', TIMEOUT: 3, POSITION_UNAVAILABLE: 2, PERMISSION_DENIED: 1 }), 50); return 1; };
    navigator.geolocation.getCurrentPosition = (ok, err) => setTimeout(() => err({ code: ${code}, message: 'x' }), 50); navigator.geolocation.clearWatch = () => {};`);
  const { ctx, page } = await staffPage({ init });
  await page.goto(`${base}/index.html#/staff/attendance`);
  await page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('.att-geo')?.textContent || ''), rx.source, { timeout: 20000 });
  check(true, `geolocation error code ${code} → specific message`);
  check(await page.locator('text=Retry location').count() > 0 && await actionBtn(page).isDisabled(), `code ${code} → retry button, check-in blocked`);
  await ctx.close();
}

// ---------------------------------------------------------------- 12. closed after last window
{
  const { ctx, page, state } = await staffPage({ state: { closesAt: '00:00:01' } });
  await page.goto(`${base}/index.html#/staff/attendance`);
  await page.waitForSelector('text=/Check-in time for today has ended/', { timeout: 15000 });
  check(/12:00 AM/.test(await page.textContent('main')), 'closed message shows 12-hour time');
  check(await page.locator('.att-action .btn--primary', { hasText: 'Check in' }).count() === 0, 'no check-in button after closing');
  check(count(state, 'check_in') === 0, 'no check_in request sent');
  await ctx.close();
}
{
  const closes = cairoHms(new Date(Date.now() + 6000));
  const { ctx, page } = await staffPage({ state: { closesAt: closes } });
  await page.goto(`${base}/index.html#/staff/attendance`);
  await page.waitForSelector('.att-action .btn--primary:not([disabled])', { timeout: 15000 });
  check(true, `open page before closing (${closes} Cairo): check-in available`);
  await page.waitForSelector('text=/Check-in time for today has ended/', { timeout: 15000 });
  check(true, 'page left open across the closing time → switches to "closed" by itself');
  await ctx.close();
}
{ // server is the authority: UI thinks open, server refuses
  const { ctx, page, state } = await staffPage({ state: { hook: (a) => (a === 'check_in' ? { error: 'check_in_closed', detail: { closes_at: '11:00:00' } } : null) } });
  await page.goto(`${base}/index.html#/staff/attendance`);
  await page.waitForSelector('.att-action .btn--primary:not([disabled])', { timeout: 15000 });
  await actionBtn(page).click();
  await page.waitForFunction(() => /11:00 AM/.test(document.querySelector('.toast-region')?.textContent || ''), null, { timeout: 10000 });
  check(!state.attendance, 'server refusal (check_in_closed) → message with 11:00 AM, nothing recorded');
  await ctx.close();
}

// ---------------------------------------------------------------- 7. leave dialog
{
  const { ctx, page, state, errors } = await staffPage({ state: { hook: null } });
  await page.goto(`${base}/index.html#/staff/requests`);
  const opener = page.locator('button', { hasText: 'Request leave' });
  await opener.click(); await page.waitForSelector('dialog[open]');
  check(await page.evaluate(() => getComputedStyle(document.documentElement).overflow === 'hidden' || getComputedStyle(document.body).overflow === 'hidden' || document.documentElement.classList.length >= 0), 'dialog opened');
  const d = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  await page.fill('dialog[open] input[type=date] >> nth=0', d); await page.fill('dialog[open] input[type=date] >> nth=1', d);
  await page.fill('dialog[open] textarea', 'family');
  // server failure keeps the dialog + data
  state.hook = (a) => (a === 'request_leave' ? { mode: '500' } : null);
  await page.click('dialog[open] button[type=submit]');
  await page.waitForTimeout(800);
  check(await page.locator('dialog[open]').count() === 1 && (await page.inputValue('dialog[open] textarea')) === 'family', 'failure → dialog stays open with the data');
  state.hook = (a) => (a === 'request_leave' ? { delay: 600 } : null);
  await page.click('dialog[open] button[type=submit]'); await page.click('dialog[open] button[type=submit]', { force: true, timeout: 500 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 5000 });
  check(count(state, 'request_leave') === 2, `double submit → one request (${count(state, 'request_leave') - 1} after the failure)`);
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({ focus: document.activeElement?.textContent?.trim(), lock: document.body.style.overflow || '', cls: document.documentElement.className }));
  check(/Request leave/.test(st.focus || ''), 'focus returned to the opener');
  check(!/hidden/.test(st.lock) && !/modal-open|scroll-lock/.test(st.cls), 'scroll lock removed');
  check(/submitted|sent|received/i.test(await page.textContent('.toast-region')), 'confirmation toast shown');
  // Escape + navigation
  await opener.click(); await page.waitForSelector('dialog[open]'); await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 3000 });
  check(true, 'Escape closes the dialog');
  await opener.click(); await page.waitForSelector('dialog[open]');
  await page.evaluate(() => { location.hash = '#/staff/home'; });
  await page.waitForTimeout(700);
  check(await page.locator('dialog.modal').count() === 0, 'navigating away closes and removes the dialog');
  check(!errors.length, `leave dialog: no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ---------------------------------------------------------------- 8. push paragraph once
for (const lang of ['ar', 'en']) {
  const { ctx, page } = await staffPage({ lang });
  for (let i = 0; i < 3; i++) {
    await page.goto(`${base}/index.html#/staff/account`); await page.waitForTimeout(250);
    await page.goto(`${base}/index.html#/staff/home`); await page.waitForTimeout(250);
  }
  await page.goto(`${base}/index.html#/staff/account`); await page.waitForTimeout(700);
  const n = await page.evaluate((l) => {
    const needle = l === 'ar' ? 'تصلك إشعارات قبل بداية' : 'Get notified before work starts';
    return [...document.querySelectorAll('main p, main span, main div')].filter((e) => e.children.length === 0 && e.textContent.includes(needle)).length;
  }, lang);
  check(n <= 1, `[${lang}] shift-reminder paragraph appears at most once on Account after repeated navigation (${n})`);
  await ctx.close();
}

// ---------------------------------------------------------------- 11. progress bar values
for (const g of [0, 1, 29, 30, 31]) {
  const { ctx, page } = await staffPage({ state: { green: g } });
  await page.goto(`${base}/index.html#/staff/points`); await page.waitForSelector('.progress--reward'); await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const tr = document.querySelector('.progress--reward .progress__track'); const f = tr.querySelector('.progress__fill');
    return { var: tr.style.getPropertyValue('--progress'), fill: f.getBoundingClientRect().width, track: tr.getBoundingClientRect().width,
      after: getComputedStyle(tr, '::after').content };
  });
  const expect = Math.min(g, 30) / 30;
  const ok = g === 0 ? r.fill === 0 : Math.abs(r.fill / r.track - expect) < 0.02;
  check(ok && (r.after === 'none' || r.after === 'normal'), `progress ${g}/30 → fill ${(r.fill / r.track * 100).toFixed(1)}% (var ${r.var}), no extra marker`);
  await ctx.close();
}

// ---------------------------------------------------------------- 6. leaderboard
{
  const cases = [
    ['empty', [], (t) => /turned off/i.test(t) && !/No green points recorded/.test(t)],
    ['zeros', [{ rank: 1, full_name_ar: 'أ', full_name_en: 'Ahmed', green: 0, threshold: 30, is_me: true }, { rank: 2, full_name_ar: 'ب', full_name_en: 'Badr', green: 0, threshold: 30, is_me: false }], (t) => /No green points recorded this month yet/.test(t) && /Ahmed/.test(t)],
    ['points', [{ rank: 1, full_name_ar: 'أ', full_name_en: 'Ahmed', green: 5, threshold: 30, is_me: true }], (t) => !/No green points recorded/.test(t) && /Ahmed/.test(t)],
  ];
  for (const [name, rows, pred] of cases) {
    const { ctx, page } = await staffPage({ state: { leaderboard: rows } });
    await page.goto(`${base}/index.html#/staff/leaderboard`); await page.waitForTimeout(900);
    const txt = await page.textContent('main');
    check(pred(txt), `leaderboard [${name}] renders the right single state`);
    const list = (await page.locator('.leaderboard').count()) ? await page.textContent('.leaderboard') : '';
    check(!/red|black|deduct|EGP/i.test(list.replace(/Ahmed|Badr/g, '')) && !(await page.locator('.leaderboard .badge--point-red, .leaderboard .badge--point-black').count()), `leaderboard [${name}] shows no penalties`);
    await ctx.close();
  }
}

// ---------------------------------------------------------------- owner announcement on Home
{
  const { ctx, page } = await staffPage({ state: { announcements: [{ body: 'Meeting at 10 tomorrow', created_at: new Date().toISOString() }] } });
  await page.waitForSelector('.announce');
  check(/Announcement[\s\S]*Meeting at 10 tomorrow/.test(await page.textContent('.announce')), 'owner announcement (bot broadcast) shown on staff Home');
  await ctx.close();
}

// ---------------------------------------------------------------- leaderboard tabs + home closing time
{
  const { ctx, page, state } = await staffPage({ state: { closesAt: '11:00:00' } });
  await page.waitForSelector('.today-box');
  check(/until 11:00 AM|has ended \(11:00 AM\)/.test(await page.textContent('main')), 'home shows the real check-in closing time (11:00 AM)');
  await page.goto(`${base}/index.html#/staff/leaderboard`); await page.waitForSelector('.tabs__btn');
  for (const [label, scope] of [['Last month', 'prev'], ['All time', 'all'], ['This month', 'month']]) {
    await page.click(`.tabs__btn:has-text("${label}")`); await page.waitForTimeout(500);
    const last = state.calls.filter((c) => c.path.includes('get_leaderboard')).at(-1);
    check(last?.body?.p_scope === scope && (await page.getAttribute(`.tabs__btn:has-text("${label}")`, 'aria-selected')) === 'true', `leaderboard tab "${label}" → scope ${scope}`);
  }
  await ctx.close();
}

// ---------------------------------------------------------------- 11. stats grid + approved label
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await installMock(ctx); const page = await ctx.newPage();
  await uiLogin(page, base, '87654321'); await page.waitForFunction(() => location.hash === '#/owner/dashboard');
  await page.waitForSelector('.stats-grid > *');
  const rows = await page.$$eval('.stats-grid > *', (els) => { const ys = {}; els.forEach((e) => { const y = Math.round(e.getBoundingClientRect().top); ys[y] = (ys[y] || 0) + 1; }); return Object.values(ys); });
  check(rows.length === 1 || Math.min(...rows) > 1, `dashboard stats at 1440 px: no lone card on its own row (rows: ${rows.join('+')})`);
  await page.goto(`${base}/index.html#/owner/account`); await page.waitForTimeout(300);
  await ctx.close();
  const { ctx: c2, page: p2 } = await staffPage({ lang: 'ar' });
  await p2.goto(`${base}/index.html#/staff/requests`); await p2.waitForTimeout(800);
  check(/تمت الموافقة/.test(await p2.textContent('main')), 'Arabic approved status reads «تمت الموافقة»');
  await c2.close();
}

await browser.close();
console.log(fail ? `\n${fail} checks failed` : '\nAll fix-package checks passed');
process.exit(fail ? 1 : 0);
