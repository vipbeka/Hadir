-- =====================================================================
-- Zintra حاضر — business engine (Steps 3–10)
-- ---------------------------------------------------------------------
-- All business rules run here, on the database clock, in the business
-- timezone. The browser only sends input (coordinates, form fields).
-- Public entry points are svc_*(p_actor uuid, p jsonb) functions called
-- by the `api` Edge Function with the service role after it has
-- authenticated the caller; EXECUTE is revoked from browser roles.
-- Errors are raised as 'ZH:<code>' (+ optional JSON detail) and mapped to
-- localized messages in the UI.
-- =====================================================================

-- ------------------------------------------------------------ schema
alter table public.profiles
  add column if not exists job_title_ar text check (job_title_ar is null or char_length(job_title_ar) <= 80),
  add column if not exists job_title_en text check (job_title_en is null or char_length(job_title_en) <= 80);

alter type public.point_source add value if not exists 'absence_cancel';

-- exact creation order (several events can be written in one transaction)
alter table public.point_events alter column created_at set default clock_timestamp();
alter table public.point_events
  add column if not exists rate_snapshot_piastres bigint not null default 0 check (rate_snapshot_piastres >= 0),
  add column if not exists request_key text;

alter table public.settings
  add column if not exists jobs_start_date date not null default ((now() at time zone 'Africa/Cairo')::date);

alter table public.notification_outbox
  add column if not exists employee_id uuid references public.profiles (id) on delete cascade,
  add column if not exists subscription_id uuid references public.push_subscriptions (id) on delete cascade;

-- ------------------------------------------------------------ helpers
create or replace function private.err(p_code text, p_detail jsonb default null)
returns void language plpgsql as $$
begin
  raise exception using message = 'ZH:' || p_code, detail = coalesce(p_detail::text, ''), errcode = 'P0001';
end $$;

create or replace function private.tz() returns text
language sql stable security definer set search_path = '' as $$ select business_timezone from public.settings where id $$;

create or replace function private.local_now() returns timestamp
language sql stable security definer set search_path = '' as $$ select now() at time zone private.tz() $$;

create or replace function private.period_of(d date) returns date
language sql immutable as $$ select date_trunc('month', d)::date $$;

-- Distance in metres between two WGS84 points (haversine).
create or replace function private.distance_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- Everything that decides how a calendar day behaves.
create or replace function private.day_info(d date)
returns table (is_work_day boolean, check_in_enabled boolean, points_enabled boolean,
               holiday_name_ar text, holiday_name_en text, enabled_windows int)
language sql stable security definer set search_path = '' as $$
  select coalesce(r.is_work_day, false) and h.id is null,
         coalesce(r.check_in_enabled, false) and h.id is null,
         coalesce(r.points_enabled, false) and h.id is null,
         h.name_ar, h.name_en,
         (select count(*)::int from public.check_in_windows w where w.day_of_week = extract(dow from d) and w.enabled)
  from (select 1) one
  left join public.day_rules r on r.day_of_week = extract(dow from d)
  left join public.public_holidays h on h.holiday_date = d and h.enabled
$$;

-- Points engine core: which window (if any) a local time falls in.
-- Start-inclusive / end-exclusive. At or after the last enabled window's
-- end → red. Before the first window or in a gap → no point. No enabled
-- windows at all → no point + config warning (never an accidental red).
create or replace function private.evaluate_time(d date, t time)
returns table (outcome text, window_id uuid, label_ar text, label_en text, config_warning boolean)
language plpgsql stable security definer set search_path = '' as $$
declare w record; v_last time;
begin
  select max(cw.end_time) into v_last from public.check_in_windows cw
   where cw.day_of_week = extract(dow from d) and cw.enabled;
  if v_last is null then
    return query select 'none'::text, null::uuid, null::text, null::text, true; return;
  end if;
  for w in select * from public.check_in_windows cw
            where cw.day_of_week = extract(dow from d) and cw.enabled order by cw.start_time loop
    if t >= w.start_time and t < w.end_time then
      return query select case when w.awards_green_point then 'green' else 'none' end, w.id, w.label_ar, w.label_en, false;
      return;
    end if;
  end loop;
  if t >= v_last then
    return query select 'red'::text, null::uuid, null::text, null::text, false;
  else
    return query select 'none'::text, null::uuid, null::text, null::text, false;
  end if;
end $$;

-- Is this positive event cancelled by an active reversal?
create or replace function private.is_reversed(p_event uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.point_events r where r.reverses_event_id = p_event and r.status = 'active')
$$;

-- Deterministic red-warning designation for one employee-period: the
-- FIRST active, un-reversed red (by work date, then creation) is the
-- warning when the policy is on; every other one is chargeable at its
-- snapshotted rate. Called after any change to red events.
create or replace function private.recalc_reds(p_emp uuid, p_period date)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings();
begin
  with reds as (
    select pe.id, row_number() over (order by pe.effective_work_date, pe.created_at, pe.id) as rn
    from public.point_events pe
    where pe.employee_id = p_emp and pe.reward_period = p_period and pe.color = 'red'
      and pe.delta > 0 and pe.status = 'active' and not private.is_reversed(pe.id))
  update public.point_events p
     set warning_only = (s.first_red_warning and r.rn = 1),
         deduction_amount_piastres = case when s.first_red_warning and r.rn = 1 then 0 else p.rate_snapshot_piastres end
    from reds r
   where p.id = r.id
     and (p.warning_only is distinct from (s.first_red_warning and r.rn = 1)
          or p.deduction_amount_piastres is distinct from (case when s.first_red_warning and r.rn = 1 then 0 else p.rate_snapshot_piastres end));
  -- reversed reds never deduct
  update public.point_events p set deduction_amount_piastres = 0, warning_only = false
   where p.employee_id = p_emp and p.reward_period = p_period and p.color = 'red' and p.delta > 0
     and private.is_reversed(p.id) and (p.deduction_amount_piastres <> 0 or p.warning_only);
end $$;

