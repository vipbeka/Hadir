-- =====================================================================
-- Staff & owner tools: permissions (إذن), personal schedules, leave
-- balance, attendance corrections, change log, my pay, statement,
-- daily summary, check-out overdue reminder, points goal, RLS.
-- Temporary employees only; ONE transaction, rolled back.
-- =====================================================================
create function pg_temp.ok(cond boolean, msg text) returns text language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ASSERTION FAILED: %', msg; end if;
  raise notice 'ok: %', msg; return 'ok';
end $$;
-- expect an error code (ZH:<code>) from a statement
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
create function pg_temp.hm(i interval) returns text language sql as $$ select to_char((now() at time zone 'Africa/Cairo') + i, 'HH24:MI') $$;

-- ids: O owner, A permissions, B schedule check-in, C corrections, D leave balance,
--      E permission excuses lateness, F control (no permission), G personal day off, H permission over the cutoff
insert into auth.users (id, email) select ('00000000-0000-4000-d000-00000000000' || x)::uuid, x || '@test.invalid'
  from unnest(array['1', 'a', 'b', 'c', 'd', 'e', 'f']) x;
insert into auth.users (id, email) values ('00000000-0000-4000-d000-000000000010', 'g@test.invalid'), ('00000000-0000-4000-d000-000000000011', 'h@test.invalid');
insert into auth.sessions (id, user_id) values
  ('20000000-0000-4000-d000-00000000000a', '00000000-0000-4000-d000-00000000000a'),
  ('20000000-0000-4000-d000-000000000001', '00000000-0000-4000-d000-000000000001');
insert into public.profiles (id, full_name_ar, full_name_en, role, created_at) values
  ('00000000-0000-4000-d000-000000000001', 'المالك', 'Owner', 'owner', now() - interval '60 days'),
  ('00000000-0000-4000-d000-00000000000a', 'أحمد إذن', 'Perm A', 'staff', now() - interval '60 days'),
  ('00000000-0000-4000-d000-00000000000b', 'بسمة جدول', 'Sched B', 'staff', now() - interval '60 days'),
  ('00000000-0000-4000-d000-00000000000c', 'كريم تصحيح', 'Corr C', 'staff', now() - interval '60 days'),
  ('00000000-0000-4000-d000-00000000000d', 'دينا رصيد', 'Bal D', 'staff', now() - interval '60 days'),
  ('00000000-0000-4000-d000-00000000000e', 'إيهاب متأخر', 'Late E', 'staff', now() - interval '60 days'),
  ('00000000-0000-4000-d000-00000000000f', 'فادي مقارنة', 'Ctrl F', 'staff', now() - interval '60 days'),
  ('00000000-0000-4000-d000-000000000010', 'غادة راحة', 'Off G', 'staff', now() - interval '60 days'),
  ('00000000-0000-4000-d000-000000000011', 'هاني إذن صباحي', 'Perm H', 'staff', now() - interval '60 days');
-- only the test employees are "staff" for the jobs below
update public.profiles set active = false where role = 'staff' and id::text not like '00000000-0000-4000-d000-%';
update public.settings set owner_telegram_chat_id = '123456789', owner_alert_channel = 'telegram',
  work_start_time = '00:00', work_end_time = '23:59:59', permission_monthly_limit = 2, permission_max_minutes = 180, annual_leave_days = 21;
update public.day_rules set is_work_day = true, check_in_enabled = true, points_enabled = true;
-- one company day off: 4 days from today's weekday
update public.day_rules set is_work_day = false where day_of_week = (extract(dow from pg_temp.today())::int + 4) % 7;
delete from public.public_holidays where holiday_date between pg_temp.today() - 40 and pg_temp.today() + 40;
insert into public.push_subscriptions (employee_id, endpoint, p256dh, auth_key, device_label) values
  ('00000000-0000-4000-d000-00000000000a', 'https://push.example.invalid/a', 'k', 'a', 'Android'),
  ('00000000-0000-4000-d000-00000000000c', 'https://push.example.invalid/c', 'k', 'a', 'Android');

-- =============================================================== 1. permissions
select public.svc_request_permission('00000000-0000-4000-d000-00000000000a',
  jsonb_build_object('date', pg_temp.today() + 1, 'from_time', '10:00', 'to_time', '11:00', 'reason', 'بنك'));
select pg_temp.ok((select count(*) = 1 and bool_and(not over_limit and status = 'pending' and minutes = 60) from public.permission_requests
  where employee_id = '00000000-0000-4000-d000-00000000000a'), 'permission request saved (60 min, pending, within the limit)');
