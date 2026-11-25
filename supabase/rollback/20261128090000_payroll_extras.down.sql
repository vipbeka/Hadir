-- Rollback of 20261128090000_payroll_extras: previous definitions, then drop the new objects.
CREATE OR REPLACE FUNCTION private.pay_entitlement(p_emp uuid, p_month date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_month date := private.period_of(p_month); v_end date := (private.period_of(p_month) + interval '1 month - 1 day')::date;
  s public.settings := private.settings(); v_base bigint; v_has_salary boolean;
  v_earn jsonb; v_earn_sum bigint; v_pending_rw bigint; v_rw_paid bigint; v_rw_review boolean;
  v_ded jsonb; v_ded_sum bigint; v_warn int; v_black_pending int; v_black_declined int;
  v_pay jsonb; v_sal_paid bigint; v_net bigint; v_paid bigint; v_rem bigint; v_flags text[] := '{}'; v_status text;
  v_green int; v_missing int; v_active boolean;
begin
  select sal.monthly_salary_piastres, sal.employee_id is not null and sal.monthly_salary_piastres is not null
    into v_base, v_has_salary from public.profiles p left join public.employee_salaries sal on sal.employee_id = p.id where p.id = p_emp;
  select active into v_active from public.profiles where id = p_emp;
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'kind', 'reward', 'status', r.status, 'amount_piastres', r.reward_amount_piastres,
           'decided_at', r.decided_at, 'paid_at', r.paid_at, 'paid_reference', r.paid_reference, 'rule_version', r.applied_rule_version) order by r.created_at), '[]'::jsonb),
         coalesce(sum(r.reward_amount_piastres), 0), coalesce(sum(r.reward_amount_piastres) filter (where r.status = 'paid'), 0),
         coalesce(bool_or(r.needs_owner_review), false)
    into v_earn, v_earn_sum, v_rw_paid, v_rw_review
    from public.reward_requests r where r.employee_id = p_emp and r.period_month = v_month and r.status in ('approved', 'paid');
  select coalesce(sum(reward_amount_piastres), 0) into v_pending_rw from public.reward_requests
   where employee_id = p_emp and period_month = v_month and status = 'pending';
  select coalesce(jsonb_agg(jsonb_build_object('kind', g.color, 'rate_piastres', g.amt, 'count', g.n, 'amount_piastres', g.amt * g.n, 'dates', g.dates)
           order by g.color desc, g.amt), '[]'::jsonb), coalesce(sum(g.amt * g.n), 0)
    into v_ded, v_ded_sum
    from (select e.color::text as color, e.deduction_amount_piastres as amt, count(*) as n, jsonb_agg(e.effective_work_date order by e.effective_work_date) as dates
            from public.point_events e
           where e.employee_id = p_emp and e.reward_period = v_month and e.status = 'active' and e.delta > 0
             and ((e.color = 'red' and not e.warning_only) or e.color = 'black') and not private.is_reversed(e.id) and e.deduction_amount_piastres > 0
           group by e.color, e.deduction_amount_piastres) g;
  select count(*) filter (where color = 'red' and warning_only and status = 'active' and not private.is_reversed(id)),
         count(*) filter (where color = 'black' and status = 'pending_approval'),
         count(*) filter (where color = 'black' and status = 'declined')
    into v_warn, v_black_pending, v_black_declined
    from public.point_events where employee_id = p_emp and reward_period = v_month and delta > 0;
  select coalesce(jsonb_agg(jsonb_build_object('id', sp.id, 'kind', sp.kind, 'amount_piastres', sp.amount_piastres, 'paid_on', sp.paid_on,
           'method', sp.method, 'reference', sp.reference, 'note', sp.note, 'reverses_id', sp.reverses_id, 'created_at', sp.created_at,
           'reversed', exists (select 1 from public.salary_payments x where x.reverses_id = sp.id)) order by sp.created_at), '[]'::jsonb),
         coalesce(sum(sp.amount_piastres), 0)
    into v_pay, v_sal_paid from public.salary_payments sp where sp.employee_id = p_emp and sp.month = v_month;
  v_green := greatest(private.period_total(p_emp, 'green', v_month), 0);
  select count(*) into v_missing from public.attendance_days where employee_id = p_emp and work_date between v_month and v_end
     and checked_in_at is not null and checked_out_at is null and not corrected and work_date < private.local_now()::date;
  v_net := case when v_has_salary then v_base + v_earn_sum - v_ded_sum end;
  v_paid := v_sal_paid + v_rw_paid;
  v_rem := case when v_net is not null then v_net - v_paid end;
  if not v_has_salary then v_flags := v_flags || 'salary_missing'::text; end if;
  if v_net < 0 then v_flags := v_flags || 'negative_net'::text; end if;
  if v_rem < 0 then v_flags := v_flags || 'overpaid'::text; end if;
  if v_rw_review then v_flags := v_flags || 'reward_needs_review'::text; end if;
  if v_black_pending > 0 or v_missing > 0 then v_flags := v_flags || 'unresolved_items'::text; end if;
  if not v_active then v_flags := v_flags || 'inactive'::text; end if;
  v_status := case when v_net is null then 'review'
                   when v_rem < 0 then 'overpaid'
                   when v_net <= 0 and v_sal_paid = 0 then case when v_net = 0 then 'nothing_due' else 'review' end
                   when v_rem = 0 then 'paid'
                   when v_sal_paid > 0 then 'partial'
                   else 'unpaid' end;
  return jsonb_build_object(
    'employee_id', p_emp, 'month', v_month, 'currency', 'EGP',
    'base_piastres', v_base, 'salary_set', v_has_salary,
    'earnings', v_earn, 'earnings_piastres', v_earn_sum, 'pending_rewards_piastres', v_pending_rw,
    'deductions', v_ded, 'deductions_piastres', v_ded_sum,
    'warnings_count', v_warn, 'black_pending', v_black_pending, 'black_declined', v_black_declined, 'missing_checkouts', v_missing,
    'net_piastres', v_net, 'net_adjustment_piastres', v_earn_sum - v_ded_sum,
    'salary_paid_piastres', v_sal_paid, 'reward_paid_piastres', v_rw_paid, 'paid_piastres', v_paid,
    'remaining_piastres', v_rem, 'payments', v_pay, 'status', v_status, 'flags', to_jsonb(v_flags),
    'green_points', v_green, 'threshold', s.green_reward_threshold, 'rule_version', s.rule_version);