create or replace function private.lang_of(p_emp uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(p.preferred_language, s.default_language) from public.profiles p, public.settings s where p.id = p_emp and s.id
$$;

create or replace function private.name_of(p_emp uuid) returns text
language sql stable security definer set search_path = '' as $$
  select full_name_ar || ' (' || full_name_en || ')' from public.profiles where id = p_emp
$$;

-- Queue a web push to every enabled device of an employee (respects the
-- per-employee reminder toggle when p_respect_toggle).
create or replace function private.enqueue_push(p_emp uuid, p_kind text, p_key text, p_title_ar text, p_body_ar text,
                                                p_title_en text, p_body_en text, p_respect_toggle boolean default true)
returns int language plpgsql security definer set search_path = '' as $$
declare v_lang text := private.lang_of(p_emp); v_n int := 0; sub record; s public.settings := private.settings();
begin
  if p_respect_toggle and not coalesce((select reminders_enabled from public.profiles where id = p_emp), s.shift_reminders_default) then
    return 0;
  end if;
  for sub in select id from public.push_subscriptions where employee_id = p_emp and enabled loop
    insert into public.notification_outbox (dedupe_key, event_type, channel, recipient, payload, employee_id, subscription_id)
    values (p_kind || ':' || p_key || ':' || sub.id, p_kind, 'web_push', sub.id::text,
            jsonb_build_object('kind', p_kind,
              'title', case when v_lang = 'en' then p_title_en else p_title_ar end,
              'body', case when v_lang = 'en' then p_body_en else p_body_ar end,
              'lang', v_lang),
            p_emp, sub.id)
    on conflict (dedupe_key) do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;

-- Insert a point event (idempotent on idempotency_key). Returns its id.
create or replace function private.add_event(
  p_emp uuid, p_date date, p_key text, p_color public.point_color, p_delta int, p_source public.point_source,
  p_status public.point_status, p_rate bigint, p_deduction bigint, p_actor uuid, p_reason text,
  p_attendance uuid default null, p_category text default null, p_reverses uuid default null, p_request text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; s public.settings := private.settings();
begin
  insert into public.point_events (employee_id, effective_work_date, reward_period, attendance_day_id, idempotency_key,
    applied_rule_version, color, delta, source, outcome_category, status, warning_only, deduction_amount_piastres,
    rate_snapshot_piastres, reason, created_by, reverses_event_id, request_key,
    approved_by, approved_at)
  values (p_emp, p_date, private.period_of(p_date), p_attendance, p_key, s.rule_version, p_color, p_delta, p_source,
    p_category, p_status, false, p_deduction, p_rate, p_reason, p_actor, p_reverses, p_request,
    case when p_status = 'active' and p_color = 'black' and p_delta > 0 then p_actor end,
    case when p_status = 'active' and p_color = 'black' and p_delta > 0 then now() end)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then select id into v_id from public.point_events where idempotency_key = p_key; end if;
  return v_id;
end $$;

-- Cancel / reverse absence black points for a date (late check-in or
-- retroactive leave). Pending → cancelled (no negative point written);
-- active → linked reversal. Idempotent.
create or replace function private.clear_absence(p_emp uuid, p_date date, p_source public.point_source, p_actor uuid, p_reason text)
returns int language plpgsql security definer set search_path = '' as $$
declare e record; v_n int := 0;
begin
  for e in select * from public.point_events
            where employee_id = p_emp and effective_work_date = p_date and source = 'auto_absence'
              and color = 'black' and delta > 0 for update loop
    if e.status = 'pending_approval' then
      update public.point_events set status = 'cancelled', reason = coalesce(reason || ' · ', '') || p_reason where id = e.id;
      perform private.audit(p_actor, 'points.absence_cancelled', 'point_events', e.id::text,
        jsonb_build_object('status', 'pending_approval'), jsonb_build_object('status', 'cancelled'), p_reason,
        case when p_actor is null then 'system' else 'user' end);
      v_n := v_n + 1;
    elsif e.status = 'active' and not private.is_reversed(e.id) then
      perform private.add_event(p_emp, p_date, 'rev:' || e.id, 'black', -1, p_source, 'active', 0, 0, p_actor, p_reason,
                                null, null, e.id);
      perform private.audit(p_actor, 'points.absence_reversed', 'point_events', e.id::text, null,
        jsonb_build_object('reversed_by', p_source), p_reason, case when p_actor is null then 'system' else 'user' end);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- =====================================================================
-- Step 3 — check-in / check-out (geofence + server time)
-- =====================================================================
create or replace function private.validate_coords(p jsonb)
returns table (lat float8, lng float8, acc float8) language plpgsql as $$
declare v_lat float8; v_lng float8; v_acc float8;
begin
  begin
    v_lat := (p ->> 'lat')::float8; v_lng := (p ->> 'lng')::float8; v_acc := (p ->> 'accuracy')::float8;
  exception when others then perform private.err('invalid_coordinates'); end;
  if v_lat is null or v_lng is null or v_acc is null
     or v_lat = 'NaN' or v_lng = 'NaN' or v_acc = 'NaN'
     or v_lat in ('Infinity', '-Infinity') or v_lng in ('Infinity', '-Infinity') or v_acc in ('Infinity', '-Infinity')
     or v_lat not between -90 and 90 or v_lng not between -180 and 180 or v_acc <= 0 or v_acc > 100000 then
    perform private.err('invalid_coordinates');
  end if;
  return query select v_lat, v_lng, v_acc;
end $$;

create or replace function private.check_geofence(v_lat float8, v_lng float8, v_acc float8)
returns float8 language plpgsql stable security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_dist float8;
begin
  v_dist := private.distance_m(v_lat, v_lng, s.geofence_lat::float8, s.geofence_lng::float8);
  if v_acc > s.geofence_radius_m then
    perform private.err('accuracy_too_low', jsonb_build_object('accuracy_m', round(v_acc), 'radius_m', s.geofence_radius_m));
  end if;
  if v_dist > s.geofence_radius_m then
    perform private.err('outside_geofence', jsonb_build_object('distance_m', round(v_dist), 'radius_m', s.geofence_radius_m));
  end if;
  return v_dist;
end $$;

create or replace function public.svc_check_in(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.settings := private.settings();
  v_local timestamp := private.local_now();
  v_date date := v_local::date;
  v_time time := v_local::time;
  di record; c record; ev record; v_dist float8; v_att uuid; v_event uuid; v_rows int;
begin
  if (select role from public.profiles where id = p_actor) <> 'staff' then perform private.err('staff_only'); end if;
  select * into di from private.day_info(v_date);
  if di.holiday_name_ar is not null then perform private.err('holiday', jsonb_build_object('name_ar', di.holiday_name_ar, 'name_en', di.holiday_name_en)); end if;
  if not di.check_in_enabled then perform private.err('check_in_disabled'); end if;
  select * into c from private.validate_coords(p);
  v_dist := private.check_geofence(c.lat, c.lng, c.acc);

  insert into public.attendance_days (employee_id, work_date, checked_in_at, check_in_lat, check_in_lng, check_in_accuracy_m)
  values (p_actor, v_date, now(), c.lat, c.lng, c.acc)
  on conflict (employee_id, work_date) do nothing
  returning id into v_att;
  if v_att is null then perform private.err('already_checked_in'); end if;

  select * into ev from private.evaluate_time(v_date, v_time);
  if not di.points_enabled then ev.outcome := 'none'; end if;

  if ev.outcome = 'green' then
    v_event := private.add_event(p_actor, v_date, 'win:' || p_actor || ':' || v_date, 'green', 1, 'auto_window', 'active', 0, 0, null,
                                 'check-in ' || to_char(v_time, 'HH24:MI'), v_att);
  elsif ev.outcome = 'red' then
    v_event := private.add_event(p_actor, v_date, 'win:' || p_actor || ':' || v_date, 'red', 1, 'auto_window', 'active',
                                 s.red_penalty_piastres, s.red_penalty_piastres, null, 'late check-in ' || to_char(v_time, 'HH24:MI'), v_att);
    perform private.recalc_reds(p_actor, private.period_of(v_date));
  end if;

  update public.attendance_days
     set window_id = ev.window_id, window_label_snapshot = coalesce(ev.label_en, null),
         check_in_outcome = ev.outcome, point_event_id = v_event
   where id = v_att;

  -- never charge absence AND lateness for the same date
  perform private.clear_absence(p_actor, v_date, 'absence_cancel', null, 'late check-in cancels absence');

  if ev.outcome = 'red' then
    perform private.enqueue_owner_alert('red_point', 'red:' || v_event,
      jsonb_build_object('kind', 'red_point', 'employee', private.name_of(p_actor), 'date', v_date,
        'time', to_char(v_time, 'HH24:MI'),
        'warning_only', (select warning_only from public.point_events where id = v_event)), v_event::text);
  end if;

  return jsonb_build_object('outcome', ev.outcome, 'window_label_ar', ev.label_ar, 'window_label_en', ev.label_en,
    'checked_in_at', now(), 'distance_m', round(v_dist), 'config_warning', ev.config_warning,
    'warning_only', (select warning_only from public.point_events where id = v_event));
end $$;

create or replace function public.svc_check_out(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_date date := private.local_now()::date; a public.attendance_days; c record; v_dist float8;
begin
  select * into a from public.attendance_days where employee_id = p_actor and work_date = v_date for update;
  if not found or a.checked_in_at is null then perform private.err('not_checked_in'); end if;
  if a.checked_out_at is not null then perform private.err('already_checked_out'); end if;
  select * into c from private.validate_coords(p);
  v_dist := private.check_geofence(c.lat, c.lng, c.acc);
  update public.attendance_days
     set checked_out_at = now(), check_out_lat = c.lat, check_out_lng = c.lng, check_out_accuracy_m = c.acc,
         worked_minutes = floor(extract(epoch from now() - a.checked_in_at) / 60)::int, missing_checkout = false
   where id = a.id returning * into a;
  return jsonb_build_object('checked_out_at', a.checked_out_at, 'worked_minutes', a.worked_minutes, 'distance_m', round(v_dist));
end $$;

-- Everything the staff Attendance/Home screens need for "today".
create or replace function public.svc_my_day(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.settings := private.settings(); v_local timestamp := private.local_now(); v_date date := v_local::date;
  di record; a public.attendance_days; el public.early_leave_requests;
begin
  select * into di from private.day_info(v_date);
  select * into a from public.attendance_days where employee_id = p_actor and work_date = v_date;
  select * into el from public.early_leave_requests where employee_id = p_actor and work_date = v_date
     and status in ('pending', 'approved') order by created_at desc limit 1;
  return jsonb_build_object(
    'server_now', now(), 'business_date', v_date, 'business_time', to_char(v_local, 'HH24:MI:SS'), 'timezone', s.business_timezone,
    'is_work_day', di.is_work_day, 'check_in_enabled', di.check_in_enabled, 'points_enabled', di.points_enabled,
    'holiday', case when di.holiday_name_ar is null then null else jsonb_build_object('name_ar', di.holiday_name_ar, 'name_en', di.holiday_name_en) end,
    'geofence', jsonb_build_object('lat', s.geofence_lat, 'lng', s.geofence_lng, 'radius_m', s.geofence_radius_m),
    'work_start_time', s.work_start_time, 'work_end_time', s.work_end_time,
    'expected_end_time', case when el.status = 'approved' then el.requested_leave_time else s.work_end_time end,
    'windows', coalesce((select jsonb_agg(jsonb_build_object('label_ar', w.label_ar, 'label_en', w.label_en,
        'start', w.start_time, 'end', w.end_time, 'green', w.awards_green_point) order by w.start_time)
      from public.check_in_windows w where w.day_of_week = extract(dow from v_date) and w.enabled), '[]'::jsonb),
    'attendance', case when a.id is null then null else to_jsonb(a) - 'check_in_lat' - 'check_in_lng' - 'check_out_lat' - 'check_out_lng' end,
    'early_leave', case when el.id is null then null else to_jsonb(el) end,
    'missing_checkouts', (select count(*) from public.attendance_days x where x.employee_id = p_actor
                             and x.checked_out_at is null and x.work_date < v_date and not x.corrected));
end $$;

-- Owner correction of a forgotten check-out (required reason, audited).
create or replace function public.svc_correct_attendance(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.attendance_days; b public.attendance_days; v_out timestamptz; v_reason text := btrim(coalesce(p ->> 'reason', ''));
begin
  if char_length(v_reason) < 3 then perform private.err('reason_required'); end if;
  select * into b from public.attendance_days where id = (p ->> 'attendance_id')::uuid for update;
  if not found then perform private.err('not_found'); end if;
  begin v_out := (p ->> 'checked_out_at')::timestamptz; exception when others then perform private.err('invalid_time'); end;
  if v_out is null or b.checked_in_at is null or v_out <= b.checked_in_at or v_out > b.checked_in_at + interval '24 hours' then
    perform private.err('invalid_time');
  end if;
  update public.attendance_days
     set checked_out_at = v_out, worked_minutes = floor(extract(epoch from v_out - b.checked_in_at) / 60)::int,
         missing_checkout = false, corrected = true, corrected_by = p_actor, corrected_at = now(), correction_reason = v_reason
   where id = b.id returning * into a;
  perform private.audit(p_actor, 'attendance.correct', 'attendance_days', a.id::text,
    jsonb_build_object('checked_out_at', b.checked_out_at, 'worked_minutes', b.worked_minutes),
    jsonb_build_object('checked_out_at', a.checked_out_at, 'worked_minutes', a.worked_minutes), v_reason);
  return to_jsonb(a);
end $$;

-- =====================================================================
-- Step 4 — settings, day rules, windows, holidays (all audited)
-- =====================================================================
create or replace function public.svc_update_settings(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.settings; a public.settings; k text;
  allowed text[] := array['business_timezone','default_language','geofence_lat','geofence_lng','geofence_radius_m',
    'work_start_time','work_end_time','absence_cutoff','red_penalty_piastres','black_penalty_piastres','first_red_warning',
    'green_reward_threshold','reward_amount_piastres','payout_methods','owner_alert_channel','owner_telegram_chat_id',
    'notify_events','digest_enabled','digest_time','weekly_summary_enabled','weekly_summary_dow','weekly_summary_time',
    'shift_reminders_default','shift_reminder_lead_min','missed_checkin_reminder_enabled','missed_checkin_lead_min',
    'leaderboard_visible','code_length','lockout_max_failures','lockout_window_min','global_failure_limit_per_hour'];
  money text[] := array['red_penalty_piastres','black_penalty_piastres','reward_amount_piastres'];
  versioned text[] := array['red_penalty_piastres','black_penalty_piastres','green_reward_threshold','reward_amount_piastres',
    'first_red_warning','work_start_time','work_end_time'];
  v_bump boolean := false;
begin
  for k in select jsonb_object_keys(p) loop
    if not (k = any (allowed)) then perform private.err('invalid_setting', jsonb_build_object('field', k)); end if;
    if k = any (money) and ((p ->> k)::numeric % 100 <> 0 or (p ->> k)::numeric < 0) then
      perform private.err('invalid_amount', jsonb_build_object('field', k));
    end if;
  end loop;
  select * into b from public.settings where id for update;
  begin
    update public.settings s set
      business_timezone = coalesce(p ->> 'business_timezone', s.business_timezone),
      default_language = coalesce(p ->> 'default_language', s.default_language),
      geofence_lat = coalesce((p ->> 'geofence_lat')::numeric, s.geofence_lat),
      geofence_lng = coalesce((p ->> 'geofence_lng')::numeric, s.geofence_lng),
      geofence_radius_m = coalesce((p ->> 'geofence_radius_m')::int, s.geofence_radius_m),
      work_start_time = coalesce((p ->> 'work_start_time')::time, s.work_start_time),
      work_end_time = coalesce((p ->> 'work_end_time')::time, s.work_end_time),
      absence_cutoff = coalesce((p ->> 'absence_cutoff')::time, s.absence_cutoff),
      red_penalty_piastres = coalesce((p ->> 'red_penalty_piastres')::bigint, s.red_penalty_piastres),
      black_penalty_piastres = coalesce((p ->> 'black_penalty_piastres')::bigint, s.black_penalty_piastres),
      first_red_warning = coalesce((p ->> 'first_red_warning')::boolean, s.first_red_warning),
      green_reward_threshold = coalesce((p ->> 'green_reward_threshold')::int, s.green_reward_threshold),
      reward_amount_piastres = coalesce((p ->> 'reward_amount_piastres')::bigint, s.reward_amount_piastres),
      payout_methods = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'payout_methods') x), s.payout_methods),
      owner_alert_channel = coalesce(p ->> 'owner_alert_channel', s.owner_alert_channel),
      owner_telegram_chat_id = coalesce(p ->> 'owner_telegram_chat_id', s.owner_telegram_chat_id),
      notify_events = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'notify_events') x), s.notify_events),
      digest_enabled = coalesce((p ->> 'digest_enabled')::boolean, s.digest_enabled),
      digest_time = coalesce((p ->> 'digest_time')::time, s.digest_time),
      weekly_summary_enabled = coalesce((p ->> 'weekly_summary_enabled')::boolean, s.weekly_summary_enabled),
      weekly_summary_dow = case when p ? 'weekly_summary_dow' then (p ->> 'weekly_summary_dow')::smallint else s.weekly_summary_dow end,
      weekly_summary_time = coalesce((p ->> 'weekly_summary_time')::time, s.weekly_summary_time),
      shift_reminders_default = coalesce((p ->> 'shift_reminders_default')::boolean, s.shift_reminders_default),
      shift_reminder_lead_min = coalesce((p ->> 'shift_reminder_lead_min')::smallint, s.shift_reminder_lead_min),
      missed_checkin_reminder_enabled = coalesce((p ->> 'missed_checkin_reminder_enabled')::boolean, s.missed_checkin_reminder_enabled),
      missed_checkin_lead_min = coalesce((p ->> 'missed_checkin_lead_min')::smallint, s.missed_checkin_lead_min),
      leaderboard_visible = coalesce((p ->> 'leaderboard_visible')::boolean, s.leaderboard_visible),
      code_length = coalesce((p ->> 'code_length')::smallint, s.code_length),
      lockout_max_failures = coalesce((p ->> 'lockout_max_failures')::smallint, s.lockout_max_failures),
      lockout_window_min = coalesce((p ->> 'lockout_window_min')::smallint, s.lockout_window_min),
      global_failure_limit_per_hour = coalesce((p ->> 'global_failure_limit_per_hour')::int, s.global_failure_limit_per_hour),
      updated_at = now(), updated_by = p_actor
    where s.id returning * into a;
  exception
    when check_violation or invalid_datetime_format or invalid_text_representation or numeric_value_out_of_range
         or datetime_field_overflow or invalid_parameter_value then
      perform private.err('invalid_settings');
  end;
  for k in select unnest(versioned) loop
    if to_jsonb(a) -> k is distinct from to_jsonb(b) -> k then v_bump := true; end if;
  end loop;
  if v_bump then
    update public.settings set rule_version = rule_version + 1 where id returning * into a;
  end if;
  perform private.audit(p_actor, 'settings.update', 'settings', 'singleton',
    to_jsonb(b) - 'updated_at', to_jsonb(a) - 'updated_at');
  return to_jsonb(a);
end $$;

create or replace function public.svc_save_day(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dow smallint := (p ->> 'day_of_week')::smallint; b jsonb; a jsonb; w jsonb;
begin
  if v_dow is null or v_dow not between 0 and 6 then perform private.err('invalid_day'); end if;
  select jsonb_build_object('rule', to_jsonb(r), 'windows', (select jsonb_agg(to_jsonb(x) order by x.start_time) from public.check_in_windows x where x.day_of_week = v_dow))
    into b from public.day_rules r where r.day_of_week = v_dow;
  update public.day_rules set
    is_work_day = coalesce((p ->> 'is_work_day')::boolean, is_work_day),
    check_in_enabled = coalesce((p ->> 'check_in_enabled')::boolean, check_in_enabled),
    points_enabled = coalesce((p ->> 'points_enabled')::boolean, points_enabled),
    updated_at = now()
  where day_of_week = v_dow;
  if p ? 'windows' then
    delete from public.check_in_windows where day_of_week = v_dow;
    begin
      for w in select * from jsonb_array_elements(p -> 'windows') loop
        insert into public.check_in_windows (day_of_week, label_ar, label_en, start_time, end_time, enabled, awards_green_point)
        values (v_dow, btrim(w ->> 'label_ar'), btrim(w ->> 'label_en'), (w ->> 'start')::time, (w ->> 'end')::time,
                coalesce((w ->> 'enabled')::boolean, true), coalesce((w ->> 'awards_green_point')::boolean, true));
      end loop;
    exception
      when exclusion_violation then perform private.err('windows_overlap');
      when check_violation or not_null_violation or invalid_datetime_format then perform private.err('invalid_window');
    end;
  end if;
  select jsonb_build_object('rule', to_jsonb(r), 'windows', (select jsonb_agg(to_jsonb(x) order by x.start_time) from public.check_in_windows x where x.day_of_week = v_dow))
    into a from public.day_rules r where r.day_of_week = v_dow;
  perform private.audit(p_actor, 'day_rules.update', 'day_rules', v_dow::text, b, a);
  return a;
end $$;

create or replace function public.svc_save_holiday(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.public_holidays; a public.public_holidays; v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  if v_id is not null then select * into b from public.public_holidays where id = v_id for update; end if;
  begin
    if v_id is null then
      insert into public.public_holidays (holiday_date, name_ar, name_en, kind, enabled)
      values ((p ->> 'holiday_date')::date, btrim(p ->> 'name_ar'), btrim(p ->> 'name_en'),
              coalesce((p ->> 'kind')::public.holiday_kind, 'company'), coalesce((p ->> 'enabled')::boolean, true))
      returning * into a;
    else
      update public.public_holidays set
        holiday_date = coalesce((p ->> 'holiday_date')::date, holiday_date),
        name_ar = coalesce(btrim(p ->> 'name_ar'), name_ar), name_en = coalesce(btrim(p ->> 'name_en'), name_en),
        enabled = coalesce((p ->> 'enabled')::boolean, enabled)
      where id = v_id returning * into a;
      if a.id is null then perform private.err('not_found'); end if;
    end if;
  exception
    when unique_violation then perform private.err('holiday_exists');
    when check_violation or not_null_violation or invalid_datetime_format then perform private.err('invalid_holiday');
  end;
  perform private.audit(p_actor, case when v_id is null then 'holiday.create' else 'holiday.update' end,
    'public_holidays', a.id::text, to_jsonb(b), to_jsonb(a));
  return to_jsonb(a);
end $$;

-- =====================================================================
-- Step 5 — black point approvals
-- =====================================================================
create or replace function public.svc_decide_black(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.point_events; v_approve boolean := (p ->> 'approve')::boolean;
begin
  select * into e from public.point_events where id = (p ->> 'event_id')::uuid for update;
  if not found or e.color <> 'black' then perform private.err('not_found'); end if;
  if e.status <> 'pending_approval' then return jsonb_build_object('result', 'already_decided', 'status', e.status); end if;
  if v_approve then
    -- the deduction amount must be explicitly confirmed by the owner
    if (p ->> 'confirm_amount_piastres')::bigint is distinct from e.rate_snapshot_piastres then
      perform private.err('confirm_amount', jsonb_build_object('amount_piastres', e.rate_snapshot_piastres));
    end if;
    update public.point_events set status = 'active', approved_by = p_actor, approved_at = now(),
      deduction_amount_piastres = e.rate_snapshot_piastres, amount_confirmed_by = p_actor, amount_confirmed_at = now()
     where id = e.id returning * into e;
  else
    update public.point_events set status = 'declined', approved_by = p_actor, approved_at = now() where id = e.id returning * into e;
  end if;
  perform private.audit(p_actor, case when v_approve then 'black.approve' else 'black.decline' end, 'point_events', e.id::text,
    jsonb_build_object('status', 'pending_approval'), jsonb_build_object('status', e.status, 'deduction_piastres', e.deduction_amount_piastres));
  return jsonb_build_object('result', 'decided', 'status', e.status);
end $$;

-- =====================================================================
-- Step 6 — owner outcome points and manual adjustments
-- =====================================================================
create or replace function public.svc_award_outcome(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := (p ->> 'employee_id')::uuid; v_cat text := p ->> 'category'; v_note text := btrim(coalesce(p ->> 'note', ''));
  v_req text := coalesce(p ->> 'request_id', gen_random_uuid()::text); v_id uuid; v_date date := private.local_now()::date;
begin
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff' and active) then perform private.err('invalid_employee'); end if;
  if v_cat not in ('shipment_cleared', 'customs_ready', 'deal_closed', 'custom') then perform private.err('invalid_category'); end if;
  if char_length(v_note) < 2 or char_length(v_note) > 500 then perform private.err('note_required'); end if;
  v_id := private.add_event(v_emp, v_date, 'outcome:' || v_req, 'green', 1, 'owner_outcome', 'active', 0, 0, p_actor, v_note, null, v_cat);
  perform private.audit(p_actor, 'points.outcome', 'point_events', v_id::text, null, jsonb_build_object('employee_id', v_emp, 'category', v_cat, 'note', v_note));
  return jsonb_build_object('event_id', v_id);
end $$;

create or replace function private.period_total(p_emp uuid, p_color public.point_color, p_period date)
returns int language sql stable security definer set search_path = '' as $$
  select coalesce(sum(delta), 0)::int from public.point_events
   where employee_id = p_emp and color = p_color and reward_period = p_period and status = 'active'
$$;

-- Add / Remove / Set. Remove reverses the most recent un-reversed positive
-- event of that color (linked); Set writes the correcting events. Totals
-- never go negative. Black additions need the owner to confirm the amount.
create or replace function public.svc_manual_adjust(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.settings := private.settings();
  v_emp uuid := (p ->> 'employee_id')::uuid; v_color public.point_color; v_action text := p ->> 'action';
  v_reason text := btrim(coalesce(p ->> 'reason', '')); v_req text := coalesce(p ->> 'request_id', gen_random_uuid()::text);
  v_date date := private.local_now()::date; v_period date := private.period_of(private.local_now()::date);
  v_cur int; v_target int; v_delta int; i int; v_rate bigint := 0; e record; v_ids uuid[] := '{}'; v_id uuid;
begin
  begin v_color := (p ->> 'color')::public.point_color; exception when others then perform private.err('invalid_color'); end;
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff') then perform private.err('invalid_employee'); end if;
  if char_length(v_reason) < 3 then perform private.err('reason_required'); end if;
  v_cur := private.period_total(v_emp, v_color, v_period);
  v_target := case v_action when 'add' then v_cur + 1 when 'remove' then v_cur - 1
                            when 'set' then (p ->> 'value')::int else null end;
  if v_target is null then perform private.err('invalid_action'); end if;
  if v_target < 0 then perform private.err('negative_total'); end if;
  if v_target > 500 then perform private.err('invalid_value'); end if;
  v_delta := v_target - v_cur;
  if v_delta = 0 then perform private.err('no_change'); end if;
  v_rate := case v_color when 'red' then s.red_penalty_piastres when 'black' then s.black_penalty_piastres else 0 end;
  if v_color = 'black' and v_delta > 0
     and (p ->> 'confirm_amount_piastres')::bigint is distinct from v_rate * v_delta then
    perform private.err('confirm_amount', jsonb_build_object('amount_piastres', v_rate * v_delta, 'count', v_delta));
  end if;
  if v_delta > 0 then
    for i in 1..v_delta loop
      v_id := private.add_event(v_emp, v_date, 'manual:' || v_req || ':' || i, v_color, 1, 'owner_manual', 'active',
                                v_rate, case when v_color = 'black' then v_rate else 0 end, p_actor, v_reason, null, null, null, v_req);
      if v_color = 'black' then
        update public.point_events set amount_confirmed_by = p_actor, amount_confirmed_at = now() where id = v_id;
      end if;
      v_ids := v_ids || v_id;
    end loop;
  else
    for i in 1..(-v_delta) loop
      select pe.* into e from public.point_events pe
       where pe.employee_id = v_emp and pe.color = v_color and pe.reward_period = v_period and pe.status = 'active'
         and pe.delta > 0 and not private.is_reversed(pe.id)
       order by pe.effective_work_date desc, pe.created_at desc limit 1;
      if e.id is null then perform private.err('nothing_to_remove'); end if;
      v_id := private.add_event(v_emp, v_date, 'manual:' || v_req || ':' || i, v_color, -1, 'owner_manual', 'active',
                                0, 0, p_actor, v_reason, null, null, e.id, v_req);
      update public.point_events set deduction_amount_piastres = 0 where id = e.id and v_color = 'black';
      v_ids := v_ids || v_id;
    end loop;
  end if;
  if v_color = 'red' then perform private.recalc_reds(v_emp, v_period); end if;
  perform private.audit(p_actor, 'points.manual', 'point_events', v_emp::text,
    jsonb_build_object('color', v_color, 'total', v_cur),
    jsonb_build_object('color', v_color, 'total', v_target, 'action', v_action, 'events', v_ids), v_reason);
  return jsonb_build_object('previous', v_cur, 'total', v_target, 'events', v_ids);
end $$;

-- =====================================================================
-- Step 7 — reward requests
-- =====================================================================
create or replace function public.svc_request_reward(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_period date := private.period_of(private.local_now()::date);
  v_green int; r public.reward_requests; v_prev uuid; v_method text := p ->> 'payout_method'; v_num text := btrim(coalesce(p ->> 'payout_number', ''));
begin
  v_green := private.period_total(p_actor, 'green', v_period);
  if v_green < s.green_reward_threshold then perform private.err('not_eligible', jsonb_build_object('green', v_green, 'threshold', s.green_reward_threshold)); end if;
  if not (v_method = any (s.payout_methods)) then perform private.err('invalid_method'); end if;
  if v_num !~ '^[0-9A-Za-z@._+ -]{4,64}$' then perform private.err('invalid_payout_number'); end if;
  select id into v_prev from public.reward_requests where employee_id = p_actor and period_month = v_period and status = 'rejected' order by created_at desc limit 1;
  begin
    insert into public.reward_requests (employee_id, period_month, reward_amount_piastres, applied_rule_version, payout_method, payout_number, replaces_request_id)
    values (p_actor, v_period, s.reward_amount_piastres, s.rule_version, v_method, v_num, v_prev) returning * into r;
  exception when unique_violation then perform private.err('already_requested'); end;
  perform private.enqueue_owner_alert('reward_request', 'reward:' || r.id,
    jsonb_build_object('kind', 'reward_request', 'employee', private.name_of(p_actor), 'period', v_period,
      'amount_piastres', r.reward_amount_piastres, 'method', v_method, 'green', v_green), r.id::text);
  perform private.audit(p_actor, 'reward.request', 'reward_requests', r.id::text, null, to_jsonb(r));
  return to_jsonb(r);
end $$;

create or replace function public.svc_decide_reward(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); b public.reward_requests; a public.reward_requests; v_action text := p ->> 'action';
begin
  select * into b from public.reward_requests where id = (p ->> 'id')::uuid for update;
  if not found then perform private.err('not_found'); end if;
  if v_action = 'approve' then
    if b.status = 'approved' then return jsonb_build_object('result', 'already_decided', 'status', b.status); end if;
    if b.status <> 'pending' then perform private.err('invalid_transition'); end if;
    if private.period_total(b.employee_id, 'green', b.period_month) < s.green_reward_threshold then perform private.err('not_eligible_now'); end if;
    update public.reward_requests set status = 'approved', decided_by = p_actor, decided_at = now(),
      decision_comment = nullif(btrim(coalesce(p ->> 'comment', '')), '') where id = b.id returning * into a;
  elsif v_action = 'paid' then
    if b.status = 'paid' then return jsonb_build_object('result', 'already_decided', 'status', b.status); end if;
    if b.status <> 'approved' then perform private.err('invalid_transition'); end if;
    if char_length(btrim(coalesce(p ->> 'reference', ''))) < 2 then perform private.err('reference_required'); end if;
    update public.reward_requests set status = 'paid', paid_at = now(), paid_reference = btrim(p ->> 'reference') where id = b.id returning * into a;
  elsif v_action = 'reject' then
    if b.status = 'rejected' then return jsonb_build_object('result', 'already_decided', 'status', b.status); end if;
    if b.status not in ('pending', 'approved') then perform private.err('invalid_transition'); end if;
    update public.reward_requests set status = 'rejected', decided_by = p_actor, decided_at = now(),
      decision_comment = nullif(btrim(coalesce(p ->> 'comment', '')), '') where id = b.id returning * into a;
  else perform private.err('invalid_action'); end if;
  perform private.audit(p_actor, 'reward.' || v_action, 'reward_requests', a.id::text, to_jsonb(b), to_jsonb(a), p ->> 'comment');
  return jsonb_build_object('result', 'decided', 'request', to_jsonb(a));
end $$;

-- =====================================================================
-- Step 8 — leave and early-leave requests
-- =====================================================================
create or replace function public.svc_request_leave(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.leave_requests; v_from date; v_to date; v_today date := private.local_now()::date;
begin
  begin v_from := (p ->> 'from_date')::date; v_to := (p ->> 'to_date')::date; exception when others then perform private.err('invalid_dates'); end;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 60 or v_from < v_today - 31 or v_from > v_today + 365 then
    perform private.err('invalid_dates');
  end if;
  if (p ->> 'type') not in ('personal', 'sick') then perform private.err('invalid_type'); end if;
  insert into public.leave_requests (employee_id, type, from_date, to_date, reason)
  values (p_actor, (p ->> 'type')::public.leave_type, v_from, v_to, nullif(btrim(coalesce(p ->> 'reason', '')), ''))
  returning * into r;
  perform private.audit(p_actor, 'leave.request', 'leave_requests', r.id::text, null, to_jsonb(r));
  return to_jsonb(r);
end $$;

create or replace function public.svc_cancel_leave(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.leave_requests; a public.leave_requests;
begin
  select * into b from public.leave_requests where id = (p ->> 'id')::uuid and employee_id = p_actor for update;
  if not found then perform private.err('not_found'); end if;
  if b.status not in ('pending', 'approved') then return jsonb_build_object('result', 'already_decided', 'status', b.status); end if;
  -- cancelling approved leave stops shielding FUTURE runs; reversed points are not resurrected
  update public.leave_requests set status = 'cancelled' where id = b.id returning * into a;
  perform private.audit(p_actor, 'leave.cancel', 'leave_requests', a.id::text, to_jsonb(b), to_jsonb(a));
  return jsonb_build_object('result', 'cancelled', 'request', to_jsonb(a));
end $$;

create or replace function public.svc_decide_leave(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.leave_requests; a public.leave_requests; v_approve boolean := (p ->> 'approve')::boolean; d date; v_n int := 0;
  v_status public.request_status;
begin
  select * into b from public.leave_requests where id = (p ->> 'id')::uuid for update;
  if not found then perform private.err('not_found'); end if;
  v_status := case when v_approve then 'approved' else 'rejected' end;
  if b.status = v_status then return jsonb_build_object('result', 'already_decided', 'status', b.status); end if;
  if b.status = 'cancelled' or (b.status = 'rejected' and v_approve) then perform private.err('invalid_transition'); end if;
  update public.leave_requests set status = v_status, decided_by = p_actor, decided_at = now(),
    admin_comment = coalesce(nullif(btrim(coalesce(p ->> 'comment', '')), ''), admin_comment)
   where id = b.id returning * into a;
  if v_approve then
    -- retroactive shield: cancel pending / reverse approved absence points in range
    for d in select generate_series(a.from_date, a.to_date, interval '1 day')::date loop
      v_n := v_n + private.clear_absence(a.employee_id, d, 'leave_reversal', p_actor, 'approved leave');
    end loop;
  end if;
  perform private.audit(p_actor, 'leave.' || v_status, 'leave_requests', a.id::text, to_jsonb(b), to_jsonb(a), p ->> 'comment');
  return jsonb_build_object('result', 'decided', 'status', a.status, 'absences_cleared', v_n);
end $$;

create or replace function public.svc_comment_leave(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.leave_requests;
begin
  update public.leave_requests set admin_comment = left(btrim(coalesce(p ->> 'comment', '')), 500)
   where id = (p ->> 'id')::uuid returning * into a;
  if a.id is null then perform private.err('not_found'); end if;
  perform private.audit(p_actor, 'leave.comment', 'leave_requests', a.id::text, null, jsonb_build_object('comment', a.admin_comment));
  return to_jsonb(a);
end $$;

create or replace function public.svc_request_early_leave(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_local timestamp := private.local_now(); v_date date := v_local::date;
  v_time time; di record; r public.early_leave_requests;
begin
  begin v_time := (p ->> 'leave_time')::time; exception when others then perform private.err('invalid_time'); end;
  select * into di from private.day_info(v_date);
  if di.holiday_name_ar is not null then perform private.err('holiday'); end if;
  if not di.is_work_day then perform private.err('not_work_day'); end if;
  if v_time is null or v_time <= v_local::time or v_time >= s.work_end_time then
    perform private.err('invalid_time', jsonb_build_object('work_end_time', s.work_end_time));
  end if;
  if exists (select 1 from public.early_leave_requests where employee_id = p_actor and work_date = v_date and status = 'approved') then
    perform private.err('already_approved');
  end if;
  begin
    insert into public.early_leave_requests (employee_id, work_date, requested_leave_time, reason)
    values (p_actor, v_date, v_time, nullif(btrim(coalesce(p ->> 'reason', '')), '')) returning * into r;
  exception when unique_violation then perform private.err('already_pending'); end;
  perform private.enqueue_owner_alert('early_leave_request', 'early:' || r.id,
    jsonb_build_object('kind', 'early_leave_request', 'id', r.id, 'employee', private.name_of(p_actor),
      'date', v_date, 'time', to_char(v_time, 'HH24:MI'), 'reason', r.reason), r.id::text);
  perform private.audit(p_actor, 'early_leave.request', 'early_leave_requests', r.id::text, null, to_jsonb(r));
  return to_jsonb(r);
end $$;

create or replace function public.svc_cancel_early_leave(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.early_leave_requests; a public.early_leave_requests;
begin
  select * into b from public.early_leave_requests where id = (p ->> 'id')::bigint and employee_id = p_actor for update;
  if not found then perform private.err('not_found'); end if;
  if b.status not in ('pending', 'approved') then return jsonb_build_object('result', 'already_decided', 'status', b.status); end if;
  update public.early_leave_requests set status = 'cancelled' where id = b.id returning * into a;
  perform private.audit(p_actor, 'early_leave.cancel', 'early_leave_requests', a.id::text, to_jsonb(b), to_jsonb(a));
  return jsonb_build_object('result', 'cancelled');
end $$;

-- ONE decision path for the dashboard and Telegram. Idempotent.
create or replace function public.svc_decide_early_leave(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.early_leave_requests; a public.early_leave_requests; v_approve boolean := (p ->> 'approve')::boolean;
  v_channel public.decision_channel := coalesce((p ->> 'channel')::public.decision_channel, 'dashboard');
begin
  select * into b from public.early_leave_requests where id = (p ->> 'id')::bigint for update;
  if not found then perform private.err('not_found'); end if;
  if b.status = 'pending' then
    update public.early_leave_requests set status = (case when v_approve then 'approved' else 'rejected' end)::public.request_status,
      decided_by = p_actor, decided_at = now(), decision_channel = v_channel,
      admin_comment = nullif(btrim(coalesce(p ->> 'comment', '')), '') where id = b.id returning * into a;
  elsif b.status = 'approved' and not v_approve and coalesce((p ->> 'revoke')::boolean, false) then
    -- rejecting a previously approved request returns the day to normal rules
    update public.early_leave_requests set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_channel = v_channel
     where id = b.id returning * into a;
  else
    return jsonb_build_object('result', 'already_decided', 'status', b.status, 'id', b.id);
  end if;
  perform private.audit(p_actor, 'early_leave.' || a.status, 'early_leave_requests', a.id::text, to_jsonb(b), to_jsonb(a), a.admin_comment,
    case when v_channel = 'telegram' then 'telegram' else 'user' end);
  perform private.enqueue_push(a.employee_id, 'early_leave_decision', a.id::text || ':' || a.status,
    'Zintra حاضر', case when a.status = 'approved' then 'تمت الموافقة على انصرافك المبكر الساعة ' || to_char(a.requested_leave_time, 'HH24:MI')
                        else 'تم رفض طلب الانصراف المبكر.' end,
    'Zintra حاضر', case when a.status = 'approved' then 'Your early leave at ' || to_char(a.requested_leave_time, 'HH24:MI') || ' was approved.'
                        else 'Your early-leave request was declined.' end, false);
  return jsonb_build_object('result', 'decided', 'status', a.status, 'id', a.id,
    'employee', private.name_of(a.employee_id), 'time', to_char(a.requested_leave_time, 'HH24:MI'), 'date', a.work_date);
end $$;

-- =====================================================================
-- Step 9 — summaries, dashboards, payroll
-- =====================================================================
create or replace function public.svc_my_summary(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_today date := private.local_now()::date; v_period date := private.period_of(private.local_now()::date);
begin
  return jsonb_build_object(
    'period', v_period, 'threshold', s.green_reward_threshold, 'reward_amount_piastres', s.reward_amount_piastres,
    'payout_methods', s.payout_methods,
    'period_totals', jsonb_build_object('green', private.period_total(p_actor, 'green', v_period),
       'red', private.period_total(p_actor, 'red', v_period), 'black', private.period_total(p_actor, 'black', v_period)),
    'lifetime_totals', (select jsonb_build_object('green', coalesce(sum(delta) filter (where color = 'green'), 0),
        'red', coalesce(sum(delta) filter (where color = 'red'), 0), 'black', coalesce(sum(delta) filter (where color = 'black'), 0))
        from public.point_events where employee_id = p_actor and status = 'active'),
    'pending_black', (select count(*) from public.point_events where employee_id = p_actor and status = 'pending_approval'),
    'days_present', (select count(*) from public.attendance_days where employee_id = p_actor and checked_in_at is not null
                       and work_date >= v_period and work_date <= v_today),
    'worked_minutes', (select coalesce(sum(worked_minutes), 0) from public.attendance_days where employee_id = p_actor
                       and work_date >= v_period and work_date <= v_today),
    'reward_request', (select to_jsonb(r) from public.reward_requests r where r.employee_id = p_actor and r.period_month = v_period
                       order by r.created_at desc limit 1));
end $$;

create or replace function public.svc_owner_dashboard(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.local_now()::date; v_period date := private.period_of(private.local_now()::date); di record;
begin
  select * into di from private.day_info(v_today);
  return jsonb_build_object(
    'today', v_today, 'period', v_period,
    'is_work_day', di.is_work_day, 'holiday', di.holiday_name_ar,
    'pending', jsonb_build_object(
      'black', (select count(*) from public.point_events where status = 'pending_approval'),
      'leave', (select count(*) from public.leave_requests where status = 'pending'),
      'early_leave', (select count(*) from public.early_leave_requests where status = 'pending'),
      'reward', (select count(*) from public.reward_requests where status in ('pending', 'approved')),
      'missing_checkout', (select count(*) from public.attendance_days where checked_out_at is null and work_date < v_today and not corrected)),
    'employees', coalesce((select jsonb_agg(row_to_json(x) order by x.full_name_en) from (
      select p.id, p.full_name_ar, p.full_name_en, p.job_title_ar, p.job_title_en, p.role, p.active,
             sal.monthly_salary_piastres,
             private.period_total(p.id, 'green', v_period) as green,
             private.period_total(p.id, 'red', v_period) as red,
             private.period_total(p.id, 'black', v_period) as black,
             (select count(*) from public.point_events e where e.employee_id = p.id and e.status = 'pending_approval') as pending_black,
             (select jsonb_build_object('checked_in_at', a.checked_in_at, 'checked_out_at', a.checked_out_at, 'outcome', a.check_in_outcome)
                from public.attendance_days a where a.employee_id = p.id and a.work_date = v_today) as today
      from public.profiles p left join public.employee_salaries sal on sal.employee_id = p.id
      where p.role = 'staff') x), '[]'::jsonb));
end $$;

-- Pending items for the owner's Approvals screen.
create or replace function public.svc_pending(p_actor uuid, p jsonb default '{}')
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'black', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'employee_id', e.employee_id, 'name_ar', pr.full_name_ar, 'name_en', pr.full_name_en,
        'date', e.effective_work_date, 'amount_piastres', e.rate_snapshot_piastres, 'created_at', e.created_at) order by e.effective_work_date)
      from public.point_events e join public.profiles pr on pr.id = e.employee_id where e.status = 'pending_approval'), '[]'::jsonb),
    'leave', coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object('name_ar', pr.full_name_ar, 'name_en', pr.full_name_en) order by l.created_at desc)
      from public.leave_requests l join public.profiles pr on pr.id = l.employee_id
      where l.status in ('pending', 'approved') or l.created_at > now() - interval '30 days'), '[]'::jsonb),
    'early_leave', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('name_ar', pr.full_name_ar, 'name_en', pr.full_name_en) order by r.created_at desc)
      from public.early_leave_requests r join public.profiles pr on pr.id = r.employee_id
      where r.status = 'pending' or r.created_at > now() - interval '14 days'), '[]'::jsonb),
    'reward', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('name_ar', pr.full_name_ar, 'name_en', pr.full_name_en) order by r.created_at desc)
      from public.reward_requests r join public.profiles pr on pr.id = r.employee_id
      where r.status in ('pending', 'approved') or r.created_at > now() - interval '60 days'), '[]'::jsonb),
    'missing_checkout', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name_ar', pr.full_name_ar, 'name_en', pr.full_name_en,
        'work_date', a.work_date, 'checked_in_at', a.checked_in_at) order by a.work_date)
      from public.attendance_days a join public.profiles pr on pr.id = a.employee_id
      where a.checked_out_at is null and a.work_date < (now() at time zone private.tz())::date and not a.corrected), '[]'::jsonb))