select pg_temp.err($$select public.svc_request_permission('00000000-0000-4000-d000-00000000000a',
  jsonb_build_object('date', pg_temp.today() + 1, 'from_time', '10:30', 'to_time', '11:30'))$$, 'permission_overlap', 'overlapping permission refused');
select pg_temp.err($$select public.svc_request_permission('00000000-0000-4000-d000-00000000000a',
  jsonb_build_object('date', pg_temp.today() + 1, 'from_time', '12:00', 'to_time', '16:00'))$$, 'permission_duration', 'longer than the maximum refused');
select pg_temp.err($$select public.svc_request_permission('00000000-0000-4000-d000-00000000000a',
  jsonb_build_object('date', pg_temp.today() - 1, 'from_time', '12:00', 'to_time', '13:00'))$$, 'invalid_dates', 'past day refused');
select pg_temp.err($$select public.svc_request_permission('00000000-0000-4000-d000-00000000000a',
  jsonb_build_object('date', pg_temp.today() + 1, 'from_time', '13:00', 'to_time', '12:00'))$$, 'invalid_time', 'end before start refused');
select pg_temp.err($$select public.svc_request_permission('00000000-0000-4000-d000-00000000000a',
  jsonb_build_object('date', pg_temp.today() + 4, 'from_time', '10:00', 'to_time', '11:00'))$$, 'not_work_day', 'company day off refused');
select pg_temp.err($$select public.svc_request_permission('00000000-0000-4000-d000-000000000001',
  jsonb_build_object('date', pg_temp.today() + 1, 'from_time', '10:00', 'to_time', '11:00'))$$, 'staff_only', 'owner cannot request a permission');
select public.svc_request_permission('00000000-0000-4000-d000-00000000000a',
  jsonb_build_object('date', pg_temp.today() + 1, 'from_time', '12:00', 'to_time', '12:30'));
select public.svc_request_permission('00000000-0000-4000-d000-00000000000a',
  jsonb_build_object('date', pg_temp.today() + 1, 'from_time', '14:00', 'to_time', '14:30', 'reason', 'مشوار'));
select pg_temp.ok((select over_limit from public.permission_requests where employee_id = '00000000-0000-4000-d000-00000000000a' and from_time = '14:00'),
  'the 3rd permission of the month (limit 2) is flagged over the limit');
select pg_temp.ok((select count(*) = 3 from public.owner_notifications where event = 'permission_request'
  and employee_id = '00000000-0000-4000-d000-00000000000a'), 'owner notified once per permission request');
select pg_temp.ok((select body_ar like 'أحمد إذن طلب إذن يوم % من 2:00 م إلى 2:30 م، السبب: مشوار%' and body_ar like '%⚠️ فوق الحد الشهري للأذونات%'
  from public.owner_notifications where event = 'permission_request' and ref_id = (select id::text from public.permission_requests where from_time = '14:00'
    and employee_id = '00000000-0000-4000-d000-00000000000a')), 'permission notification text (times, reason, over-limit warning)');
select pg_temp.ok((select payload ->> 'kind' = 'permission_request' and payload ? 'id' from public.notification_outbox
  where channel = 'telegram' and event_type = 'permission_request' limit 1), 'Telegram message carries the id (approve/reject buttons)');
select pg_temp.ok((select jsonb_array_length(public.svc_pending('00000000-0000-4000-d000-000000000001', '{}') -> 'permission') >= 3
  and (select (x ->> 'month_count')::int from jsonb_array_elements(public.svc_pending('00000000-0000-4000-d000-000000000001', '{}') -> 'permission') x
        where x ->> 'employee_id' = '00000000-0000-4000-d000-00000000000a' limit 1) = 3), 'approvals list permissions with the month count');
select pg_temp.err($$select public.svc_decide_permission('00000000-0000-4000-d000-00000000000a',
  jsonb_build_object('id', (select max(id) from public.permission_requests), 'approve', true))$$, 'forbidden', 'staff cannot decide a permission');
-- approve the over-limit one WITH a deduction
select public.svc_decide_permission('00000000-0000-4000-d000-000000000001', jsonb_build_object('id',
  (select id from public.permission_requests where employee_id = '00000000-0000-4000-d000-00000000000a' and from_time = '14:00'), 'approve', true, 'deduct', true));
select pg_temp.ok((select r.status = 'approved' and e.color = 'red' and e.status = 'active' and e.source = 'owner_manual'
  from public.permission_requests r join public.point_events e on e.id = r.deduction_event_id where r.from_time = '14:00'
   and r.employee_id = '00000000-0000-4000-d000-00000000000a'), 'over-limit approval with deduction → red point');
select pg_temp.ok((select count(*) = 1 from public.notification_outbox where event_type = 'permission_decision'
  and employee_id = '00000000-0000-4000-d000-00000000000a'), 'employee gets a push with the decision');
