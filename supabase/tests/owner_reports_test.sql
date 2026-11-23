-- =====================================================================
-- Owner Telegram reports (features 5–8). One transaction, rolled back.
-- No network: "sending" is simulated through the outbox functions.
-- =====================================================================
create function pg_temp.ok(cond boolean, msg text) returns text language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ASSERTION FAILED: %', msg; end if;
  raise notice 'ok: %', msg; return 'ok';
end $$;
create function pg_temp.expect_err(stmt text, code text, msg text) returns text language plpgsql as $$
begin
  execute stmt;
  raise exception 'ASSERTION FAILED: % (no error, expected %)', msg, code;
exception when others then
  if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
  if sqlerrm <> 'ZH:' || code then raise exception 'ASSERTION FAILED: % (got "%", expected ZH:%)', msg, sqlerrm, code; end if;
  raise notice 'ok: %', msg; return 'ok';
end $$;

-- fixtures ---------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-c000-000000000001', 'o2@staff.invalid'), ('00000000-0000-4000-c000-00000000000a', 'a2@staff.invalid'),
  ('00000000-0000-4000-c000-00000000000b', 'b2@staff.invalid'), ('00000000-0000-4000-c000-00000000000c', 'c2@staff.invalid');
insert into auth.sessions (id, user_id) values ('30000000-0000-4000-c000-00000000000a', '00000000-0000-4000-c000-00000000000a');
insert into public.profiles (id, full_name_ar, full_name_en, role, created_at) values
  ('00000000-0000-4000-c000-000000000001', 'المالك', 'Owner', 'owner', '2026-01-01'),
  ('00000000-0000-4000-c000-00000000000a', 'أحمد', 'Ahmed', 'staff', '2026-01-01'),
  ('00000000-0000-4000-c000-00000000000b', 'بسمة', 'Basma', 'staff', '2026-01-01'),
  ('00000000-0000-4000-c000-00000000000c', 'جمال', 'Gamal', 'staff', '2026-01-01');
update public.settings set jobs_start_date = '2026-10-01', owner_alert_channel = 'telegram', owner_telegram_chat_id = '123456789',
  notify_events = '{}', absence_streak_enabled = true, absence_streak_enabled_at = '2026-10-01', absence_streak_leave_policy = 'pause';

-- ---------------------------------------------------------------- Africa/Cairo
select pg_temp.ok(private.cairo_local_to_utc('2026-07-01 12:00') = '2026-07-01 09:00+00', 'summer (DST) 12:00 Cairo = 09:00 UTC');
select pg_temp.ok(private.cairo_local_to_utc('2026-01-01 12:00') = '2026-01-01 10:00+00', 'winter 12:00 Cairo = 10:00 UTC');
select pg_temp.expect_err($$select private.cairo_local_to_utc('2027-04-30 00:30')$$, 'local_time_nonexistent', 'spring-forward gap time rejected');
select pg_temp.expect_err($$select private.cairo_local_to_utc('2027-10-28 23:30')$$, 'local_time_ambiguous', 'fall-back repeated time rejected');
select pg_temp.ok(private.cairo_local_to_utc('2028-02-29 09:00') = '2028-02-29 07:00+00', 'leap day resolves');
select pg_temp.ok(private.cairo_local_to_utc('2026-12-31 23:30') = '2026-12-31 21:30+00', 'year end: local 31/12 23:30 is still 2026 in UTC');
select pg_temp.ok(private.cairo_local_to_utc('2027-01-01 01:00') = '2026-12-31 23:00+00', 'UTC/local date boundary (local new year = UTC 31/12)');

-- ---------------------------------------------------------------- message splitting
select pg_temp.ok(cardinality(private.split_report('H', array[repeat('a', 2000), repeat('b', 2000)])) = 2, 'two 2000-char lines → 2 parts');
select pg_temp.ok((select bool_and(char_length(x) <= 3500) and sum(char_length(regexp_replace(x, '^H( \(\d/\d\))?\n\n', '')))::int = 8000
  from unnest(private.split_report('H', array[repeat('x', 8000)])) x), 'one 8000-char line split, nothing lost, every part ≤ 3500');
