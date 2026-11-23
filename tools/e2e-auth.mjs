// Step 2 UI flow checks against the MOCKED backend (tools/mock-backend.mjs).
import { createRequire } from 'node:module';
import { installMock, uiLogin } from './mock-backend.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8787';
let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const browser = await chromium.launch();

// ---- staff flow
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const state = await installMock(ctx);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await uiLogin(page, base, '99999999');
  await page.waitForSelector('.field__error:not([hidden])');
  const generic = await page.textContent('.field__error');
  check(/لم يتم التعرف|not recognized/i.test(generic), 'wrong code → generic message');
  check(await page.inputValue('input[name=code]') === '', 'code field cleared after failure');
  await uiLogin(page, base, '00000000');
  await page.waitForSelector('.field__error:not([hidden])');
  check(/15/.test(await page.textContent('.field__error')), 'lockout → "try again in 15 minutes" message');
  await uiLogin(page, base, '12345678');
  await page.waitForFunction(() => location.hash === '#/staff/home');
  check(true, 'staff code → lands on /staff/home');
  check(await page.locator('a[href^="#/owner"]').count() === 0, 'staff shell has no owner links');
  check(await page.locator('text=/موظف\\/مالك|role switch/i').count() === 0, 'no role-switch control rendered');
  await page.goto(`${base}/index.html#/owner/employees`); await page.waitForTimeout(300);
  check(await page.evaluate(() => location.hash) === '#/staff/home', 'staff hitting /owner/employees is redirected to /staff/home');
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(300);
  check(await page.evaluate(() => location.hash.startsWith('#/staff/')), 'reload keeps the session (no code prompt)');
  const ls = await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
  check(!ls.includes('12345678'), 'code never stored in local/session storage');
  await page.goto(`${base}/index.html#/staff/account`); await page.waitForTimeout(300);
  const acct = await page.textContent('main');
  check(!/salary|راتب|8,000|8000/i.test(acct), 'staff account screen has no salary');
  // staff calling the owner function directly is refused (mock mirrors server rule)
  const status = await page.evaluate(async () => {
    const tok = JSON.parse(localStorage.getItem('zh.auth')).access_token;
    const r = await fetch('https://hppcujuplyjkuaxwmjhk.supabase.co/functions/v1/owner-employees', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{"action":"list"}' });
    return r.status;
  });
  check(status === 403, 'staff token → owner function 403 (mock)');
  // server-side revocation → next focus check returns to login
  const sid = await page.evaluate(() => JSON.parse(atob(JSON.parse(localStorage.getItem('zh.auth')).access_token.split('.')[1])).session_id);
  state.revoked.add(sid);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(500);
  check(await page.evaluate(() => location.hash) === '#/login', 'revoked session → back to login');
  check(/انتهت جلستك|session ended/i.test(await page.textContent('body')), 'calm "session ended" notice shown');
  check(errors.filter((e) => !/401|403|429|Failed to load resource/.test(e)).length === 0, `no unexpected console errors (${errors.join(' | ')})`);
  await ctx.close();
}

// ---- owner flow
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem('zh.lang', 'en'));
  const state = await installMock(ctx);
  const page = await ctx.newPage();
  await uiLogin(page, base, '87654321');
  await page.waitForFunction(() => location.hash === '#/owner/dashboard');
  check(true, 'owner code → lands on /owner/dashboard');
  await page.goto(`${base}/index.html#/staff/home`); await page.waitForTimeout(300);
  check(await page.evaluate(() => location.hash) === '#/owner/dashboard', 'owner hitting /staff/* is redirected to own console');
  await page.goto(`${base}/index.html#/owner/employees`);
  await page.waitForSelector('table');
  check(await page.locator('tbody tr').count() === 2, 'employees list renders 2 rows');
  check(/Set on/.test(await page.textContent('tbody')), 'code status shows "Set on <date>", never a code');
  await page.click('text=Add employee');
  await page.fill('input[lang=ar]', 'منى حسن');
  await page.fill('input[lang=en]', 'Mona Hassan');
  await page.fill('input[type=tel]', '+20 100 555 1234');
  await page.click('button[form=add-emp]');
  await page.waitForSelector('.code-reveal');
  check((await page.textContent('.code-reveal')).replace(/\s/g, '') === '40917263', 'new code shown once in dialog');
  check(/will not be shown again/.test(await page.textContent('dialog[open]:has(.code-reveal)')), 'warning "will not be shown again" present');
  await page.click('text=Done, I\'ve handed it over'); await page.waitForTimeout(400);
  check(!(await page.content()).includes('40917263'), 'code gone from the DOM after closing');
  check(!(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + location.href)).includes('40917263'), 'code not in storage or URL');
  check(await page.locator('tbody tr').count() === 3, 'list refreshed with the new employee');
  // manage: sessions + salary
  await page.locator('tbody tr', { hasText: 'Ahmed Ali' }).locator('button', { hasText: 'Edit' }).click();
  await page.waitForSelector('.session-item');
  check(await page.locator('.session-item').count() === 2, 'sessions panel lists devices');
  check(await page.locator('dialog[open]').getByLabel('Monthly salary', { exact: true }).inputValue() === '8000', 'salary shows 8000 EGP for owner');
  await page.locator('dialog[open]').getByLabel('Monthly salary', { exact: true }).fill('12.5');
  await page.click('text=Save salary');
  check(/whole number/.test(await page.textContent('dialog[open]')), 'fractional salary rejected with a clear message');
  await page.locator('dialog[open]').getByLabel('Monthly salary', { exact: true }).fill('9500');
  await page.click('text=Save salary'); await page.waitForTimeout(300);
  check(state.calls.some((c) => c.body.action === 'set_salary' && c.body.monthly_salary_egp === 9500), 'salary saved as whole EGP');
  await ctx.close();
}
await browser.close();
console.log(fail ? `\n${fail} checks failed` : '\nAll mocked auth/employee flow checks passed');
process.exit(fail ? 1 : 0);