select pg_temp.ok((public.svc_decide_permission('00000000-0000-4000-d000-000000000001', jsonb_build_object('id',
  (select id from public.permission_requests where from_time = '14:00' and employee_id = '00000000-0000-4000-d000-00000000000a'), 'approve', true)) ->> 'result') = 'already_decided',
  'second decision is idempotent (already decided)');
select pg_temp.err($$select public.svc_cancel_permission('00000000-0000-4000-d000-00000000000a', jsonb_build_object('id',
  (select id from public.permission_requests where from_time = '14:00' and employee_id = '00000000-0000-4000-d000-00000000000a')))$$,
  'invalid_transition', 'employee cannot cancel a deducted permission');
-- revoke it → the red point is reversed
select public.svc_decide_permission('00000000-0000-4000-d000-000000000001', jsonb_build_object('id',
  (select id from public.permission_requests where from_time = '14:00' and employee_id = '00000000-0000-4000-d000-00000000000a'), 'approve', false, 'revoke', true));
select pg_temp.ok((select r.status = 'rejected' and private.is_reversed(r.deduction_event_id) from public.permission_requests r
  where r.from_time = '14:00' and r.employee_id = '00000000-0000-4000-d000-00000000000a'), 'revoking it reverses the red point');
select public.svc_cancel_permission('00000000-0000-4000-d000-00000000000a', jsonb_build_object('id',
  (select id from public.permission_requests where from_time = '12:00' and employee_id = '00000000-0000-4000-d000-00000000000a')));
select pg_temp.ok((select status = 'cancelled' from public.permission_requests where from_time = '12:00'
  and employee_id = '00000000-0000-4000-d000-00000000000a'), 'employee cancels a pending permission');
select pg_temp.err($$select public.svc_cancel_permission('00000000-0000-4000-d000-00000000000b', jsonb_build_object('id',
  (select id from public.permission_requests where from_time = '10:00' and employee_id = '00000000-0000-4000-d000-00000000000a')))$$,
  'not_found', 'another employee cannot cancel it');

-- an approved permission now: lateness excused and check-in allowed after the close time
do $$ declare v_dow int := extract(dow from pg_temp.today()); t time := (now() at time zone 'Africa/Cairo')::time;
begin
  delete from public.check_in_windows where day_of_week = v_dow;
  insert into public.check_in_windows (day_of_week, label_ar, label_en, start_time, end_time, awards_green_point, awards_red_point)
  values (v_dow, 'صباحي', 'Morning', t - interval '3 hours', t - interval '2 hours', true, false);
  insert into public.permission_requests (employee_id, work_date, from_time, to_time, status)
  values ('00000000-0000-4000-d000-00000000000e', pg_temp.today(), t - interval '2 hours 30 minutes', t + interval '10 minutes', 'approved');
end $$;
select pg_temp.ok((select (r ->> 'outcome') = 'none' and (r ->> 'excused_by_permission')::boolean
  from (select public.svc_check_in('00000000-0000-4000-d000-00000000000e', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}') r) x),
  'approved permission: late arrival excused (no red point) and check-in allowed after the close time');
select pg_temp.ok((select count(*) = 0 from public.point_events where employee_id = '00000000-0000-4000-d000-00000000000e'), 'no point for the excused arrival');
select pg_temp.err($$select public.svc_check_in('00000000-0000-4000-d000-00000000000f', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}')$$,
  'check_in_closed', 'without a permission the closed check-in stays closed');

-- =============================================================== 2. personal schedule
select pg_temp.err($$select public.svc_save_employee_schedule('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id',
  '00000000-0000-4000-d000-00000000000b', 'days', jsonb_build_array(jsonb_build_object('day_of_week', (extract(dow from pg_temp.today())::int + 4) % 7, 'is_work_day', true))))$$,
  'not_company_work_day', 'cannot make a company day off a work day');
select pg_temp.err($$select public.svc_save_employee_schedule('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id',
  '00000000-0000-4000-d000-00000000000b', 'days', jsonb_build_array(jsonb_build_object('day_of_week', 1, 'is_work_day', true, 'start_time', '17:00', 'end_time', '09:00'))))$$,
  'invalid_time', 'start after end refused');
select pg_temp.err($$select public.svc_save_employee_schedule('00000000-0000-4000-d000-00000000000b', jsonb_build_object('employee_id',
  '00000000-0000-4000-d000-00000000000b', 'days', '[]'::jsonb))$$, 'forbidden', 'staff cannot edit schedules');
