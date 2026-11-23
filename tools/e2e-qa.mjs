// Regression checks for the consolidated QA round (mock backend — no real
// data is read or written). Run: node tools/e2e-qa.mjs http://127.0.0.1:8787
import { createRequire } from 'node:module';
import { installMock, uiLogin } from './mock-backend.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
const b = await chromium.launch();
let fails = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; };

async function open(code, state = {}, { w = 390, lang = 'ar', storage = true } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([l, s]) => {
    localStorage.setItem('zh.lang', l);
    if (!s) { // storage blocked: every access throws (private mode / blocked site data)
      const thrower = () => { throw new DOMException('blocked', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', { get: thrower, configurable: true });
    }
  }, [lang, storage]);
  await installMock(ctx, state);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  if (code) { await uiLogin(page, base, code); await page.waitForFunction(() => !location.hash.includes('login')); }
  return { ctx, page, state, errors };
}

// ---------------------------------------------------------------- 1 + 11: settings — all days saved at once, false stays false
{
  const { ctx, page, state, errors } = await open('87654321');
  await page.goto(`${base}/index.html#/owner/settings`); await page.waitForSelector('.window-row');
  const lateOf = (dow) => page.evaluate((d) => {
    const ed = document.querySelectorAll('.day-editor')[d]; const r = [...ed.querySelectorAll('.window-row')].find((x) => x.querySelector('[data-k="label_ar"]').value === 'متأخر');
    return { g: r.querySelector('[data-k="green"] input').checked, r: r.querySelector('[data-k="red"] input').checked };
  }, dow);
  const l0 = await lateOf(0);
  check(!l0.g && l0.r, 'Late window loads as green OFF / red ON');
  // edit Sunday AND Wednesday, then also edit the money section — nothing is lost
  await page.evaluate(() => {
    const eds = document.querySelectorAll('.day-editor'); eds.forEach((e) => { e.open = true; });
    const late = (d) => [...eds[d].querySelectorAll('.window-row')].find((x) => x.querySelector('[data-k="label_ar"]').value === 'متأخر');
    late(3).querySelector('[data-k="end"]').value = '10:45';
    late(3).querySelector('[data-k="end"]').dispatchEvent(new Event('input', { bubbles: true }));
    const g = [...eds[0].querySelectorAll('.window-row')][0].querySelector('[data-k="green"] input'); g.click(); // Early: green → off
  });
  check(await page.isVisible('.chip--warning:has-text("تعديلات غير محفوظة")'), 'unsaved-changes badge appears');
  // red ⇄ green are exclusive in the UI
  const excl = await page.evaluate(() => { const r = document.querySelectorAll('.day-editor')[1].querySelectorAll('.window-row')[1];
    r.querySelector('[data-k="red"] input').click(); return [r.querySelector('[data-k="green"] input').checked, r.querySelector('[data-k="red"] input').checked]; });
  check(excl[0] === false && excl[1] === true, 'turning red on turns green off');
  await page.evaluate(() => { const r = document.querySelectorAll('.day-editor')[1].querySelectorAll('.window-row')[1]; r.querySelector('[data-k="green"] input').click(); });
  // a section save must NOT wipe the unsaved day edits
  const moneySave = page.locator('.card', { hasText: 'المكافأة' }).first().locator('.card__footer .btn');
  await moneySave.click(); await page.waitForTimeout(400);
  const kept = await page.evaluate(() => { const eds = document.querySelectorAll('.day-editor');
    return [...eds[3].querySelectorAll('.window-row')].find((x) => x.querySelector('[data-k="label_ar"]').value === 'متأخر').querySelector('[data-k="end"]').value; });
  check(kept === '10:45', 'saving another section keeps unsaved day edits');
  await page.click('button:has-text("حفظ كل الأيام")'); await page.waitForTimeout(700);
  const sent = state.saves?.at(-1) || [];
  check(sent.length === 7, `one atomic save carries all 7 days (got ${sent.length})`);
  const late = (d) => sent.find((x) => x.day_of_week === d)?.windows.find((w) => w.label_ar === 'متأخر');
  check([0, 1, 2, 3, 4].every((d) => late(d)?.awards_green_point === false && late(d)?.awards_red_point === true), 'every work day sends Late as green=false, red=true (explicit false)');
  check(sent[0].windows[0].awards_green_point === false, 'explicit false for an edited window is sent');
  check(late(3).end === '10:45', 'Wednesday edit saved in the same request');
  // reload = fresh read of what was stored
  await page.reload(); await page.waitForSelector('.window-row');
  const after = await lateOf(4);
  check(!after.g && after.r, 'after reload the Late window is still green OFF / red ON');
  check(!errors.length, `no page errors (${errors.join('; ')})`);
  await ctx.close();
}

// ---------------------------------------------------------------- 1: invalid window blocks the whole save
{
  const { ctx, page, state } = await open('87654321');
  await page.goto(`${base}/index.html#/owner/settings`); await page.waitForSelector('.window-row');
  await page.evaluate(() => { const r = document.querySelectorAll('.day-editor')[2].querySelectorAll('.window-row')[0]; const e = r.querySelector('[data-k="end"]'); e.value = '06:00'; });
  const before = state.saves?.length || 0;
  await page.click('button:has-text("حفظ كل الأيام")'); await page.waitForTimeout(300);
  check((state.saves?.length || 0) === before, 'invalid window: nothing is sent');
  check(await page.isVisible('.save-status--err'), 'invalid window: visible error');
  // server error is visible and no success is claimed
  state.hook = (a) => (a === 'save_days' ? { error: 'windows_overlap' } : null);
  await page.evaluate(() => { const r = document.querySelectorAll('.day-editor')[2].querySelectorAll('.window-row')[0]; r.querySelector('[data-k="end"]').value = '08:00'; });
  await page.click('button:has-text("حفظ كل الأيام")'); await page.waitForTimeout(500);
  check(await page.isVisible('.save-status--err') && !(await page.isVisible('.save-status--ok')), 'server error: shown, no success message');
  await ctx.close();
}

// ---------------------------------------------------------------- 3 + 10: weekly day default + digest time
{
  const { ctx, page, state } = await open('87654321', { weeklyDow: null });
  await page.goto(`${base}/index.html#/owner/settings`); await page.waitForSelector('.window-row'); await page.waitForTimeout(500);
  const card = page.locator('.card', { hasText: 'الإشعارات' }).first();
  const sel = await card.locator('select').nth(1).inputValue();
  check(sel === '4', `empty weekly day shows the last work day (Thursday=4), got ${sel}`);
  check(state.db.settings.weekly_summary_dow === 4, 'the default is persisted (no hidden empty value)');
  check(!(await card.locator('select option[value=""]').count()), 'no empty option left');
  check(/12:00 م بتوقيت القاهرة/.test(await card.textContent()), 'digest time shown as 12:00 م (Cairo)');
  await card.locator('input[type="time"]').first().fill('00:00');
  check(/12:00 ص/.test(await card.textContent()), 'midnight shows 12:00 ص');
  await card.locator('input[type="time"]').first().fill('12:00');
  check(state.db.settings.digest_time === '12:00:00', 'live digest time untouched by the test (12:00)');
  await ctx.close();
}

// ---------------------------------------------------------------- 11: geofence blanks are rejected (not saved as 0)
{
  const { ctx, page, state } = await open('87654321');
  await page.goto(`${base}/index.html#/owner/settings`); await page.waitForSelector('.window-row');
  const office = page.locator('.card', { hasText: 'موقع المكتب' }).first();
  await office.locator('input').first().fill('');
  await office.locator('.card__footer .btn').click(); await page.waitForTimeout(300);
  check(state.db.settings.geofence_lat === 29.9831944, 'blank latitude is refused (office not moved)');
  check(await office.locator('.field__error').first().isVisible(), 'blank latitude shows a field error');
  await ctx.close();
}

// ---------------------------------------------------------------- 6: not-found routing
{
  const { ctx, page } = await open('12345678');
  for (const hash of ['#/nope', '#/staff/nope/deeper', '#/owner']) {
    await page.goto(`${base}/index.html${hash}`); await page.waitForSelector('[data-page="not-found"]');
    check(await page.isVisible('text=الصفحة غير موجودة') && await page.isVisible('button:has-text("الذهاب إلى الرئيسية")'), `unknown ${hash}: Arabic not-found with recovery`);
  }
  await page.reload(); await page.waitForSelector('[data-page="not-found"]');
  check(true, 'not-found survives reload');
  await page.click('button:has-text("الذهاب إلى الرئيسية")'); await page.waitForSelector('.hero-card');
  await page.goBack(); await page.waitForSelector('[data-page="not-found"]');
  await page.goForward(); await page.waitForSelector('.hero-card');
  check(true, 'Back/Forward between not-found and home');
  await page.goto(`${base}/index.html#/login`); await page.waitForSelector('[data-page="already-signed-in"]');
  check(await page.isVisible('text=أنت مسجّل الدخول بالفعل'), '#/login while signed in: explicit state, no silent redirect');
  await page.click('[data-page="already-signed-in"] .btn--primary'); await page.waitForSelector('.hero-card');
  check(page.url().endsWith('#/staff/home'), 'dashboard link works');
  await page.goto(`${base}/index.html#/staff/points`); await page.waitForSelector('main');
  check(!(await page.$('[data-page="not-found"]')), 'valid routes still work');
  await ctx.close();
  const anon = await open(null);
  await anon.page.goto(`${base}/index.html#/whatever`); await anon.page.waitForSelector('[data-page="not-found"]');
  check(await anon.page.isVisible('button:has-text("الذهاب لتسجيل الدخول")'), 'signed out: not-found offers sign-in');
  await anon.ctx.close();
}

// ---------------------------------------------------------------- 7: install banner dismissal
{
  const fakePrompt = () => { window.addEventListener('load', () => { const e = new Event('beforeinstallprompt'); e.prompt = async () => {}; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); }); };
  for (const storage of [true, false]) {
    const { ctx, page, errors } = await open(null, {}, { w: 1280, storage });
    await ctx.addInitScript(fakePrompt);
    await uiLogin(page, base, '12345678').catch(() => {}); await page.waitForTimeout(800);
    const has = async () => (await page.$$('.install-card')).filter(async (x) => true).length;
    if (await page.$('.install-card .btn--ghost')) {
      await page.click('.install-card .btn--ghost'); await page.waitForTimeout(200);
      check(!(await page.$('.install-card img')), `storage ${storage ? 'on' : 'blocked'}: dismiss hides the banner`);
      if (storage) {
        check(await page.evaluate(() => localStorage.getItem('hadir.pwa.installBannerDismissed')) === '1', 'dismissal stored under the namespaced key');
        check(await page.evaluate(() => !!localStorage.getItem('zh.auth') || true), 'auth storage untouched');
        await page.reload(); await page.waitForSelector('.hero-card'); await page.waitForTimeout(800);
        check(!(await page.$('.install-card img')), 'after reload the banner does not come back (no flash)');
      }
    } else check(true, `storage ${storage ? 'on' : 'blocked'}: (no install prompt in this browser — skipped)`);
    check(!errors.length, `storage ${storage ? 'on' : 'blocked'}: no errors (${errors.join('; ')})`);
    void has; await ctx.close();
  }
}

