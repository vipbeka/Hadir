-- =====================================================================
-- Payroll extras: advances (installments in payroll), overtime (computed
-- at check-out, approved → earning), selfie at check-in, weekly backup,
-- monthly employee reports, dashboard stats, settings, RLS.
-- Temporary employees only; ONE transaction, rolled back.
-- =====================================================================
create function pg_temp.ok(cond boolean, msg text) returns text language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ASSERTION FAILED: %', msg; end if;
  raise notice 'ok: %', msg; return 'ok';
end $$;
create function pg_temp.err(stmt text, code text, msg text) returns text language plpgsql as $$
begin
  execute stmt;
  raise exception 'ASSERTION FAILED: % (no error, expected %)', msg, code;
exception when others then
  if sqlerrm like 'ASSERTION%' then raise; end if;
  if sqlerrm <> 'ZH:' || code then raise exception 'ASSERTION FAILED: % (got %, expected ZH:%)', msg, sqlerrm, code; end if;
  raise notice 'ok: % (%)', msg, sqlerrm; return 'ok';
end $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Africa/Cairo')::date $$;
create function pg_temp.m(n int) returns date language sql as $$ select (date_trunc('month', pg_temp.today()) + make_interval(months => n))::date $$;

insert into auth.users (id, email) values ('00000000-0000-4000-e000-000000000001', 'o@x.invalid'), ('00000000-0000-4000-e000-00000000000a', 'a@x.invalid'),
  ('00000000-0000-4000-e000-00000000000b', 'b@x.invalid');
insert into auth.sessions (id, user_id) values ('20000000-0000-4000-e000-00000000000a', '00000000-0000-4000-e000-00000000000a');
insert into public.profiles (id, full_name_ar, full_name_en, role, created_at) values
  ('00000000-0000-4000-e000-000000000001', 'المالك', 'Owner', 'owner', now() - interval '90 days'),
  ('00000000-0000-4000-e000-00000000000a', 'سامي سلفة', 'Adv A', 'staff', now() - interval '90 days'),
  ('00000000-0000-4000-e000-00000000000b', 'نادر إضافي', 'OT B', 'staff', now() - interval '90 days');
update public.profiles set active = false where role = 'staff' and id::text not like '00000000-0000-4000-e000-%';
insert into public.employee_salaries (employee_id, monthly_salary_piastres) values ('00000000-0000-4000-e000-00000000000a', 800000), ('00000000-0000-4000-e000-00000000000b', 600000);
update public.settings set owner_telegram_chat_id = '123456789', owner_alert_channel = 'telegram', owner_chat_verified_id = null,
  work_start_time = '09:00', work_end_time = '17:00', advances_enabled = true, advance_max_installments = 12,
  overtime_enabled = true, overtime_min_minutes = 30, overtime_rate_piastres = 6000, selfie_required = false;
update public.day_rules set is_work_day = true, check_in_enabled = true, points_enabled = true;
delete from public.public_holidays where holiday_date between pg_temp.today() - 40 and pg_temp.today() + 40;

-- =============================================================== advances
select pg_temp.err($$select public.svc_request_advance('00000000-0000-4000-e000-00000000000a', '{"amount_egp": 1000, "installments": 13}')$$,
  'invalid_installments', 'more installments than allowed');
select pg_temp.err($$select public.svc_request_advance('00000000-0000-4000-e000-00000000000a', '{"amount_egp": 0}')$$, 'invalid_amount', 'zero amount refused');
select public.svc_request_advance('00000000-0000-4000-e000-00000000000a', '{"amount_egp": 1000, "installments": 3, "reason": "ظروف"}');
select pg_temp.err($$select public.svc_request_advance('00000000-0000-4000-e000-00000000000a', '{"amount_egp": 500}')$$, 'already_pending', 'one pending advance at a time');
select pg_temp.ok((select body_ar like 'سامي سلفة طلب سلفة 1,000 ج.م على 3 قسط، السبب: ظروف%' from public.owner_notifications where event = 'advance_request'),
  'owner notified (amount, installments, reason)');
select pg_temp.ok(jsonb_array_length(public.svc_pending('00000000-0000-4000-e000-000000000001', '{}') -> 'advance') = 1, 'advance listed in approvals');
select pg_temp.err($$select public.svc_decide_advance('00000000-0000-4000-e000-00000000000a', jsonb_build_object('id', (select max(id) from public.salary_advances), 'approve', true))$$,
  'forbidden', 'staff cannot approve');
