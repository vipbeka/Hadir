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

const today = () => new Date().toISOString().slice(0, 10);
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function mockApi(state, who, action, p) {
  const sid = state.employees.find((e) => e.role === 'staff')?.id;
  switch (action) {
    case 'my_day': return { server_now: state.serverNow ? state.serverNow() : new Date().toISOString(),
      check_in_closes_at: state.closesAt ?? '23:59:59', check_in_closed: !!state.closed, business_date: today(), business_time: '10:15:00', timezone: 'Africa/Cairo',
      is_work_day: true, check_in_enabled: true, points_enabled: true, holiday: null,
      geofence: { lat: 29.9831944, lng: 31.3239444, radius_m: 100 }, work_start_time: '09:00:00', work_end_time: '17:00:00', expected_end_time: '17:00:00',
      windows: [{ label_ar: 'مبكر', label_en: 'Early', start: '07:00:00', end: '08:00:00', green: true }, { label_ar: 'عادي', label_en: 'Normal', start: '09:00:00', end: '10:00:00', green: true }, { label_ar: 'متأخر', label_en: 'Late', start: '10:00:00', end: '11:00:00', green: true }],
      attendance: state.attendance || null, early_leave: state.earlyLeave || null, missing_checkouts: 0 };
    case 'my_summary': return { period: today().slice(0, 8) + '01', threshold: 30, reward_amount_piastres: 10000, payout_methods: ['instapay', 'vodafone_cash'],
      period_totals: { green: state.green ?? 7, red: 1, black: 0 }, lifetime_totals: { green: 21, red: 2, black: 0 }, pending_black: 0, days_present: 14, worked_minutes: 6750, reward_request: state.reward || null };
    case 'check_in': state.attendance = { checked_in_at: new Date().toISOString(), checked_out_at: null, worked_minutes: null, check_in_outcome: 'green' };
      return { outcome: 'green', window_label_ar: 'متأخر', window_label_en: 'Late', checked_in_at: new Date().toISOString(), distance_m: 12, warning_only: null };
    case 'check_out': state.attendance = { ...state.attendance, checked_out_at: new Date().toISOString(), worked_minutes: 125 }; return { checked_out_at: state.attendance.checked_out_at, worked_minutes: 125, distance_m: 12 };
    case 'request_early_leave': state.earlyLeave = { id: 7, requested_leave_time: `${p.leave_time}:00`, status: 'pending' }; return state.earlyLeave;
    case 'cancel_early_leave': state.earlyLeave = null; return { result: 'cancelled' };
    case 'request_leave': return { id: 'x', status: 'pending' };
    case 'request_reward': state.reward = { status: 'pending' }; return state.reward;
    case 'set_reminders': return { reminders_enabled: p.enabled };
    case 'owner_dashboard': return { today: today(), period: today().slice(0, 8) + '01', is_work_day: true, pending: { black: 1, leave: 1, early_leave: 1, reward: 1, missing_checkout: 1 },
      employees: state.employees.filter((e) => e.role === 'staff').map((e) => ({ ...e, green: 7, red: 1, black: 0, pending_black: 1, today: { checked_in_at: new Date().toISOString(), checked_out_at: null, outcome: 'green' } })) };
    case 'pending': return {
      black: [{ id: 'b1', employee_id: sid, name_ar: 'أحمد علي', name_en: 'Ahmed Ali', date: today(), amount_piastres: 100000 }],
      leave: [{ id: 'l1', employee_id: sid, name_ar: 'أحمد علي', name_en: 'Ahmed Ali', type: 'sick', from_date: today(), to_date: today(), status: 'pending', reason: 'flu' }],
      early_leave: [{ id: 7, employee_id: sid, name_ar: 'أحمد علي', name_en: 'Ahmed Ali', work_date: today(), requested_leave_time: '15:00:00', status: 'pending', reason: 'doctor' }],
      reward: [{ id: 'r1', employee_id: sid, name_ar: 'أحمد علي', name_en: 'Ahmed Ali', period_month: today().slice(0, 8) + '01', reward_amount_piastres: 10000, payout_method: 'instapay', payout_number: '01001234567', status: 'pending' }],
      missing_checkout: [{ id: 'a1', name_ar: 'أحمد علي', name_en: 'Ahmed Ali', work_date: today(), checked_in_at: new Date().toISOString() }] };
    case 'decide_black': if (!p.approve || p.confirm_amount_piastres === 100000) return { result: 'decided' }; throw Object.assign(new Error(), { code: 'confirm_amount' });
    case 'payroll': return { month: p.month, generated_at: new Date().toISOString(), timezone: 'Africa/Cairo', rule_version: 1, red_penalty_piastres: 5000, black_penalty_piastres: 100000, reward_amount_piastres: 10000, threshold: 30,
      rows: (state.payrollStaff || state.employees.filter((e) => e.role === 'staff')).map((e) => ({ ...e, worked_minutes: 6750, unresolved_flags: [], incomplete: false, deductions_piastres: 105000, bonuses_earned_piastres: 0, bonuses_paid_piastres: 0, net_adjustment_piastres: -105000,
        points_breakdown: { green_attendance: 7, green_outcome: 1, green_manual: 0, green_total: 8, red_warnings: 1, red_chargeable: 1, red_amount_piastres: 5000, black_approved: 1, black_amount_piastres: 100000, black_pending: 0, black_declined: 0 } })) };
    case 'export_raw': {
      const n = state.rawRows ?? 1;
      const attendance = [{ employee: '=cmd()', work_date: today(), checked_in_at: '2026-11-22T07:12:00Z', checked_out_at: '2026-11-22T14:44:00Z' }];
      for (let i = 1; i < n; i++) attendance.push({ employee: `موظف ${i}`, work_date: today(), checked_in_at: '2026-11-22T07:12:00Z', checked_out_at: '2026-11-22T14:44:00Z' });
      return { attendance, point_events: [{ employee: 'أحمد', color: 'red', reason: '+SUM(1)', created_at: '2026-07-01T12:00:00Z' }], deductions: [] };
    }
    case 'employee_points': return [{ color: 'green', delta: 1, source: 'owner_outcome', outcome_category: 'deal_closed', reason: 'Closed X', status: 'active', effective_work_date: today(), deduction_amount_piastres: 0 }];
    case 'award_outcome': return { event_id: 'e' };
    case 'manual_adjust': return { previous: 1, total: 2, events: [] };
    case 'telegram_status': return null;
    case 'update_settings': if (!state.db) return p; Object.assign(state.db.settings, p, { updated_at: new Date().toISOString() }); return { ...state.db.settings };
    case 'save_day': case 'save_days': {
      const days = p.days || [p];
      if (!state.db) return { days };
      for (const d of days) {
        Object.assign(state.db.day_rules.find((r) => r.day_of_week === d.day_of_week), { is_work_day: d.is_work_day, check_in_enabled: d.check_in_enabled, points_enabled: d.points_enabled });
        state.db.check_in_windows = state.db.check_in_windows.filter((w) => w.day_of_week !== d.day_of_week).concat((d.windows || []).map((w) => ({
          day_of_week: d.day_of_week, label_ar: w.label_ar, label_en: w.label_en, start_time: `${w.start}:00`, end_time: `${w.end}:00`, enabled: w.enabled,
          awards_green_point: !!w.awards_green_point, awards_red_point: !!w.awards_red_point })));
      }
      (state.saves ??= []).push(days);
      return { days };
    }
    case 'broadcast': { const a = { id: `a${Date.now()}${Math.random().toString(16).slice(2, 6)}`, title: p.title || null, body: p.text, created_at: new Date().toISOString() }; state.announcements.unshift(a); return { id: a.id, people: 1, devices: 0 }; }
    case 'list_announcements': return { total: state.announcements.length, rows: [...state.announcements].sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id.localeCompare(x.id)) };
    case 'delete_announcement': { const i = state.announcements.findIndex((a) => a.id === p.id); if (i < 0) return { id: p.id, deleted: false }; state.announcements.splice(i, 1); return { id: p.id, deleted: true }; }
    default: return { result: 'decided' };
  }
}