select pg_temp.ok((private.split_report('H', array[repeat('x', 8000)]))[2] like 'H (2/3)%', 'every part keeps the header + (i/n)');

-- ---------------------------------------------------------------- private chat only
select pg_temp.ok(private.queue_owner_report('weekly_owner', 't', 1, 'h', array['a'], '{}') is null, 'unverified chat → nothing queued');
select pg_temp.ok(not (public.svc_owner_chat_verified('999', 'private') ->> 'verified')::boolean, 'another chat cannot verify itself');
update public.settings set owner_telegram_chat_id = '-1001234567';
select public.svc_owner_chat_verified('-1001234567', 'supergroup');
select pg_temp.ok(private.owner_private_chat() is null, 'a group chat is never a payroll/report destination');
update public.settings set owner_telegram_chat_id = '123456789';
select pg_temp.ok((public.svc_owner_chat_verified('123456789', 'private') ->> 'verified')::boolean, 'Telegram confirms a private chat');
select pg_temp.ok(private.owner_private_chat() = '123456789', 'owner private chat verified');

-- ---------------------------------------------------------------- 8. absence streaks
-- Ahmed: present Sun 01/11, absent Mon–Thu 02–05/11, (Fri/Sat off), absent Sun 08/11, present Mon 09/11, absent 10–11/11
-- Basma: always present.   Gamal: absent 02/11, approved leave 03/11, absent 04/11.
insert into public.attendance_days (employee_id, work_date, checked_in_at, checked_out_at)
select e, d, (d + time '09:00') at time zone 'Africa/Cairo', (d + time '17:00') at time zone 'Africa/Cairo'
  from (values ('00000000-0000-4000-c000-00000000000a'::uuid, '2026-11-01'::date), ('00000000-0000-4000-c000-00000000000a', '2026-11-09'),
               ('00000000-0000-4000-c000-00000000000c', '2026-11-01'), ('00000000-0000-4000-c000-00000000000c', '2026-11-05'),
               ('00000000-0000-4000-c000-00000000000c', '2026-11-08')) v(e, d);
insert into public.attendance_days (employee_id, work_date, checked_in_at, checked_out_at)
select '00000000-0000-4000-c000-00000000000b', g::date, (g::date + time '09:00') at time zone 'Africa/Cairo', (g::date + time '17:00') at time zone 'Africa/Cairo'
  from generate_series('2026-11-01'::date, '2026-11-11', '1 day') g where extract(dow from g) between 0 and 4;
insert into public.leave_requests (employee_id, from_date, to_date, type, status, reason)
values ('00000000-0000-4000-c000-00000000000c', '2026-11-03', '2026-11-03', 'personal', 'approved', 'test');

