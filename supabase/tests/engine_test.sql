-- =====================================================================
-- Engine tests (Steps 3–10). Run inside ONE transaction, rolled back.
-- Times are made deterministic by configuring today's windows relative
-- to the current server time.
-- =====================================================================
create function pg_temp.ok(cond boolean, msg text) returns text language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ASSERTION FAILED: %', msg; end if;
  raise notice 'ok: %', msg; return 'ok';
end $$;
-- expect a ZH error code from a statement
create function pg_temp.expect_err(stmt text, code text, msg text) returns text language plpgsql as $$
begin
  execute stmt;
  raise exception 'ASSERTION FAILED: % (no error, expected %)', msg, code;
exception when others then
  if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
  if sqlerrm <> 'ZH:' || code then raise exception 'ASSERTION FAILED: % (got "%", expected ZH:%)', msg, sqlerrm, code; end if;
  raise notice 'ok: %', msg; return 'ok';
end $$;

-- fixtures ------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-b000-000000000001', 'o@staff.invalid'), ('00000000-0000-4000-b000-00000000000a', 'a@staff.invalid'),
  ('00000000-0000-4000-b000-00000000000b', 'b@staff.invalid'), ('00000000-0000-4000-b000-00000000000c', 'c@staff.invalid'),
  ('00000000-0000-4000-b000-00000000000d', 'd@staff.invalid');
insert into auth.sessions (id, user_id) values
  ('20000000-0000-4000-b000-00000000000a', '00000000-0000-4000-b000-00000000000a'),
  ('20000000-0000-4000-b000-000000000001', '00000000-0000-4000-b000-000000000001');
insert into public.profiles (id, full_name_ar, full_name_en, role, created_at) values
  ('00000000-0000-4000-b000-000000000001', 'المالك', 'Owner T', 'owner', now() - interval '30 days'),
  ('00000000-0000-4000-b000-00000000000a', 'أ أ', 'Staff A', 'staff', now() - interval '30 days'),
  ('00000000-0000-4000-b000-00000000000b', 'ب ب', 'Staff B', 'staff', now() - interval '30 days'),
  ('00000000-0000-4000-b000-00000000000c', 'ج ج', 'Staff C', 'staff', now() - interval '30 days'),
  ('00000000-0000-4000-b000-00000000000d', 'د د', 'Staff D', 'staff', now() - interval '30 days');
update public.profiles set active = false where id = '00000000-0000-4000-b000-00000000000d';
update public.settings set jobs_start_date = (now() at time zone 'Africa/Cairo')::date - 7;
delete from public.public_holidays where holiday_date = (now() at time zone 'Africa/Cairo')::date;

-- 1) window boundaries (Sunday = seeded Early/Normal/Late) -------------
select pg_temp.ok((select outcome from private.evaluate_time('2026-11-22', '06:59')) = 'none', 'before first window → no point');
select pg_temp.ok((select outcome from private.evaluate_time('2026-11-22', '07:00')) = 'green', 'exactly at window start → green');
select pg_temp.ok((select outcome from private.evaluate_time('2026-11-22', '08:00')) = 'none', 'exactly at window end (gap follows) → no point');
select pg_temp.ok((select outcome from private.evaluate_time('2026-11-22', '08:30')) = 'none', 'between windows → no point');
select pg_temp.ok((select outcome from private.evaluate_time('2026-11-22', '10:00')) = 'green', 'Normal end = Late start → green (Late)');
select pg_temp.ok((select outcome from private.evaluate_time('2026-11-22', '10:59:59')) = 'green', 'just before last end → green');
select pg_temp.ok((select outcome from private.evaluate_time('2026-11-22', '11:00')) = 'red', 'exactly at last window end → red');
select pg_temp.ok((select outcome from private.evaluate_time('2026-11-22', '16:00')) = 'red', 'after last window → red');
select pg_temp.ok((select outcome from private.evaluate_time('2026-11-27', '12:00')) = 'none'
  and (select config_warning from private.evaluate_time('2026-11-27', '12:00')), 'day with no enabled windows → no point + config warning');
select pg_temp.expect_err($$select public.svc_save_day(null, '{"day_of_week":0,"windows":[{"label_ar":"أ","label_en":"A","start":"09:00","end":"10:00"},{"label_ar":"ب","label_en":"B","start":"09:30","end":"11:00"}]}')$$,
  'windows_overlap', 'overlapping windows rejected');