-- B and G: personal day off today; B also custom hours tomorrow
select public.svc_save_employee_schedule('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-d000-00000000000b',
  'days', jsonb_build_array(jsonb_build_object('day_of_week', extract(dow from pg_temp.today())::int, 'is_work_day', false),
    jsonb_build_object('day_of_week', (extract(dow from pg_temp.today())::int + 1) % 7, 'is_work_day', true, 'start_time', '12:00', 'end_time', '20:00'))));
select public.svc_save_employee_schedule('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-d000-000000000010',
  'days', jsonb_build_array(jsonb_build_object('day_of_week', extract(dow from pg_temp.today())::int, 'is_work_day', false))));
select pg_temp.ok((select (x ->> 'is_work_day')::boolean = false and (x ->> 'company_work_day')::boolean
  from jsonb_array_elements(public.svc_employee_schedule('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000b"}') -> 'days') x
  where (x ->> 'day_of_week')::int = extract(dow from pg_temp.today())), 'schedule saved: personal day off');
select pg_temp.ok((select x.start_time = '12:00' and x.end_time = '20:00' and x.is_work from private.emp_day('00000000-0000-4000-d000-00000000000b', pg_temp.today() + 1) x),
  'custom hours on another day');
select pg_temp.ok((select (d ->> 'is_work_day')::boolean = false and (d ->> 'day_off')::boolean
  from (select public.svc_my_day('00000000-0000-4000-d000-000000000010', '{}') d) x), 'my day shows the personal day off');
select pg_temp.err($$select public.svc_request_early_leave('00000000-0000-4000-d000-000000000010', jsonb_build_object('leave_time', pg_temp.hm('1 hour')))$$,
  'not_work_day', 'no early leave on a personal day off');
-- check-in on a personal day off: allowed, no points
do $$ declare v_dow int := extract(dow from pg_temp.today()); t time := (now() at time zone 'Africa/Cairo')::time;
begin
  delete from public.check_in_windows where day_of_week = v_dow;
  insert into public.check_in_windows (day_of_week, label_ar, label_en, start_time, end_time, awards_green_point, awards_red_point)
  values (v_dow, 'الآن', 'Now', t - interval '20 minutes', t + interval '20 minutes', true, false);
end $$;
select pg_temp.ok((select (r ->> 'outcome') = 'none' and (r ->> 'day_off')::boolean
  from (select public.svc_check_in('00000000-0000-4000-d000-00000000000b', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}') r) x),
  'check-in on a personal day off is recorded without points');
-- absence job: G (day off) and H (approved permission over the cutoff) are not absent; F is
insert into public.permission_requests (employee_id, work_date, from_time, to_time, status)
select '00000000-0000-4000-d000-000000000011', pg_temp.today(), absence_cutoff - interval '1 hour', absence_cutoff + interval '1 hour', 'approved'
  from public.settings where id;
select private.run_absence(pg_temp.today());
select pg_temp.ok((select count(*) = 0 from public.point_events where employee_id in ('00000000-0000-4000-d000-000000000010', '00000000-0000-4000-d000-000000000011')
  and source = 'auto_absence'), 'personal day off / permission over the cutoff → no absence');
select pg_temp.ok((select count(*) = 1 from public.point_events where employee_id = '00000000-0000-4000-d000-00000000000f' and source = 'auto_absence'),
  'the control employee without a check-in is still marked absent');
select pg_temp.ok((select detail -> 'lines' @> '[{"line":"Personal Day Off -> No Absence"}]'::jsonb
  and detail -> 'lines' @> '[{"line":"Approved Permission Covers Cutoff -> No Absence"}]'::jsonb
  from public.job_runs where job_name = 'absence' and run_key = pg_temp.today()::text), 'absence job log explains both');
select pg_temp.ok(private.emp_day_status('00000000-0000-4000-d000-000000000010', pg_temp.today()) = 'nonwork', 'absence streaks skip the day off');

-- =============================================================== 8. check-out overdue reminder
do $$ declare t time := (now() at time zone 'Africa/Cairo')::time; v_n int;
begin
  if t < '06:00' or t > '21:30' then raise notice 'ok: (skipped overdue reminder test near midnight)'; return; end if;
  update public.settings set checkout_overdue_reminder = true, checkout_overdue_min = 30, shift_reminders_default = true;
  insert into public.employee_schedules (employee_id, day_of_week, is_work_day, start_time, end_time)
  values ('00000000-0000-4000-d000-00000000000a', extract(dow from pg_temp.today()), true, t - interval '5 hours', t - interval '40 minutes');
  insert into public.attendance_days (employee_id, work_date, checked_in_at, check_in_outcome)
  values ('00000000-0000-4000-d000-00000000000a', pg_temp.today(), now() - interval '4 hours', 'none');
  perform private.enqueue_reminders();
  select count(*) into v_n from public.notification_outbox where employee_id = '00000000-0000-4000-d000-00000000000a' and event_type = 'checkout_overdue';
  if v_n <> 1 then raise exception 'ASSERTION FAILED: overdue reminder (got %)', v_n; end if;
  perform private.enqueue_reminders();
  select count(*) into v_n from public.notification_outbox where employee_id = '00000000-0000-4000-d000-00000000000a' and event_type = 'checkout_overdue';
  if v_n <> 1 then raise exception 'ASSERTION FAILED: overdue reminder repeated (got %)', v_n; end if;
  update public.settings set checkout_overdue_reminder = false;
  delete from public.notification_outbox where event_type = 'checkout_overdue';
  perform private.enqueue_reminders();
  if exists (select 1 from public.notification_outbox where event_type = 'checkout_overdue') then raise exception 'ASSERTION FAILED: toggle off still reminds'; end if;
  raise notice 'ok: check-out overdue reminder: once after end + 30 min, never twice, off when disabled';
  update public.settings set checkout_overdue_reminder = true;
end $$;

-- =============================================================== 3. leave balance
select pg_temp.ok((public.svc_my_leave_balance('00000000-0000-4000-d000-00000000000d', '{}') ->> 'available')::numeric = 21, 'default balance 21 days');
select public.svc_set_leave_balance('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-d000-00000000000d',
  'year', extract(year from pg_temp.today()), 'entitled_days', 2, 'note', 'سنة أولى'));
select pg_temp.ok((select (b ->> 'entitled')::numeric = 2 and (b ->> 'custom')::boolean and b ->> 'note' = 'سنة أولى'
  from (select public.svc_my_leave_balance('00000000-0000-4000-d000-00000000000d', '{}') b) x), 'owner sets a custom balance');
select pg_temp.err($$select public.svc_set_leave_balance('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id',
  '00000000-0000-4000-d000-00000000000d', 'year', 2026, 'entitled_days', 1.3))$$, 'invalid_value', 'half days only');