end $function$
;

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
  di record; c record; ev record; v_dist float8; v_att uuid; v_event uuid; v_close time; ed record; v_excused boolean := false;
begin
  if (select role from public.profiles where id = p_actor) <> 'staff' then perform private.err('staff_only'); end if;
  select * into di from private.day_info(v_date);
  if di.holiday_name_ar is not null then perform private.err('holiday', jsonb_build_object('name_ar', di.holiday_name_ar, 'name_en', di.holiday_name_en)); end if;
  if not di.check_in_enabled then perform private.err('check_in_disabled'); end if;
  select * into ed from private.emp_day(p_actor, v_date);
  v_close := private.checkin_close_time(v_date);
  if v_close is not null and v_time >= v_close and not private.permission_covers(p_actor, v_date, v_time) then
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
  if not di.points_enabled or not ed.is_work then ev.outcome := 'none'; end if;   -- personal day off: no points
  if ev.outcome = 'red' and private.permission_covers(p_actor, v_date, v_time) then ev.outcome := 'none'; v_excused := true; end if;
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
    'warning_only', (select warning_only from public.point_events where id = v_event),
    'excused_by_permission', v_excused, 'day_off', not ed.is_work);
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_check_out(p_actor uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_correct_attendance(p_actor uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  di record; a public.attendance_days; el public.early_leave_requests; v_close time; ed record;
begin
  select * into di from private.day_info(v_date);
  select * into ed from private.emp_day(p_actor, v_date);
  select * into a from public.attendance_days where employee_id = p_actor and work_date = v_date;
  select * into el from public.early_leave_requests where employee_id = p_actor and work_date = v_date
     and status in ('pending', 'approved') order by created_at desc limit 1;
  v_close := private.checkin_close_time(v_date);
  return jsonb_build_object(
    'server_now', now(), 'business_date', v_date, 'business_time', to_char(v_local, 'HH24:MI:SS'), 'timezone', s.business_timezone,
    'is_work_day', di.is_work_day and ed.is_work, 'day_off', ed.day_off, 'check_in_enabled', di.check_in_enabled, 'points_enabled', di.points_enabled,
    'holiday', case when di.holiday_name_ar is null then null else jsonb_build_object('name_ar', di.holiday_name_ar, 'name_en', di.holiday_name_en) end,
    'geofence', jsonb_build_object('lat', s.geofence_lat, 'lng', s.geofence_lng, 'radius_m', s.geofence_radius_m),
    'work_start_time', ed.start_time, 'work_end_time', ed.end_time,
    'expected_end_time', case when el.status = 'approved' then el.requested_leave_time else ed.end_time end,
    'permissions', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'from_time', r.from_time, 'to_time', r.to_time, 'status', r.status)
        order by r.from_time) from public.permission_requests r where r.employee_id = p_actor and r.work_date = v_date and r.status in ('pending', 'approved')), '[]'::jsonb),
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
      'permission', (select count(*) from public.permission_requests where status = 'pending'),
      'correction', (select count(*) from public.correction_requests where status = 'pending'),
      'reward', (select count(*) from public.reward_requests where status in ('pending', 'approved')),
      'missing_checkout', (select count(*) from public.attendance_days where checked_out_at is null and work_date < v_today and not corrected)),
    'employees', coalesce((select jsonb_agg(row_to_json(x) order by x.full_name_en) from (
      select p.id, p.full_name_ar, p.full_name_en, p.job_title_ar, p.job_title_en, p.role, p.active,
             sal.monthly_salary_piastres,
             private.period_total(p.id, 'green', v_period) as green,
             private.period_total(p.id, 'red', v_period) as red,
             private.period_total(p.id, 'black', v_period) as black,
             (select count(*) from public.point_events e where e.employee_id = p.id and e.status = 'pending_approval') as pending_black,
             (select x.day_off from private.emp_day(p.id, v_today) x) as day_off,
             (select jsonb_build_object('checked_in_at', a.checked_in_at, 'checked_out_at', a.checked_out_at, 'outcome', a.check_in_outcome)
                from public.attendance_days a where a.employee_id = p.id and a.work_date = v_today) as today
      from public.profiles p left join public.employee_salaries sal on sal.employee_id = p.id
      where p.role = 'staff') x), '[]'::jsonb));
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
    'permission', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('name_ar', pr.full_name_ar, 'name_en', pr.full_name_en,
        'month_count', (select count(*) from public.permission_requests x where x.employee_id = r.employee_id and x.status in ('pending', 'approved')
                          and date_trunc('month', x.work_date) = date_trunc('month', r.work_date))) order by r.created_at desc)
      from public.permission_requests r join public.profiles pr on pr.id = r.employee_id
      where r.status = 'pending' or r.created_at > now() - interval '30 days'), '[]'::jsonb),
    'correction', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('name_ar', pr.full_name_ar, 'name_en', pr.full_name_en) order by r.created_at desc)
      from public.correction_requests r join public.profiles pr on pr.id = r.employee_id
      where r.status = 'pending' or r.created_at > now() - interval '30 days'), '[]'::jsonb),
    'missing_checkout', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name_ar', pr.full_name_ar, 'name_en', pr.full_name_en,
        'work_date', a.work_date, 'checked_in_at', a.checked_in_at) order by a.work_date)
      from public.attendance_days a join public.profiles pr on pr.id = a.employee_id
      where a.checked_out_at is null and a.work_date < (now() at time zone private.tz())::date and not a.corrected), '[]'::jsonb))