-- configure TODAY: work day, window open now, geofence at the office --
do $$ declare v_dow int := extract(dow from (now() at time zone 'Africa/Cairo')); t time := (now() at time zone 'Africa/Cairo')::time;
begin
  update public.day_rules set is_work_day = true, check_in_enabled = true, points_enabled = true where day_of_week = v_dow;
  delete from public.check_in_windows where day_of_week = v_dow;
  if t > '00:30' and t < '23:20' then
    insert into public.check_in_windows (day_of_week, label_ar, label_en, start_time, end_time)
    values (v_dow, 'الآن', 'Now', t - interval '20 minutes', t + interval '20 minutes');
  end if;
end $$;

-- 2) check-in / out -------------------------------------------------
select pg_temp.expect_err($$select public.svc_check_in('00000000-0000-4000-b000-00000000000a', '{"lat":30.05,"lng":31.24,"accuracy":10}')$$, 'outside_geofence', 'check-in outside the radius fails');
select pg_temp.expect_err($$select public.svc_check_in('00000000-0000-4000-b000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":500}')$$, 'accuracy_too_low', 'accuracy worse than radius → unverified');
select pg_temp.expect_err($$select public.svc_check_in('00000000-0000-4000-b000-00000000000a', '{"lat":"NaN","lng":31.3,"accuracy":5}')$$, 'invalid_coordinates', 'non-finite coordinates rejected');
select pg_temp.expect_err($$select public.svc_check_in('00000000-0000-4000-b000-00000000000a', '{"lat":95,"lng":31.3,"accuracy":5}')$$, 'invalid_coordinates', 'out-of-range coordinates rejected');
select pg_temp.expect_err($$select public.svc_check_out('00000000-0000-4000-b000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":5}')$$, 'not_checked_in', 'check-out before check-in impossible');
select pg_temp.ok((public.svc_check_in('00000000-0000-4000-b000-00000000000a', '{"lat":29.98325,"lng":31.32400,"accuracy":12}') ->> 'outcome') = 'green', 'check-in inside an open window → green');
select pg_temp.ok((select checked_in_at is not null and window_id is not null from public.attendance_days where employee_id = '00000000-0000-4000-b000-00000000000a'), 'server timestamp + matched window stored');
select pg_temp.expect_err($$select public.svc_check_in('00000000-0000-4000-b000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":10}')$$, 'already_checked_in', 'second check-in same day rejected');
update public.attendance_days set checked_in_at = now() - interval '125 minutes' where employee_id = '00000000-0000-4000-b000-00000000000a';
select pg_temp.ok((public.svc_check_out('00000000-0000-4000-b000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}') ->> 'worked_minutes')::int = 125, 'worked_minutes computed server-side (125)');
select pg_temp.expect_err($$select public.svc_check_out('00000000-0000-4000-b000-00000000000a', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}')$$, 'already_checked_out', 'duplicate check-out rejected');
select pg_temp.ok((select green from public.v_point_totals where employee_id = '00000000-0000-4000-b000-00000000000a') = 1, 'green total derived = 1');
select pg_temp.expect_err($$select public.svc_check_in('00000000-0000-4000-b000-000000000001', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}')$$, 'staff_only', 'owner account is not tracked');

-- 3) #12 closing time + red warning policy + rule version snapshots ----
-- a seeded work day (Sun–Thu, Early/Normal/Late) that is NOT today's weekday
create function pg_temp.other_day() returns date language sql as $$
  select d::date from generate_series((now() at time zone 'Africa/Cairo')::date + 1, (now() at time zone 'Africa/Cairo')::date + 7, interval '1 day') d
   where extract(dow from d) between 0 and 4 and extract(dow from d) <> extract(dow from (now() at time zone 'Africa/Cairo')) limit 1 $$;
select pg_temp.ok(private.checkin_close_time(pg_temp.other_day()) = '11:00', 'closing time = end of the last enabled window (11:00)');
select pg_temp.ok(not private.checkin_closed(pg_temp.other_day(), '10:59:59'), 'just before closing → check-in allowed');
select pg_temp.ok(private.checkin_closed(pg_temp.other_day(), '11:00'), 'exactly at closing → closed');
select pg_temp.ok(private.checkin_closed(pg_temp.other_day(), '11:00:01'), 'just after closing → closed');
select pg_temp.ok(private.checkin_close_time('2026-11-27') is null and not private.checkin_closed('2026-11-27', '23:00'), 'day without enabled windows → no closing rule');
do $$ declare v_dow int := extract(dow from (now() at time zone 'Africa/Cairo')); t time := (now() at time zone 'Africa/Cairo')::time;
begin  -- move the only window into the past → the day is closed for new check-ins
  update public.check_in_windows set start_time = '00:00', end_time = (t - interval '1 minute')::time where day_of_week = v_dow;
end $$;
select pg_temp.expect_err($$select public.svc_check_in('00000000-0000-4000-b000-00000000000b', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}')$$, 'check_in_closed', 'check-in after the last window closed is refused (server clock)');
select pg_temp.ok((select count(*) from public.attendance_days where employee_id = '00000000-0000-4000-b000-00000000000b') = 0, 'refused check-in writes no attendance row');
select pg_temp.ok((select count(*) from public.point_events where employee_id = '00000000-0000-4000-b000-00000000000b') = 0, 'refused check-in creates no point/penalty');
select pg_temp.ok((public.svc_my_day('00000000-0000-4000-b000-00000000000b') ->> 'check_in_closed')::boolean, 'my_day reports the day as closed');
-- the red warning policy itself is unchanged (exercised through owner-added reds)
select public.svc_manual_adjust('00000000-0000-4000-b000-000000000001', '{"employee_id":"00000000-0000-4000-b000-00000000000b","action":"add","color":"red","reason":"late meeting 1"}');
select pg_temp.ok((select warning_only and deduction_amount_piastres = 0 from public.point_events where employee_id = '00000000-0000-4000-b000-00000000000b' and color = 'red'), 'first red of the period is a warning (0 EGP)');

select pg_temp.ok((public.svc_update_settings('00000000-0000-4000-b000-000000000001', '{"red_penalty_piastres": 7500}') ->> 'rule_version')::int = 2, 'editing the red amount bumps rule_version');
select pg_temp.expect_err($$select public.svc_update_settings(null, '{"red_penalty_piastres": 7550}')$$, 'invalid_amount', 'fractional EGP amount rejected');
select pg_temp.expect_err($$select public.svc_update_settings(null, '{"work_start_time": "18:00"}')$$, 'invalid_settings', 'work start after end rejected');
select pg_temp.expect_err($$select public.svc_update_settings(null, '{"green_reward_threshold": 0}')$$, 'invalid_settings', 'threshold < 1 rejected');
select pg_temp.ok((select count(*) from public.audit_log where action = 'settings.update') = 1, 'settings change audited with before/after');
select public.svc_manual_adjust('00000000-0000-4000-b000-000000000001', '{"employee_id":"00000000-0000-4000-b000-00000000000b","action":"add","color":"red","reason":"late meeting"}');
select pg_temp.ok((select count(*) from public.point_events where employee_id = '00000000-0000-4000-b000-00000000000b' and color = 'red' and not warning_only and deduction_amount_piastres = 7500) = 1, 'second red is chargeable at the NEW rate (75 EGP)');
select pg_temp.ok((select applied_rule_version from public.point_events where employee_id = '00000000-0000-4000-b000-00000000000b' and color = 'red' and warning_only) = 1, 'earlier event keeps its applied rule version 1');
-- removing the warning red makes the remaining red the warning (deterministic recalculation)
select public.svc_manual_adjust('00000000-0000-4000-b000-000000000001', '{"employee_id":"00000000-0000-4000-b000-00000000000b","action":"remove","color":"red","reason":"correction"}');
select pg_temp.ok((select count(*) from public.point_events e where employee_id = '00000000-0000-4000-b000-00000000000b' and color = 'red' and delta > 0 and status = 'active' and not private.is_reversed(e.id) and warning_only) = 1, 'after a red correction the first remaining red is the warning');
select pg_temp.expect_err($$select public.svc_manual_adjust(null, '{"employee_id":"00000000-0000-4000-b000-00000000000c","action":"remove","color":"red","reason":"x x"}')$$, 'negative_total', 'manual remove cannot make totals negative');
select pg_temp.expect_err($$select public.svc_manual_adjust(null, '{"employee_id":"00000000-0000-4000-b000-00000000000c","action":"add","color":"black","reason":"x x"}')$$, 'confirm_amount', 'black add requires explicit amount confirmation');

-- 4) absence job ------------------------------------------------------
insert into public.leave_requests (employee_id, type, from_date, to_date, status)
values ('00000000-0000-4000-b000-00000000000a', 'personal', (now() at time zone 'Africa/Cairo')::date - 1, (now() at time zone 'Africa/Cairo')::date - 1, 'approved');
select private.run_absence((now() at time zone 'Africa/Cairo')::date);
select private.run_absence((now() at time zone 'Africa/Cairo')::date);
select pg_temp.ok((select count(*) from public.point_events where source = 'auto_absence' and employee_id = '00000000-0000-4000-b000-00000000000c') = 1, 'no check-in, no leave → exactly one pending black (job ran twice)');
select pg_temp.ok((select status from public.point_events where source = 'auto_absence' and employee_id = '00000000-0000-4000-b000-00000000000c') = 'pending_approval', 'absence black is pending approval');
select pg_temp.ok((select count(*) from public.point_events where source = 'auto_absence' and employee_id = '00000000-0000-4000-b000-00000000000d') = 0, 'inactive employee skipped');
select pg_temp.ok((select count(*) from public.point_events where source = 'auto_absence' and employee_id = '00000000-0000-4000-b000-00000000000a') = 0, 'checked-in employee gets no absence');
select pg_temp.ok((select count(*) from public.point_events where source = 'auto_absence' and employee_id = '00000000-0000-4000-b000-00000000000b') = 1, 'refused late check-in → absence follows its ORIGINAL path (pending black)');
select pg_temp.ok((select detail::text like '%No Check-In, No Leave -> Black Point Pending Approval%' from public.job_runs where job_name = 'absence' limit 1), 'per-employee log line recorded');
select private.run_absence((now() at time zone 'Africa/Cairo')::date - 1);
select pg_temp.ok((select detail::text like '%Approved Leave Found -> No Absence Penalty%' from public.job_runs where job_name = 'absence' and run_key = ((now() at time zone 'Africa/Cairo')::date - 1)::text)
   or (select status from public.job_runs where job_name = 'absence' and run_key = ((now() at time zone 'Africa/Cairo')::date - 1)::text) = 'skipped',
   'approved leave → "Approved Leave Found -> No Absence Penalty" (or day skipped)');
select pg_temp.ok((select black from public.v_point_totals where employee_id = '00000000-0000-4000-b000-00000000000c') is null, 'pending black does not count in totals');
-- a check-in while a window is still open cancels a pending absence (never both)
do $$ declare v_dow int := extract(dow from (now() at time zone 'Africa/Cairo')); t time := (now() at time zone 'Africa/Cairo')::time;
begin
  if t > '00:30' and t < '23:20' then
    update public.check_in_windows set start_time = (t - interval '20 minutes')::time, end_time = (t + interval '20 minutes')::time where day_of_week = v_dow;
  end if;
end $$;
select public.svc_check_in('00000000-0000-4000-b000-00000000000c', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}');
select pg_temp.ok((select status from public.point_events where source = 'auto_absence' and employee_id = '00000000-0000-4000-b000-00000000000c'
   and effective_work_date = (now() at time zone 'Africa/Cairo')::date) = 'cancelled', 'check-in cancels the pending absence');
select pg_temp.ok((select count(*) from public.point_events where employee_id = '00000000-0000-4000-b000-00000000000c' and color = 'black' and status = 'active'
   and effective_work_date = (now() at time zone 'Africa/Cairo')::date) = 0, '… and never charges absence for a day with a check-in');

-- 5) black approval + retroactive leave -------------------------------
select private.add_event('00000000-0000-4000-b000-00000000000c', (now() at time zone 'Africa/Cairo')::date - 2,
  'absence:test:c:2', 'black', 1, 'auto_absence', 'pending_approval', 100000, 0, null, 'test absence');