select pg_temp.err($$select public.svc_set_leave_balance('00000000-0000-4000-d000-00000000000d', jsonb_build_object('employee_id',
  '00000000-0000-4000-d000-00000000000d', 'year', 2026, 'entitled_days', 30))$$, 'forbidden', 'staff cannot change balances');
-- 3 consecutive company work days starting tomorrow (skipping the company day off at +4)
select pg_temp.err($$select public.svc_request_leave('00000000-0000-4000-d000-00000000000d', jsonb_build_object('type', 'personal',
  'from_date', pg_temp.today() + 1, 'to_date', pg_temp.today() + 3))$$, 'leave_balance_insufficient', '3 work days > balance 2 → refused');
select public.svc_request_leave('00000000-0000-4000-d000-00000000000d', jsonb_build_object('type', 'personal', 'from_date', pg_temp.today() + 3, 'to_date', pg_temp.today() + 5));
select pg_temp.ok((select (b ->> 'pending')::int = 2 and (b ->> 'available')::numeric = 0 from (select public.svc_my_leave_balance('00000000-0000-4000-d000-00000000000d', '{}') b) x),
  'a 3-day range with the company day off counts 2 work days (reserved while pending)');
select pg_temp.err($$select public.svc_request_leave('00000000-0000-4000-d000-00000000000d', jsonb_build_object('type', 'personal',
  'from_date', pg_temp.today() + 8, 'to_date', pg_temp.today() + 8))$$, 'leave_balance_insufficient', 'pending days are reserved');
select public.svc_request_leave('00000000-0000-4000-d000-00000000000d', jsonb_build_object('type', 'sick', 'from_date', pg_temp.today() + 9, 'to_date', pg_temp.today() + 10));
select pg_temp.ok((select count(*) = 1 from public.leave_requests where employee_id = '00000000-0000-4000-d000-00000000000d' and type = 'sick'), 'sick leave is not limited by the balance');
select pg_temp.err($$select public.svc_request_leave('00000000-0000-4000-d000-00000000000d', jsonb_build_object('type', 'sick',
  'from_date', pg_temp.today() + 4, 'to_date', pg_temp.today() + 4))$$, 'no_work_days', 'a leave with no work day is refused');
select public.svc_decide_leave('00000000-0000-4000-d000-000000000001', jsonb_build_object('id',
  (select id from public.leave_requests where employee_id = '00000000-0000-4000-d000-00000000000d' and type = 'personal'), 'approve', true));
select public.svc_decide_leave('00000000-0000-4000-d000-000000000001', jsonb_build_object('id',
  (select id from public.leave_requests where employee_id = '00000000-0000-4000-d000-00000000000d' and type = 'sick'), 'approve', true));