$function$
;

CREATE OR REPLACE FUNCTION private.owner_fanout(p_type text, p_event text, p_dedupe text, p_payload jsonb, p_ref text, p_force boolean DEFAULT false)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s public.settings := private.settings();
  a public.attendance_days; e public.point_events; lr public.leave_requests; er public.early_leave_requests; rr public.reward_requests; pq public.permission_requests; cq public.correction_requests;
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
  elsif p_event = 'permission_request' then select * into pq from public.permission_requests where id::text = p_ref;
  elsif p_event = 'correction_request' then select * into cq from public.correction_requests where id::text = p_ref;
  end if;
  v_emp := coalesce(a.employee_id, e.employee_id, lr.employee_id, er.employee_id, rr.employee_id, pq.employee_id, cq.employee_id, nullif(p_payload ->> 'employee_id', '')::uuid);
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
    elsif p_event = 'permission_request' then
      v_at := coalesce(pq.created_at, now());
      v_title := 'طلب إذن';
      v_body := format('%s طلب إذن %s من %s إلى %s', v_name, case when pq.work_date = v_today then 'اليوم' else 'يوم ' || private.ar_date(pq.work_date) end,
                  private.fmt12(pq.from_time, 'ar'), private.fmt12(pq.to_time, 'ar'));
      if pq.reason is not null then v_body := v_body || '، السبب: ' || pq.reason; end if;
      if pq.over_limit then v_body := v_body || E'\n' || '⚠️ فوق الحد الشهري للأذونات'; v_flags := v_flags || jsonb_build_object('over_limit', true); end if;
    elsif p_event = 'correction_request' then
      v_at := coalesce(cq.created_at, now());
      v_title := 'طلب تصحيح حضور';
      v_body := format('%s طلب تصحيح %s يوم %s', v_name,
                  case cq.kind when 'check_in' then 'الحضور ' || private.fmt12(cq.check_in_time, 'ar')
                               when 'check_out' then 'الانصراف ' || private.fmt12(cq.check_out_time, 'ar')
                               else format('الحضور %s والانصراف %s', private.fmt12(cq.check_in_time, 'ar'), private.fmt12(cq.check_out_time, 'ar')) end,
                  private.ar_date(cq.work_date)) || '، السبب: ' || cq.reason;
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
                              when 'leave_request' then 'request' when 'early_leave_request' then 'request' when 'reward_request' then 'request'
                              when 'permission_request' then 'request' when 'correction_request' then 'request' end;
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

