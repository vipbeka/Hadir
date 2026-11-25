-- =====================================================================
-- Live owner notifications: check-in (on time / late / outside location),
-- check-out, absence, requests → ONE in-app row + ONE Telegram + ONE push
-- per owner device, same Arabic text, Cairo time; toggles; idempotency;
-- RLS; a notification failure never blocks the employee.
-- Temporary employees only; runs inside ONE transaction, rolled back.
-- =====================================================================
create function pg_temp.ok(cond boolean, msg text) returns text language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ASSERTION FAILED: %', msg; end if;
  raise notice 'ok: %', msg; return 'ok';
end $$;
create function pg_temp.n(p_type text, p_emp uuid) returns int language sql as
  $$ select count(*)::int from public.owner_notifications where type = p_type and employee_id = p_emp $$;
create function pg_temp.tg(p_emp uuid) returns int language sql as
  $$ select count(*)::int from public.notification_outbox where channel = 'telegram' and subject_id = p_emp $$;
create function pg_temp.push(p_emp uuid) returns int language sql as
  $$ select count(*)::int from public.notification_outbox where channel = 'web_push' and subject_id = p_emp $$;

-- fixtures: owner + temporary staff (rolled back) ------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-c000-000000000001', 'o@test.invalid'), ('00000000-0000-4000-c000-00000000000a', 'a@test.invalid'),
  ('00000000-0000-4000-c000-00000000000b', 'b@test.invalid'), ('00000000-0000-4000-c000-00000000000c', 'c@test.invalid'),
  ('00000000-0000-4000-c000-00000000000d', 'd@test.invalid'), ('00000000-0000-4000-c000-00000000000e', 'e@test.invalid');
insert into auth.sessions (id, user_id) values
  ('20000000-0000-4000-c000-00000000000a', '00000000-0000-4000-c000-00000000000a'),
  ('20000000-0000-4000-c000-000000000001', '00000000-0000-4000-c000-000000000001');
insert into public.profiles (id, full_name_ar, full_name_en, role, created_at) values
  ('00000000-0000-4000-c000-000000000001', 'المالك', 'Owner', 'owner', now() - interval '30 days'),
  ('00000000-0000-4000-c000-00000000000a', 'محمد تجربة', 'Test A', 'staff', now() - interval '30 days'),
  ('00000000-0000-4000-c000-00000000000b', 'سارة تجربة', 'Test B', 'staff', now() - interval '30 days'),
  ('00000000-0000-4000-c000-00000000000c', 'علي تجربة', 'Test C', 'staff', now() - interval '30 days'),
  ('00000000-0000-4000-c000-00000000000d', 'موقوف تجربة', 'Test D', 'staff', now() - interval '30 days'),
  ('00000000-0000-4000-c000-00000000000e', 'إجازة تجربة', 'Test E', 'staff', now() - interval '30 days');
update public.profiles set active = false where id = '00000000-0000-4000-c000-00000000000d';
update public.settings set owner_telegram_chat_id = '123456789', owner_alert_channel = 'telegram', work_end_time = '23:59:59';
delete from public.public_holidays where holiday_date = (now() at time zone 'Africa/Cairo')::date;
insert into public.push_subscriptions (employee_id, endpoint, p256dh, auth_key, device_label)
values ('00000000-0000-4000-c000-000000000001', 'https://push.example.invalid/owner-phone', 'k', 'a', 'Android');
-- approved leave today for E (→ never "absent")
insert into public.leave_requests (employee_id, type, from_date, to_date, status)
values ('00000000-0000-4000-c000-00000000000e', 'personal', (now() at time zone 'Africa/Cairo')::date, (now() at time zone 'Africa/Cairo')::date, 'approved');

select pg_temp.ok((select (owner_alert_prefs -> 'check_in' ->> 'app')::boolean and (owner_alert_prefs -> 'request' ->> 'push')::boolean
  from public.settings where id), 'all toggles on by default');