select private.run_absence('2026-11-01'); select private.run_absence('2026-11-02');
select pg_temp.ok(not exists (select 1 from public.absence_streak_alerts where employee_id = '00000000-0000-4000-c000-00000000000a'), 'one absent day → no alert');
select private.run_absence('2026-11-03');
select pg_temp.ok((select count(*) from public.absence_streak_alerts where employee_id = '00000000-0000-4000-c000-00000000000a') = 1, 'second consecutive absent working day → alert');
select pg_temp.ok((select count(*) from private.owner_reports where kind = 'absence_streak' and report_key like '00000000-0000-4000-c000-00000000000a:%') = 1, 'alert queued once to the owner');
select pg_temp.ok((select bool_and(o.recipient = '123456789' and o.payload::text not like '%أحمد%') from public.notification_outbox o where o.event_type = 'owner_report'), 'outbox row: owner chat only, no names/amounts in the payload');
select private.run_absence('2026-11-04'); select private.run_absence('2026-11-05');
select private.run_absence('2026-11-03');   -- duplicate scheduler run
select pg_temp.ok((select count(*) from private.owner_reports where kind = 'absence_streak' and report_key like '00000000-0000-4000-c000-00000000000a:%') = 1, '3rd/4th day and duplicate runs → no repeat alert');
select private.run_absence('2026-11-08');
select pg_temp.ok((select streak_length from public.absence_streak_alerts where employee_id = '00000000-0000-4000-c000-00000000000a') = 5, 'weekend (Fri/Sat) does not break the streak (5 working days)');
select pg_temp.ok(not exists (select 1 from public.absence_streak_alerts where employee_id = '00000000-0000-4000-c000-00000000000b'), 'present employee: no alert');
select pg_temp.ok((select absent_dates from public.absence_streak_alerts where employee_id = '00000000-0000-4000-c000-00000000000c') = array['2026-11-02', '2026-11-04']::date[], 'approved leave pauses the streak (policy=pause)');
update public.settings set absence_streak_leave_policy = 'break';
select pg_temp.ok(cardinality((private.absence_streak('00000000-0000-4000-c000-00000000000c', '2026-11-04')).dates) = 1, 'policy=break: leave ends the streak');
update public.settings set absence_streak_leave_policy = 'pause';
-- reset + a new streak
select private.run_absence('2026-11-09'); select private.run_absence('2026-11-10');
select pg_temp.ok((select count(*) from public.absence_streak_alerts where employee_id = '00000000-0000-4000-c000-00000000000a') = 1, 'attended day resets; 1 new absence is not yet a streak');
select private.run_absence('2026-11-11');
select pg_temp.ok((select count(*) from public.absence_streak_alerts where employee_id = '00000000-0000-4000-c000-00000000000a' and status = 'alerted') = 2, 'a new qualifying streak after a reset → a new alert');
-- correction: the owner declines Gamal's 04/11 absence → his streak is invalidated (recorded, not deleted)
update public.point_events set status = 'declined' where employee_id = '00000000-0000-4000-c000-00000000000c' and effective_work_date = '2026-11-04' and source = 'auto_absence';
select pg_temp.ok((select status from public.absence_streak_alerts where employee_id = '00000000-0000-4000-c000-00000000000c' and absent_dates @> array['2026-11-02'::date]) = 'invalidated', 'correction → streak invalidated and recorded');
-- correction that shifts a streak start: decline Ahmed's 02/11 → same streak follows, no new alert
update public.point_events set status = 'declined' where employee_id = '00000000-0000-4000-c000-00000000000a' and effective_work_date = '2026-11-02' and source = 'auto_absence';
select pg_temp.ok((select count(*) from private.owner_reports where kind = 'absence_streak' and report_key like '00000000-0000-4000-c000-00000000000a:%') = 2
  and exists (select 1 from public.absence_streak_alerts where employee_id = '00000000-0000-4000-c000-00000000000a' and streak_start = '2026-11-03' and status = 'alerted'),
  'start-shifting correction updates the record without re-alerting');
select pg_temp.ok((select count(*) from public.attendance_days where employee_id = '00000000-0000-4000-c000-00000000000a') = 2, 'attendance history untouched by the alert logic');