CREATE OR REPLACE FUNCTION private.tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.settings := private.settings(); v_local timestamp := private.local_now(); v_today date := v_local::date;
  d date; v_out jsonb := '{}'::jsonb; v_target_dow int; v_week_start date; v_prev_month date; v_sun_start date; v_closed boolean;
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
  -- the old mid-week summary is replaced by the Sunday summary when that is on
  if s.weekly_summary_enabled and not s.sunday_summary_enabled then
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
  -- 6. Sunday summary of the previous CLOSED week (Sun..Sat). Sent on Sunday
  -- at the weekly summary time; after an outage it is still sent until
  -- Tuesday, never later (then recorded as skipped).
  if s.sunday_summary_enabled then
    v_sun_start := v_today - extract(dow from v_today)::int - 7;      -- previous week's Sunday
    if not private.job_done('sunday_summary', v_sun_start::text) and (extract(dow from v_today) > 0 or v_local::time >= s.weekly_summary_time) then
      if extract(dow from v_today) <= 2 then
        select bool_and(private.job_done('absence', g::date::text) or g::date < s.jobs_start_date) into v_closed
          from generate_series(v_sun_start, v_sun_start + 6, interval '1 day') g;
        if v_closed then perform private.run_sunday_summary(v_sun_start); end if;
      else
        perform private.record_job('sunday_summary', v_sun_start::text, 'skipped', jsonb_build_object('reason', 'missed: older than Tuesday'));
      end if;
    end if;
  end if;
  v_prev_month := private.period_of(v_today) - interval '1 month';
  if v_prev_month >= private.period_of(s.jobs_start_date) and not private.job_done('monthly', v_prev_month::text) then
    perform public.svc_payroll(null, jsonb_build_object('month', v_prev_month));
    perform private.record_job('monthly', v_prev_month::text, 'succeeded', '{}'::jsonb);
  end if;
  -- 7. payroll summary of the previous month, from the 1st at the set time,
  -- only once the month is closed (re-checked every minute; the "not final
  -- yet" notice is sent once). Only the immediately previous month.
  if s.payroll_summary_enabled and (extract(day from v_today) > 1 or v_local::time >= s.payroll_summary_time)
     and not private.job_done('payroll_summary', to_char(v_prev_month, 'YYYY-MM')) then
    perform private.run_payroll_summary(v_prev_month);
  end if;
  v_out := v_out || jsonb_build_object('scheduled_announcements', private.process_scheduled_announcements());
  return v_out;
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_staff_tools(p_actor uuid, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.settings := private.settings();
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  return jsonb_build_object('permission_monthly_limit', s.permission_monthly_limit, 'permission_max_minutes', s.permission_max_minutes,
    'annual_leave_days', s.annual_leave_days, 'checkout_overdue_reminder', s.checkout_overdue_reminder,
    'checkout_overdue_min', s.checkout_overdue_min, 'staff_pay_visible', s.staff_pay_visible);
end $function$
;

CREATE OR REPLACE FUNCTION public.svc_save_staff_tools(p_actor uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b public.settings; a public.settings;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  select * into b from public.settings where id for update;
  begin
    update public.settings set
      permission_monthly_limit = coalesce((p ->> 'permission_monthly_limit')::smallint, permission_monthly_limit),
      permission_max_minutes = coalesce((p ->> 'permission_max_minutes')::smallint, permission_max_minutes),
      annual_leave_days = coalesce((p ->> 'annual_leave_days')::numeric, annual_leave_days),
      checkout_overdue_reminder = coalesce((p ->> 'checkout_overdue_reminder')::boolean, checkout_overdue_reminder),
      checkout_overdue_min = coalesce((p ->> 'checkout_overdue_min')::smallint, checkout_overdue_min),
      staff_pay_visible = coalesce((p ->> 'staff_pay_visible')::boolean, staff_pay_visible),
      updated_at = now(), updated_by = p_actor
    where id returning * into a;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range then perform private.err('invalid_value'); end;
  perform private.audit(p_actor, 'settings.staff_tools', 'settings', 'settings',
    jsonb_build_object('permission_monthly_limit', b.permission_monthly_limit, 'permission_max_minutes', b.permission_max_minutes,
      'annual_leave_days', b.annual_leave_days, 'checkout_overdue_reminder', b.checkout_overdue_reminder,
      'checkout_overdue_min', b.checkout_overdue_min, 'staff_pay_visible', b.staff_pay_visible),
    jsonb_build_object('permission_monthly_limit', a.permission_monthly_limit, 'permission_max_minutes', a.permission_max_minutes,
      'annual_leave_days', a.annual_leave_days, 'checkout_overdue_reminder', a.checkout_overdue_reminder,
      'checkout_overdue_min', a.checkout_overdue_min, 'staff_pay_visible', a.staff_pay_visible));
  return public.svc_staff_tools(p_actor, '{}');
end $function$
;

drop function if exists public.svc_request_advance(uuid, jsonb), public.svc_cancel_advance(uuid, jsonb), public.svc_decide_advance(uuid, jsonb),
  public.svc_create_advance(uuid, jsonb), public.svc_decide_overtime(uuid, jsonb), public.svc_backup_data(), public.svc_backup_export(uuid, jsonb),
  public.svc_dashboard_stats(uuid, jsonb), private.run_backup(date), private.run_employee_month_reports(date),
  private.advance_due(uuid, date), private.sync_overtime(uuid);
drop table if exists public.salary_advances, public.overtime_entries;
alter table public.attendance_days drop column if exists selfie_path;
alter table public.settings drop constraint if exists settings_payroll_extras,
  drop column if exists overtime_enabled, drop column if exists overtime_min_minutes, drop column if exists overtime_rate_piastres,
  drop column if exists advances_enabled, drop column if exists advance_max_installments, drop column if exists monthly_reports_enabled,
  drop column if exists backup_enabled, drop column if exists backup_dow, drop column if exists backup_time, drop column if exists selfie_required;
delete from private.owner_reports where kind = 'employee_month';
alter table private.owner_reports drop constraint if exists owner_reports_kind_check;
alter table private.owner_reports add constraint owner_reports_kind_check
  check (kind = any (array['weekly_owner', 'payroll_summary', 'payroll_blocked', 'absence_streak', 'announcement']));