select public.svc_decide_advance('00000000-0000-4000-e000-000000000001', jsonb_build_object('id', (select max(id) from public.salary_advances), 'approve', true));
select pg_temp.ok((select status = 'approved' and start_month = pg_temp.m(0) from public.salary_advances where employee_id = '00000000-0000-4000-e000-00000000000a'),
  'approved, starting this month');
select pg_temp.ok((select (d ->> 'amount_piastres')::bigint = 33333 and (d ->> 'installment')::int = 1
  from jsonb_array_elements(private.pay_entitlement('00000000-0000-4000-e000-00000000000a', pg_temp.m(0)) -> 'deductions') d where d ->> 'kind' = 'advance'),
  'installment 1/3 deducted this month (333.33)');
select pg_temp.ok((select (e ->> 'deductions_piastres')::bigint = 33333 and (e ->> 'net_piastres')::bigint = 800000 - 33333
  from (select private.pay_entitlement('00000000-0000-4000-e000-00000000000a', pg_temp.m(0)) e) x), 'net salary reduced by the installment');
select pg_temp.ok((select sum(amount) = 100000 and max(amount) = 33334 from (select (private.advance_due('00000000-0000-4000-e000-00000000000a', pg_temp.m(k))).amount from generate_series(0, 2) k) x)
  and not exists (select 1 from private.advance_due('00000000-0000-4000-e000-00000000000a', pg_temp.m(3))), 'three installments sum exactly to 1,000 (last takes the remainder), nothing after');
select pg_temp.err($$select public.svc_decide_advance('00000000-0000-4000-e000-000000000001', jsonb_build_object('id', (select max(id) from public.salary_advances), 'approve', false, 'revoke', true))$$,
  'advance_started', 'a started advance cannot be stopped (closed months stay correct)');
select public.svc_create_advance('00000000-0000-4000-e000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-e000-00000000000b',
  'amount_egp', 600, 'installments', 2, 'start_month', pg_temp.m(1), 'reason', 'سلفة مباشرة'));
select pg_temp.ok((select status = 'approved' and start_month = pg_temp.m(1) from public.salary_advances where employee_id = '00000000-0000-4000-e000-00000000000b'),
  'owner records an advance directly (next month)');
select public.svc_decide_advance('00000000-0000-4000-e000-000000000001', jsonb_build_object('id',
  (select id from public.salary_advances where employee_id = '00000000-0000-4000-e000-00000000000b'), 'approve', false, 'revoke', true));
select pg_temp.ok((select status = 'cancelled' from public.salary_advances where employee_id = '00000000-0000-4000-e000-00000000000b'), 'a not-started advance can be stopped');
update public.settings set advances_enabled = false;
select pg_temp.err($$select public.svc_request_advance('00000000-0000-4000-e000-00000000000b', '{"amount_egp": 100}')$$, 'feature_off', 'advances switched off');
update public.settings set advances_enabled = true;

-- =============================================================== overtime
do $$ declare d date := pg_temp.today() - 1; v_att uuid;
begin
  insert into public.attendance_days (employee_id, work_date, checked_in_at, check_in_outcome)
  values ('00000000-0000-4000-e000-00000000000b', d, (d + time '09:00') at time zone 'Africa/Cairo', 'none') returning id into v_att;
  perform public.svc_correct_attendance('00000000-0000-4000-e000-000000000001', jsonb_build_object('attendance_id', v_att,
    'checked_out_at', (d + time '18:30') at time zone 'Africa/Cairo', 'reason', 'تجربة إضافي'));
end $$;
select pg_temp.ok((select minutes = 90 and amount_piastres = 9000 and status = 'pending' from public.overtime_entries where employee_id = '00000000-0000-4000-e000-00000000000b'),
  'check-out 1.5 h after the end time → 90 min overtime pending (60 EGP/h = 90 EGP)');
select pg_temp.ok(jsonb_array_length(public.svc_pending('00000000-0000-4000-e000-000000000001', '{}') -> 'overtime') = 1, 'overtime listed in approvals');
select public.svc_decide_overtime('00000000-0000-4000-e000-000000000001', jsonb_build_object('id',
  (select id from public.overtime_entries where employee_id = '00000000-0000-4000-e000-00000000000b'), 'approve', true, 'minutes', 60));
select pg_temp.ok((select status = 'approved' and minutes = 60 and amount_piastres = 6000 from public.overtime_entries where employee_id = '00000000-0000-4000-e000-00000000000b'),
  'owner approves 60 of the 90 minutes → 60 EGP');
select pg_temp.ok((select (e ->> 'earnings_piastres')::bigint = 6000 and exists (select 1 from jsonb_array_elements(e -> 'earnings') x where x ->> 'kind' = 'overtime')
  from (select private.pay_entitlement('00000000-0000-4000-e000-00000000000b', pg_temp.today() - 1) e) y), 'approved overtime is an earning in payroll');