-- today: work day, a green window open now ------------------------------
do $$ declare v_dow int := extract(dow from (now() at time zone 'Africa/Cairo')); t time := (now() at time zone 'Africa/Cairo')::time;
begin
  update public.day_rules set is_work_day = true, check_in_enabled = true, points_enabled = true where day_of_week = v_dow;
  delete from public.check_in_windows where day_of_week = v_dow;
  insert into public.check_in_windows (day_of_week, label_ar, label_en, start_time, end_time, awards_green_point, awards_red_point)
  values (v_dow, 'الآن', 'Now', t - interval '20 minutes', t + interval '20 minutes', true, false);
end $$;

-- 1) on-time check-in --------------------------------------------------
select public.svc_check_in('00000000-0000-4000-c000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}');
select pg_temp.ok(pg_temp.n('check_in', '00000000-0000-4000-c000-00000000000a') = 1, 'check-in → one in-app notification');
select pg_temp.ok(pg_temp.tg('00000000-0000-4000-c000-00000000000a') = 1, 'check-in → one Telegram message queued');
select pg_temp.ok(pg_temp.push('00000000-0000-4000-c000-00000000000a') = 1, 'check-in → one push per owner device');
select pg_temp.ok((select body_ar like 'محمد تجربة حضر الساعة %' || private.fmt12_ts(a.checked_in_at, 'ar') || '%'
                     and body_ar like '%' || private.ar_date(a.work_date) || '%' and body_ar not like '%متأخر%'
                   from public.owner_notifications n join public.attendance_days a on a.id::text = n.ref_id
                  where n.employee_id = '00000000-0000-4000-c000-00000000000a'), 'Arabic text: name, «حضر», Cairo 12h time (ص/م), date; no lateness');
select pg_temp.ok((select private.fmt12_ts(now(), 'ar') ~ '^\d{1,2}:\d{2} (ص|م)$'), '12-hour time with ص/م');
select pg_temp.ok((select o.payload ->> 'text_ar' = n.title_ar || E'\n' || n.body_ar from public.notification_outbox o
                   join public.owner_notifications n on n.employee_id = o.subject_id and n.type = 'check_in'
                  where o.channel = 'telegram' and o.subject_id = '00000000-0000-4000-c000-00000000000a'), 'Telegram text = in-app text');
select pg_temp.ok((select o.payload ->> 'body' = n.body_ar and o.payload ->> 'url' = './index.html#/owner/notifications?id=' || n.id
                   from public.notification_outbox o join public.owner_notifications n on n.employee_id = o.subject_id and n.type = 'check_in'
                  where o.channel = 'web_push' and o.subject_id = '00000000-0000-4000-c000-00000000000a'), 'push text = in-app text, opens the notifications page');
select pg_temp.ok((select link = '#/owner/employee?id=00000000-0000-4000-c000-00000000000a' from public.owner_notifications
                   where employee_id = '00000000-0000-4000-c000-00000000000a'), 'in-app click opens the employee record');
-- retry / double tap: the same event again creates nothing new
select private.enqueue_owner_alert('check_in', 'in:' || id, '{"kind":"check_in"}'::jsonb, id::text) from public.attendance_days
 where employee_id = '00000000-0000-4000-c000-00000000000a';
select pg_temp.ok(pg_temp.n('check_in', '00000000-0000-4000-c000-00000000000a') = 1 and pg_temp.tg('00000000-0000-4000-c000-00000000000a') = 1
  and pg_temp.push('00000000-0000-4000-c000-00000000000a') = 1, 'repeated event → still exactly one per channel');