select pg_temp.expect_err(format($$select public.svc_decide_black(null, '{"event_id":"%s","approve":true}')$$,
  (select id from public.point_events where idempotency_key = 'absence:test:c:2')), 'confirm_amount', 'approving a black needs the amount confirmed');
select public.svc_decide_black('00000000-0000-4000-b000-000000000001', jsonb_build_object('event_id',
  (select id from public.point_events where idempotency_key = 'absence:test:c:2'), 'approve', true, 'confirm_amount_piastres', 100000));
select pg_temp.ok((select status = 'active' and deduction_amount_piastres = 100000 from public.point_events where idempotency_key = 'absence:test:c:2'), 'approved black deducts 1,000 EGP');
select pg_temp.ok((public.svc_decide_black(null, jsonb_build_object('event_id', (select id from public.point_events where idempotency_key = 'absence:test:c:2'), 'approve', false)) ->> 'result') = 'already_decided', 'second decision is a no-op');
insert into public.leave_requests (id, employee_id, type, from_date, to_date)
values ('30000000-0000-4000-b000-000000000001', '00000000-0000-4000-b000-00000000000c', 'sick', (now() at time zone 'Africa/Cairo')::date - 2, (now() at time zone 'Africa/Cairo')::date - 2);
select public.svc_decide_leave('00000000-0000-4000-b000-000000000001', '{"id":"30000000-0000-4000-b000-000000000001","approve":true}');
select public.svc_decide_leave('00000000-0000-4000-b000-000000000001', '{"id":"30000000-0000-4000-b000-000000000001","approve":true}');
select pg_temp.ok((select count(*) from public.point_events where reverses_event_id = (select id from public.point_events where idempotency_key = 'absence:test:c:2')) = 1, 'retro leave writes ONE linked reversal (idempotent)');
select pg_temp.ok((select source from public.point_events where reverses_event_id = (select id from public.point_events where idempotency_key = 'absence:test:c:2')) = 'leave_reversal', 'reversal source = leave_reversal');
select public.svc_cancel_leave('00000000-0000-4000-b000-00000000000c', '{"id":"30000000-0000-4000-b000-000000000001"}');
select pg_temp.ok((select count(*) from public.point_events where reverses_event_id = (select id from public.point_events where idempotency_key = 'absence:test:c:2') and status = 'active') = 1, 'cancelling the leave does not resurrect the reversed point');