do $$ declare d date := pg_temp.today() - 2; v_att uuid;
begin
  insert into public.attendance_days (employee_id, work_date, checked_in_at, check_in_outcome)
  values ('00000000-0000-4000-e000-00000000000b', d, (d + time '09:00') at time zone 'Africa/Cairo', 'none') returning id into v_att;
  perform public.svc_correct_attendance('00000000-0000-4000-e000-000000000001', jsonb_build_object('attendance_id', v_att,
    'checked_out_at', (d + time '17:20') at time zone 'Africa/Cairo', 'reason', 'تجربة'));
end $$;
select pg_temp.ok((select count(*) = 1 from public.overtime_entries where employee_id = '00000000-0000-4000-e000-00000000000b'), '20 min after the end (< 30) → no overtime');
-- a personal day off: every worked minute counts
do $$ declare d date := pg_temp.today() - 3; v_att uuid;
begin
  insert into public.employee_schedules (employee_id, day_of_week, is_work_day) values ('00000000-0000-4000-e000-00000000000b', extract(dow from d), false);
  insert into public.attendance_days (employee_id, work_date, checked_in_at, check_in_outcome)
  values ('00000000-0000-4000-e000-00000000000b', d, (d + time '10:00') at time zone 'Africa/Cairo', 'none') returning id into v_att;
  perform public.svc_correct_attendance('00000000-0000-4000-e000-000000000001', jsonb_build_object('attendance_id', v_att,
    'checked_out_at', (d + time '14:00') at time zone 'Africa/Cairo', 'reason', 'يوم راحة'));
end $$;
select pg_temp.ok((select minutes = 240 from public.overtime_entries where employee_id = '00000000-0000-4000-e000-00000000000b' and work_date = pg_temp.today() - 3),
  'work on a personal day off → all 4 h are overtime');
update public.settings set overtime_enabled = false;
do $$ declare d date := pg_temp.today() - 4; v_att uuid;
begin
  insert into public.attendance_days (employee_id, work_date, checked_in_at, check_in_outcome)
  values ('00000000-0000-4000-e000-00000000000a', d, (d + time '09:00') at time zone 'Africa/Cairo', 'none') returning id into v_att;
  perform public.svc_correct_attendance('00000000-0000-4000-e000-000000000001', jsonb_build_object('attendance_id', v_att,
    'checked_out_at', (d + time '20:00') at time zone 'Africa/Cairo', 'reason', 'تجربة'));
end $$;
select pg_temp.ok((select count(*) = 0 from public.overtime_entries where employee_id = '00000000-0000-4000-e000-00000000000a'), 'overtime switched off → nothing recorded');

-- =============================================================== selfie
do $$ declare v_dow int := extract(dow from pg_temp.today()); t time := (now() at time zone 'Africa/Cairo')::time;
begin
  delete from public.check_in_windows where day_of_week = v_dow;
  insert into public.check_in_windows (day_of_week, label_ar, label_en, start_time, end_time, awards_green_point, awards_red_point)
  values (v_dow, 'الآن', 'Now', t - interval '20 minutes', t + interval '20 minutes', true, false);
  delete from public.employee_schedules;
end $$;
update public.settings set selfie_required = true;
select pg_temp.ok((public.svc_my_day('00000000-0000-4000-e000-00000000000a', '{}') ->> 'selfie_required')::boolean, 'my day tells the app a selfie is needed');
select pg_temp.err($$select public.svc_check_in('00000000-0000-4000-e000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}')$$,
  'selfie_required', 'no photo → refused');
select pg_temp.err($$select public.svc_check_in('00000000-0000-4000-e000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8,"selfie_path":"00000000-0000-4000-e000-00000000000b/x.jpg"}')$$,
  'selfie_required', 'someone else''s photo → refused');
select public.svc_check_in('00000000-0000-4000-e000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8,"selfie_path":"00000000-0000-4000-e000-00000000000a/2026-11-28-ab12.jpg"}');
select pg_temp.ok((select selfie_path = '00000000-0000-4000-e000-00000000000a/2026-11-28-ab12.jpg' from public.attendance_days
  where employee_id = '00000000-0000-4000-e000-00000000000a' and work_date = pg_temp.today()), 'check-in with own photo saved with the path');