export async function installMock(context, state = {}) {
  state.revoked ??= new Set();
  state.employees ??= [
    { ...PEOPLE.owner, code_created_at: '2026-11-22T08:00:00Z', code_last_used_at: '2026-11-22T09:00:00Z', monthly_salary_piastres: null, session_count: 1 },
    { ...PEOPLE.staff, code_created_at: '2026-11-22T08:05:00Z', code_last_used_at: null, monthly_salary_piastres: 800000, session_count: 1 },
  ];
  state.calls ??= [];
  await context.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG1 }));
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
    if (url.pathname === '/functions/v1/api') {
      if (!sessionOk) return json(401, { error: 'unauthorized' });
      const ownerOnly = ['owner_dashboard', 'pending', 'decide_black', 'payroll', 'export_raw', 'employee_points', 'award_outcome', 'manual_adjust', 'update_settings', 'save_day', 'save_days', 'save_holiday', 'broadcast', 'list_announcements', 'delete_announcement', 'run_job', 'set_job_title'];
      if (ownerOnly.includes(body.action) && who.role !== 'owner') return json(403, { error: 'forbidden' });
      if (body.action === 'telegram_status') return json(200, { data: { connected: false, token_missing: true } });
      const hook = state.hook?.(body.action);
      if (hook?.delay) await new Promise((r) => setTimeout(r, hook.delay));
      if (hook?.mode === 'abort') return route.abort('internetdisconnected');
      if (hook?.mode === 'abortAfterApply') { mockApi(state, who, body.action, body.params || {}); return route.abort('connectionreset'); }
      if (hook?.mode === '500') return json(500, { error: 'server_error' });
      if (hook?.error) return json(400, { error: hook.error, detail: hook.detail || {} });
      try { return json(200, { data: mockApi(state, who, body.action, body.params || {}) }); }
      catch (e) { return json(400, { error: e.code || 'server_error', detail: { amount_piastres: 100000 } }); }
    }
    if (url.pathname.startsWith('/rest/v1/rpc/get_leaderboard')) {
      if (!sessionOk) return json(401, {});
      if (state.leaderboard) return json(200, state.leaderboard);
      return json(200, state.employees.filter((e) => e.role === 'staff').map((e, i) => ({ rank: i + 1, full_name_ar: e.full_name_ar, full_name_en: e.full_name_en, job_title_ar: 'محاسب', job_title_en: 'Accountant', green: 7 - i, threshold: 30, is_me: e.id === who?.id })));
    }
    const tableData = state.db ??= {
      announcements: state.announcements ?? [],
      point_events: [{ color: 'green', delta: 1, source: 'auto_window', reason: 'check-in 09:12', status: 'active', effective_work_date: today(), deduction_amount_piastres: 0 },
        { color: 'red', delta: 1, source: 'auto_window', reason: 'late', status: 'active', warning_only: true, effective_work_date: today(), deduction_amount_piastres: 0 }],
      leave_requests: [{ id: 'l1', type: 'personal', from_date: today(), to_date: today(), status: 'approved', reason: 'family' }],
      early_leave_requests: [{ id: 7, work_date: today(), requested_leave_time: '15:00:00', status: 'pending' }],
      public_holidays: [{ id: 'h1', holiday_date: '2026-10-06', name_ar: 'عيد القوات المسلحة', name_en: 'Armed Forces Day', kind: 'official', enabled: true },
        { id: 'h2', holiday_date: '2027-01-07', name_ar: 'عيد الميلاد المجيد', name_en: 'Coptic Christmas', kind: 'official', enabled: false }, { id: 'h3', holiday_date: '2027-03-10', name_ar: 'عيد الفطر (اليوم الأول)', name_en: 'Eid al-Fitr (day 1)', kind: 'official', enabled: true, provisional: true }],
      settings: { id: true, rule_version: 3, updated_at: new Date().toISOString(), red_penalty_piastres: 5000, black_penalty_piastres: 100000, green_reward_threshold: 30, reward_amount_piastres: 10000,
        first_red_warning: true, work_start_time: '09:00:00', work_end_time: '17:00:00', absence_cutoff: '11:30:00', geofence_lat: 29.9831944, geofence_lng: 31.3239444, geofence_radius_m: 100,
        owner_telegram_chat_id: '1360140225', owner_alert_channel: 'telegram', digest_enabled: true, digest_time: '12:00:00', weekly_summary_enabled: true, weekly_summary_dow: state.weeklyDow === undefined ? null : state.weeklyDow, weekly_summary_time: '18:00:00',
        shift_reminders_default: true, shift_reminder_lead_min: 15, missed_checkin_reminder_enabled: true, missed_checkin_lead_min: 15, leaderboard_visible: true },
      day_rules: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, is_work_day: d < 5, check_in_enabled: d < 5, points_enabled: d < 5 })),
      check_in_windows: [0, 1, 2, 3, 4].flatMap((d) => [['مبكر', 'Early', '07:00:00', '08:00:00'], ['عادي', 'Normal', '09:00:00', '10:00:00'], ['متأخر', 'Late', '10:00:00', '11:00:00']]
        .map(([a, e, s1, e1]) => ({ day_of_week: d, label_ar: a, label_en: e, start_time: s1, end_time: e1, enabled: true, awards_green_point: a !== 'متأخر', awards_red_point: a === 'متأخر' }))),
    };
    state.announcements = tableData.announcements;
    const tname = url.pathname.replace('/rest/v1/', '');
    if (tableData[tname] !== undefined) {
      if (!sessionOk) return json(200, []);
      if (tname === 'settings' && who.role !== 'owner') return json(406, { message: 'no rows' });
      const single = (req.headers().accept || '').includes('vnd.pgrst.object');
      return json(200, single ? tableData[tname] : (Array.isArray(tableData[tname]) ? tableData[tname] : [tableData[tname]]));
    }
    if (tname === 'push_subscriptions') return json(201, []);
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