-- 6) early leave ------------------------------------------------------
update public.settings set work_end_time = '23:59';  -- test-only: keep "now + 5 min" inside the work day
select pg_temp.expect_err($$select public.svc_request_early_leave('00000000-0000-4000-b000-00000000000a', '{"leave_time":"00:01"}')$$, 'invalid_time', 'early leave before now rejected');
do $$ declare r jsonb; t text := to_char((now() at time zone 'Africa/Cairo') + interval '5 minutes', 'HH24:MI');
begin
  if (now() at time zone 'Africa/Cairo')::time < '23:40' then
    r := public.svc_request_early_leave('00000000-0000-4000-b000-00000000000a', jsonb_build_object('leave_time', t, 'reason', 'doctor'));
    perform pg_temp.ok(r ->> 'status' = 'pending', 'early leave request created pending');
    perform pg_temp.expect_err(format($q$select public.svc_request_early_leave('00000000-0000-4000-b000-00000000000a', '{"leave_time":"%s"}')$q$, t), 'already_pending', 'one pending request per day');
    perform pg_temp.ok((public.svc_decide_early_leave('00000000-0000-4000-b000-000000000001', jsonb_build_object('id', r ->> 'id', 'approve', true, 'channel', 'telegram')) ->> 'result') = 'decided', 'decided via the Telegram channel');
    perform pg_temp.ok((public.svc_decide_early_leave('00000000-0000-4000-b000-000000000001', jsonb_build_object('id', r ->> 'id', 'approve', false, 'channel', 'dashboard')) ->> 'result') = 'already_decided', 'second decision from the dashboard is a no-op');
    perform pg_temp.ok((select decision_channel = 'telegram' from public.early_leave_requests where id = (r ->> 'id')::bigint), 'decision channel recorded');
    perform pg_temp.ok((public.svc_my_day('00000000-0000-4000-b000-00000000000a') ->> 'expected_end_time') = t || ':00', 'approved early leave sets the expected leaving time');
  end if;