$$;

create or replace function public.svc_employee_points(p_actor uuid, p jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb)
  from (select * from public.point_events where employee_id = (p ->> 'employee_id')::uuid order by created_at desc limit 300) e
$$;

-- Payroll-ready monthly report. Recomputes and upserts ONE row per
-- employee/month (calculation_version increments, audit revision); never
-- duplicates financial events. NOT net pay: salary is shown alongside.
create or replace function public.svc_payroll(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.settings := private.settings();
  v_month date := private.period_of(coalesce((p ->> 'month')::date, private.local_now()::date));
  v_end date := (v_month + interval '1 month - 1 day')::date;
  v_today date := private.local_now()::date;
  emp record; r jsonb; v_out jsonb := '[]'::jsonb;
  v_green_att int; v_green_out int; v_green_manual int; v_green_total int; v_warn int; v_red_n int; v_red_amt bigint;
  v_black_n int; v_black_amt bigint; v_black_pending int; v_black_declined int; v_minutes int; v_unresolved jsonb;
  v_earned bigint; v_paid bigint; v_deductions bigint; v_incomplete boolean; v_prev public.payroll_reports;
begin
  for emp in select pr.*, sal.monthly_salary_piastres from public.profiles pr
               left join public.employee_salaries sal on sal.employee_id = pr.id
              where pr.role = 'staff' and (pr.active or exists (select 1 from public.point_events e where e.employee_id = pr.id and e.reward_period = v_month)
                                           or exists (select 1 from public.attendance_days a where a.employee_id = pr.id and a.work_date between v_month and v_end))
              order by pr.full_name_en loop
    select coalesce(sum(delta) filter (where color = 'green' and source = 'auto_window'), 0),
           coalesce(sum(delta) filter (where color = 'green' and source = 'owner_outcome'), 0),
           coalesce(sum(delta) filter (where color = 'green' and source = 'owner_manual'), 0),
           coalesce(sum(delta) filter (where color = 'green'), 0)
      into v_green_att, v_green_out, v_green_manual, v_green_total
      from public.point_events where employee_id = emp.id and reward_period = v_month and status = 'active';
    select count(*) filter (where warning_only),
           count(*) filter (where not warning_only),
           coalesce(sum(deduction_amount_piastres) filter (where not warning_only), 0)
      into v_warn, v_red_n, v_red_amt
      from public.point_events e where e.employee_id = emp.id and e.reward_period = v_month and e.status = 'active'
       and e.color = 'red' and e.delta > 0 and not private.is_reversed(e.id);
    select count(*), coalesce(sum(deduction_amount_piastres), 0) into v_black_n, v_black_amt
      from public.point_events e where e.employee_id = emp.id and e.reward_period = v_month and e.status = 'active'
       and e.color = 'black' and e.delta > 0 and not private.is_reversed(e.id);
    select count(*) filter (where status = 'pending_approval'), count(*) filter (where status = 'declined')
      into v_black_pending, v_black_declined
      from public.point_events where employee_id = emp.id and reward_period = v_month and color = 'black';
    select coalesce(sum(worked_minutes), 0) into v_minutes from public.attendance_days
     where employee_id = emp.id and work_date between v_month and v_end;
    select coalesce(jsonb_agg(jsonb_build_object('type', 'missing_checkout', 'date', work_date)), '[]'::jsonb) into v_unresolved
      from public.attendance_days where employee_id = emp.id and work_date between v_month and least(v_end, v_today - 1)
       and checked_in_at is not null and checked_out_at is null;
    select coalesce(sum(reward_amount_piastres) filter (where status = 'paid'), 0) into v_paid
      from public.reward_requests where employee_id = emp.id and period_month = v_month;
    v_earned := case when v_green_total >= s.green_reward_threshold
                     then coalesce((select reward_amount_piastres from public.reward_requests where employee_id = emp.id and period_month = v_month
                                     and status in ('pending', 'approved', 'paid') order by created_at desc limit 1), s.reward_amount_piastres)
                     else 0 end;
    v_deductions := v_red_amt + v_black_amt;
    v_incomplete := jsonb_array_length(v_unresolved) > 0 or v_black_pending > 0;
    -- a paid reward whose eligibility later dropped is flagged, never silently reclaimed
    update public.reward_requests set needs_owner_review = true
     where employee_id = emp.id and period_month = v_month and status = 'paid' and v_green_total < s.green_reward_threshold and not needs_owner_review;

    select * into v_prev from public.payroll_reports where employee_id = emp.id and month = v_month;
    insert into public.payroll_reports (employee_id, month, calculation_version, calculated_at, worked_minutes, unresolved_flags,
      points_breakdown, warnings_count, deductions_piastres, bonuses_earned_piastres, bonuses_paid_piastres, net_adjustment_piastres,
      incomplete, source_refs)
    values (emp.id, v_month, 1, now(), v_minutes, v_unresolved,
      jsonb_build_object('green_attendance', v_green_att, 'green_outcome', v_green_out, 'green_manual', v_green_manual, 'green_total', v_green_total,
        'red_warnings', v_warn, 'red_chargeable', v_red_n, 'red_amount_piastres', v_red_amt,
        'black_approved', v_black_n, 'black_amount_piastres', v_black_amt, 'black_pending', v_black_pending, 'black_declined', v_black_declined),
      v_warn, v_deductions, v_earned, v_paid, greatest(v_earned - v_paid, 0) - v_deductions, v_incomplete,
      jsonb_build_object('rule_version', s.rule_version, 'timezone', s.business_timezone))
    on conflict (employee_id, month) do update set
      calculation_version = public.payroll_reports.calculation_version + 1, calculated_at = now(),
      worked_minutes = excluded.worked_minutes, unresolved_flags = excluded.unresolved_flags, points_breakdown = excluded.points_breakdown,
      warnings_count = excluded.warnings_count, deductions_piastres = excluded.deductions_piastres,
      bonuses_earned_piastres = excluded.bonuses_earned_piastres, bonuses_paid_piastres = excluded.bonuses_paid_piastres,
      net_adjustment_piastres = excluded.net_adjustment_piastres, incomplete = excluded.incomplete, source_refs = excluded.source_refs;
    insert into public.monthly_deductions (employee_id, month, red_count, black_count, red_amount_piastres, black_amount_piastres,
      bonus_amount_piastres, total_amount_piastres, computed_at)
    values (emp.id, v_month, v_red_n, v_black_n, v_red_amt, v_black_amt, v_earned, v_deductions, now())
    on conflict (employee_id, month) do update set red_count = excluded.red_count, black_count = excluded.black_count,
      red_amount_piastres = excluded.red_amount_piastres, black_amount_piastres = excluded.black_amount_piastres,
      bonus_amount_piastres = excluded.bonus_amount_piastres, total_amount_piastres = excluded.total_amount_piastres,
      calculation_version = public.monthly_deductions.calculation_version + 1, computed_at = now();
    if v_prev.id is not null and (v_prev.deductions_piastres, v_prev.bonuses_earned_piastres, v_prev.net_adjustment_piastres)
         is distinct from (v_deductions, v_earned, greatest(v_earned - v_paid, 0) - v_deductions) then
      perform private.audit(p_actor, 'payroll.recalculate', 'payroll_reports', v_prev.id::text,
        jsonb_build_object('deductions', v_prev.deductions_piastres, 'earned', v_prev.bonuses_earned_piastres, 'net_adjustment', v_prev.net_adjustment_piastres),
        jsonb_build_object('deductions', v_deductions, 'earned', v_earned, 'net_adjustment', greatest(v_earned - v_paid, 0) - v_deductions),
        null, case when p_actor is null then 'system' else 'user' end);
    end if;
    select to_jsonb(pr) || jsonb_build_object('full_name_ar', emp.full_name_ar, 'full_name_en', emp.full_name_en,
        'job_title_ar', emp.job_title_ar, 'job_title_en', emp.job_title_en, 'active', emp.active,
        'monthly_salary_piastres', emp.monthly_salary_piastres)
      into r from public.payroll_reports pr where pr.employee_id = emp.id and pr.month = v_month;
    v_out := v_out || r;
  end loop;
  return jsonb_build_object('month', v_month, 'generated_at', now(), 'timezone', s.business_timezone, 'rule_version', s.rule_version,
    'red_penalty_piastres', s.red_penalty_piastres, 'black_penalty_piastres', s.black_penalty_piastres,
    'reward_amount_piastres', s.reward_amount_piastres, 'threshold', s.green_reward_threshold, 'rows', v_out);
end $$;

-- Raw rows for CSV export (owner).
create or replace function public.svc_export_raw(p_actor uuid, p jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (select date_trunc('month', coalesce((p ->> 'month')::date, (now() at time zone private.tz())::date))::date as m)
  select jsonb_build_object(
    'attendance', coalesce((select jsonb_agg(jsonb_build_object('employee', pr.full_name_en, 'work_date', a.work_date,
        'checked_in_at', a.checked_in_at, 'checked_out_at', a.checked_out_at, 'worked_minutes', a.worked_minutes,
        'outcome', a.check_in_outcome, 'missing_checkout', a.checked_out_at is null, 'corrected', a.corrected) order by a.work_date, pr.full_name_en)
      from public.attendance_days a join public.profiles pr on pr.id = a.employee_id, m
      where a.work_date >= m.m and a.work_date < m.m + interval '1 month'), '[]'::jsonb),
    'point_events', coalesce((select jsonb_agg(jsonb_build_object('employee', pr.full_name_en, 'date', e.effective_work_date, 'color', e.color,
        'delta', e.delta, 'source', e.source, 'status', e.status, 'warning_only', e.warning_only,
        'deduction_egp', e.deduction_amount_piastres / 100.0, 'category', e.outcome_category, 'reason', e.reason, 'created_at', e.created_at)
        order by e.effective_work_date, e.created_at)
      from public.point_events e join public.profiles pr on pr.id = e.employee_id, m where e.reward_period = m.m), '[]'::jsonb),
    'deductions', coalesce((select jsonb_agg(jsonb_build_object('employee', pr.full_name_en, 'month', d.month, 'red_count', d.red_count,
        'black_count', d.black_count, 'red_egp', d.red_amount_piastres / 100.0, 'black_egp', d.black_amount_piastres / 100.0,
        'total_egp', d.total_amount_piastres / 100.0, 'bonus_egp', d.bonus_amount_piastres / 100.0))
      from public.monthly_deductions d join public.profiles pr on pr.id = d.employee_id, m where d.month = m.m), '[]'::jsonb))
$$;

-- =====================================================================
-- Step 10 — leaderboard (green progress only, safe fields)
-- =====================================================================
create or replace function public.get_leaderboard()
returns table (rank int, full_name_ar text, full_name_en text, job_title_ar text, job_title_en text,
               green int, threshold int, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.current_uid(); s public.settings := private.settings();
  v_period date := private.period_of(private.local_now()::date);
begin
  if v_uid is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not s.leaderboard_visible and not private.is_owner() then return; end if;
  return query
    select (rank() over (order by g.green desc))::int, g.full_name_ar, g.full_name_en, g.job_title_ar, g.job_title_en,
           g.green, s.green_reward_threshold, g.id = v_uid
    from (select p.id, p.full_name_ar, p.full_name_en, p.job_title_ar, p.job_title_en,
                 greatest(private.period_total(p.id, 'green', v_period), 0) as green
          from public.profiles p where p.role = 'staff' and p.active) g
    order by g.green desc, g.full_name_en;
end $$;
revoke all on function public.get_leaderboard() from public, anon;
grant execute on function public.get_leaderboard() to authenticated, service_role;

-- =====================================================================
-- Step 5 — scheduled jobs (driven by private.tick() every minute)
-- =====================================================================
create or replace function private.job_done(p_job text, p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.job_runs where job_name = p_job and run_key = p_key and status in ('succeeded', 'skipped'))
$$;

create or replace function private.record_job(p_job text, p_key text, p_status text, p_detail jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.job_runs (job_name, run_key, status, finished_at, detail)
  values (p_job, p_key, p_status, now(), p_detail)
  on conflict (job_name, run_key) do update set status = excluded.status, finished_at = now(), detail = excluded.detail
$$;

-- Absence job for one work date. Idempotent (event idempotency keys + job_runs).
create or replace function private.run_absence(p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); di record; emp record; v_lines jsonb := '[]'::jsonb; v_id uuid; v_created int := 0;
  v_cutoff timestamptz := (p_date + s.absence_cutoff) at time zone s.business_timezone;
begin
  select * into di from private.day_info(p_date);
  if di.holiday_name_ar is not null or not di.is_work_day or not di.check_in_enabled or di.enabled_windows = 0 then
    perform private.record_job('absence', p_date::text, 'skipped', jsonb_build_object('reason',
      case when di.holiday_name_ar is not null then 'holiday: ' || di.holiday_name_en
           when not di.is_work_day then 'non-work day' when not di.check_in_enabled then 'check-in disabled'
           else 'no enabled windows (configuration warning)' end));
    return jsonb_build_object('skipped', true);
  end if;
  for emp in select * from public.profiles where role = 'staff' and active and created_at < v_cutoff order by full_name_en loop
    if exists (select 1 from public.attendance_days where employee_id = emp.id and work_date = p_date and checked_in_at is not null) then
      v_lines := v_lines || jsonb_build_object('employee', emp.full_name_en, 'line', 'Checked In -> No Absence');
    elsif exists (select 1 from public.leave_requests where employee_id = emp.id and status = 'approved' and p_date between from_date and to_date) then
      v_lines := v_lines || jsonb_build_object('employee', emp.full_name_en, 'line', 'Approved Leave Found -> No Absence Penalty');
    else
      v_id := private.add_event(emp.id, p_date, 'absence:' || emp.id || ':' || p_date, 'black', 1, 'auto_absence', 'pending_approval',
                                s.black_penalty_piastres, 0, null, 'no check-in, no approved leave');
      v_created := v_created + 1;
      v_lines := v_lines || jsonb_build_object('employee', emp.full_name_en, 'line', 'No Check-In, No Leave -> Black Point Pending Approval');
      perform private.enqueue_owner_alert('black_pending', 'black:' || v_id,
        jsonb_build_object('kind', 'black_pending', 'employee', private.name_of(emp.id), 'date', p_date,
          'amount_piastres', s.black_penalty_piastres), v_id::text);
    end if;
  end loop;
  perform private.record_job('absence', p_date::text, 'succeeded', jsonb_build_object('lines', v_lines, 'black_pending_created', v_created));
  return jsonb_build_object('lines', v_lines, 'created', v_created);
end $$;

-- End-of-day digest: ONE Telegram message for the whole day.
create or replace function private.run_digest(p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); di record; emp record; v_lines jsonb := '[]'::jsonb; a public.attendance_days; v_status text;
begin
  select * into di from private.day_info(p_date);
  if di.holiday_name_ar is not null then
    v_lines := jsonb_build_array(jsonb_build_object('line', 'عطلة رسمية: ' || di.holiday_name_ar));
  elsif not di.is_work_day then
    perform private.record_job('digest', p_date::text, 'skipped', jsonb_build_object('reason', 'non-work day'));
    return jsonb_build_object('skipped', true);
  else
    for emp in select * from public.profiles where role = 'staff' and active order by full_name_ar loop
      select * into a from public.attendance_days where employee_id = emp.id and work_date = p_date;
      if a.id is not null and a.check_in_outcome = 'red' then
        v_status := 'متأخر ' || to_char(a.checked_in_at at time zone s.business_timezone, 'HH24:MI') ||
          case when (select warning_only from public.point_events where id = a.point_event_id) then ' (إنذار)' else ' (خصم)' end;
      elsif a.id is not null then
        v_status := 'حاضر ' || to_char(a.checked_in_at at time zone s.business_timezone, 'HH24:MI') || coalesce(' · ' || (
          select label_ar from public.check_in_windows w where w.id = a.window_id), '');
      elsif exists (select 1 from public.leave_requests where employee_id = emp.id and status = 'approved' and p_date between from_date and to_date) then
        v_status := 'إجازة معتمدة';
      elsif exists (select 1 from public.point_events where employee_id = emp.id and effective_work_date = p_date and source = 'auto_absence' and status = 'pending_approval') then
        v_status := 'غائب — نقطة سوداء بانتظار الموافقة';
      else
        v_status := 'لم يسجّل حضورًا';
      end if;
      v_lines := v_lines || jsonb_build_object('line', emp.full_name_ar || ': ' || v_status);
    end loop;
    v_lines := v_lines || coalesce((select jsonb_agg(jsonb_build_object('line', 'طلب مكافأة: ' || pr.full_name_ar || ' — ' || r.status))
       from public.reward_requests r join public.profiles pr on pr.id = r.employee_id
      where (r.created_at at time zone s.business_timezone)::date = p_date or (r.decided_at at time zone s.business_timezone)::date = p_date), '[]'::jsonb);
  end if;
  perform private.enqueue_owner_alert('digest', 'digest:' || p_date, jsonb_build_object('kind', 'digest', 'date', p_date, 'lines', v_lines));
  perform private.record_job('digest', p_date::text, 'succeeded', jsonb_build_object('lines', v_lines));
  return jsonb_build_object('lines', v_lines);
end $$;

-- Weekly summary: ONE message per week (week = Sunday..Saturday, business tz).
create or replace function private.run_weekly(p_week_start date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare emp record; v_lines jsonb := '[]'::jsonb; v_end date := p_week_start + 6;
  v_present int; v_late int; v_warn int; v_abs int; g int; r int; b int;
begin
  for emp in select * from public.profiles where role = 'staff' and active order by full_name_ar loop
    select count(*) into v_present from public.attendance_days a
     where a.employee_id = emp.id and a.work_date between p_week_start and v_end and a.checked_in_at is not null
       and not exists (select 1 from public.public_holidays h where h.holiday_date = a.work_date and h.enabled);
    select count(*) filter (where e.delta > 0), count(*) filter (where e.warning_only) into v_late, v_warn
      from public.point_events e where e.employee_id = emp.id and e.color = 'red' and e.status = 'active'
       and e.effective_work_date between p_week_start and v_end and not private.is_reversed(e.id) and e.delta > 0;
    select count(*) into v_abs from public.point_events e where e.employee_id = emp.id and e.color = 'black' and e.status = 'active'
       and e.delta > 0 and e.source = 'auto_absence' and e.effective_work_date between p_week_start and v_end and not private.is_reversed(e.id);
    select coalesce(sum(delta) filter (where color = 'green'), 0), coalesce(sum(delta) filter (where color = 'red'), 0),
           coalesce(sum(delta) filter (where color = 'black'), 0) into g, r, b
      from public.point_events where employee_id = emp.id and status = 'active' and effective_work_date between p_week_start and v_end;
    v_lines := v_lines || jsonb_build_object('line', emp.full_name_ar || ': حضور ' || v_present || ' · تأخير ' || v_late ||
      case when v_warn > 0 then ' (منها إنذار ' || v_warn || ')' else '' end || ' · غياب ' || v_abs ||
      ' · نقاط: +' || g || ' خضراء، ' || r || ' حمراء، ' || b || ' سوداء');
  end loop;
  perform private.enqueue_owner_alert('weekly_summary', 'weekly:' || p_week_start,
    jsonb_build_object('kind', 'weekly_summary', 'week_start', p_week_start, 'week_end', v_end, 'lines', v_lines));
  perform private.record_job('weekly', p_week_start::text, 'succeeded', jsonb_build_object('lines', v_lines));
  return jsonb_build_object('lines', v_lines);
end $$;

-- Reminder fan-out (web push). Only inside the lead window before the
-- target time, so no catch-up reminder is ever sent for a passed window.
create or replace function private.enqueue_reminders()
returns int language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_local timestamp := private.local_now(); v_date date := v_local::date;
  v_t time := v_local::time; di record; emp record; w record; v_n int := 0;
begin
  select * into di from private.day_info(v_date);
  if not di.is_work_day then return 0; end if;  -- holidays & weekends: nothing
  for emp in select * from public.profiles where role = 'staff' and active loop
    if exists (select 1 from public.leave_requests where employee_id = emp.id and status = 'approved' and v_date between from_date and to_date) then
      continue;
    end if;
    -- shift start
    if v_t >= s.work_start_time - make_interval(mins => s.shift_reminder_lead_min) and v_t < s.work_start_time then
      v_n := v_n + private.enqueue_push(emp.id, 'shift_start', v_date::text,
        'Zintra حاضر', 'يبدأ العمل بعد ' || s.shift_reminder_lead_min || ' دقيقة — سجّل حضورك عند وصولك.',
        'Zintra حاضر', 'Work starts in ' || s.shift_reminder_lead_min || ' minutes — check in when you arrive.');
    end if;
    -- shift end (only if checked in and not yet checked out)
    if v_t >= s.work_end_time - make_interval(mins => s.shift_reminder_lead_min) and v_t < s.work_end_time
       and exists (select 1 from public.attendance_days where employee_id = emp.id and work_date = v_date and checked_in_at is not null and checked_out_at is null) then
      v_n := v_n + private.enqueue_push(emp.id, 'shift_end', v_date::text,
        'Zintra حاضر', 'ينتهي العمل بعد ' || s.shift_reminder_lead_min || ' دقيقة — لا تنسَ تسجيل الانصراف.',
        'Zintra حاضر', 'Work ends in ' || s.shift_reminder_lead_min || ' minutes — remember to check out.');
    end if;
    -- missed check-in: a window closing soon and no check-in yet
    if s.missed_checkin_reminder_enabled and di.check_in_enabled
       and not exists (select 1 from public.attendance_days where employee_id = emp.id and work_date = v_date) then
      for w in select * from public.check_in_windows where day_of_week = extract(dow from v_date) and enabled loop
        if v_t >= w.end_time - make_interval(mins => s.missed_checkin_lead_min) and v_t < w.end_time then
          v_n := v_n + private.enqueue_push(emp.id, 'missed_checkin', v_date::text || ':' || w.id,
            'Zintra حاضر', 'نافذة «' || w.label_ar || '» تُغلق بعد ' || s.missed_checkin_lead_min || ' دقيقة — تذكّر تسجيل الحضور.',
            'Zintra حاضر', 'The ' || w.label_en || ' window closes in ' || s.missed_checkin_lead_min || ' minutes — remember to check in.');
        end if;
      end loop;
    end if;
  end loop;
  return v_n;
end $$;

-- The heartbeat. Catch-up: missed absence runs (since jobs_start_date,
-- up to 7 days back) run once; a missed digest/weekly for TODAY/THIS WEEK
-- is sent late once, older ones are recorded as skipped (never twice).
create or replace function private.tick()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_local timestamp := private.local_now(); v_today date := v_local::date;
  d date; v_out jsonb := '{}'::jsonb; v_target_dow int; v_week_start date; v_prev_month date;
begin
  update public.attendance_days set missing_checkout = true
   where checked_in_at is not null and checked_out_at is null and work_date < v_today and not missing_checkout;

  v_out := v_out || jsonb_build_object('reminders', private.enqueue_reminders());

  for d in select generate_series(greatest(v_today - 7, s.jobs_start_date), v_today, interval '1 day')::date loop
    if (d < v_today or v_local::time >= s.absence_cutoff) and not private.job_done('absence', d::text) then
      perform private.run_absence(d);
    end if;
    if s.digest_enabled and not private.job_done('digest', d::text) then
      if d = v_today and v_local::time >= s.digest_time then perform private.run_digest(d);
      elsif d < v_today then perform private.record_job('digest', d::text, 'skipped', jsonb_build_object('reason', 'scheduler missed the send time'));
      end if;
    end if;
  end loop;

  if s.weekly_summary_enabled then
    v_week_start := v_today - extract(dow from v_today)::int;
    v_target_dow := coalesce(s.weekly_summary_dow, (select max(day_of_week) from public.day_rules where is_work_day));
    if v_target_dow is not null and not private.job_done('weekly', v_week_start::text) and v_week_start + v_target_dow <= v_today
       and (v_week_start + v_target_dow < v_today or v_local::time >= s.weekly_summary_time) then
      perform private.run_weekly(v_week_start);
    end if;
    if (v_week_start - 7) >= s.jobs_start_date - 7 and not private.job_done('weekly', (v_week_start - 7)::text) then
      perform private.record_job('weekly', (v_week_start - 7)::text, 'skipped', jsonb_build_object('reason', 'scheduler missed the send time'));
    end if;
  end if;

  v_prev_month := private.period_of(v_today) - interval '1 month';
  if v_prev_month >= private.period_of(s.jobs_start_date) and not private.job_done('monthly', v_prev_month::text) then
    perform public.svc_payroll(null, jsonb_build_object('month', v_prev_month));
    perform private.record_job('monthly', v_prev_month::text, 'succeeded', '{}'::jsonb);
  end if;
  return v_out;
end $$;

-- Owner can re-run a job for a date (simulation / testing, idempotent).
create or replace function public.svc_run_job(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_date date := coalesce((p ->> 'date')::date, private.local_now()::date);
begin
  perform private.audit(p_actor, 'job.run', 'job_runs', p ->> 'job', null, p);
  return case p ->> 'job'
    when 'absence' then private.run_absence(v_date)
    when 'digest' then private.run_digest(v_date)
    when 'weekly' then private.run_weekly(v_date - extract(dow from v_date)::int)
    when 'payroll' then public.svc_payroll(p_actor, jsonb_build_object('month', v_date))
    else jsonb_build_object('error', 'unknown job') end;
end $$;

-- ================================================ outbox (dispatcher)
-- Claim due messages (SKIP LOCKED: overlapping dispatchers never double-send).
create or replace function public.svc_claim_outbox(p_limit int default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  -- missed check-in reminders are re-checked at send time
  update public.notification_outbox o set status = 'skipped', last_error = 'checked in before send'
   where o.status in ('pending', 'failed') and o.event_type = 'missed_checkin'
     and exists (select 1 from public.attendance_days a where a.employee_id = o.employee_id
                  and a.work_date = (o.created_at at time zone private.tz())::date);
  update public.notification_outbox o set status = 'skipped', last_error = 'subscription disabled'
   where o.status in ('pending', 'failed') and o.channel = 'web_push'
     and not exists (select 1 from public.push_subscriptions p where p.id = o.subscription_id and p.enabled);
  with due as (
    select id from public.notification_outbox
     where status in ('pending', 'failed') and next_attempt_at <= now()
     order by created_at limit p_limit for update skip locked),
  upd as (
    update public.notification_outbox o set status = 'sending', attempt_count = o.attempt_count + 1,
           next_attempt_at = now() + interval '10 minutes'   -- lease
      from due where o.id = due.id
    returning o.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'channel', u.channel, 'recipient', u.recipient,
      'event_type', u.event_type, 'payload', u.payload, 'attempt', u.attempt_count,
      'push', (select jsonb_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth_key)
                 from public.push_subscriptions p where p.id = u.subscription_id))), '[]'::jsonb)
    into v_rows from upd u;
  -- stuck 'sending' rows whose lease expired (dispatcher crashed) become retryable
  update public.notification_outbox set status = 'failed', last_error = 'dispatcher timeout'
   where status = 'sending' and next_attempt_at < now();
  return v_rows;
end $$;

create or replace function public.svc_outbox_result(p_id uuid, p_ok boolean, p_ref text, p_error text, p_gone boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.notification_outbox;
begin
  select * into o from public.notification_outbox where id = p_id for update;
  if not found then return; end if;
  if p_ok then
    update public.notification_outbox set status = 'sent', sent_at = now(), provider_reference = left(p_ref, 200), last_error = null where id = p_id;
    if o.subscription_id is not null then update public.push_subscriptions set last_success_at = now() where id = o.subscription_id; end if;
  elsif p_gone then
    update public.notification_outbox set status = 'dead', last_error = left(p_error, 300) where id = p_id;
    update public.push_subscriptions set enabled = false, disabled_at = now() where id = o.subscription_id;
  else
    update public.notification_outbox set
      status = (case when o.attempt_count >= 6 then 'dead' else 'failed' end)::public.delivery_status,
      next_attempt_at = now() + make_interval(mins => least(power(2, o.attempt_count)::int, 120)),
      last_error = left(p_error, 300) where id = p_id;
  end if;
end $$;

-- Owner chat + owner profile for the Telegram webhook.
create or replace function public.svc_telegram_context()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('chat_id', s.owner_telegram_chat_id, 'channel', s.owner_alert_channel,
    'owner_id', (select id from public.profiles where role = 'owner' and active order by created_at limit 1))
  from public.settings s where s.id
$$;

-- Per-employee reminder toggle (staff self-service).
create or replace function public.svc_set_reminders(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.profiles;
begin
  update public.profiles set reminders_enabled = (p ->> 'enabled')::boolean,
    preferred_language = coalesce(nullif(p ->> 'language', ''), preferred_language)
   where id = p_actor returning * into a;
  return jsonb_build_object('reminders_enabled', a.reminders_enabled);
end $$;

-- Job titles: extend the employee functions.
create or replace function public.svc_set_job_title(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.profiles; a public.profiles;
begin
  select * into b from public.profiles where id = (p ->> 'employee_id')::uuid for update;
  if not found then perform private.err('not_found'); end if;
  begin
    update public.profiles set job_title_ar = nullif(btrim(coalesce(p ->> 'job_title_ar', '')), ''),
      job_title_en = nullif(btrim(coalesce(p ->> 'job_title_en', '')), '') where id = b.id returning * into a;
  exception when check_violation then perform private.err('invalid_job_title'); end;
  perform private.audit(p_actor, 'employee.job_title', 'profiles', a.id::text,
    jsonb_build_object('job_title_ar', b.job_title_ar, 'job_title_en', b.job_title_en),
    jsonb_build_object('job_title_ar', a.job_title_ar, 'job_title_en', a.job_title_en));
  return to_jsonb(a);
end $$;

create or replace function public.svc_list_employees()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.role, x.full_name_en), '[]'::jsonb) from (
    select p.id, p.full_name_ar, p.full_name_en, p.job_title_ar, p.job_title_en, p.phone, p.role, p.active, p.created_at, p.deactivated_at,
           (select c.created_at from public.login_codes c where c.profile_id = p.id and c.revoked_at is null) as code_created_at,
           (select c.last_used_at from public.login_codes c where c.profile_id = p.id and c.revoked_at is null) as code_last_used_at,
           sal.monthly_salary_piastres,
           (select count(*) from auth.sessions s where s.user_id = p.id) as session_count
    from public.profiles p
    left join public.employee_salaries sal on sal.employee_id = p.id
  ) x
$$;

-- =============================================== lock down EXECUTE again
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'svc\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname not in ('current_uid', 'is_owner') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
