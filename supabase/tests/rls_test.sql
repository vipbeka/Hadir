-- =====================================================================
-- RLS / privilege tests. Runs inside ONE transaction and rolls back, so
-- it is safe on the hosted project:  begin; \i rls_test.sql; rollback;
-- (tools/sql-test/run.sh runs it locally; the MCP runner wraps it.)
-- Creates fake auth users + sessions, simulates their JWTs with
-- request.jwt.claims + SET LOCAL ROLE, and asserts what each can see/do.
-- =====================================================================
create function pg_temp.ok(cond boolean, msg text) returns text language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ASSERTION FAILED: %', msg; end if;
  return 'ok: ' || msg;
end $$;
create function pg_temp.as_user(uid uuid, sid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'session_id', sid, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.as_user(uuid, uuid) to anon, authenticated;

-- fixtures (as the migration owner)
insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-000000000001', 'test-owner@staff.invalid'),
  ('00000000-0000-4000-a000-000000000002', 'test-a@staff.invalid'),
  ('00000000-0000-4000-a000-000000000003', 'test-b@staff.invalid');
insert into auth.sessions (id, user_id) values
  ('10000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000001'),
  ('10000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-000000000002'),
  ('10000000-0000-4000-a000-000000000022', '00000000-0000-4000-a000-000000000002'),
  ('10000000-0000-4000-a000-000000000003', '00000000-0000-4000-a000-000000000003');
insert into public.profiles (id, full_name_ar, full_name_en, role) values
  ('00000000-0000-4000-a000-000000000001', 'مالك اختبار', 'Test Owner', 'owner'),
  ('00000000-0000-4000-a000-000000000002', 'موظف أ', 'Test Staff A', 'staff'),
  ('00000000-0000-4000-a000-000000000003', 'موظف ب', 'Test Staff B', 'staff');
insert into public.employee_salaries (employee_id, monthly_salary_piastres) values
  ('00000000-0000-4000-a000-000000000002', 800000), ('00000000-0000-4000-a000-000000000003', 900000);
insert into public.login_codes (profile_id, code_hash) values
  ('00000000-0000-4000-a000-000000000002', '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234');
insert into public.point_events (employee_id, effective_work_date, reward_period, idempotency_key, applied_rule_version, color, delta, source) values
  ('00000000-0000-4000-a000-000000000002', '2026-11-22', '2026-11-01', 'test:a:1', 1, 'green', 1, 'auto_window'),
  ('00000000-0000-4000-a000-000000000003', '2026-11-22', '2026-11-01', 'test:b:1', 1, 'red', 1, 'auto_window'),
  ('00000000-0000-4000-a000-000000000003', '2026-11-22', '2026-11-01', 'test:b:2', 1, 'black', 1, 'auto_absence');
update public.point_events set status = 'pending_approval' where idempotency_key = 'test:b:2';
insert into public.attendance_days (employee_id, work_date, checked_in_at) values
  ('00000000-0000-4000-a000-000000000002', '2026-11-22', now() - interval '2 hours'),
  ('00000000-0000-4000-a000-000000000003', '2026-11-22', now() - interval '2 hours');

-- ------------------------------------------------------ staff A session
select pg_temp.as_user('00000000-0000-4000-a000-000000000002', '10000000-0000-4000-a000-000000000002');
set local role authenticated;
select pg_temp.ok((select count(*) from public.profiles) = 1, 'staff sees only own profile');
select pg_temp.ok((select count(*) from public.point_events) = 1, 'staff sees only own point events');
select pg_temp.ok((select count(*) from public.point_events where employee_id = '00000000-0000-4000-a000-000000000003') = 0, 'staff cannot read another employee''s points');
select pg_temp.ok((select count(*) from public.attendance_days) = 1, 'staff sees only own attendance');
select pg_temp.ok((select count(*) from public.employee_salaries) = 0, 'staff cannot read ANY salary, including own');
select pg_temp.ok((select count(*) from public.settings) = 0, 'staff cannot read settings row (chat id)');
select pg_temp.ok((select count(*) from public.audit_log) = 0, 'staff cannot read audit log');
select pg_temp.ok((select count(*) from public.check_in_windows) > 0, 'staff can read check-in windows');
select pg_temp.ok((select count(*) from public.public_holidays) > 0, 'staff can read holidays');
select pg_temp.ok((public.get_app_config() ->> 'green_reward_threshold')::int = 30, 'staff gets safe app config');
select pg_temp.ok(not (public.get_app_config() ? 'owner_telegram_chat_id'), 'app config omits telegram chat id');
select pg_temp.ok((select green from public.v_point_totals) = 1, 'derived totals view respects RLS');
do $$ begin
  perform 1 from public.login_codes; raise exception 'ASSERTION FAILED: staff read login_codes';
exception when insufficient_privilege then raise notice 'ok: login_codes not readable by staff'; end $$;
do $$ begin
  perform public.svc_list_employees(); raise exception 'ASSERTION FAILED: staff called svc_list_employees';
exception when insufficient_privilege then raise notice 'ok: staff cannot call owner service functions'; end $$;
do $$ begin
  perform public.svc_set_salary('00000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-000000000002', 100);
  raise exception 'ASSERTION FAILED: staff set salary';
exception when insufficient_privilege then raise notice 'ok: staff cannot set salary'; end $$;
do $$ begin
  insert into public.leave_requests (employee_id, type, from_date, to_date) values ('00000000-0000-4000-a000-000000000003', 'personal', '2026-12-01', '2026-12-01');
  raise exception 'ASSERTION FAILED: staff filed leave for someone else';
exception when insufficient_privilege then raise notice 'ok: staff cannot file leave for another employee'; end $$;
do $$ begin
  update public.point_events set delta = 5; -- no UPDATE privilege at all
  raise exception 'ASSERTION FAILED: staff updated points';
exception when insufficient_privilege then raise notice 'ok: staff cannot write point events'; end $$;
do $$ begin
  update public.profiles set role = 'owner' where id = '00000000-0000-4000-a000-000000000002';
  raise exception 'ASSERTION FAILED: staff escalated role';
exception when insufficient_privilege then raise notice 'ok: staff cannot change own role'; end $$;
do $$ begin
  insert into public.leave_requests (employee_id, type, from_date, to_date) values ('00000000-0000-4000-a000-000000000002', 'sick', '2026-12-01', '2026-12-02');
  raise exception 'ASSERTION FAILED: staff bypassed the API with a direct leave insert';
exception when insufficient_privilege then raise notice 'ok: direct REST insert of leave is refused (must go through the validated API)'; end $$;
do $$ begin
  insert into public.early_leave_requests (employee_id, work_date, requested_leave_time) values ('00000000-0000-4000-a000-000000000002', current_date, '15:00');
  raise exception 'ASSERTION FAILED: staff bypassed the API with a direct early-leave insert';
exception when insufficient_privilege then raise notice 'ok: direct REST insert of early leave is refused'; end $$;
reset role;
-- the validated API path (what the Edge Function calls as service role)
select public.svc_request_leave('00000000-0000-4000-a000-000000000002',
  jsonb_build_object('type', 'sick', 'from_date', current_date + 7, 'to_date', current_date + 8));
select pg_temp.as_user('00000000-0000-4000-a000-000000000002', '10000000-0000-4000-a000-000000000002');
set local role authenticated;
select pg_temp.ok((select count(*) from public.leave_requests) = 1, 'staff can file own leave through the API (pending) and read it');
select pg_temp.ok((select status from public.leave_requests) = 'pending', 'new leave is pending');
reset role;

-- ---------------------------------------------------------- owner session
select pg_temp.as_user('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001');
set local role authenticated;
select pg_temp.ok((select count(*) from public.profiles where id::text like '00000000-0000-4000-a000-%') = 3, 'owner sees all profiles');
select pg_temp.ok((select count(*) from public.point_events where idempotency_key like 'test:%') = 3, 'owner sees all point events');
select pg_temp.ok((select count(*) from public.employee_salaries where employee_id::text like '00000000-0000-4000-a000-%') = 2, 'owner reads salaries');
select pg_temp.ok((select count(*) from public.settings) = 1, 'owner reads settings');
select pg_temp.ok((select black from public.v_point_totals where employee_id = '00000000-0000-4000-a000-000000000003') = 0, 'pending black point is not counted');
do $$ begin
  perform 1 from public.login_codes; raise exception 'ASSERTION FAILED: owner browser session read login_codes';
exception when insufficient_privilege then raise notice 'ok: login_codes not readable even by owner session'; end $$;
reset role;

-- ---------------------------------------- revoked session / deactivation
delete from auth.sessions where id = '10000000-0000-4000-a000-000000000002';
select pg_temp.as_user('00000000-0000-4000-a000-000000000002', '10000000-0000-4000-a000-000000000002');
set local role authenticated;
select pg_temp.ok((select count(*) from public.profiles) = 0, 'revoked session sees nothing (immediately, before token expiry)');
reset role;
select pg_temp.as_user('00000000-0000-4000-a000-000000000002', '10000000-0000-4000-a000-000000000022');
set local role authenticated;
select pg_temp.ok((select count(*) from public.profiles) = 1, 'the same employee''s other session keeps working');
reset role;
update public.profiles set active = false where id = '00000000-0000-4000-a000-000000000002';
set local role authenticated;
select pg_temp.ok((select count(*) from public.point_events) = 0, 'deactivated employee sees nothing');
reset role;
select pg_temp.as_user('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000002');
set local role authenticated;
select pg_temp.ok(not private.is_owner(), 'owner uid with a forged/foreign session id is not owner');
reset role;

-- ------------------------------------------------------------ anon
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$ begin
  perform 1 from public.profiles; raise exception 'ASSERTION FAILED: anon read profiles';
exception when insufficient_privilege then raise notice 'ok: anon cannot read profiles'; end $$;
select pg_temp.ok((public.get_server_time() ->> 'timezone') = 'Africa/Cairo', 'anon can read server time');
reset role;
select 'RLS TESTS PASSED' as result;