end $$;

-- 7) outcome points + reward request ---------------------------------
select public.svc_award_outcome('00000000-0000-4000-b000-000000000001', '{"employee_id":"00000000-0000-4000-b000-00000000000a","category":"deal_closed","note":"Closed the X deal"}');
select pg_temp.ok((select count(*) from public.point_events where source = 'owner_outcome' and outcome_category = 'deal_closed') = 1, 'outcome point recorded with category + note');
select pg_temp.expect_err($$select public.svc_request_reward('00000000-0000-4000-b000-00000000000a', '{"payout_method":"instapay","payout_number":"01001234567"}')$$, 'not_eligible', 'reward request blocked below the threshold');
select public.svc_manual_adjust('00000000-0000-4000-b000-000000000001', '{"employee_id":"00000000-0000-4000-b000-00000000000a","action":"set","color":"green","value":30,"reason":"test set"}');
select pg_temp.ok(private.period_total('00000000-0000-4000-b000-00000000000a', 'green', private.period_of((now() at time zone 'Africa/Cairo')::date)) = 30, '"Set" brings the derived total to 30 with correcting events');
select public.svc_request_reward('00000000-0000-4000-b000-00000000000a', '{"payout_method":"vodafone_cash","payout_number":"01001234567"}');
select pg_temp.expect_err($$select public.svc_request_reward('00000000-0000-4000-b000-00000000000a', '{"payout_method":"instapay","payout_number":"01001234567"}')$$, 'already_requested', 'duplicate reward request blocked');
select pg_temp.ok((select reward_amount_piastres from public.reward_requests where employee_id = '00000000-0000-4000-b000-00000000000a') = 10000, 'reward amount snapshotted (100 EGP)');
select public.svc_decide_reward('00000000-0000-4000-b000-000000000001', jsonb_build_object('id', (select id from public.reward_requests where employee_id = '00000000-0000-4000-b000-00000000000a'), 'action', 'approve'));
select pg_temp.expect_err(format($$select public.svc_decide_reward(null, '{"id":"%s","action":"paid"}')$$, (select id from public.reward_requests where employee_id = '00000000-0000-4000-b000-00000000000a')), 'reference_required', 'mark paid needs a payment reference');
select public.svc_decide_reward('00000000-0000-4000-b000-000000000001', jsonb_build_object('id', (select id from public.reward_requests where employee_id = '00000000-0000-4000-b000-00000000000a'), 'action', 'paid', 'reference', 'IP-123'));
select pg_temp.expect_err($$select public.svc_request_reward('00000000-0000-4000-b000-00000000000a', '{"payout_method":"instapay","payout_number":"01001234567"}')$$, 'already_requested', 'a paid request never unlocks a second payment');

