-- =====================================================================
-- Zintra حاضر — production audit fixes + Telegram admin-bot backend
-- Additive / replacing function bodies only. No data is deleted.
-- =====================================================================

-- ------------------------------------------------ security hardening
-- (1) Staff wrote leave / early-leave rows only through the API (svc_*),
--     but a direct REST insert was also allowed. That path skipped every
--     server rule (dates, times, duplicate checks) and the owner alert.
drop policy if exists leave_insert_own on public.leave_requests;
drop policy if exists early_leave_insert_own on public.early_leave_requests;
revoke insert on public.leave_requests, public.early_leave_requests from authenticated, anon;

-- (2) Platform helper exposed over REST.
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- (3) Pin search_path on the remaining helpers (linter 0011).
alter function private.touch_updated_at() set search_path = '';
alter function private.period_of(date) set search_path = '';
alter function private.distance_m(float8, float8, float8, float8) set search_path = '';
alter function private.validate_coords(jsonb) set search_path = '';
alter function private.err(text, jsonb) set search_path = '';
alter function private.fmt12(time, text) set search_path = '';

-- (4) Owner alerts: never queue a Telegram row without a destination
--     (a NULL chat id produced a NULL dedupe key → duplicates, no recipient).
create or replace function private.enqueue_owner_alert(p_event text, p_dedupe text, p_payload jsonb, p_ref text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings();
begin
  if s.owner_alert_channel <> 'telegram' or not (p_event = any (s.notify_events))
     or nullif(btrim(coalesce(s.owner_telegram_chat_id, '')), '') is null then
    return;
  end if;
  insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload)
  values (p_dedupe || ':telegram:' || s.owner_telegram_chat_id, p_event, p_ref, 'telegram', s.owner_telegram_chat_id, p_payload)
  on conflict (dedupe_key) do nothing;
end $$;

-- ------------------------------------------------ login: parallel-request bypass
-- Failures used to be counted only AFTER the code check, so many requests
-- sent at once all passed the pre-check before any failure was recorded.
-- Now the pre-check serialises per client (advisory lock), counts in-flight
-- attempts as failures, and reserves a row that svc_login_record completes.
create or replace function public.svc_login_precheck(p_ip_hash text, p_device_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_until timestamptz; v_fail int; v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('zh-login:' || p_ip_hash, 0));
  if p_device_hash <> p_ip_hash then perform pg_advisory_xact_lock(hashtextextended('zh-login:' || p_device_hash, 0)); end if;
  select max(locked_until) into v_until from public.login_lockouts
   where key_hash in (p_ip_hash, p_device_hash, 'global') and locked_until > now();
  if v_until is not null then
    return jsonb_build_object('allowed', false, 'retry_after_s', ceil(extract(epoch from v_until - now()))::int);
  end if;
  select greatest(
    (select count(*) from public.login_attempts a where a.client_ip_hash = p_ip_hash and not a.success and not a.refused_locked
       and a.attempted_at > now() - make_interval(mins => s.lockout_window_min)
       and a.attempted_at > coalesce((select max(l.created_at) from public.login_lockouts l where l.key_hash = p_ip_hash), '-infinity')),
    (select count(*) from public.login_attempts a where a.device_id_hash = p_device_hash and not a.success and not a.refused_locked
       and a.attempted_at > now() - make_interval(mins => s.lockout_window_min)
       and a.attempted_at > coalesce((select max(l.created_at) from public.login_lockouts l where l.key_hash = p_device_hash), '-infinity')))
    into v_fail;
  if v_fail >= s.lockout_max_failures then
    -- attempts already in flight used the allowance: refuse until they resolve
    return jsonb_build_object('allowed', false, 'retry_after_s', 60);
  end if;
  insert into public.login_attempts (client_ip_hash, device_id_hash, success) values (p_ip_hash, p_device_hash, false)
  returning id into v_id;
  return jsonb_build_object('allowed', true, 'attempt_id', v_id);
