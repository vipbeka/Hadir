-- =====================================================================
-- Zintra حاضر — fix package (2026-11-22)
--   #2  leave requests now reach the owner on Telegram (they were never
--       queued: svc_request_leave had no enqueue and 'leave_request'
--       was not an enabled event type).
--   #3  owner messages show Cairo time in 12-hour format (4:44 م).
--   #12 new check-ins are refused once the day's LAST enabled window has
--       closed (server clock, Africa/Cairo). Approved by the owner.
-- Additive and non-destructive: no data is deleted or recomputed.
-- =====================================================================

-- ---------------------------------------------------------- #3 helpers
-- 12-hour clock text for a local time value (no date parsing, no offsets).
create or replace function private.fmt12(p_t time, p_lang text default 'ar')
returns text language sql immutable as $$
  select case when p_t is null then null else
    ltrim(to_char(p_t, 'HH12:MI'), '0') ||
    case when p_lang = 'en' then (case when p_t < '12:00' then ' AM' else ' PM' end)
         else (case when p_t < '12:00' then ' ص' else ' م' end) end end
$$;

-- Same for a timestamp, converted to the business timezone first.
create or replace function private.fmt12_ts(p_ts timestamptz, p_lang text default 'ar')
returns text language sql stable security definer set search_path = '' as $$
  select private.fmt12((p_ts at time zone private.tz())::time, p_lang)
$$;

-- --------------------------------------------------------- #12 closing
-- Closing moment for new check-ins = end of the day's last ENABLED window
-- (null when the day has no enabled windows → no closing rule applies).
create or replace function private.checkin_close_time(d date)
returns time language sql stable security definer set search_path = '' as $$
  select max(end_time) from public.check_in_windows
   where day_of_week = extract(dow from d) and enabled
$$;

-- Start-inclusive / end-exclusive: at the exact closing moment it is closed.
create or replace function private.checkin_closed(d date, t time)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(t >= private.checkin_close_time(d), false)
$$;

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

-- my_day: expose the closing time + whether it has passed (server decides).
create or replace function public.svc_my_day(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.settings := private.settings(); v_local timestamp := private.local_now(); v_date date := v_local::date;
  di record; a public.attendance_days; el public.early_leave_requests; v_close time;
begin
  select * into di from private.day_info(v_date);
  select * into a from public.attendance_days where employee_id = p_actor and work_date = v_date;
  select * into el from public.early_leave_requests where employee_id = p_actor and work_date = v_date
     and status in ('pending', 'approved') order by created_at desc limit 1;
  v_close := private.checkin_close_time(v_date);
  return jsonb_build_object(
    'server_now', now(), 'business_date', v_date, 'business_time', to_char(v_local, 'HH24:MI:SS'), 'timezone', s.business_timezone,
    'is_work_day', di.is_work_day, 'check_in_enabled', di.check_in_enabled, 'points_enabled', di.points_enabled,
    'holiday', case when di.holiday_name_ar is null then null else jsonb_build_object('name_ar', di.holiday_name_ar, 'name_en', di.holiday_name_en) end,
    'geofence', jsonb_build_object('lat', s.geofence_lat, 'lng', s.geofence_lng, 'radius_m', s.geofence_radius_m),
    'work_start_time', s.work_start_time, 'work_end_time', s.work_end_time,
    'expected_end_time', case when el.status = 'approved' then el.requested_leave_time else s.work_end_time end,
    'check_in_closes_at', v_close,
    'check_in_closed', (v_close is not null and v_local::time >= v_close),
    'windows', coalesce((select jsonb_agg(jsonb_build_object('label_ar', w.label_ar, 'label_en', w.label_en,
        'start', w.start_time, 'end', w.end_time, 'green', w.awards_green_point) order by w.start_time)
      from public.check_in_windows w where w.day_of_week = extract(dow from v_date) and w.enabled), '[]'::jsonb),
    'attendance', case when a.id is null then null else to_jsonb(a) - 'check_in_lat' - 'check_in_lng' - 'check_out_lat' - 'check_out_lng' end,
    'early_leave', case when el.id is null then null else to_jsonb(el) end,
    'missing_checkouts', (select count(*) from public.attendance_days x where x.employee_id = p_actor
                             and x.checked_out_at is null and x.work_date < v_date and not x.corrected));
end $$;

-- ------------------------------------------------------- #2 leave alerts
-- Enable the event type (append only if missing; the owner can still
-- turn it off from settings).
update public.settings
   set notify_events = array_append(notify_events, 'leave_request')
 where id and not ('leave_request' = any (notify_events));
alter table public.settings alter column notify_events
  set default array['red_point', 'black_pending', 'reward_request', 'early_leave_request', 'leave_request', 'security', 'digest', 'weekly_summary'];

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
  -- Owner alert goes through the outbox (async, retried, deduped by the
  -- request id). A Telegram failure never affects the saved request.
  perform private.enqueue_owner_alert('leave_request', 'leave:' || r.id,
    jsonb_build_object('kind', 'leave_request', 'id', r.id, 'employee', private.name_of(p_actor),
      'type', r.type, 'from', r.from_date, 'to', r.to_date, 'days', r.to_date - r.from_date + 1,
      'reason', r.reason, 'status', r.status), r.id::text);
  return to_jsonb(r);
end $$;

-- ---------------------------------------------- #3 12-hour times in texts
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
      'date', v_date, 'time', private.fmt12(v_time, 'ar'), 'reason', r.reason), r.id::text);
  perform private.audit(p_actor, 'early_leave.request', 'early_leave_requests', r.id::text, null, to_jsonb(r));
  return to_jsonb(r);
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
        v_status := 'متأخر ' || private.fmt12_ts(a.checked_in_at, 'ar') ||
          case when (select warning_only from public.point_events where id = a.point_event_id) then ' (إنذار)' else ' (خصم)' end;
      elsif a.id is not null then
        v_status := 'حاضر ' || private.fmt12_ts(a.checked_in_at, 'ar') || coalesce(' · ' || (
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