-- ---------------------------------------------------------------- 6. Sunday summary
select private.add_event('00000000-0000-4000-c000-00000000000a', '2026-11-01', 'g-test-a1', 'green', 3, 'owner_manual', 'active', 0, 0, null, 'test');
select private.add_event('00000000-0000-4000-c000-00000000000b', '2026-11-01', 'g-test-b1', 'green', 3, 'owner_manual', 'active', 0, 0, null, 'test');
select private.add_event('00000000-0000-4000-c000-00000000000c', '2026-11-01', 'g-test-c1', 'green', 1, 'owner_manual', 'active', 0, 0, null, 'test');
select private.add_event('00000000-0000-4000-c000-00000000000b', '2026-11-02', 'r-test-b1', 'red', 1, 'auto_window', 'active', 5000, 0, null, 'late');
select private.run_sunday_summary('2026-11-01');
select private.run_sunday_summary('2026-11-01');   -- duplicate scheduler invocation
select pg_temp.ok((select count(*) from private.owner_reports where kind = 'weekly_owner' and report_key = '2026-11-01') = 1, 'duplicate Sunday runs → one report');
select pg_temp.ok((select parts[1] from private.owner_reports where kind = 'weekly_owner' and report_key = '2026-11-01') like '%من الأحد 01/11/2026 إلى السبت 07/11/2026%', 'exact closed date range in the message');
select pg_temp.ok((select parts[1] from private.owner_reports where kind = 'weekly_owner') like '%أحمد: 3 أيام%', 'absences counted with the app''s own rule (declined one excluded)');
select pg_temp.ok((select parts[1] from private.owner_reports where kind = 'weekly_owner') like '%بسمة: 1 يوم%', 'lateness counted (days)');
select pg_temp.ok((select parts[1] ~ '1\. أحمد — 3[^\n]*\n1\. بسمة — 3[^\n]*\n3\. جمال — 1' from private.owner_reports where kind = 'weekly_owner'), 'ties share a rank (1, 1, 3)');
select private.run_sunday_summary('2026-10-04');
select pg_temp.ok((select parts[1] like '%لا يوجد تأخير.%' and parts[1] like '%لا يوجد غياب.%' from private.owner_reports where kind = 'weekly_owner' and report_key = '2026-10-04'), 'empty week reports "none"');

-- ---------------------------------------------------------------- 7. payroll summary
insert into public.employee_salaries (employee_id, monthly_salary_piastres) values ('00000000-0000-4000-c000-00000000000a', 800050);
select private.record_job('absence', g::date::text, 'succeeded', '{}') from generate_series('2026-10-01'::date, '2026-10-31', '1 day') g;
insert into public.attendance_days (employee_id, work_date, checked_in_at)   -- open shift on the month's last working day
values ('00000000-0000-4000-c000-00000000000b', '2026-10-29', '2026-10-29 21:00+00');
select private.run_payroll_summary('2026-10-01'); select private.run_payroll_summary('2026-10-01');
select pg_temp.ok((select count(*) from private.owner_reports where kind = 'payroll_blocked') = 1
  and not exists (select 1 from private.owner_reports where kind = 'payroll_summary'), 'open shift → "not final yet" notice once, no figures');
select pg_temp.ok((select parts[1] !~ '\d+,\d{3}' from private.owner_reports where kind = 'payroll_blocked'), 'the notice carries no amounts');
update public.attendance_days set checked_out_at = '2026-10-30 03:00+00' where employee_id = '00000000-0000-4000-c000-00000000000b' and work_date = '2026-10-29';  -- overnight shift closed
select private.add_event('00000000-0000-4000-c000-00000000000a', '2026-10-15', 'blk-test-a', 'black', 1, 'owner_manual', 'active', 100000, 100000, null, 'test');
select private.run_payroll_summary('2026-10-01');
select pg_temp.ok((select count(*) from private.owner_reports where kind = 'payroll_summary' and report_key = '2026-10' and version = 1) = 1, 'final summary v1 after the month closes');
select pg_temp.ok((select parts[1] like '%8,000.50 ج.م%' and parts[1] like '%PR-2026-10-v1%' and parts[1] like '%العملة: جنيه مصري%'
  from private.owner_reports where kind = 'payroll_summary'), 'piastre precision kept (8,000.50), currency + stable id');