end $$;

create or replace function public.svc_login_record(
  p_ip_hash text, p_device_hash text, p_success boolean, p_profile uuid, p_refused_locked boolean default false, p_attempt bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.settings := private.settings();
  v_fail_ip int; v_fail_dev int; v_fail_global int;
  v_level int; v_minutes int; v_key text; v_locked boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended('zh-login:' || p_ip_hash, 0));
  if p_attempt is not null then
    update public.login_attempts set success = p_success, refused_locked = p_refused_locked,
           matched_profile_id = case when p_success then p_profile end
     where id = p_attempt and client_ip_hash = p_ip_hash;
    if not found then p_attempt := null; end if;
  end if;
  if p_attempt is null then
    insert into public.login_attempts (client_ip_hash, device_id_hash, success, refused_locked, matched_profile_id)
    values (p_ip_hash, p_device_hash, p_success, p_refused_locked, case when p_success then p_profile end);
  end if;

  if p_success or p_refused_locked then
    return jsonb_build_object('locked', false);
  end if;

  select count(*) into v_fail_ip from public.login_attempts a
   where a.client_ip_hash = p_ip_hash and not a.success and not a.refused_locked
     and a.attempted_at > now() - make_interval(mins => s.lockout_window_min)
     and a.attempted_at > coalesce((select max(l.created_at) from public.login_lockouts l where l.key_hash = p_ip_hash), '-infinity');
  select count(*) into v_fail_dev from public.login_attempts a
   where a.device_id_hash = p_device_hash and not a.success and not a.refused_locked
     and a.attempted_at > now() - make_interval(mins => s.lockout_window_min)
     and a.attempted_at > coalesce((select max(l.created_at) from public.login_lockouts l where l.key_hash = p_device_hash), '-infinity');

  if greatest(v_fail_ip, v_fail_dev) >= s.lockout_max_failures
     and not exists (select 1 from public.login_lockouts where key_hash in (p_ip_hash, p_device_hash) and locked_until > now()) then
    v_key := case when v_fail_ip >= v_fail_dev then p_ip_hash else p_device_hash end;
    select count(*) + 1 into v_level from public.login_lockouts
     where key_hash in (p_ip_hash, p_device_hash) and created_at > now() - interval '24 hours';
    v_minutes := s.lockout_durations_min[least(v_level, cardinality(s.lockout_durations_min))];
    insert into public.login_lockouts (scope, key_hash, level, locked_until)
    values ('client', p_ip_hash, v_level, now() + make_interval(mins => v_minutes));
    if p_device_hash <> p_ip_hash then
      insert into public.login_lockouts (scope, key_hash, level, locked_until)
      values ('client', p_device_hash, v_level, now() + make_interval(mins => v_minutes));
    end if;
    v_locked := true;
    perform private.enqueue_owner_alert('security',
      'lockout:' || left(v_key, 16) || ':' || to_char(now(), 'YYYYMMDDHH24MI'),
      jsonb_build_object('kind', 'client_lockout', 'level', v_level, 'minutes', v_minutes,
                         'failures', greatest(v_fail_ip, v_fail_dev), 'at', now()));
  end if;

  select count(*) into v_fail_global from public.login_attempts a
   where not a.success and not a.refused_locked and a.attempted_at > now() - interval '1 hour';
  if v_fail_global >= s.global_failure_limit_per_hour
     and not exists (select 1 from public.login_lockouts where key_hash = 'global' and locked_until > now()) then
    insert into public.login_lockouts (scope, key_hash, level, locked_until)
    values ('global', 'global', 1, now() + interval '15 minutes');
    perform private.enqueue_owner_alert('security',
      'global_throttle:' || to_char(now(), 'YYYYMMDDHH24MI'),
      jsonb_build_object('kind', 'global_throttle', 'failures_last_hour', v_fail_global, 'minutes', 15, 'at', now()));
    v_locked := true;
  end if;
  return jsonb_build_object('locked', v_locked);