-- 2) late check-in (window that gives red, on-time limit 25 min ago) -----
do $$ declare v_dow int := extract(dow from (now() at time zone 'Africa/Cairo')); t time := (now() at time zone 'Africa/Cairo')::time;
begin
  delete from public.check_in_windows where day_of_week = v_dow;
  insert into public.check_in_windows (day_of_week, label_ar, label_en, start_time, end_time, awards_green_point, awards_red_point) values
    (v_dow, 'عادي', 'Normal', t - interval '60 minutes', t - interval '25 minutes', true, false),
    (v_dow, 'متأخر', 'Late', t - interval '25 minutes', t + interval '30 minutes', false, true);
end $$;
select public.svc_check_in('00000000-0000-4000-c000-00000000000b', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}');
select pg_temp.ok(pg_temp.n('check_in', '00000000-0000-4000-c000-00000000000b') = 1 and pg_temp.tg('00000000-0000-4000-c000-00000000000b') = 1,
  'late check-in → one notification (not two)');
select pg_temp.ok((select title_ar = 'حضور متأخر' and body_ar like '%⏰ متأخر 25 دقيقة%' and (flags ->> 'late_minutes')::int = 25
                   from public.owner_notifications where employee_id = '00000000-0000-4000-c000-00000000000b'), 'late check-in shows 25 minutes late');

-- 3) check-in outside the allowed location (the API refuses it; a record
--    that still lands outside, e.g. a corrected one, carries a warning) --
insert into public.attendance_days (employee_id, work_date, checked_in_at, check_in_lat, check_in_lng, check_in_accuracy_m, check_in_outcome)
values ('00000000-0000-4000-c000-00000000000e', (now() at time zone 'Africa/Cairo')::date, now(), 30.05, 31.24, 10, 'none');
select private.enqueue_owner_alert('check_in', 'in:' || id, '{"kind":"check_in"}'::jsonb, id::text) from public.attendance_days
 where employee_id = '00000000-0000-4000-c000-00000000000e';
select pg_temp.ok((select body_ar like '%⚠️ تسجيل خارج الموقع المسموح%' and (flags ->> 'outside_location')::boolean
                   from public.owner_notifications where employee_id = '00000000-0000-4000-c000-00000000000e'), 'outside-location warning line');
delete from public.attendance_days where employee_id = '00000000-0000-4000-c000-00000000000e';

-- 4) check-out ---------------------------------------------------------
-- (same transaction = same now(): move the check-ins 2 h back)
update public.attendance_days set checked_in_at = now() - interval '2 hours' where employee_id in ('00000000-0000-4000-c000-00000000000a', '00000000-0000-4000-c000-00000000000b');
select public.svc_check_out('00000000-0000-4000-c000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}');
select pg_temp.ok(pg_temp.n('check_out', '00000000-0000-4000-c000-00000000000a') = 1
  and (select body_ar like 'محمد تجربة انصرف الساعة %' from public.owner_notifications where type = 'check_out'
        and employee_id = '00000000-0000-4000-c000-00000000000a'), 'check-out → «انصرف الساعة …»');
select pg_temp.ok(pg_temp.tg('00000000-0000-4000-c000-00000000000a') = 2 and pg_temp.push('00000000-0000-4000-c000-00000000000a') = 2, 'check-out → Telegram + push');

-- 5) toggles: check-out OFF on every channel ---------------------------
select public.svc_owner_alert_prefs('00000000-0000-4000-c000-000000000001', jsonb_build_object('prefs', jsonb_build_object(
  'check_in', '{"telegram":true,"app":true,"push":true}'::jsonb, 'check_out', '{"telegram":false,"app":false,"push":false}'::jsonb,
  'absence', '{"telegram":true,"app":true,"push":true}'::jsonb, 'request', '{"telegram":true,"app":true,"push":false}'::jsonb)));
select public.svc_check_out('00000000-0000-4000-c000-00000000000b', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}');
select pg_temp.ok(pg_temp.n('check_out', '00000000-0000-4000-c000-00000000000b') = 0 and pg_temp.tg('00000000-0000-4000-c000-00000000000b') = 1
  and pg_temp.push('00000000-0000-4000-c000-00000000000b') = 1, 'check-out toggle off → nothing sent (employee still checked out)');