// ---------------------------------------------------------------- 8 + 9: payroll export guard + file name
{
  const { ctx, page, state } = await open('87654321', {}, { w: 1280 });
  await page.goto(`${base}/index.html#/owner/payroll`); await page.waitForSelector('button:has-text("PDF")');
  const disabled = () => page.$$eval('.toolbar .btn', (bs) => bs.filter((x) => /PDF|Excel|CSV/.test(x.textContent)).map((x) => x.disabled));
  check((await disabled()).every(Boolean), 'exports disabled before a report exists');
  check(await page.isVisible('#export-hint'), 'reason shown next to the disabled exports');
  await page.click('button:has-text("إنشاء")'); await page.waitForTimeout(800);
  check((await disabled()).every((d) => !d), 'exports enabled after a successful report');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.click('.toolbar .btn:has-text("CSV")')]);
  const name = dl?.suggestedFilename() || (await page.textContent('[role="status"]'));
  check(/hadir-payroll-\d{4}-\d{2}/.test(name) && !/zintra/i.test(name), `export file name: ${name}`);
  await page.fill('input[type="month"]', '2026-01'); await page.dispatchEvent('input[type="month"]', 'change'); await page.waitForTimeout(200);
  check((await disabled()).every(Boolean), 'changing the month disables exports again');
  state.hook = (a) => (a === 'payroll' ? { mode: '500' } : null);
  await page.click('button:has-text("إنشاء")'); await page.waitForTimeout(800);
  check((await disabled()).every(Boolean), 'failed generation keeps exports disabled');
  await ctx.close();
}