select pg_temp.ok((select (b ->> 'used')::int = 2 and (b ->> 'remaining')::numeric = 0 and (b ->> 'sick_used')::int = 2
  from (select public.svc_my_leave_balance('00000000-0000-4000-d000-00000000000d', '{}') b) x), 'approved: used 2, remaining 0, sick 2 counted separately');
select pg_temp.ok((select (x ->> 'used')::int = 2 from jsonb_array_elements(public.svc_leave_balances('00000000-0000-4000-d000-000000000001', '{}') -> 'employees') x
  where x ->> 'employee_id' = '00000000-0000-4000-d000-00000000000d'), 'owner sees everyone''s balance');

-- =============================================================== 4. attendance corrections
select pg_temp.err($$select public.svc_request_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('date', pg_temp.today() - 2,
  'kind', 'check_out', 'check_out_time', '17:00', 'reason', 'نسيت'))$$, 'not_checked_in', 'check-out correction needs a check-in');
select pg_temp.err($$select public.svc_request_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('date', pg_temp.today() + 1,
  'kind', 'both', 'check_in_time', '09:00', 'check_out_time', '17:00', 'reason', 'نسيت'))$$, 'invalid_dates', 'future day refused');
select pg_temp.err($$select public.svc_request_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('date', pg_temp.today() - 2,
  'kind', 'both', 'check_in_time', '09:00', 'check_out_time', '17:00', 'reason', 'x'))$$, 'reason_required', 'a reason is required');
select public.svc_request_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('date', pg_temp.today() - 2,
  'kind', 'both', 'check_in_time', '09:00', 'check_out_time', '17:00', 'reason', 'النت كان فاصل'));
select pg_temp.err($$select public.svc_request_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('date', pg_temp.today() - 2,
  'kind', 'both', 'check_in_time', '09:00', 'check_out_time', '17:00', 'reason', 'تاني'))$$, 'already_pending', 'one pending request per day');
select pg_temp.ok((select body_ar like 'كريم تصحيح طلب تصحيح الحضور 9:00 ص والانصراف 5:00 م يوم %، السبب: النت كان فاصل%'
  from public.owner_notifications where event = 'correction_request'), 'correction notification text');
select pg_temp.err($$select public.svc_decide_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('id',
  (select max(id) from public.correction_requests), 'approve', true))$$, 'forbidden', 'staff cannot decide a correction');
select public.svc_decide_correction('00000000-0000-4000-d000-000000000001', jsonb_build_object('id',
  (select id from public.correction_requests where employee_id = '00000000-0000-4000-d000-00000000000c'), 'approve', true));
select pg_temp.ok((select a.corrected and to_char(a.checked_in_at at time zone 'Africa/Cairo', 'HH24:MI') = '09:00'
  and to_char(a.checked_out_at at time zone 'Africa/Cairo', 'HH24:MI') = '17:00' and a.worked_minutes = 480 and r.status = 'approved' and r.attendance_id = a.id
  from public.attendance_days a join public.correction_requests r on r.employee_id = a.employee_id and r.work_date = a.work_date
  where a.employee_id = '00000000-0000-4000-d000-00000000000c'), 'approved: attendance created with both times (corrected, 8 h)');
select pg_temp.ok((select count(*) = 1 from public.notification_outbox where event_type = 'correction_decision'
  and employee_id = '00000000-0000-4000-d000-00000000000c'), 'employee gets a push with the decision');
-- missing check-out on another day → check-out correction, then a rejected one
insert into public.attendance_days (employee_id, work_date, checked_in_at, check_in_outcome)
values ('00000000-0000-4000-d000-00000000000c', pg_temp.today() - 3, ((pg_temp.today() - 3) + time '09:10') at time zone 'Africa/Cairo', 'none');
select public.svc_request_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('date', pg_temp.today() - 3,
  'kind', 'check_out', 'check_out_time', '17:10', 'reason', 'نسيت أسجل انصراف'));
select public.svc_decide_correction('00000000-0000-4000-d000-000000000001', jsonb_build_object('id',
  (select id from public.correction_requests where work_date = pg_temp.today() - 3 and employee_id = '00000000-0000-4000-d000-00000000000c'), 'approve', true));
select pg_temp.ok((select worked_minutes = 480 and not missing_checkout from public.attendance_days
  where employee_id = '00000000-0000-4000-d000-00000000000c' and work_date = pg_temp.today() - 3), 'check-out correction applied');
select public.svc_request_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('date', pg_temp.today() - 4,
  'kind', 'check_in', 'check_in_time', '09:00', 'reason', 'كنت موجود'));
