-- Rollback of 20261123120000_audit_fixes_and_admin_bot (restores previous definitions)

drop function if exists public.svc_bot_claim_update(bigint);

drop function if exists public.svc_bot_state(text, boolean, jsonb);

drop function if exists public.svc_bot_action_create(text, jsonb);

drop function if exists public.svc_bot_action_take(text, uuid);

drop function if exists public.svc_manual_check_in(uuid, jsonb);

drop function if exists public.svc_bot_today(uuid, jsonb);

drop function if exists public.svc_bot_points(uuid, jsonb);

drop function if exists public.svc_broadcast(uuid, jsonb);
drop function if exists public.svc_bot_settings();
drop function if exists public.svc_bot_setup_needed(text);
drop function if exists public.svc_bot_setup_done(text, boolean, jsonb);

drop table if exists public.telegram_updates, public.telegram_bot_state, public.telegram_actions, public.announcements;

drop index if exists public.point_events_attendance_day, public.outbox_employee, public.outbox_subscription, public.attendance_days_window, public.attendance_days_point_event, public.early_leave_status;

update public.settings set notify_events = array_remove(array_remove(notify_events, 'check_in'), 'check_out') where id;

alter table public.settings alter column notify_events set default array['red_point', 'black_pending', 'reward_request', 'early_leave_request', 'leave_request', 'security', 'digest', 'weekly_summary'];

grant insert (employee_id, from_date, to_date, type, reason) on public.leave_requests to authenticated;

grant insert (employee_id, work_date, requested_leave_time, reason) on public.early_leave_requests to authenticated;

create policy leave_insert_own on public.leave_requests for insert to authenticated with check (employee_id = (select private.current_uid()));

create policy early_leave_insert_own on public.early_leave_requests for insert to authenticated with check (employee_id = (select private.current_uid()));

alter function private.touch_updated_at() reset search_path;

alter function private.period_of(date) reset search_path;

alter function private.distance_m(float8, float8, float8, float8) reset search_path;

alter function private.validate_coords(jsonb) reset search_path;

alter function private.err(text, jsonb) reset search_path;

alter function private.fmt12(time, text) reset search_path;

drop function if exists public.svc_login_record(text, text, boolean, uuid, boolean, bigint);

create or replace function private.enqueue_owner_alert(p_event text, p_dedupe text, p_payload jsonb, p_ref text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare s public.settings := private.settings();
begin
  if s.owner_alert_channel <> 'telegram' or not (p_event = any (s.notify_events)) then
    return;
  end if;
  insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload)
  values (p_dedupe || ':telegram:' || s.owner_telegram_chat_id, p_event, p_ref, 'telegram', s.owner_telegram_chat_id, p_payload)
  on conflict (dedupe_key) do nothing;
end $$;

create or replace function public.svc_login_precheck(p_ip_hash text, p_device_hash text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  select max(locked_until) into v_until
  from public.login_lockouts
  where key_hash in (p_ip_hash, p_device_hash, 'global') and locked_until > now();
  if v_until is not null then
    return jsonb_build_object('allowed', false, 'retry_after_s', ceil(extract(epoch from v_until - now()))::int);
  end if;
  return jsonb_build_object('allowed', true);
end $$;

create or replace function public.svc_login_record(
  p_ip_hash text, p_device_hash text, p_success boolean, p_profile uuid, p_refused_locked boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.settings := private.settings();
  v_fail_ip int; v_fail_dev int; v_fail_global int;
  v_level int; v_minutes int; v_key text; v_locked boolean := false;
begin
  insert into public.login_attempts (client_ip_hash, device_id_hash, success, refused_locked, matched_profile_id)
  values (p_ip_hash, p_device_hash, p_success, p_refused_locked, case when p_success then p_profile end);

  if p_success or p_refused_locked then
    return jsonb_build_object('locked', false);
  end if;

  -- failures since the last success / lockout window, per key
  select count(*) into v_fail_ip from public.login_attempts a
   where a.client_ip_hash = p_ip_hash and not a.success and not a.refused_locked
     and a.attempted_at > now() - make_interval(mins => s.lockout_window_min)
     and a.attempted_at > coalesce((select max(l.created_at) from public.login_lockouts l where l.key_hash = p_ip_hash), '-infinity');
  select count(*) into v_fail_dev from public.login_attempts a
   where a.device_id_hash = p_device_hash and not a.success and not a.refused_locked
     and a.attempted_at > now() - make_interval(mins => s.lockout_window_min)
     and a.attempted_at > coalesce((select max(l.created_at) from public.login_lockouts l where l.key_hash = p_device_hash), '-infinity');

  if greatest(v_fail_ip, v_fail_dev) >= s.lockout_max_failures then
    v_key := case when v_fail_ip >= v_fail_dev then p_ip_hash else p_device_hash end;
    -- escalation: count this key's lockouts in the last 24h
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

  -- global throttle across all clients
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
  -- #12: no new check-in after the last window has closed (decided on the
  -- server clock; nothing is written, so no phantom check-in or penalty).
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

  -- never charge absence AND lateness for the same date
  perform private.clear_absence(p_actor, v_date, 'absence_cancel', null, 'late check-in cancels absence');

  if ev.outcome = 'red' then
    perform private.enqueue_owner_alert('red_point', 'red:' || v_event,
      jsonb_build_object('kind', 'red_point', 'employee', private.name_of(p_actor), 'date', v_date,
        'time', private.fmt12(v_time, 'ar'),
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
    return jsonb_build_object('result', 'already_decided', 'status', b.status, 'id', b.id);
  end if;
  perform private.audit(p_actor, 'early_leave.' || a.status, 'early_leave_requests', a.id::text, to_jsonb(b), to_jsonb(a), a.admin_comment,
    case when v_channel = 'telegram' then 'telegram' else 'user' end);
  perform private.enqueue_push(a.employee_id, 'early_leave_decision', a.id::text || ':' || a.status,
    'Zintra حاضر', case when a.status = 'approved' then 'تمت الموافقة على انصرافك المبكر الساعة ' || private.fmt12(a.requested_leave_time, 'ar')
                        else 'تم رفض طلب الانصراف المبكر.' end,
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

revoke all on function public.svc_login_record(text, text, boolean, uuid, boolean) from public, anon, authenticated;

grant execute on function public.svc_login_record(text, text, boolean, uuid, boolean) to service_role;