end $$;
drop function if exists public.svc_login_record(text, text, boolean, uuid, boolean);

-- ------------------------------------------------ performance: FK indexes on hot joins
create index if not exists point_events_attendance_day on public.point_events (attendance_day_id) where attendance_day_id is not null;
create index if not exists outbox_employee on public.notification_outbox (employee_id) where employee_id is not null;
create index if not exists outbox_subscription on public.notification_outbox (subscription_id) where subscription_id is not null;
create index if not exists attendance_days_window on public.attendance_days (window_id) where window_id is not null;
create index if not exists attendance_days_point_event on public.attendance_days (point_event_id) where point_event_id is not null;
create index if not exists early_leave_status on public.early_leave_requests (status, created_at desc);

-- ------------------------------------------------ owner check-in / check-out alerts
update public.settings set notify_events = notify_events || array['check_in', 'check_out']
 where id and not ('check_in' = any (notify_events));
alter table public.settings alter column notify_events
  set default array['red_point', 'black_pending', 'reward_request', 'early_leave_request', 'leave_request', 'security', 'digest', 'weekly_summary', 'check_in', 'check_out'];

create or replace function public.svc_check_in(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.settings := private.settings();
  v_local timestamp := private.local_now();
  v_date date := v_local::date;
  v_time time := v_local::time;
  di record; c record; ev record; v_dist float8; v_att uuid; v_event uuid; v_close time;
begin
  if (select role from public.profiles where id = p_actor) <> 'staff' then perform private.err('staff_only'); end if;
  select * into di from private.day_info(v_date);
  if di.holiday_name_ar is not null then perform private.err('holiday', jsonb_build_object('name_ar', di.holiday_name_ar, 'name_en', di.holiday_name_en)); end if;
  if not di.check_in_enabled then perform private.err('check_in_disabled'); end if;
  v_close := private.checkin_close_time(v_date);
  if v_close is not null and v_time >= v_close then
    perform private.err('check_in_closed', jsonb_build_object('closes_at', v_close,
      'closes_at_ar', private.fmt12(v_close, 'ar'), 'closes_at_en', private.fmt12(v_close, 'en')));
  end if;
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

  perform private.clear_absence(p_actor, v_date, 'absence_cancel', null, 'late check-in cancels absence');

  if ev.outcome = 'red' then
    perform private.enqueue_owner_alert('red_point', 'red:' || v_event,
      jsonb_build_object('kind', 'red_point', 'employee', private.name_of(p_actor), 'date', v_date,
        'time', private.fmt12(v_time, 'ar'),
        'warning_only', (select warning_only from public.point_events where id = v_event)), v_event::text);
  else
    perform private.enqueue_owner_alert('check_in', 'in:' || v_att,
      jsonb_build_object('kind', 'check_in', 'employee', private.name_of(p_actor), 'date', v_date,
        'time', private.fmt12(v_time, 'ar'), 'outcome', ev.outcome, 'window', ev.label_ar), v_att::text);
  end if;

  return jsonb_build_object('outcome', ev.outcome, 'window_label_ar', ev.label_ar, 'window_label_en', ev.label_en,
    'checked_in_at', now(), 'distance_m', round(v_dist), 'config_warning', ev.config_warning,
    'warning_only', (select warning_only from public.point_events where id = v_event));
end $$;

-- Check-out: also closes an open record from the previous day when the
-- employee checks out just after midnight (within 20 h of checking in).
create or replace function public.svc_check_out(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_date date := private.local_now()::date; a public.attendance_days; c record; v_dist float8;
begin
  select * into a from public.attendance_days where employee_id = p_actor and work_date = v_date for update;
  if not found then
    select * into a from public.attendance_days
     where employee_id = p_actor and work_date = v_date - 1 and checked_in_at is not null and checked_out_at is null
       and not corrected and now() - checked_in_at < interval '20 hours'
     for update;
  end if;
  if a.id is null or a.checked_in_at is null then perform private.err('not_checked_in'); end if;
  if a.checked_out_at is not null then perform private.err('already_checked_out'); end if;
  select * into c from private.validate_coords(p);
  v_dist := private.check_geofence(c.lat, c.lng, c.acc);
  update public.attendance_days
     set checked_out_at = now(), check_out_lat = c.lat, check_out_lng = c.lng, check_out_accuracy_m = c.acc,
         worked_minutes = floor(extract(epoch from now() - a.checked_in_at) / 60)::int, missing_checkout = false
   where id = a.id returning * into a;
  perform private.enqueue_owner_alert('check_out', 'out:' || a.id,
    jsonb_build_object('kind', 'check_out', 'employee', private.name_of(p_actor), 'date', a.work_date,
      'time', private.fmt12_ts(a.checked_out_at, 'ar'), 'worked_minutes', a.worked_minutes), a.id::text);
  return jsonb_build_object('checked_out_at', a.checked_out_at, 'worked_minutes', a.worked_minutes, 'distance_m', round(v_dist));
end $$;

-- ------------------------------------------------ decisions notify the employee (Egyptian Arabic)
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
    update public.early_leave_requests set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_channel = v_channel
     where id = b.id returning * into a;
  else
    return jsonb_build_object('result', 'already_decided', 'status', b.status, 'id', b.id,
      'employee', private.name_of(b.employee_id), 'time', private.fmt12(b.requested_leave_time, 'ar'), 'date', b.work_date);
  end if;
  perform private.audit(p_actor, 'early_leave.' || a.status, 'early_leave_requests', a.id::text, to_jsonb(b), to_jsonb(a), a.admin_comment,
    case when v_channel = 'telegram' then 'telegram' else 'user' end);
  perform private.enqueue_push(a.employee_id, 'early_leave_decision', a.id::text || ':' || a.status,
    'Zintra حاضر', case when a.status = 'approved' then 'تمام 👍 اتوافق على انصرافك بدري الساعة ' || private.fmt12(a.requested_leave_time, 'ar')
                        else 'للأسف طلب الانصراف بدري اترفض.' end,
    'Zintra حاضر', case when a.status = 'approved' then 'Your early leave at ' || private.fmt12(a.requested_leave_time, 'en') || ' was approved.'
                        else 'Your early-leave request was declined.' end, false);
  return jsonb_build_object('result', 'decided', 'status', a.status, 'id', a.id,
    'employee', private.name_of(a.employee_id), 'time', private.fmt12(a.requested_leave_time, 'ar'), 'date', a.work_date);
end $$;

create or replace function public.svc_decide_leave(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.leave_requests; a public.leave_requests; v_approve boolean := (p ->> 'approve')::boolean; d date; v_n int := 0;
  v_status public.request_status;
begin
  select * into b from public.leave_requests where id = (p ->> 'id')::uuid for update;
  if not found then perform private.err('not_found'); end if;
  v_status := case when v_approve then 'approved' else 'rejected' end;
  if b.status = v_status then return jsonb_build_object('result', 'already_decided', 'status', b.status, 'employee', private.name_of(b.employee_id)); end if;
  if b.status = 'cancelled' or (b.status = 'rejected' and v_approve) then perform private.err('invalid_transition'); end if;
  update public.leave_requests set status = v_status, decided_by = p_actor, decided_at = now(),
    admin_comment = coalesce(nullif(btrim(coalesce(p ->> 'comment', '')), ''), admin_comment)
   where id = b.id returning * into a;
  if v_approve then
    for d in select generate_series(a.from_date, a.to_date, interval '1 day')::date loop
      v_n := v_n + private.clear_absence(a.employee_id, d, 'leave_reversal', p_actor, 'approved leave');
    end loop;
  end if;
  perform private.audit(p_actor, 'leave.' || v_status, 'leave_requests', a.id::text, to_jsonb(b), to_jsonb(a), p ->> 'comment');
  perform private.enqueue_push(a.employee_id, 'leave_decision', a.id::text || ':' || a.status,
    'Zintra حاضر', case when a.status = 'approved' then 'تمام 👍 إجازتك من ' || a.from_date || ' لـ ' || a.to_date || ' اتوافق عليها.'
                        else 'للأسف طلب الإجازة اترفض.' end,
    'Zintra حاضر', case when a.status = 'approved' then 'Your leave ' || a.from_date || ' → ' || a.to_date || ' was approved.'
                        else 'Your leave request was declined.' end, false);
  return jsonb_build_object('result', 'decided', 'status', a.status, 'absences_cleared', v_n, 'employee', private.name_of(a.employee_id));
end $$;

-- ------------------------------------------------ bot storage (service role only)
create table if not exists public.telegram_updates (
  update_id   bigint primary key,
  received_at timestamptz not null default now()
);
create table if not exists public.telegram_bot_state (
  chat_id    text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.telegram_actions (
  id         uuid primary key default gen_random_uuid(),
  chat_id    text not null,
  action     jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at    timestamptz
);
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists announcements_recent on public.announcements (created_at desc);
alter table public.telegram_updates enable row level security;
alter table public.telegram_bot_state enable row level security;
alter table public.telegram_actions enable row level security;
alter table public.announcements enable row level security;
revoke all on public.telegram_updates, public.telegram_bot_state, public.telegram_actions from anon, authenticated;
revoke all on public.announcements from anon, authenticated;
grant select on public.announcements to authenticated;
drop policy if exists announcements_select on public.announcements;
create policy announcements_select on public.announcements for select to authenticated
  using ((select private.current_uid()) is not null and created_at > now() - interval '30 days');

-- Telegram may redeliver an update; process each update_id once.
create or replace function public.svc_bot_claim_update(p_update_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from public.telegram_updates where received_at < now() - interval '7 days';
  insert into public.telegram_updates (update_id) values (p_update_id) on conflict do nothing;
  return found;
end $$;

create or replace function public.svc_bot_state(p_chat text, p_set boolean default false, p_state jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_set then
    if p_state is null then delete from public.telegram_bot_state where chat_id = p_chat;
    else insert into public.telegram_bot_state (chat_id, state, updated_at) values (p_chat, p_state, now())
         on conflict (chat_id) do update set state = excluded.state, updated_at = now();
    end if;
    return p_state;
  end if;
  select state into v from public.telegram_bot_state where chat_id = p_chat and updated_at > now() - interval '30 minutes';
  return v;
end $$;

-- A pending (unconfirmed) action. Confirm buttons carry only its id.
create or replace function public.svc_bot_action_create(p_chat text, p_action jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  delete from public.telegram_actions where expires_at < now() - interval '1 day';
  insert into public.telegram_actions (chat_id, action) values (p_chat, p_action) returning id into v;
  return v;
end $$;

-- Take it exactly once (a second tap / replay gets NULL).
create or replace function public.svc_bot_action_take(p_chat text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  update public.telegram_actions set used_at = now()
   where id = p_id and chat_id = p_chat and used_at is null and expires_at > now()
  returning action into v;
  return v;
end $$;

-- ------------------------------------------------ manual (exceptional) check-in
create or replace function public.svc_manual_check_in(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.settings := private.settings();
  v_emp uuid; v_date date; v_time time; v_reason text := btrim(coalesce(p ->> 'reason', ''));
  v_today date := private.local_now()::date; v_ts timestamptz; di record; ev record; v_att uuid; v_event uuid;
begin
  begin v_emp := (p ->> 'employee_id')::uuid; v_date := coalesce((p ->> 'date')::date, v_today); v_time := (p ->> 'time')::time;
  exception when others then perform private.err('invalid_time'); end;
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff' and active) then perform private.err('invalid_employee'); end if;
  if v_time is null or v_date > v_today or v_date < v_today - 31 then perform private.err('invalid_time'); end if;
  if char_length(v_reason) < 3 then perform private.err('reason_required'); end if;
  v_ts := (v_date + v_time) at time zone s.business_timezone;
  if v_ts > now() then perform private.err('invalid_time'); end if;
  select * into di from private.day_info(v_date);

  insert into public.attendance_days (employee_id, work_date, checked_in_at, corrected, corrected_by, corrected_at, correction_reason)
  values (v_emp, v_date, v_ts, true, p_actor, now(), v_reason)
  on conflict (employee_id, work_date) do nothing
  returning id into v_att;
  if v_att is null then perform private.err('already_checked_in'); end if;

  select * into ev from private.evaluate_time(v_date, v_time);
  if not di.points_enabled then ev.outcome := 'none'; end if;
  if ev.outcome = 'green' then
    v_event := private.add_event(v_emp, v_date, 'win:' || v_emp || ':' || v_date, 'green', 1, 'auto_window', 'active', 0, 0, p_actor,
                                 'manual check-in ' || to_char(v_time, 'HH24:MI') || ' — ' || v_reason, v_att);
  elsif ev.outcome = 'red' then
    v_event := private.add_event(v_emp, v_date, 'win:' || v_emp || ':' || v_date, 'red', 1, 'auto_window', 'active',
                                 s.red_penalty_piastres, s.red_penalty_piastres, p_actor, 'manual late check-in ' || to_char(v_time, 'HH24:MI'), v_att);
    perform private.recalc_reds(v_emp, private.period_of(v_date));
  end if;
  update public.attendance_days set window_id = ev.window_id, window_label_snapshot = ev.label_en,
         check_in_outcome = ev.outcome, point_event_id = v_event where id = v_att;
  perform private.clear_absence(v_emp, v_date, 'absence_cancel', p_actor, 'manual check-in by owner');
  perform private.audit(p_actor, 'attendance.manual_check_in', 'attendance_days', v_att::text, null,
    jsonb_build_object('employee_id', v_emp, 'date', v_date, 'time', v_time, 'outcome', ev.outcome), v_reason);
  return jsonb_build_object('attendance_id', v_att, 'employee', private.name_of(v_emp), 'date', v_date,
    'time', private.fmt12(v_time, 'ar'), 'outcome', ev.outcome, 'window', ev.label_ar);
end $$;

-- ------------------------------------------------ reports for the bot
create or replace function public.svc_bot_today(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_local timestamp := private.local_now(); v_today date := v_local::date; di record; v_close time;
begin
  select * into di from private.day_info(v_today);
  v_close := private.checkin_close_time(v_today);
  return jsonb_build_object('date', v_today, 'is_work_day', di.is_work_day, 'holiday', di.holiday_name_ar,
    'closes_at', private.fmt12(v_close, 'ar'), 'closed', v_close is not null and v_local::time >= v_close,
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'name', p.full_name_ar,
        'in', private.fmt12_ts(a.checked_in_at, 'ar'), 'out', private.fmt12_ts(a.checked_out_at, 'ar'),
        'outcome', a.check_in_outcome, 'manual', coalesce(a.corrected, false),
        'leave', exists (select 1 from public.leave_requests l where l.employee_id = p.id and l.status = 'approved' and v_today between l.from_date and l.to_date),
        'early_leave', (select private.fmt12(r.requested_leave_time, 'ar') from public.early_leave_requests r
                         where r.employee_id = p.id and r.work_date = v_today and r.status = 'approved' limit 1),
        'absence_pending', exists (select 1 from public.point_events e where e.employee_id = p.id and e.effective_work_date = v_today
                                    and e.source = 'auto_absence' and e.status = 'pending_approval'))
        order by p.full_name_ar)
      from public.profiles p left join public.attendance_days a on a.employee_id = p.id and a.work_date = v_today
      where p.role = 'staff' and p.active), '[]'::jsonb));
end $$;

create or replace function public.svc_bot_points(p_actor uuid, p jsonb default '{}')
returns jsonb language sql stable security definer set search_path = '' as $$
  with per as (
    select p.id, p.full_name_ar,
      private.period_total(p.id, 'green', private.period_of(private.local_now()::date)) as green,
      private.period_total(p.id, 'red', private.period_of(private.local_now()::date)) as red,
      private.period_total(p.id, 'black', private.period_of(private.local_now()::date)) as black,
      (select coalesce(sum(e.delta), 0)::int from public.point_events e where e.employee_id = p.id and e.color = 'green' and e.status = 'active') as green_all
    from public.profiles p where p.role = 'staff' and p.active)
  select jsonb_build_object('period', private.period_of(private.local_now()::date),
    'threshold', (select green_reward_threshold from public.settings where id),
    'rows', coalesce(jsonb_agg(jsonb_build_object('rank', r.rnk, 'id', r.id, 'name', r.full_name_ar, 'green', r.green, 'red', r.red, 'black', r.black, 'green_all', r.green_all)
                     order by r.rnk, r.full_name_ar), '[]'::jsonb))
  from (select per.*, rank() over (order by greatest(per.green, 0) desc)::int as rnk from per) r
$$;

-- ------------------------------------------------ broadcast to all employees
create or replace function public.svc_broadcast(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_body text := btrim(coalesce(p ->> 'text', '')); v_id uuid; emp record; v_n int := 0; v_people int := 0;
begin
  if char_length(v_body) not between 1 and 1000 then perform private.err('invalid_text'); end if;
  insert into public.announcements (body, created_by) values (v_body, p_actor) returning id into v_id;
  for emp in select id from public.profiles where role = 'staff' and active loop
    v_people := v_people + 1;
    v_n := v_n + private.enqueue_push(emp.id, 'announcement', v_id::text, 'Zintra حاضر — إعلان', left(v_body, 240),
                                      'Zintra حاضر — Announcement', left(v_body, 240), false);
  end loop;
  perform private.audit(p_actor, 'announcement.send', 'announcements', v_id::text, null, jsonb_build_object('body', v_body, 'devices', v_n));
  return jsonb_build_object('id', v_id, 'people', v_people, 'devices', v_n);
end $$;


-- ------------------------------------------------ settings snapshot for the bot
create or replace function public.svc_bot_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'geofence_lat', s.geofence_lat, 'geofence_lng', s.geofence_lng, 'radius_m', s.geofence_radius_m,
    'reward_piastres', s.reward_amount_piastres, 'threshold', s.green_reward_threshold,
    'work_end', private.fmt12(s.work_end_time, 'ar'), 'notify_events', to_jsonb(s.notify_events),
    'work_days', coalesce((select jsonb_agg(r.day_of_week order by r.day_of_week) from public.day_rules r where r.is_work_day), '[]'::jsonb),
    'windows', coalesce((select jsonb_agg(jsonb_build_object('label_ar', w.label_ar, 'label_en', w.label_en, 'start', to_char(w.start_time, 'HH24:MI'),
        'end', to_char(w.end_time, 'HH24:MI'), 'green', w.awards_green_point) order by w.start_time)
      from public.check_in_windows w where w.enabled and w.day_of_week = (select min(r.day_of_week) from public.day_rules r where r.is_work_day)), '[]'::jsonb))
  from public.settings s where s.id
$$;

-- one-time setup steps run by the dispatcher (e.g. re-registering the webhook)
create or replace function public.svc_bot_setup_needed(p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not private.job_done('telegram_setup', p_key)
$$;
create or replace function public.svc_bot_setup_done(p_key text, p_ok boolean, p_detail jsonb)
returns void language sql security definer set search_path = '' as $$
  select private.record_job('telegram_setup', p_key, case when p_ok then 'succeeded' else 'failed' end, p_detail)
$$;

-- ------------------------------------------------ lock down EXECUTE again
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