select public.svc_decide_correction('00000000-0000-4000-d000-000000000001', jsonb_build_object('id',
  (select id from public.correction_requests where work_date = pg_temp.today() - 4 and employee_id = '00000000-0000-4000-d000-00000000000c'),
  'approve', false, 'comment', 'الكاميرا مش مسجلاك'));
select pg_temp.ok((select r.status = 'rejected' and r.admin_comment = 'الكاميرا مش مسجلاك' and not exists (select 1 from public.attendance_days a
  where a.employee_id = r.employee_id and a.work_date = r.work_date) from public.correction_requests r where r.work_date = pg_temp.today() - 4
  and r.employee_id = '00000000-0000-4000-d000-00000000000c'), 'rejected: nothing changes, comment kept');
select pg_temp.ok((select payload ->> 'body' like '%السبب: الكاميرا مش مسجلاك%' from public.notification_outbox where event_type = 'correction_decision'
  and dedupe_key like '%:rejected:%'), 'rejection push includes the owner''s reason');
select public.svc_request_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('date', pg_temp.today() - 5,
  'kind', 'check_in', 'check_in_time', '09:00', 'reason', 'تجربة إلغاء'));
select public.svc_cancel_correction('00000000-0000-4000-d000-00000000000c', jsonb_build_object('id',
  (select id from public.correction_requests where work_date = pg_temp.today() - 5)));
select pg_temp.ok((select status = 'cancelled' from public.correction_requests where work_date = pg_temp.today() - 5), 'employee cancels a pending correction');

-- =============================================================== 7. change log
select pg_temp.ok((select bool_or(x ->> 'action' = 'correction.approved') and bool_or(x ->> 'action' = 'attendance.manual_check_in')
  and bool_or(x ->> 'action' = 'correction.rejected') and not bool_or(x ->> 'action' = 'correction.request')
  from jsonb_array_elements(public.svc_my_changes('00000000-0000-4000-d000-00000000000c', '{}')) x), 'employee sees what the owner changed (not their own requests)');
select pg_temp.ok((select bool_or(x ->> 'action' = 'correction.rejected' and x ->> 'reason' = 'الكاميرا مش مسجلاك' and x ->> 'by' = 'المالك')
  from jsonb_array_elements(public.svc_my_changes('00000000-0000-4000-d000-00000000000c', '{}')) x), 'with the owner''s reason and name');
select pg_temp.ok((select bool_or(x ->> 'action' = 'leave_balance.set') from jsonb_array_elements(public.svc_my_changes('00000000-0000-4000-d000-00000000000d', '{}')) x)
  and (select bool_or(x ->> 'action' = 'schedule.set') from jsonb_array_elements(public.svc_my_changes('00000000-0000-4000-d000-00000000000b', '{}')) x),
  'balance and schedule changes are listed');
select pg_temp.ok((select count(*) = 0 from jsonb_array_elements(public.svc_my_changes('00000000-0000-4000-d000-00000000000c', '{}')) x
  where x ->> 'action' in ('schedule.set', 'leave_balance.set')), 'other employees'' changes are not listed');
select pg_temp.err($$select public.svc_employee_changes('00000000-0000-4000-d000-00000000000c', '{"employee_id":"00000000-0000-4000-d000-00000000000d"}')$$,
  'forbidden', 'staff cannot read another employee''s log');
select pg_temp.ok(jsonb_array_length(public.svc_employee_changes('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000c"}')) >= 4,
  'owner reads the employee''s change log');

-- =============================================================== 9. my pay
update public.settings set staff_pay_visible = false;
select pg_temp.ok((select not (p ? 'base_piastres') and not (p ? 'net_piastres') and not (p ? 'payments') and p ? 'deductions' and p ? 'events'
  and not (p ->> 'pay_visible')::boolean from (select public.svc_my_pay('00000000-0000-4000-d000-00000000000f', '{}') p) x),
  'salary/net hidden by default; deductions and events shown');
select pg_temp.ok((select bool_or(e ->> 'color' = 'black' and e ->> 'status' = 'pending_approval')
  from jsonb_array_elements(public.svc_my_pay('00000000-0000-4000-d000-00000000000f', '{}') -> 'events') e), 'the pending absence is listed');
update public.settings set staff_pay_visible = true;
select pg_temp.ok((select p ? 'base_piastres' and p ? 'net_piastres' and (p ->> 'pay_visible')::boolean
  from (select public.svc_my_pay('00000000-0000-4000-d000-00000000000f', '{}') p) x), 'salary/net shown when the owner turns it on');
select pg_temp.err($$select public.svc_my_pay('00000000-0000-4000-d000-00000000000f', jsonb_build_object('month', pg_temp.today() + 40))$$,
  'invalid_dates', 'future months refused');