select pg_temp.ok((select checked_out_at is not null from public.attendance_days where employee_id = '00000000-0000-4000-c000-00000000000b'), 'employee flow unaffected by the toggle');
do $$ begin perform public.svc_owner_alert_prefs('00000000-0000-4000-c000-00000000000a', '{"prefs":{}}'); raise exception 'ASSERTION FAILED: staff changed prefs';
exception when others then if sqlerrm like 'ASSERTION%' then raise; end if; raise notice 'ok: staff cannot change notification settings (%)', sqlerrm; end $$;

-- 6) requests ------------------------------------------------------------
select public.svc_request_early_leave('00000000-0000-4000-c000-00000000000b',
  jsonb_build_object('leave_time', to_char((now() at time zone 'Africa/Cairo') + interval '5 minutes', 'HH24:MI'), 'reason', 'موعد طبيب'));
select pg_temp.ok((select body_ar like 'سارة تجربة طلب انصراف مبكر اليوم الساعة %، السبب: موعد طبيب%' and body_ar like '%وقت الطلب: %'
                     and link = '#/owner/approvals' from public.owner_notifications where type = 'request'
                     and employee_id = '00000000-0000-4000-c000-00000000000b'), 'early-departure request text with reason and submit time');
select pg_temp.ok((select payload ? 'id' and payload ->> 'kind' = 'early_leave_request' from public.notification_outbox
                   where channel = 'telegram' and event_type = 'early_leave_request' and subject_id = '00000000-0000-4000-c000-00000000000b'),
  'Telegram keeps the request id (approve/reject buttons)');
select pg_temp.ok(pg_temp.push('00000000-0000-4000-c000-00000000000b') = 1, 'request push toggle off → no push, in-app + Telegram still sent');
-- (a leave must include at least one work day: make both days work days)
update public.day_rules set is_work_day = true where day_of_week in (extract(dow from (now() at time zone 'Africa/Cairo')::date + 2), extract(dow from (now() at time zone 'Africa/Cairo')::date + 3));
select public.svc_request_leave('00000000-0000-4000-c000-00000000000c', jsonb_build_object('type', 'personal',
  'from_date', (now() at time zone 'Africa/Cairo')::date + 2, 'to_date', (now() at time zone 'Africa/Cairo')::date + 3, 'reason', 'سفر'));
select pg_temp.ok((select body_ar like 'علي تجربة طلب إجازة (غياب) من % إلى % (2 يوم)، السبب: سفر%' from public.owner_notifications
                   where type = 'request' and employee_id = '00000000-0000-4000-c000-00000000000c'), 'absence/leave request text');

-- 7) absence (C: no check-in, no approved leave today) -----------------
select private.run_absence((now() at time zone 'Africa/Cairo')::date);
select private.run_absence((now() at time zone 'Africa/Cairo')::date);   -- the job runs again: no repeat
select pg_temp.ok(pg_temp.n('absence', '00000000-0000-4000-c000-00000000000c') = 1
  and (select count(*) from public.notification_outbox where event_type = 'black_pending' and subject_id = '00000000-0000-4000-c000-00000000000c') = 1,
  'absent employee → «غاب اليوم» once (job re-run sends nothing again)');
select pg_temp.ok((select body_ar like 'علي تجربة غاب اليوم%' from public.owner_notifications where type = 'absence'
                   and employee_id = '00000000-0000-4000-c000-00000000000c'), 'absence text «غاب اليوم»');
select pg_temp.ok(pg_temp.n('absence', '00000000-0000-4000-c000-00000000000a') + pg_temp.n('absence', '00000000-0000-4000-c000-00000000000b') = 0,
  'checked-in employees are not absent');