-- 8) payroll ----------------------------------------------------------
select public.svc_payroll(null, '{}');
select public.svc_payroll(null, '{}');
select pg_temp.ok((select count(*) from public.payroll_reports where employee_id = '00000000-0000-4000-b000-00000000000c') = 1, 'payroll recalculation updates in place (no duplicates)');
select pg_temp.ok((select calculation_version from public.payroll_reports where employee_id = '00000000-0000-4000-b000-00000000000c') = 2, 'calculation_version incremented');
select pg_temp.ok((select (points_breakdown ->> 'black_approved')::int = 0 and deductions_piastres = (select coalesce(sum(deduction_amount_piastres),0) from public.point_events e where e.employee_id = '00000000-0000-4000-b000-00000000000c' and e.status='active' and e.delta>0 and not private.is_reversed(e.id) and e.reward_period = private.period_of((now() at time zone 'Africa/Cairo')::date))
   from public.payroll_reports where employee_id = '00000000-0000-4000-b000-00000000000c'), 'reversed black excluded; deductions match active events');
select pg_temp.ok((select bonuses_earned_piastres = 10000 and bonuses_paid_piastres = 10000 from public.payroll_reports where employee_id = '00000000-0000-4000-b000-00000000000a'), 'paid reward not counted again as unpaid bonus');
select pg_temp.ok((select count(*) from public.monthly_deductions) >= 3, 'monthly_deductions rows upserted');

-- 9) holidays skip everything -----------------------------------------
insert into public.public_holidays (holiday_date, name_ar, name_en, kind) values ((now() at time zone 'Africa/Cairo')::date, 'عطلة اختبار', 'Test holiday', 'company');
select pg_temp.expect_err($$select public.svc_check_in('00000000-0000-4000-b000-00000000000d', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}')$$, 'holiday', 'check-in on a holiday is refused');
delete from public.job_runs where job_name = 'absence';
select private.run_absence((now() at time zone 'Africa/Cairo')::date);
select pg_temp.ok((select status from public.job_runs where job_name = 'absence' and run_key = ((now() at time zone 'Africa/Cairo')::date)::text) = 'skipped', 'absence job skips a holiday');
select pg_temp.ok(private.enqueue_reminders() = 0, 'no reminders on a holiday');
update public.public_holidays set enabled = false where name_en = 'Test holiday';

-- 10) reminders + outbox ----------------------------------------------
insert into public.push_subscriptions (id, employee_id, endpoint, p256dh, auth_key) values
  ('40000000-0000-4000-b000-000000000001', '00000000-0000-4000-b000-00000000000b', 'https://push.example/1', 'k', 'a');
select private.enqueue_push('00000000-0000-4000-b000-00000000000b', 'shift_start', 'test-day', 't', 'b', 't', 'b');
select private.enqueue_push('00000000-0000-4000-b000-00000000000b', 'shift_start', 'test-day', 't', 'b', 't', 'b');
select pg_temp.ok((select count(*) from public.notification_outbox where event_type = 'shift_start') = 1, 'push reminder is idempotent per employee+device+day+kind');
update public.profiles set reminders_enabled = false where id = '00000000-0000-4000-b000-00000000000b';
select pg_temp.ok(private.enqueue_push('00000000-0000-4000-b000-00000000000b', 'shift_end', 'test-day', 't', 'b', 't', 'b') = 0, 'per-employee toggle off → no reminder');
select pg_temp.ok(jsonb_array_length(public.svc_claim_outbox(100)) >= 1, 'dispatcher claims due messages');
select public.svc_outbox_result((select id from public.notification_outbox where event_type = 'shift_start'), false, null, 'gone', true);
select pg_temp.ok((select not enabled from public.push_subscriptions where id = '40000000-0000-4000-b000-000000000001'), '404/410 disables the subscription');
select public.svc_outbox_result((select id from public.notification_outbox where event_type = 'black_pending' order by created_at, id limit 1), false, null, 'timeout', false);
select pg_temp.ok((select status = 'failed' and next_attempt_at > now() from public.notification_outbox where event_type = 'black_pending' order by created_at, id limit 1), 'failed send scheduled for retry (never blocks the write)');