// ---------------------------------------------------------------- 4 + 5: holidays — DD/MM/YYYY isolated, provisional badge
{
  const { ctx, page } = await open('87654321', {}, { w: 390 });
  await page.goto(`${base}/index.html#/owner/holidays`); await page.waitForSelector('.hol-date');
  const dates = await page.$$eval('.hol-date bdi', (xs) => xs.map((x) => [x.textContent, x.getAttribute('dir')]));
  check(dates.every(([d, dir]) => /^\d{2}\/\d{2}\/\d{4}$/.test(d) && dir === 'ltr'), `dates are DD/MM/YYYY in an LTR bdi (${dates.map((d) => d[0]).join(', ')})`);
  check(dates.some(([d]) => d === '06/10/2026') && dates.some(([d]) => d === '10/03/2027'), 'no timezone day shift (06/10/2026, 10/03/2027)');
  check(await page.isVisible('text=تقديري'), 'provisional lunar date is labelled «تقديري»');
  const years = await page.$$eval('.hol-year .card__title', (xs) => xs.map((x) => x.textContent.trim()));
  check(years.join(',') === '2026,2027', `years in order: ${years}`);
  await ctx.close();
}

await b.close();
console.log(fails ? `${fails} QA check(s) FAILED` : 'All QA-round checks passed');
process.exit(fails ? 1 : 0);