select pg_temp.ok(pg_temp.n('absence', '00000000-0000-4000-c000-00000000000d') = 0, 'inactive employee never notified');
select pg_temp.ok(pg_temp.n('absence', '00000000-0000-4000-c000-00000000000e') = 0, 'approved leave → not absent');

-- 8) a notification failure never blocks the employee -------------------
alter table public.owner_notifications add constraint zz_break check (false) not valid;
update public.profiles set active = true where id = '00000000-0000-4000-c000-00000000000d';
select pg_temp.ok((public.svc_check_in('00000000-0000-4000-c000-00000000000d', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}') ->> 'checked_in_at') is not null,
  'check-in succeeds even when the notification fails');
select pg_temp.ok((select count(*) from public.job_runs where job_name = 'owner_notify' and status = 'failed') = 1, 'the failure is kept in the log');
alter table public.owner_notifications drop constraint zz_break;

-- 9) test notification, status, log -------------------------------------
select pg_temp.ok((select (r ->> 'notification_id') is not null and (r ->> 'push_queued')::int = 1 and (r ->> 'telegram_queued')::boolean
                   from public.svc_owner_notify_test('00000000-0000-4000-c000-000000000001', '{}') r), 'test notification → app + push + Telegram');
select pg_temp.ok((select (r ->> 'telegram_chat_set')::boolean and (r ->> 'push_devices')::int = 1 and (r ->> 'unread')::int >= 7
                   from public.svc_owner_notify_status('00000000-0000-4000-c000-000000000001', '{}') r), 'status: Telegram set, 1 device, unread count');
select pg_temp.ok((select jsonb_array_length(r -> 'deliveries') >= 8 and jsonb_array_length(r -> 'errors') = 1
                   from public.svc_owner_notify_log('00000000-0000-4000-c000-000000000001', '{}') r), 'delivery log lists attempts and the error');
update public.notification_outbox set status = 'failed', attempt_count = 1, last_error = 'telegram 502: Bad Gateway'
 where channel = 'telegram' and subject_id = '00000000-0000-4000-c000-00000000000a' and event_type = 'check_out';
select public.svc_outbox_result(id, false, null, 'telegram 502: Bad Gateway') from public.notification_outbox
 where channel = 'telegram' and subject_id = '00000000-0000-4000-c000-00000000000a' and event_type = 'check_out';
select pg_temp.ok((select status = 'failed' and next_attempt_at > now() and last_error like 'telegram 502%' from public.notification_outbox
                   where channel = 'telegram' and subject_id = '00000000-0000-4000-c000-00000000000a' and event_type = 'check_out'), 'failed send → retried later, error kept');

-- 10) RLS: only the owner reads / marks notifications --------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-c000-00000000000a","role":"authenticated","session_id":"20000000-0000-4000-c000-00000000000a"}';
select pg_temp.ok((select count(*) from public.owner_notifications) = 0, 'staff sees no owner notifications');
select pg_temp.ok((select count(*) from public.notification_outbox) = 0, 'staff sees no delivery log');
update public.owner_notifications set read_at = now();
reset role;
select pg_temp.ok((select count(*) from public.owner_notifications where read_at is not null) = 0, 'staff cannot mark them read');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-c000-000000000001","role":"authenticated","session_id":"20000000-0000-4000-c000-000000000001"}';
select pg_temp.ok((select count(*) from public.owner_notifications) >= 7, 'owner reads the notifications');
update public.owner_notifications set read_at = now() where type = 'check_in';
do $$ begin update public.owner_notifications set body_ar = 'x'; raise exception 'ASSERTION FAILED: owner rewrote a notification';
exception when insufficient_privilege then raise notice 'ok: notification text cannot be edited (read flag only)'; end $$;
reset role;
select pg_temp.ok((select count(*) from public.owner_notifications where read_at is not null and type = 'check_in') >= 2, 'owner marks as read');

do $$ begin raise notice 'OWNER NOTIFICATION TESTS PASSED'; end $$;