select pg_temp.ok((select parts[1] like '%غير مسجل%' from private.owner_reports where kind = 'payroll_summary'), 'missing salary shown, not invented');
select pg_temp.ok((select (meta -> 'totals' ->> 'ded')::bigint = 100000 and (meta -> 'totals' ->> 'salary')::bigint = 800050 from private.owner_reports where kind = 'payroll_summary'), 'company totals');
select pg_temp.ok((select bool_and(payload::text !~ 'salary|800050|8,000') from public.notification_outbox where event_type = 'owner_report'), 'outbox holds no payroll figures');
select private.run_payroll_summary('2026-10-01');
select pg_temp.ok((select count(*) from private.owner_reports where kind = 'payroll_summary') = 1, 'retry with same figures → no second report');
select private.add_event('00000000-0000-4000-c000-00000000000b', '2026-10-20', 'blk-test-b', 'black', 1, 'owner_manual', 'active', 100000, 100000, null, 'test');
select pg_temp.expect_err($$select public.svc_payroll_summary_resend('00000000-0000-4000-c000-00000000000a', '{"month":"2026-10-01"}')$$, 'forbidden', 'staff cannot trigger payroll reports');
select public.svc_payroll_summary_resend('00000000-0000-4000-c000-000000000001', '{"month":"2026-10-01"}');
select pg_temp.ok((select parts[1] like '%تصحيح: النسخة 2 تحل محل النسخة 1%' and parts[1] like '%PR-2026-10-v2%' from private.owner_reports where kind = 'payroll_summary' and version = 2), 'correction is a clearly labelled v2');
select pg_temp.expect_err($$select public.svc_payroll_summary_resend('00000000-0000-4000-c000-000000000001', '{"month":"2099-01-01"}')$$, 'month_not_closed', 'open month cannot be sent as final');
-- the owner changes the chat → queued parts are blocked at send time
update public.settings set owner_telegram_chat_id = '555555555';
select pg_temp.ok((select (public.svc_owner_report_part(o.id) ->> 'blocked') = 'owner_chat_unverified' from public.notification_outbox o where o.event_type = 'owner_report' limit 1),
  'changed/unverified chat → blocked at send time (no fallback)');
select pg_temp.expect_err($$select public.svc_payroll_summary_resend('00000000-0000-4000-c000-000000000001', '{"month":"2026-10-01"}')$$, 'owner_chat_unverified', 'no delivery to an unverified chat');
update public.settings set owner_telegram_chat_id = '123456789';

-- ---------------------------------------------------------------- outbox: retry-after, jitter, exhaustion, uncertain, stale leases
do $$ declare o uuid; r public.notification_outbox; begin
  select id into o from public.notification_outbox where event_type = 'owner_report' order by created_at limit 1;
  update public.notification_outbox set status = 'sending', attempt_count = 1 where id = o;
  perform public.svc_outbox_result_v2(o, false, null, 'telegram 429', false, 30, false);
  select * into r from public.notification_outbox where id = o;
  perform pg_temp.ok(r.status = 'failed' and r.next_attempt_at between now() + interval '30 seconds' and now() + interval '32 seconds', '429 → waits retry_after');
  update public.notification_outbox set status = 'sending', attempt_count = 3 where id = o;
  perform public.svc_outbox_result_v2(o, false, null, 'telegram 502', false, null, false);
  select * into r from public.notification_outbox where id = o;
  perform pg_temp.ok(r.next_attempt_at between now() + interval '6 minutes' and now() + interval '10 minutes', 'backoff with jitter (8 min ±25%)');
  update public.notification_outbox set status = 'sending', attempt_count = 7 where id = o;
  perform public.svc_outbox_result_v2(o, false, null, 'telegram 502', false, null, false);
  perform pg_temp.ok((select status from public.notification_outbox where id = o) = 'dead', 'retries exhausted → terminal');
  select id into o from public.notification_outbox where event_type = 'owner_report' and status = 'pending' order by created_at limit 1;
  update public.notification_outbox set status = 'sending' where id = o;
  perform public.svc_outbox_result_v2(o, false, null, 'network error after send', false, null, true);
  perform pg_temp.ok((select status = 'dead' and last_error like 'uncertain:%' from public.notification_outbox where id = o), 'lost Telegram reply → uncertain, never auto-resent');
  select id into o from public.notification_outbox where event_type = 'owner_report' and status = 'pending' order by created_at limit 1;
  update public.notification_outbox set status = 'sending', next_attempt_at = now() - interval '1 minute' where id = o;
  perform public.svc_claim_outbox(0);
  perform pg_temp.ok((select status = 'dead' and last_error like 'uncertain:%' from public.notification_outbox where id = o), 'crashed worker (stale lease) → uncertain');
  perform public.svc_outbox_result_v2(o, true, '777', null);
  perform pg_temp.ok((select status from public.notification_outbox where id = o) = 'sent', 'a late confirmation still records it as sent');