-- 12) #3 12-hour Cairo time + #2 leave alert ------------------------------
select pg_temp.ok(private.fmt12('16:44', 'ar') = '4:44 م' and private.fmt12('16:44', 'en') = '4:44 PM', '16:44 → 4:44 م / 4:44 PM');
select pg_temp.ok(private.fmt12('00:05', 'ar') = '12:05 ص' and private.fmt12('12:00', 'en') = '12:00 PM', 'midnight → 12:05 ص, noon → 12:00 PM');
select pg_temp.ok(private.fmt12_ts('2026-07-15T13:44:00Z', 'en') = '4:44 PM', 'summer (UTC+3) timestamp → 4:44 PM Cairo');
select pg_temp.ok(private.fmt12_ts('2026-01-15T14:44:00Z', 'en') = '4:44 PM', 'winter (UTC+2) timestamp → 4:44 PM Cairo');
select public.svc_request_leave('00000000-0000-4000-b000-00000000000b', jsonb_build_object('type', 'sick', 'from_date', (now() at time zone 'Africa/Cairo')::date + 3, 'to_date', (now() at time zone 'Africa/Cairo')::date + 4, 'reason', 'flu'));
select pg_temp.ok((select count(*) from public.notification_outbox where event_type = 'leave_request' and channel = 'telegram') = 1, 'new leave request queues ONE owner Telegram alert');
select pg_temp.ok((select payload ->> 'type' = 'sick' and payload ->> 'reason' = 'flu' and (payload ->> 'days')::int = 2 and payload ->> 'status' = 'pending'
   from public.notification_outbox where event_type = 'leave_request'), 'alert carries employee, type, period, reason and status');
select pg_temp.ok((select recipient from public.notification_outbox where event_type = 'leave_request') = (select owner_telegram_chat_id from public.settings), 'sent only to the owner chat');

-- 11) leaderboard privacy ----------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-b000-00000000000a","session_id":"20000000-0000-4000-b000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.ok((select count(*) from public.get_leaderboard()) = 3, 'leaderboard lists active staff only');
select pg_temp.ok((select green from public.get_leaderboard() where is_me) = 30, 'own row flagged + green progress');
select pg_temp.ok((select count(*) from information_schema.routines r where r.routine_name = 'get_leaderboard') = 2, 'leaderboard functions: no-arg + scoped overload');
select pg_temp.ok((select array_agg(distinct p.proretset::text) = '{true}' and bool_and(pg_get_function_result(p.oid) not like '%red%' and pg_get_function_result(p.oid) not like '%black%' and pg_get_function_result(p.oid) not like '%deduct%')
   from pg_proc p where p.proname = 'get_leaderboard'), 'both expose rank/name/green/threshold only (no penalties)');
select pg_temp.ok((select green from public.get_leaderboard('month') where is_me) = 30, 'scope month = current period');
select pg_temp.ok((select coalesce(sum(green), 0) from public.get_leaderboard('prev')) = 0, 'scope prev = previous period (empty in fixtures)');
select pg_temp.ok((select green from public.get_leaderboard('all') where is_me) >= 30, 'scope all = lifetime green');
select pg_temp.expect_err($$select * from public.get_leaderboard('x')$$, 'invalid_scope', 'unknown scope rejected');
reset role;
update public.settings set leaderboard_visible = false;
set local role authenticated;
select pg_temp.ok((select count(*) from public.get_leaderboard()) = 0, 'leaderboard toggle off → staff data path returns nothing');
reset role;

-- 13) audit fixes + admin-bot backend ------------------------------------
-- login: parallel attempts can no longer exceed the failure allowance
select pg_temp.ok((select bool_and((public.svc_login_precheck('iphash-par', 'devhash-par') ->> 'allowed')::boolean) from generate_series(1, 5)), 'five in-flight login attempts allowed');
select pg_temp.ok(not (public.svc_login_precheck('iphash-par', 'devhash-par') ->> 'allowed')::boolean, '6th parallel attempt refused before any code is checked');
select pg_temp.ok((public.svc_login_precheck('iphash-ok', 'devhash-ok') ->> 'attempt_id') is not null, 'pre-check reserves an attempt row');
select public.svc_login_record('iphash-ok', 'devhash-ok', true, '00000000-0000-4000-b000-00000000000a', false,
  (select max(id) from public.login_attempts where client_ip_hash = 'iphash-ok'));
select pg_temp.ok((select count(*) from public.login_attempts where client_ip_hash = 'iphash-ok') = 1
  and (select bool_and(success) from public.login_attempts where client_ip_hash = 'iphash-ok'), 'successful login completes the reserved row (no double count)');
