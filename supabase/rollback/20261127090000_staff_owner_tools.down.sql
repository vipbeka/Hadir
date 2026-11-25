-- Rollback of 20261127090000_staff_owner_tools: restores the previous
-- definitions of every changed function, then drops the new objects.
CREATE OR REPLACE FUNCTION public.svc_check_in(p_actor uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION private.run_absence(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION private.emp_day_status(p_emp uuid, d date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare di record; s public.settings := private.settings();
begin
  select * into di from private.day_info(d);
  if di.holiday_name_ar is not null or not di.is_work_day or not di.check_in_enabled or di.enabled_windows = 0 then return 'nonwork'; end if;
  if (select created_at from public.profiles where id = p_emp) >= ((d + s.absence_cutoff) at time zone s.business_timezone) then return 'nonwork'; end if;
  if exists (select 1 from public.attendance_days where employee_id = p_emp and work_date = d and checked_in_at is not null) then return 'present'; end if;
  if exists (select 1 from public.leave_requests where employee_id = p_emp and status = 'approved' and d between from_date and to_date) then return 'leave'; end if;
  if exists (select 1 from public.point_events e where e.employee_id = p_emp and e.effective_work_date = d and e.source = 'auto_absence'
              and e.color = 'black' and e.delta > 0 and e.status in ('pending_approval', 'active') and not private.is_reversed(e.id)) then return 'absent'; end if;
  return 'open';
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_request_early_leave(p_actor uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_my_day(p_actor uuid, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_my_summary(p_actor uuid, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_request_leave(p_actor uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_pending(p_actor uuid, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.svc_owner_dashboard(p_actor uuid, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION private.owner_fanout(p_type text, p_event text, p_dedupe text, p_payload jsonb, p_ref text, p_force boolean DEFAULT false)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s public.settings := private.settings();
  a public.attendance_days; e public.point_events; lr public.leave_requests; er public.early_leave_requests; rr public.reward_requests;
  v_emp uuid; v_name text; v_title text; v_body text; v_link text; v_at timestamptz := now();
  v_flags jsonb := '{}'::jsonb; v_late int; v_dist float8; v_id bigint; v_payload jsonb; sub record; v_today date := private.local_now()::date;
begin
  if p_event in ('check_in', 'check_out') then
    select * into a from public.attendance_days where id::text = p_ref;
  elsif p_event in ('red_point', 'black_pending') then
    select * into e from public.point_events where id::text = p_ref;
    if p_event = 'red_point' then select * into a from public.attendance_days where employee_id = e.employee_id and work_date = e.effective_work_date; end if;
  elsif p_event = 'leave_request' then select * into lr from public.leave_requests where id::text = p_ref;
  elsif p_event = 'early_leave_request' then select * into er from public.early_leave_requests where id::text = p_ref;
  elsif p_event = 'reward_request' then select * into rr from public.reward_requests where id::text = p_ref;
  end if;
  v_emp := coalesce(a.employee_id, e.employee_id, lr.employee_id, er.employee_id, rr.employee_id, nullif(p_payload ->> 'employee_id', '')::uuid);
  v_name := coalesce((select nullif(btrim(full_name_ar), '') from public.profiles where id = v_emp), p_payload ->> 'employee', 'موظف');
  if p_type = 'check_in' then
    v_at := coalesce(a.checked_in_at, now());
    v_title := 'حضور';
    v_body := format('%s حضر الساعة %s', v_name, private.fmt12_ts(v_at, 'ar')) || E'\n' || private.ar_date(coalesce(a.work_date, v_today));
    if coalesce(a.check_in_outcome, case when p_event = 'red_point' then 'red' end) = 'red' then
      v_late := private.late_minutes(coalesce(a.work_date, v_today), (v_at at time zone s.business_timezone)::time);
      v_title := 'حضور متأخر';
      v_body := v_body || E'\n' || format('⏰ متأخر %s دقيقة', v_late)
        || case when e.warning_only then ' (أول تأخير هذا الشهر: إنذار بدون خصم)' when e.id is not null then ' (نقطة حمراء)' else '' end;
      v_flags := v_flags || jsonb_build_object('late_minutes', v_late);
    end if;
    if a.check_in_lat is not null and s.geofence_lat is not null then
      v_dist := private.distance_m(a.check_in_lat::float8, a.check_in_lng::float8, s.geofence_lat::float8, s.geofence_lng::float8);
      if v_dist > s.geofence_radius_m then
        v_body := v_body || E'\n' || format('⚠️ تسجيل خارج الموقع المسموح (على بعد %s م)', round(v_dist));
        v_flags := v_flags || jsonb_build_object('outside_location', true);
      end if;
    end if;
    v_link := '#/owner/employee?id=' || v_emp;
  elsif p_type = 'check_out' then
    v_at := coalesce(a.checked_out_at, now());
    v_title := 'انصراف';
    v_body := format('%s انصرف الساعة %s', v_name, private.fmt12_ts(v_at, 'ar')) || E'\n' || private.ar_date(coalesce(a.work_date, v_today))
      || case when a.worked_minutes is not null then E'\n' || format('مدة العمل %s س %s د', a.worked_minutes / 60, a.worked_minutes % 60) else '' end;
    v_link := '#/owner/employee?id=' || v_emp;
  elsif p_type = 'absence' then
    v_title := 'غياب';
    v_body := case when e.effective_work_date = v_today or e.effective_work_date is null then format('%s غاب اليوم', v_name)
                   else format('%s غاب يوم %s', v_name, private.ar_date(e.effective_work_date)) end
      || E'\n' || private.ar_date(coalesce(e.effective_work_date, v_today))
      || E'\n' || 'لم يسجّل حضوره حتى نهاية موعد الحضور ولا توجد إجازة معتمدة.'
      || E'\n' || 'نقطة سوداء بانتظار موافقتك في «الموافقات».';
    v_link := '#/owner/approvals';
  elsif p_type = 'request' then
    v_link := '#/owner/approvals';
    if p_event = 'early_leave_request' then
      v_at := coalesce(er.created_at, now());
      v_title := 'طلب انصراف مبكر';
      v_body := format('%s طلب انصراف مبكر %s الساعة %s', v_name,
                  case when er.work_date = v_today then 'اليوم' else private.ar_date(er.work_date) end, private.fmt12(er.requested_leave_time, 'ar'));
      if er.reason is not null then v_body := v_body || '، السبب: ' || er.reason; end if;
    elsif p_event = 'leave_request' then
      v_at := coalesce(lr.created_at, now());
      v_title := case when lr.type = 'sick' then 'طلب إجازة مرضية' else 'طلب غياب / إجازة' end;
      v_body := format('%s طلب %s %s', v_name, case when lr.type = 'sick' then 'إجازة مرضية' else 'إجازة (غياب)' end,
                  case when lr.from_date = lr.to_date then 'يوم ' || private.ar_date(lr.from_date)
                       else format('من %s إلى %s (%s يوم)', private.ar_date(lr.from_date), private.ar_date(lr.to_date), lr.to_date - lr.from_date + 1) end);
      if lr.reason is not null then v_body := v_body || '، السبب: ' || lr.reason; end if;
    elsif p_event = 'reward_request' then
      v_at := coalesce(rr.created_at, now());
      v_title := 'طلب صرف مكافأة';
      v_body := format('%s طلب صرف مكافأة شهر %s', v_name, to_char(rr.period_month, 'FMMM/YYYY'));
    else
      v_title := 'طلب'; v_body := v_name || ' أرسل طلبًا';
    end if;
    v_body := v_body || E'\n' || format('وقت الطلب: %s — %s', private.fmt12_ts(v_at, 'ar'), private.ar_date((v_at at time zone s.business_timezone)::date));
  else  -- test
    v_title := 'إشعار تجريبي';
    v_body := 'الإشعارات تعمل ✅' || E'\n' || format('%s — %s', private.fmt12_ts(now(), 'ar'), private.ar_date(v_today));
    v_link := '#/owner/notifications';
  end if;
  v_body := left(v_body, 1000);
  -- 1) in-app (also the anchor: an existing row means this event was already handled)
  if p_force or private.owner_pref(p_type, 'app') then
    insert into public.owner_notifications (dedupe_key, type, event, employee_id, ref_id, title_ar, body_ar, link, flags, event_at)
    values (p_dedupe, p_type, p_event, v_emp, p_ref, v_title, v_body, v_link, v_flags, v_at)
    on conflict (dedupe_key) do nothing returning id into v_id;
    if v_id is null then return null; end if;
  end if;
  -- 2) device push (every enabled device of an active owner)
  if p_force or private.owner_pref(p_type, 'push') then
    for sub in select p.id, p.employee_id from public.push_subscriptions p join public.profiles r on r.id = p.employee_id
                where r.role = 'owner' and r.active and p.enabled loop
      insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload, employee_id, subscription_id, subject_id)
      values (p_dedupe || ':push:' || sub.id, 'owner_' || p_type, p_ref, 'web_push', sub.id::text,
              jsonb_build_object('kind', 'owner_' || p_type, 'title', v_title, 'body', v_body, 'lang', 'ar',
                'url', './index.html#/owner/notifications' || coalesce('?id=' || v_id, ''), 'tag', p_dedupe),
              sub.employee_id, sub.id, v_emp)
      on conflict (dedupe_key) do nothing;
    end loop;
  end if;
  -- 3) Telegram (same text; existing payload keeps the approve/reject buttons)
  if (p_force or private.owner_pref(p_type, 'telegram')) and s.owner_alert_channel = 'telegram'
     and nullif(btrim(coalesce(s.owner_telegram_chat_id, '')), '') is not null then
    v_payload := coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('kind', coalesce(p_payload ->> 'kind', p_event),
      'text_ar', v_title || E'\n' || v_body, 'link', v_link, 'employee_id', v_emp);
    insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload, subject_id)
    values (p_dedupe || ':telegram:' || s.owner_telegram_chat_id, p_event, p_ref, 'telegram', s.owner_telegram_chat_id, v_payload, v_emp)
    on conflict (dedupe_key) do nothing;
  end if;
  return v_id;
end $function$
;

CREATE OR REPLACE FUNCTION private.enqueue_owner_alert(p_event text, p_dedupe text, p_payload jsonb, p_ref text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.settings := private.settings();
  v_type text := case p_event when 'check_in' then 'check_in' when 'red_point' then 'check_in' when 'check_out' then 'check_out'
                              when 'black_pending' then 'absence'
                              when 'leave_request' then 'request' when 'early_leave_request' then 'request' when 'reward_request' then 'request' end;
begin
  if v_type is not null then
    begin
      perform private.owner_fanout(v_type, p_event, p_dedupe, p_payload, p_ref);
    exception when others then
      -- never block the employee's check-in / request: keep the error visible instead
      insert into public.job_runs (job_name, run_key, status, finished_at, detail)
      values ('owner_notify', p_dedupe, 'failed', now(), jsonb_build_object('event', p_event, 'error', left(sqlerrm, 200)))
      on conflict (job_name, run_key) do update set status = 'failed', finished_at = now(), detail = excluded.detail;
    end;
    return;
  end if;
  -- other owner alerts (security, digest, weekly…): unchanged
  if s.owner_alert_channel <> 'telegram' or not (p_event = any (s.notify_events))
     or nullif(btrim(coalesce(s.owner_telegram_chat_id, '')), '') is null then
    return;
  end if;
  insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload)
  values (p_dedupe || ':telegram:' || s.owner_telegram_chat_id, p_event, p_ref, 'telegram', s.owner_telegram_chat_id, p_payload)
  on conflict (dedupe_key) do nothing;
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_employee_statement(p_actor uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_emp uuid; v_from date; v_to date; v_today date := private.local_now()::date; s public.settings := private.settings();
  prof public.profiles; v_days jsonb := '[]'::jsonb; d date; di record; a public.attendance_days; v_status text; v_leave jsonb; v_el jsonb; v_ev jsonb;
  t_present int := 0; t_late int := 0; t_abs int := 0; t_abs_pending int := 0; t_excused int := 0; t_minutes bigint := 0; t_missing int := 0;
  t_norecord int := 0; t_leave int := 0; t_work int := 0; v_ded bigint; t_ded bigint := 0; v_cutoff timestamptz;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_emp := (p ->> 'employee_id')::uuid; v_from := (p ->> 'from')::date; v_to := (p ->> 'to')::date;
  exception when others then perform private.err('invalid_time'); end;
  select * into prof from public.profiles where id = v_emp and role = 'staff';
  if prof.id is null then perform private.err('not_found'); end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 400 then perform private.err('invalid_range'); end if;
  for d in select g::date from generate_series(v_from, v_to, interval '1 day') g loop
    select * into di from private.day_info(d);
    select * into a from public.attendance_days where employee_id = v_emp and work_date = d;
    select jsonb_agg(jsonb_build_object('id', l.id, 'type', l.type, 'status', l.status, 'from', l.from_date, 'to', l.to_date) order by l.created_at)
      into v_leave from public.leave_requests l where l.employee_id = v_emp and d between l.from_date and l.to_date;
    select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'time', r.requested_leave_time) order by r.created_at)
      into v_el from public.early_leave_requests r where r.employee_id = v_emp and r.work_date = d;
    select jsonb_agg(jsonb_build_object('color', e.color, 'delta', e.delta, 'status', e.status, 'warning', e.warning_only, 'source', e.source,
        'deduction_piastres', case when e.status = 'active' and not private.is_reversed(e.id) and not e.warning_only then e.deduction_amount_piastres else 0 end,
        'reversed', private.is_reversed(e.id), 'reason', e.reason) order by e.created_at),
      coalesce(sum(case when e.status = 'active' and e.delta > 0 and not private.is_reversed(e.id) and not e.warning_only then e.deduction_amount_piastres else 0 end), 0)
      into v_ev, v_ded from public.point_events e where e.employee_id = v_emp and e.effective_work_date = d and e.reverses_event_id is null;
    v_cutoff := (d + s.absence_cutoff) at time zone s.business_timezone;
    v_status := case
      when prof.created_at > (d + time '23:59') at time zone s.business_timezone then 'not_employed'
      when a.checked_in_at is not null then case when a.check_in_outcome = 'red' then 'late' else 'present' end
      when di.holiday_name_ar is not null then 'holiday'
      when not di.is_work_day then 'weekend'
      when exists (select 1 from jsonb_array_elements(coalesce(v_leave, '[]')) x where x ->> 'status' = 'approved') then case when d > v_today then 'planned_leave' else 'leave' end
      when d > v_today then 'future'
      when exists (select 1 from jsonb_array_elements(coalesce(v_ev, '[]')) x where x ->> 'source' = 'auto_absence' and x ->> 'status' = 'active' and not (x ->> 'reversed')::boolean) then 'absent'
      when exists (select 1 from jsonb_array_elements(coalesce(v_ev, '[]')) x where x ->> 'source' = 'auto_absence' and x ->> 'status' = 'pending_approval') then 'absent_pending'
      when exists (select 1 from jsonb_array_elements(coalesce(v_ev, '[]')) x where x ->> 'source' = 'auto_absence' and x ->> 'status' = 'declined') then 'absence_excused'
      when now() < v_cutoff then 'open'
      else 'no_record' end;
    if v_status in ('present', 'late') then t_present := t_present + 1; end if;
    if v_status = 'late' then t_late := t_late + 1; end if;
    if v_status = 'absent' then t_abs := t_abs + 1; end if;
    if v_status = 'absent_pending' then t_abs_pending := t_abs_pending + 1; end if;
    if v_status = 'absence_excused' then t_excused := t_excused + 1; end if;
    if v_status = 'no_record' then t_norecord := t_norecord + 1; end if;
    if v_status = 'leave' then t_leave := t_leave + 1; end if;
    if di.is_work_day and di.holiday_name_ar is null and d <= v_today then t_work := t_work + 1; end if;
    if a.id is not null and a.checked_in_at is not null and a.checked_out_at is null and d < v_today then t_missing := t_missing + 1; end if;
    t_minutes := t_minutes + coalesce(a.worked_minutes, 0); t_ded := t_ded + v_ded;
    v_days := v_days || jsonb_build_object('date', d, 'dow', extract(dow from d)::int, 'status', v_status, 'holiday', di.holiday_name_ar,
      'check_in', case when a.checked_in_at is not null then to_char(a.checked_in_at at time zone s.business_timezone, 'HH24:MI') end,
      'check_out', case when a.checked_out_at is not null then to_char(a.checked_out_at at time zone s.business_timezone, 'HH24:MI') end,
      'check_out_date', case when a.checked_out_at is not null then (a.checked_out_at at time zone s.business_timezone)::date end,
      'worked_minutes', a.worked_minutes, 'missing_checkout', a.id is not null and a.checked_in_at is not null and a.checked_out_at is null and d < v_today,
      'outcome', a.check_in_outcome, 'window', (select label_ar from public.check_in_windows w where w.id = a.window_id),
      'corrected', coalesce(a.corrected, false), 'corrected_at', a.corrected_at, 'correction_reason', a.correction_reason,
      'corrected_by', case when a.corrected_by is not null then private.name_of(a.corrected_by) end,
      'leave', v_leave, 'early_leave', v_el, 'events', v_ev, 'deduction_piastres', v_ded);
  end loop;
  return jsonb_build_object('employee', jsonb_build_object('id', prof.id, 'code', private.emp_code(prof.id), 'name_ar', prof.full_name_ar,
      'name_en', prof.full_name_en, 'job_title_ar', prof.job_title_ar, 'job_title_en', prof.job_title_en, 'active', prof.active),
    'from', v_from, 'to', v_to, 'today', v_today, 'days', v_days,
    'totals', jsonb_build_object('working_days_elapsed', t_work, 'present', t_present, 'late', t_late, 'absent', t_abs, 'absent_pending', t_abs_pending,
      'absence_excused', t_excused, 'no_record', t_norecord, 'leave_days', t_leave, 'worked_minutes', t_minutes, 'missing_checkouts', t_missing,
      'deductions_piastres', t_ded),
    -- leave by type/status, counted once per calendar day inside the range (overlaps de-duplicated)
    'leave_summary', coalesce((select jsonb_agg(jsonb_build_object('type', x.type, 'status', x.status, 'taken_days', x.taken, 'planned_days', x.planned, 'requests', x.reqs))
      from (select l.type, l.status,
              count(distinct g::date) filter (where g::date <= v_today) as taken, count(distinct g::date) filter (where g::date > v_today) as planned,
              count(distinct l.id) as reqs
              from public.leave_requests l, generate_series(greatest(l.from_date, v_from), least(l.to_date, v_to), interval '1 day') g
             where l.employee_id = v_emp and l.to_date >= v_from and l.from_date <= v_to group by l.type, l.status) x), '[]'::jsonb),
    'leave_allowance', 'not_configured',
    'months', (select jsonb_agg(to_char(m, 'YYYY-MM') order by m) from generate_series(private.period_of(v_from), private.period_of(v_to), interval '1 month') m));
end $function$
;

CREATE OR REPLACE FUNCTION private.enqueue_reminders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION private.run_digest(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

drop function if exists public.svc_request_permission(uuid, jsonb), public.svc_cancel_permission(uuid, jsonb), public.svc_decide_permission(uuid, jsonb),
  public.svc_request_correction(uuid, jsonb), public.svc_cancel_correction(uuid, jsonb), public.svc_decide_correction(uuid, jsonb),
  public.svc_employee_schedule(uuid, jsonb), public.svc_save_employee_schedule(uuid, jsonb),
  public.svc_my_leave_balance(uuid, jsonb), public.svc_leave_balances(uuid, jsonb), public.svc_set_leave_balance(uuid, jsonb),
  public.svc_my_changes(uuid, jsonb), public.svc_employee_changes(uuid, jsonb), public.svc_my_pay(uuid, jsonb),
  public.svc_save_staff_tools(uuid, jsonb), public.svc_staff_tools(uuid, jsonb),
  private.employee_changes(uuid, int, boolean), private.leave_balance(uuid, int), private.emp_workdays(uuid, date, date),
  private.permission_covers(uuid, date, time), private.emp_day(uuid, date);
drop table if exists public.permission_requests, public.correction_requests, public.leave_balances, public.employee_schedules;
alter table public.settings drop constraint if exists settings_staff_tools,
  drop column if exists permission_monthly_limit, drop column if exists permission_max_minutes, drop column if exists annual_leave_days,
  drop column if exists checkout_overdue_reminder, drop column if exists checkout_overdue_min, drop column if exists staff_pay_visible;