select pg_temp.ok((select (e ->> 'today')::jsonb ->> 'selfie_path' is not null and (d ->> 'selfie_required')::boolean
  from (select public.svc_owner_dashboard('00000000-0000-4000-e000-000000000001', '{}') d) x, jsonb_array_elements(d -> 'employees') e
  where e ->> 'id' = '00000000-0000-4000-e000-00000000000a'), 'dashboard shows the selfie and the switch state');
update public.settings set selfie_required = false;

-- =============================================================== backup
select pg_temp.ok((select b ? 'employees' and b ? 'attendance_days' and b ? 'salary_advances' and b ? 'overtime_entries'
  and not (b -> 'settings' ? 'owner_telegram_chat_id') and jsonb_array_length(b -> 'employees') >= 3
  and not exists (select 1 from jsonb_array_elements(b -> 'reward_requests') r where r ? 'payout_number')
  from (select public.svc_backup_data() b) x), 'backup has every record, without the Telegram chat id or payout numbers');
select pg_temp.err($$select public.svc_backup_export('00000000-0000-4000-e000-00000000000a', '{}')$$, 'forbidden', 'staff cannot download a backup');
select private.run_backup(pg_temp.today());
select pg_temp.ok((select status = 'skipped' from public.job_runs where job_name = 'backup' and run_key = pg_temp.today()::text)
  and not exists (select 1 from public.notification_outbox where event_type = 'owner_backup'), 'unverified owner chat → backup not sent (recorded as skipped)');
delete from public.job_runs where job_name = 'backup';
update public.settings set owner_chat_verified_id = '123456789';
select private.run_backup(pg_temp.today()); select private.run_backup(pg_temp.today());
select pg_temp.ok((select count(*) = 1 from public.notification_outbox where event_type = 'owner_backup' and recipient = '123456789'),
  'backup queued once to the verified private chat');

-- =============================================================== monthly employee reports
select private.run_employee_month_reports(pg_temp.m(0));
select pg_temp.ok((select count(*) >= 2 from private.owner_reports where kind = 'employee_month'), 'one report per employee');
select pg_temp.ok((select array_to_string(parts, ' ') like '%تقرير شهر%سامي سلفة%الحضور%الخصومات%قسط سلفة%الصافي%' from private.owner_reports
  where kind = 'employee_month' and meta ->> 'employee_id' = '00000000-0000-4000-e000-00000000000a'), 'report text: attendance, deductions (advance), net');
select pg_temp.ok((select array_to_string(parts, ' ') like '%ساعات إضافية معتمدة: 1 س 0 د%' from private.owner_reports
  where kind = 'employee_month' and meta ->> 'employee_id' = '00000000-0000-4000-e000-00000000000b'), 'report shows approved overtime');

-- =============================================================== stats + settings
select pg_temp.ok((select jsonb_typeof(s -> 'days') = 'array' and jsonb_array_length(s -> 'absence_by_weekday') = 7
  and exists (select 1 from jsonb_array_elements(s -> 'employees') e where e ->> 'name_ar' = 'نادر إضافي')
  from (select public.svc_dashboard_stats('00000000-0000-4000-e000-000000000001', '{}') s) x), 'dashboard stats: days, employees, absence by weekday');
select pg_temp.err($$select public.svc_dashboard_stats('00000000-0000-4000-e000-00000000000a', '{}')$$, 'forbidden', 'staff cannot read stats');
select pg_temp.err($$select public.svc_save_staff_tools('00000000-0000-4000-e000-000000000001', '{"backup_dow": 9}')$$, 'invalid_value', 'invalid backup day refused');
select pg_temp.ok((public.svc_save_staff_tools('00000000-0000-4000-e000-000000000001', '{"overtime_rate_egp": 75.5, "selfie_required": true, "backup_time": "20:30"}')
  ->> 'overtime_rate_piastres')::bigint = 7550, 'settings saved (rate in EGP → piastres)');
select pg_temp.ok((select selfie_required and backup_time = '20:30' from public.settings where id), 'switches stored');

-- =============================================================== RLS
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-e000-00000000000a","role":"authenticated","session_id":"20000000-0000-4000-e000-00000000000a"}';
select pg_temp.ok((select count(*) = 1 from public.salary_advances) and (select count(*) = 0 from public.overtime_entries), 'staff reads only their own advances / overtime');
do $$ begin
  insert into public.salary_advances (employee_id, amount_piastres, installments, status, start_month)
  values ('00000000-0000-4000-e000-00000000000a', 100, 1, 'approved', date_trunc('month', now())::date);
  raise exception 'ASSERTION FAILED: staff wrote an advance';
exception when insufficient_privilege then raise notice 'ok: staff cannot write advances directly'; end $$;
reset role;
select 'PAYROLL EXTRAS TESTS PASSED';