-- =============================================================== 5/6/10/1. statement, digest, summary, dashboard
select pg_temp.ok((select (st -> 'totals' ->> 'days_off')::int >= 1 and (st -> 'leave_allowance' ? 'entitled')
  and exists (select 1 from jsonb_array_elements(st -> 'days') d where d ->> 'status' = 'day_off' and (d ->> 'date')::date = pg_temp.today())
  from (select public.svc_employee_statement('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-d000-000000000010',
    'from', date_trunc('month', pg_temp.today())::date, 'to', pg_temp.today())) st) x), 'statement: personal day off + leave balance');
select pg_temp.ok((select (st -> 'totals' ->> 'permissions')::int = 1 and (st -> 'totals' ->> 'permission_minutes')::int > 0
  from (select public.svc_employee_statement('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-d000-00000000000e',
    'from', pg_temp.today(), 'to', pg_temp.today())) st) x), 'statement counts approved permissions');
select private.run_digest(pg_temp.today());
select pg_temp.ok((select (detail -> 'lines' -> 0 ->> 'line') like 'حاضر % · متأخر % · غائب % · إجازة % · راحة %'
  and detail -> 'lines' @> '[{"line":"غادة راحة: يوم راحة"}]'::jsonb
  and exists (select 1 from jsonb_array_elements(detail -> 'lines') l where l ->> 'line' like 'هاني إذن صباحي: % · إذن %')
  and exists (select 1 from jsonb_array_elements(detail -> 'lines') l where l ->> 'line' like 'بانتظار قرارك: %إذن %')
  from public.job_runs where job_name = 'digest' and run_key = pg_temp.today()::text), 'daily summary: counts, day off, permission, pending decisions');
select pg_temp.ok((select (s ->> 'work_days_left')::int between 0 and 31 from (select public.svc_my_summary('00000000-0000-4000-d000-00000000000a', '{}') s) x),
  'points goal: work days left this month');
select pg_temp.ok((select d -> 'pending' ? 'permission' and d -> 'pending' ? 'correction'
  and exists (select 1 from jsonb_array_elements(d -> 'employees') e where e ->> 'id' = '00000000-0000-4000-d000-000000000010' and (e ->> 'day_off')::boolean)
  from (select public.svc_owner_dashboard('00000000-0000-4000-d000-000000000001', '{}') d) x), 'dashboard: pending counts and day off');

-- =============================================================== settings
select pg_temp.err($$select public.svc_save_staff_tools('00000000-0000-4000-d000-000000000001', '{"permission_monthly_limit": 99}')$$, 'invalid_value', 'out-of-range setting refused');
select pg_temp.err($$select public.svc_save_staff_tools('00000000-0000-4000-d000-00000000000a', '{"permission_monthly_limit": 4}')$$, 'forbidden', 'staff cannot change these settings');
select pg_temp.ok((public.svc_save_staff_tools('00000000-0000-4000-d000-000000000001', '{"permission_monthly_limit": 4, "annual_leave_days": 18.5, "staff_pay_visible": false}')
  ->> 'permission_monthly_limit')::int = 4, 'owner saves the settings');
select pg_temp.ok((select annual_leave_days = 18.5 and not staff_pay_visible and permission_monthly_limit = 4 from public.settings where id), 'settings stored');

-- =============================================================== RLS
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-d000-00000000000a","role":"authenticated","session_id":"20000000-0000-4000-d000-00000000000a"}';
select pg_temp.ok((select count(*) > 0 and bool_and(employee_id = '00000000-0000-4000-d000-00000000000a') from public.permission_requests), 'staff reads only their own permissions');
select pg_temp.ok((select count(*) = 0 from public.correction_requests) and (select count(*) = 0 from public.leave_balances)
  and (select count(*) <= 1 from public.employee_schedules), 'no access to other employees'' corrections / balances / schedules');
do $$ begin
  insert into public.permission_requests (employee_id, work_date, from_time, to_time, status)
  values ('00000000-0000-4000-d000-00000000000a', (now() at time zone 'Africa/Cairo')::date + 1, '15:00', '16:00', 'approved');
  raise exception 'ASSERTION FAILED: staff wrote a permission directly';
exception when insufficient_privilege then raise notice 'ok: staff cannot write requests directly (only through the API)'; end $$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-d000-000000000001","role":"authenticated","session_id":"20000000-0000-4000-d000-000000000001"}';
select pg_temp.ok((select count(*) >= 5 from public.permission_requests) and (select count(*) >= 4 from public.correction_requests), 'owner reads all requests');
reset role;
select 'STAFF TOOLS TESTS PASSED';
