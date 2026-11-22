// Playwright request interception that stands in for the Supabase API
// (Auth, PostgREST, Edge Functions) so UI flows can be exercised where
// the real project isn't reachable. MOCK ONLY — real-backend behaviour
// is verified separately against the hosted project.
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (sub, sid, role) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
  sub, session_id: sid, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
  app_metadata: { role }, email: `${sub}@staff.invalid` })}.sig`;

export const PEOPLE = {
  owner: { id: '00000000-0000-4000-a000-0000000000aa', full_name_ar: 'مالك زينترا', full_name_en: 'Zintra Owner', phone: '+201000000001', role: 'owner', active: true },
  staff: { id: '00000000-0000-4000-a000-0000000000bb', full_name_ar: 'أحمد علي', full_name_en: 'Ahmed Ali', phone: '+201000000002', role: 'staff', active: true },
};
export const CODES = { '12345678': 'staff', '87654321': 'owner', '00000000': 'LOCK' };

export async function installMock(context, state = {}) {
  state.revoked ??= new Set();
  state.employees ??= [
    { ...PEOPLE.owner, code_created_at: '2026-11-22T08:00:00Z', code_last_used_at: '2026-11-22T09:00:00Z', monthly_salary_piastres: null, session_count: 1 },
    { ...PEOPLE.staff, code_created_at: '2026-11-22T08:05:00Z', code_last_used_at: null, monthly_salary_piastres: 800000, session_count: 1 },
  ];
  state.calls ??= [];
  await context.route('https://hppcujuplyjkuaxwmjhk.supabase.co/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const json = (status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const bearer = (req.headers().authorization || '').replace('Bearer ', '');
    const claims = bearer.split('.').length === 3 ? JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()) : {};
    const who = Object.values(PEOPLE).find((p) => p.id === claims.sub);
    const sessionOk = who && !state.revoked.has(claims.session_id);
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    state.calls.push({ path: url.pathname, body });

    if (url.pathname === '/functions/v1/login') {
      const kind = CODES[body.code];
      if (kind === 'LOCK') return json(429, { error: 'locked_out', retry_after_s: 900 });
      if (!kind) return json(401, { error: 'code_not_recognized' });
      const p = PEOPLE[kind]; const sid = `sess-${kind}-${Date.now()}`;
      return json(200, { access_token: fakeJwt(p.id, sid, p.role), refresh_token: `rt-${sid}`, expires_at: Math.floor(Date.now() / 1000) + 3600, role: p.role });
    }
    if (url.pathname === '/auth/v1/user') {
      if (!sessionOk) return json(401, { msg: 'session not found' });
      return json(200, { id: who.id, aud: 'authenticated', role: 'authenticated', email: `${who.id}@staff.invalid`, app_metadata: { role: who.role }, user_metadata: {} });
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/rest/v1/profiles') {
      if (!sessionOk) return json(200, []);
      return json(200, [who]);
    }
    if (url.pathname === '/functions/v1/owner-employees') {
      if (!sessionOk) return json(401, { error: 'unauthorized' });
      if (who.role !== 'owner') return json(403, { error: 'forbidden' });
      switch (body.action) {
        case 'list': return json(200, { employees: state.employees });
        case 'create': {
          const e = { id: `00000000-0000-4000-a000-${String(state.employees.length).padStart(12, '0')}`, full_name_ar: body.full_name_ar, full_name_en: body.full_name_en,
            phone: body.phone || null, role: body.role, active: true, code_created_at: new Date().toISOString(), code_last_used_at: null, monthly_salary_piastres: null, session_count: 0 };
          state.employees.push(e);
          return json(200, { employee: e, code: '40917263' });
        }
        case 'regenerate_code': return json(200, { code: '55512345', sessions_revoked: 1 });
        case 'list_sessions': return json(200, { sessions: [
          { session_id: claims.session_id, created_at: '2026-11-22T08:00:00Z', last_active_at: new Date().toISOString(), user_agent_summary: 'Chrome · Android', approx_ip: '41.0.0.0/24', current: body.employee_id === who.id },
          { session_id: '11111111-1111-4111-8111-111111111111', created_at: '2026-11-21T08:00:00Z', last_active_at: '2026-11-21T12:00:00Z', user_agent_summary: 'Safari · iOS', approx_ip: '41.0.1.0/24', current: false }] });
        case 'revoke_session': case 'revoke_all': return json(200, { revoked: 1 });
        case 'set_salary': { const e = state.employees.find((x) => x.id === body.employee_id); e.monthly_salary_piastres = body.monthly_salary_egp == null ? null : body.monthly_salary_egp * 100; return json(200, { salary: { monthly_salary_piastres: e.monthly_salary_piastres } }); }
        case 'set_active': { const e = state.employees.find((x) => x.id === body.employee_id); e.active = body.active; return json(200, { employee: e }); }
        case 'update': { const e = state.employees.find((x) => x.id === body.employee_id); Object.assign(e, { full_name_ar: body.full_name_ar, full_name_en: body.full_name_en, phone: body.phone || null }); return json(200, { employee: e }); }
        default: return json(400, { error: 'unknown_action' });
      }
    }
    return json(404, { error: 'not_mocked', path: url.pathname });
  });
  return state;
}

/** Sign in through the real UI with a mock code. */
export async function uiLogin(page, base, code) {
  await page.goto(`${base}/index.html#/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name=code]', code);
  await page.click('form button[type=submit]');
}