end $$;
-- overlapping workers: SKIP LOCKED + the claim lease → a row is handed out once
do $$ declare n1 int; n2 int; begin
  n1 := jsonb_array_length(public.svc_claim_outbox(100));
  n2 := jsonb_array_length(public.svc_claim_outbox(100));
  perform pg_temp.ok(n1 > 0 and n1 = (select count(*) from public.notification_outbox where status = 'sending'), 'claim leases every due row once');
  perform pg_temp.ok(n2 = 0, 'a second (overlapping) worker gets nothing');
  update public.notification_outbox set status = 'pending', next_attempt_at = now() where status = 'sending';
end $$;

-- ---------------------------------------------------------------- 5. scheduled announcements
select pg_temp.expect_err($$select public.svc_sched_ann_save('00000000-0000-4000-c000-00000000000a', '{"body":"x","publish_local":"2099-01-01T10:00"}')$$, 'forbidden', 'staff cannot schedule');
select pg_temp.expect_err($$select public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', '{"body":"x","publish_local":"2027-04-30T00:30"}')$$, 'local_time_nonexistent', 'nonexistent local time rejected');
select pg_temp.expect_err($$select public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', '{"body":"x","publish_local":"2020-01-01T10:00"}')$$, 'schedule_out_of_range', 'past time rejected');
select pg_temp.expect_err($$select public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', '{"body":"x","destination":"group_-1001","publish_local":"2099-01-01T10:00"}')$$, 'invalid_destination', 'client-supplied destination rejected');
select pg_temp.expect_err(format($$select public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', '{"body":"x","destination":"owner_telegram","delete_after_minutes":3000,"publish_local":"%s"}')$$,
  to_char(now() at time zone 'Africa/Cairo' + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI')), 'invalid_delete_after', 'Telegram auto-delete beyond 47 h refused');
do $$ declare v jsonb; v_id uuid; t text := to_char(now() at time zone 'Africa/Cairo' + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI'); begin
  v := public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', jsonb_build_object('title', 'اجتماع', 'body', 'اجتماع الساعة 10', 'publish_local', t, 'delete_after_minutes', 60));
  v_id := (v ->> 'id')::uuid;
  perform public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', jsonb_build_object('id', v_id, 'body', 'اجتماع الساعة 11', 'publish_local', t, 'delete_after_minutes', 60));
  perform pg_temp.ok((select body from public.scheduled_announcements where id = v_id) = 'اجتماع الساعة 11', 'edit before sending');
  perform public.svc_sched_ann_cancel('00000000-0000-4000-c000-000000000001', jsonb_build_object('id', v_id));
  perform pg_temp.ok((select status from public.scheduled_announcements where id = v_id) = 'canceled', 'cancel before sending');
  perform pg_temp.expect_err(format($q$select public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', '{"id":"%s","body":"y","publish_local":"%s"}')$q$, v_id, t), 'not_editable', 'cannot edit after cancel');
  -- staff app: publish, then auto-remove
  v := public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', jsonb_build_object('body', 'للموظفين', 'publish_local', t, 'delete_after_minutes', 30));
  v_id := (v ->> 'id')::uuid;
  update public.scheduled_announcements set publish_at = now() - interval '1 minute' where id = v_id;
  perform private.process_scheduled_announcements(); perform private.process_scheduled_announcements();
  perform pg_temp.ok((select status = 'published' and delete_status = 'pending' from public.scheduled_announcements where id = v_id)
    and (select count(*) from public.announcements where body = 'للموظفين') = 1, 'due → published once (duplicate runs safe)');
  update public.scheduled_announcements set delete_at = now() - interval '1 minute' where id = v_id;
  perform private.process_scheduled_announcements();
  perform pg_temp.ok((select delete_status from public.scheduled_announcements where id = v_id) = 'deleted'
    and not exists (select 1 from public.announcements where body = 'للموظفين'), 'auto-removed after the set time; record kept');
  -- outage: more than 6 h late → not sent
  v := public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', jsonb_build_object('body', 'قديم', 'publish_local', t));
  update public.scheduled_announcements set publish_at = now() - interval '7 hours' where id = (v ->> 'id')::uuid;
  perform private.process_scheduled_announcements();
  perform pg_temp.ok((select status from public.scheduled_announcements where id = (v ->> 'id')::uuid) = 'failed'
    and not exists (select 1 from public.announcements where body = 'قديم'), 'missed by > 6 h → expired, not sent');
  -- owner Telegram: long text → 2 messages, ids tracked, deletion partially refused
  v := public.svc_sched_ann_save('00000000-0000-4000-c000-000000000001', jsonb_build_object('body', repeat('سطر طويل للتجربة ', 120) || E'\n' || repeat('سطر ثاني ', 200),
     'destination', 'owner_telegram', 'publish_local', t, 'delete_after_minutes', 60));
  v_id := (v ->> 'id')::uuid;
  update public.scheduled_announcements set publish_at = now() - interval '1 minute' where id = v_id;
  perform private.process_scheduled_announcements();
  perform pg_temp.ok((select status = 'sending' and parts_total = 2 from public.scheduled_announcements where id = v_id), 'long announcement → 2 Telegram messages');
  perform public.svc_outbox_result_v2(o.id, true, (100 + (o.payload ->> 'part')::int)::text, null)
     from public.notification_outbox o where o.event_ref = 'announcement:' || v_id || ':v1';
  perform pg_temp.ok((select status = 'published' and telegram_message_ids = array[101, 102]::bigint[] and delete_status = 'pending' from public.scheduled_announcements where id = v_id), 'each message id tracked');
  update public.scheduled_announcements set delete_at = now() - interval '1 minute' where id = v_id;
  perform private.process_scheduled_announcements();
  perform pg_temp.ok((select count(*) from public.notification_outbox where event_type = 'telegram_delete' and payload ->> 'sched_id' = v_id::text) = 2, 'one deletion per message');
  perform public.svc_outbox_result_v2(o.id, (o.payload ->> 'message_id') = '101', null, 'telegram 400: message can''t be deleted', (o.payload ->> 'message_id') = '102')
     from public.notification_outbox o where o.event_type = 'telegram_delete' and o.payload ->> 'sched_id' = v_id::text;
  perform pg_temp.ok((select status = 'published' and delete_status = 'failed' and deleted_message_ids = array[101]::bigint[] from public.scheduled_announcements where id = v_id),
    'deletion failure reported; publication record kept, not marked deleted');
end $$;
select pg_temp.expect_err($$select public.svc_sched_ann_cancel('00000000-0000-4000-c000-000000000001', '{"id":"not-a-uuid"}')$$, 'not_found', 'forged id rejected');
select pg_temp.expect_err($$select public.svc_bot_reports_status('00000000-0000-4000-c000-00000000000a', '{}')$$, 'forbidden', 'staff cannot read report status');

-- ---------------------------------------------------------------- non-owner database access
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-c000-00000000000a","session_id":"30000000-0000-4000-c000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
do $$ begin perform * from public.scheduled_announcements; raise exception 'ASSERTION FAILED: staff read scheduled announcements';
exception when insufficient_privilege then raise notice 'ok: staff cannot read scheduled announcements'; end $$;
do $$ begin perform * from public.absence_streak_alerts; raise exception 'ASSERTION FAILED: staff read streak alerts';
exception when insufficient_privilege then raise notice 'ok: staff cannot read absence alerts'; end $$;
do $$ begin perform * from private.owner_reports; raise exception 'ASSERTION FAILED: staff read payroll snapshots';
exception when insufficient_privilege then raise notice 'ok: staff cannot read report snapshots (payroll)'; end $$;
do $$ begin perform public.svc_owner_report_part(gen_random_uuid()); raise exception 'ASSERTION FAILED: staff called a service function';
exception when insufficient_privilege then raise notice 'ok: service functions are not callable by users'; end $$;
reset role;

select 'OWNER REPORT TESTS PASSED' as result;