-- check-out just after midnight closes yesterday's open record
insert into public.attendance_days (employee_id, work_date, checked_in_at) values ('00000000-0000-4000-b000-00000000000b', (now() at time zone 'Africa/Cairo')::date - 1, now() - interval '2 hours');
select pg_temp.ok((public.svc_check_out('00000000-0000-4000-b000-00000000000b', '{"lat":29.9831944,"lng":31.3239444,"accuracy":8}') ->> 'worked_minutes')::int = 120, 'after-midnight check-out closes the previous day (120 min)');
select pg_temp.ok((select count(*) from public.notification_outbox o join public.attendance_days a on a.id::text = o.event_ref
  where o.event_type = 'check_out' and a.employee_id = '00000000-0000-4000-b000-00000000000b') = 1, 'owner check-out alert queued once');
select pg_temp.ok((select count(*) from public.notification_outbox where event_type = 'check_in') >= 1, 'owner check-in alert queued');
-- manual (exceptional) check-in by the owner
select pg_temp.ok((public.svc_manual_check_in('00000000-0000-4000-b000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-b000-00000000000b',
  'date', (now() at time zone 'Africa/Cairo')::date - 2, 'time', '09:30', 'reason', 'forgot phone')) ->> 'attendance_id') is not null, 'owner records a forgotten check-in');
select pg_temp.ok((select corrected and correction_reason = 'forgot phone' from public.attendance_days where employee_id = '00000000-0000-4000-b000-00000000000b'
  and work_date = (now() at time zone 'Africa/Cairo')::date - 2), 'manual check-in is marked as a correction with its reason');
select pg_temp.expect_err($$select public.svc_manual_check_in('00000000-0000-4000-b000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-b000-00000000000b',
  'date', (now() at time zone 'Africa/Cairo')::date - 2, 'time', '10:00', 'reason', 'again'))$$, 'already_checked_in', 'manual check-in cannot duplicate a day');
select pg_temp.expect_err($$select public.svc_manual_check_in('00000000-0000-4000-b000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-b000-00000000000b',
  'date', (now() at time zone 'Africa/Cairo')::date + 1, 'time', '10:00', 'reason', 'future'))$$, 'invalid_time', 'manual check-in cannot be in the future');
select pg_temp.expect_err($$select public.svc_manual_check_in('00000000-0000-4000-b000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-b000-00000000000b',
  'date', (now() at time zone 'Africa/Cairo')::date - 3, 'time', '10:00', 'reason', ''))$$, 'reason_required', 'manual check-in needs a reason');
-- bot plumbing
select pg_temp.ok(public.svc_bot_claim_update(777001) and not public.svc_bot_claim_update(777001), 'each Telegram update is processed once');
select pg_temp.ok((select public.svc_bot_action_take('1360140225', public.svc_bot_action_create('1360140225', '{"t":"x"}'))) ->> 't' = 'x', 'pending action taken by its chat');
do $$ declare v uuid := public.svc_bot_action_create('1360140225', '{"t":"y"}'); begin
  perform pg_temp.ok(public.svc_bot_action_take('999', v) is null, 'another chat cannot take the action');
  perform pg_temp.ok(public.svc_bot_action_take('1360140225', v) is not null and public.svc_bot_action_take('1360140225', v) is null, 'a confirmation works once (double tap = no-op)');
end $$;
select public.svc_bot_state('1360140225', true, '{"flow":"points"}');
select pg_temp.ok(public.svc_bot_state('1360140225') ->> 'flow' = 'points', 'conversation state stored');
select public.svc_bot_state('1360140225', true, null);
select pg_temp.ok(public.svc_bot_state('1360140225') is null, 'conversation state cleared');
select pg_temp.ok(jsonb_array_length(public.svc_bot_today(null) -> 'people') = 3, '/today lists every active employee');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.svc_bot_points(null) -> 'rows')) = 3, '/points standings for every active employee');
select pg_temp.ok((public.svc_broadcast('00000000-0000-4000-b000-000000000001', '{"text":"اجتماع الساعة 10"}') ->> 'people')::int = 3, 'broadcast reaches every active employee');
select pg_temp.expect_err($$select public.svc_broadcast(null, '{"text":"  "}')$$, 'invalid_text', 'empty broadcast refused');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-b000-00000000000a","session_id":"20000000-0000-4000-b000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.ok((select count(*) from public.announcements) = 1, 'staff can read the announcement');
do $$ begin
  insert into public.announcements (body) values ('spoof');
  raise exception 'ASSERTION FAILED: staff wrote an announcement';
exception when insufficient_privilege then raise notice 'ok: staff cannot write announcements'; end $$;
do $$ begin
  perform * from public.telegram_actions;
  raise exception 'ASSERTION FAILED: staff read bot actions';
exception when insufficient_privilege then raise notice 'ok: bot tables are service-role only'; end $$;
reset role;

select 'ENGINE TESTS PASSED' as result;
