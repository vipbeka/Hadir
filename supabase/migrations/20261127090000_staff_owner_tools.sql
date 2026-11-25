-- =====================================================================
-- حاضر — staff & owner tools
--   1. permission requests (إذن: leave for a few hours and come back),
--      monthly limit (over-limit requests are flagged; the owner can
--      approve them with a deduction)
--   2. per-employee work schedule (personal days off + own hours)
--   3. annual leave balance (personal leave, counted in work days)
--   4. attendance correction requests from the employee
--   5. monthly report: statement gains day-off / permissions / balance
--   6. daily summary: counts, days off, permissions, pending requests
--   7. change log: what the owner changed for an employee (+ reasons)
--   8. check-out overdue reminder (push) after the employee's end time
--   9. "my pay" for the employee (deductions/rewards; salary + net only
--      when the owner turns it on — off by default)
--  10. points goal: work days left this month
-- All writes go through service functions (service_role only); the
-- employee can read only their own rows (RLS); nothing here blocks a
-- check-in if a notification fails.
-- =====================================================================

-- ------------------------------------------------------------ settings
alter table public.settings
  add column if not exists permission_monthly_limit smallint not null default 3,
  add column if not exists permission_max_minutes smallint not null default 180,
  add column if not exists annual_leave_days numeric(4, 1) not null default 21,
  add column if not exists checkout_overdue_reminder boolean not null default true,
  add column if not exists checkout_overdue_min smallint not null default 30,
  add column if not exists staff_pay_visible boolean not null default false;
do $$ begin
  alter table public.settings add constraint settings_staff_tools check (
    permission_monthly_limit between 0 and 31 and permission_max_minutes between 15 and 600
    and annual_leave_days between 0 and 365 and checkout_overdue_min between 5 and 240);
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------ tables
create table if not exists public.employee_schedules (
  employee_id  uuid not null references public.profiles (id) on delete cascade,
  day_of_week  smallint not null check (day_of_week between 0 and 6),   -- 0 = Sunday
  is_work_day  boolean not null default true,
  start_time   time,
  end_time     time,
  updated_by   uuid references public.profiles (id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (employee_id, day_of_week),
  constraint employee_schedule_times check ((start_time is null) = (end_time is null) and (start_time is null or start_time < end_time))
);

create table if not exists public.permission_requests (
  id                 bigint generated always as identity primary key,   -- short id for Telegram buttons
  employee_id        uuid not null references public.profiles (id) on delete cascade,
  work_date          date not null,
  from_time          time not null,
  to_time            time not null,
  minutes            integer generated always as ((extract(epoch from (to_time - from_time)) / 60)::integer) stored,
  reason             text check (reason is null or char_length(reason) <= 500),
  over_limit         boolean not null default false,
  status             public.request_status not null default 'pending',
  admin_comment      text check (admin_comment is null or char_length(admin_comment) <= 500),
  deduction_event_id uuid references public.point_events (id) on delete set null,
  decided_by         uuid references public.profiles (id) on delete set null,
  decided_at         timestamptz,
  decision_channel   public.decision_channel,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint permission_times check (from_time < to_time)
);
create index if not exists permission_requests_emp_date on public.permission_requests (employee_id, work_date);
create index if not exists permission_requests_pending on public.permission_requests (status) where status = 'pending';

create table if not exists public.correction_requests (
  id               bigint generated always as identity primary key,
  employee_id      uuid not null references public.profiles (id) on delete cascade,
  work_date        date not null,
  kind             text not null check (kind in ('check_in', 'check_out', 'both')),
  check_in_time    time,
  check_out_time   time,
  reason           text not null check (char_length(btrim(reason)) between 3 and 500),
  status           public.request_status not null default 'pending',
  admin_comment    text check (admin_comment is null or char_length(admin_comment) <= 500),
  attendance_id    uuid references public.attendance_days (id) on delete set null,
  decided_by       uuid references public.profiles (id) on delete set null,
  decided_at       timestamptz,
  decision_channel public.decision_channel,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint correction_times check (
    (kind = 'check_in' and check_in_time is not null and check_out_time is null)
    or (kind = 'check_out' and check_out_time is not null and check_in_time is null)
    or (kind = 'both' and check_in_time is not null and check_out_time is not null and check_in_time < check_out_time))
);
create unique index if not exists correction_one_pending on public.correction_requests (employee_id, work_date) where status = 'pending';

create table if not exists public.leave_balances (
  employee_id   uuid not null references public.profiles (id) on delete cascade,
  year          integer not null check (year between 2020 and 2100),
  entitled_days numeric(5, 1) not null check (entitled_days between 0 and 365),
  note          text check (note is null or char_length(note) <= 200),
  updated_by    uuid references public.profiles (id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (employee_id, year)
);

do $$ declare t text; begin
  foreach t in array array['employee_schedules', 'permission_requests', 'correction_requests', 'leave_balances'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (employee_id = (select private.current_uid()) or (select private.is_owner()))', t || '_select', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;
drop trigger if exists touch_permission_requests on public.permission_requests;
create trigger touch_permission_requests before update on public.permission_requests for each row execute function private.touch_updated_at();
drop trigger if exists touch_correction_requests on public.correction_requests;
create trigger touch_correction_requests before update on public.correction_requests for each row execute function private.touch_updated_at();

-- ------------------------------------------------------------ helpers
-- The employee's own day: company rules (holidays, weekends) AND their
-- personal schedule. Hours default to the company hours.
create or replace function private.emp_day(p_emp uuid, d date)
returns table (is_work boolean, start_time time, end_time time, day_off boolean)
language sql stable security definer set search_path = '' as $$
  select di.is_work_day and coalesce(es.is_work_day, true),
         coalesce(es.start_time, s.work_start_time), coalesce(es.end_time, s.work_end_time),
         di.is_work_day and es.is_work_day is false
  from private.day_info(d) di
  cross join public.settings s
  left join public.employee_schedules es on es.employee_id = p_emp and es.day_of_week = extract(dow from d)
  where s.id
$$;

-- An approved permission that covers this local time (arrival up to 15
-- minutes after the permission ends still counts).
create or replace function private.permission_covers(p_emp uuid, d date, t time)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.permission_requests r where r.employee_id = p_emp and r.work_date = d and r.status = 'approved'
                  and r.from_time <= t and t <= r.to_time + interval '15 minutes')
$$;

-- Work days (for this employee) between two dates, holidays excluded.
create or replace function private.emp_workdays(p_emp uuid, a date, b date)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from generate_series(a, b, interval '1 day') g
   where a <= b and (select x.is_work from private.emp_day(p_emp, g::date) x)
$$;

-- Annual personal-leave balance (work days). Pending requests are
-- reserved so two requests can't spend the same days.
create or replace function private.leave_balance(p_emp uuid, p_year int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_a date := make_date(p_year, 1, 1); v_b date := make_date(p_year, 12, 31);
  v_ent numeric; v_custom boolean; v_used int; v_pend int; v_sick int; v_note text;
begin
  select lb.entitled_days, lb.note into v_ent, v_note from public.leave_balances lb where lb.employee_id = p_emp and lb.year = p_year;
  v_custom := v_ent is not null; v_ent := coalesce(v_ent, s.annual_leave_days);
  with days as (
    select distinct l.type, l.status, g::date as d
      from public.leave_requests l, generate_series(greatest(l.from_date, v_a), least(l.to_date, v_b), interval '1 day') g
     where l.employee_id = p_emp and l.status in ('approved', 'pending') and l.to_date >= v_a and l.from_date <= v_b)
  select count(distinct d) filter (where type = 'personal' and status = 'approved'),
         count(distinct d) filter (where type = 'personal' and status = 'pending'),
         count(distinct d) filter (where type = 'sick' and status = 'approved')
    into v_used, v_pend, v_sick
    from days where (select x.is_work from private.emp_day(p_emp, days.d) x);
  return jsonb_build_object('year', p_year, 'entitled', v_ent, 'custom', v_custom, 'note', v_note,
    'used', v_used, 'pending', v_pend, 'remaining', v_ent - v_used, 'available', v_ent - v_used - v_pend, 'sick_used', v_sick);
end $$;

revoke all on function private.emp_day(uuid, date), private.permission_covers(uuid, date, time),
  private.emp_workdays(uuid, date, date), private.leave_balance(uuid, int) from public, anon, authenticated;

-- =====================================================================
-- 1. Permission requests (إذن)
-- =====================================================================
create or replace function public.svc_request_permission(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_local timestamp := private.local_now(); v_today date := v_local::date;
  v_date date; v_from time; v_to time; ed record; v_used int; r public.permission_requests; v_min int;
begin
  if (select role from public.profiles where id = p_actor and active) is distinct from 'staff' then perform private.err('staff_only'); end if;
  begin v_date := coalesce((p ->> 'date')::date, v_today); v_from := (p ->> 'from_time')::time; v_to := (p ->> 'to_time')::time;
  exception when others then perform private.err('invalid_time'); end;
  if v_date is null or v_from is null or v_to is null or v_to <= v_from then perform private.err('invalid_time'); end if;
  if v_date < v_today or v_date > v_today + 30 then perform private.err('invalid_dates'); end if;
  if v_date = v_today and v_to <= v_local::time then perform private.err('invalid_time'); end if;
  select * into ed from private.emp_day(p_actor, v_date);
  if not ed.is_work then perform private.err('not_work_day'); end if;
  if v_from < ed.start_time or v_to > ed.end_time then
    perform private.err('outside_work_hours', jsonb_build_object('start', ed.start_time, 'end', ed.end_time,
      'start_ar', private.fmt12(ed.start_time, 'ar'), 'end_ar', private.fmt12(ed.end_time, 'ar')));
  end if;
  v_min := (extract(epoch from (v_to - v_from)) / 60)::int;
  if v_min < 15 or v_min > s.permission_max_minutes then
    perform private.err('permission_duration', jsonb_build_object('max_minutes', s.permission_max_minutes));
  end if;
  if exists (select 1 from public.leave_requests where employee_id = p_actor and status = 'approved' and v_date between from_date and to_date) then
    perform private.err('on_leave');
  end if;
  perform 1 from public.profiles where id = p_actor for update;        -- one request at a time per employee (limit count)
  if exists (select 1 from public.permission_requests where employee_id = p_actor and work_date = v_date and status in ('pending', 'approved')
              and from_time < v_to and v_from < to_time) then
    perform private.err('permission_overlap');
  end if;
  select count(*) into v_used from public.permission_requests
   where employee_id = p_actor and status in ('pending', 'approved') and private.period_of(work_date) = private.period_of(v_date);
  insert into public.permission_requests (employee_id, work_date, from_time, to_time, reason, over_limit)
  values (p_actor, v_date, v_from, v_to, nullif(btrim(coalesce(p ->> 'reason', '')), ''),
          s.permission_monthly_limit > 0 and v_used >= s.permission_monthly_limit)
  returning * into r;
  perform private.audit(p_actor, 'permission.request', 'permission_requests', r.id::text, null, to_jsonb(r));
  perform private.enqueue_owner_alert('permission_request', 'perm:' || r.id,
    jsonb_build_object('kind', 'permission_request', 'id', r.id, 'employee', private.name_of(p_actor), 'date', r.work_date,
      'from', private.fmt12(r.from_time, 'ar'), 'to', private.fmt12(r.to_time, 'ar'), 'reason', r.reason, 'over_limit', r.over_limit), r.id::text);
  return to_jsonb(r) || jsonb_build_object('used_this_month', v_used + 1, 'monthly_limit', s.permission_monthly_limit);
end $$;

create or replace function public.svc_cancel_permission(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.permission_requests; a public.permission_requests;
begin
  select * into b from public.permission_requests where id = (p ->> 'id')::bigint and employee_id = p_actor for update;
  if not found then perform private.err('not_found'); end if;
  if b.status not in ('pending', 'approved') then return jsonb_build_object('result', 'already_decided', 'status', b.status); end if;
  if b.status = 'approved' and b.work_date < private.local_now()::date then perform private.err('invalid_transition'); end if;
  if b.deduction_event_id is not null then perform private.err('invalid_transition'); end if;   -- the owner decides deducted ones
  update public.permission_requests set status = 'cancelled' where id = b.id returning * into a;
  perform private.audit(p_actor, 'permission.cancel', 'permission_requests', a.id::text, to_jsonb(b), to_jsonb(a));
  return jsonb_build_object('result', 'cancelled');
end $$;

create or replace function public.svc_decide_permission(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); b public.permission_requests; a public.permission_requests;
  v_approve boolean := coalesce((p ->> 'approve')::boolean, false); v_deduct boolean := coalesce((p ->> 'deduct')::boolean, false);
  v_channel public.decision_channel := coalesce((p ->> 'channel')::public.decision_channel, 'dashboard'); v_ev uuid;
  v_comment text := nullif(btrim(coalesce(p ->> 'comment', '')), '');
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  select * into b from public.permission_requests where id = (p ->> 'id')::bigint for update;
  if not found then perform private.err('not_found'); end if;
  if b.status = 'pending' then
    if v_approve and v_deduct and b.over_limit then
      v_ev := private.add_event(b.employee_id, b.work_date, 'perm:' || b.id, 'red', 1, 'owner_manual', 'active',
                                s.red_penalty_piastres, s.red_penalty_piastres, p_actor, 'إذن زائد عن الحد الشهري #' || b.id);
      perform private.recalc_reds(b.employee_id, private.period_of(b.work_date));
    end if;
    update public.permission_requests set status = (case when v_approve then 'approved' else 'rejected' end)::public.request_status,
      decided_by = p_actor, decided_at = now(), decision_channel = v_channel, deduction_event_id = v_ev,
      admin_comment = coalesce(v_comment, admin_comment) where id = b.id returning * into a;
  elsif b.status = 'approved' and not v_approve and coalesce((p ->> 'revoke')::boolean, false) then
    if b.deduction_event_id is not null and not private.is_reversed(b.deduction_event_id) then
      perform private.add_event(b.employee_id, b.work_date, 'rev:' || b.deduction_event_id, 'red', -1, 'owner_manual', 'active', 0, 0,
                                p_actor, 'إلغاء إذن #' || b.id, null, null, b.deduction_event_id);
      perform private.recalc_reds(b.employee_id, private.period_of(b.work_date));
    end if;
    update public.permission_requests set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_channel = v_channel,
      admin_comment = coalesce(v_comment, admin_comment) where id = b.id returning * into a;
  else
    return jsonb_build_object('result', 'already_decided', 'status', b.status, 'id', b.id, 'employee', private.name_of(b.employee_id));
  end if;
  perform private.audit(p_actor, 'permission.' || a.status, 'permission_requests', a.id::text, to_jsonb(b), to_jsonb(a), a.admin_comment,
    case when v_channel = 'telegram' then 'telegram' else 'user' end);
  perform private.enqueue_push(a.employee_id, 'permission_decision', a.id::text || ':' || a.status,
    'Zintra حاضر', case when a.status = 'approved' then 'تمام 👍 اتوافق على إذنك من ' || private.fmt12(a.from_time, 'ar') || ' لـ ' || private.fmt12(a.to_time, 'ar')
                          || case when a.deduction_event_id is not null then ' (زائد عن الحد الشهري: نقطة حمراء)' else '' end
                        else 'للأسف طلب الإذن اترفض.' end,
    'Zintra حاضر', case when a.status = 'approved' then 'Your permission ' || private.fmt12(a.from_time, 'en') || ' → ' || private.fmt12(a.to_time, 'en') || ' was approved.'
                        else 'Your permission request was declined.' end, false);
  return jsonb_build_object('result', 'decided', 'status', a.status, 'id', a.id, 'deducted', a.deduction_event_id is not null,
    'employee', private.name_of(a.employee_id), 'from', private.fmt12(a.from_time, 'ar'), 'to', private.fmt12(a.to_time, 'ar'), 'date', a.work_date);
end $$;

-- =====================================================================
-- 4. Attendance correction requests
-- =====================================================================
create or replace function public.svc_request_correction(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_today date := private.local_now()::date; v_date date; v_kind text := p ->> 'kind';
  v_in time; v_out time; v_reason text := btrim(coalesce(p ->> 'reason', '')); a public.attendance_days; r public.correction_requests;
  v_in_ts timestamptz; v_out_ts timestamptz;
begin
  if (select role from public.profiles where id = p_actor and active) is distinct from 'staff' then perform private.err('staff_only'); end if;
  begin v_date := (p ->> 'date')::date; v_in := nullif(p ->> 'check_in_time', '')::time; v_out := nullif(p ->> 'check_out_time', '')::time;
  exception when others then perform private.err('invalid_time'); end;
  if v_date is null or v_date > v_today or v_date < v_today - 31 then perform private.err('invalid_dates'); end if;
  if v_kind not in ('check_in', 'check_out', 'both') then perform private.err('invalid_type'); end if;
  if char_length(v_reason) < 3 then perform private.err('reason_required'); end if;
  if v_kind = 'check_in' then v_out := null; elsif v_kind = 'check_out' then v_in := null; end if;
  if (v_kind in ('check_in', 'both') and v_in is null) or (v_kind in ('check_out', 'both') and v_out is null) then perform private.err('invalid_time'); end if;
  v_in_ts := (v_date + v_in) at time zone s.business_timezone;
  v_out_ts := (v_date + v_out) at time zone s.business_timezone;
  if v_out_ts < v_in_ts then perform private.err('invalid_time'); end if;
  -- a check-out after midnight belongs to the next day
  select * into a from public.attendance_days where employee_id = p_actor and work_date = v_date;
  if v_kind = 'check_out' then
    if a.id is null or a.checked_in_at is null then perform private.err('not_checked_in'); end if;
    if a.checked_out_at is not null then perform private.err('already_checked_out'); end if;
    if v_out_ts <= a.checked_in_at then v_out_ts := v_out_ts + interval '1 day'; end if;
    if v_out_ts > a.checked_in_at + interval '24 hours' then perform private.err('invalid_time'); end if;
  else
    if a.id is not null then perform private.err('already_checked_in'); end if;
  end if;
  if coalesce(v_out_ts, v_in_ts) > now() then perform private.err('invalid_time'); end if;
  begin
    insert into public.correction_requests (employee_id, work_date, kind, check_in_time, check_out_time, reason, attendance_id)
    values (p_actor, v_date, v_kind, v_in, v_out, v_reason, a.id) returning * into r;
  exception when unique_violation then perform private.err('already_pending'); end;
  perform private.audit(p_actor, 'correction.request', 'correction_requests', r.id::text, null, to_jsonb(r));
  perform private.enqueue_owner_alert('correction_request', 'corr:' || r.id,
    jsonb_build_object('kind', 'correction_request', 'id', r.id, 'employee', private.name_of(p_actor), 'date', r.work_date,
      'type', r.kind, 'in', private.fmt12(r.check_in_time, 'ar'), 'out', private.fmt12(r.check_out_time, 'ar'), 'reason', r.reason), r.id::text);
  return to_jsonb(r);
end $$;

create or replace function public.svc_cancel_correction(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.correction_requests; a public.correction_requests;
begin
  select * into b from public.correction_requests where id = (p ->> 'id')::bigint and employee_id = p_actor for update;
  if not found then perform private.err('not_found'); end if;
  if b.status <> 'pending' then return jsonb_build_object('result', 'already_decided', 'status', b.status); end if;
  update public.correction_requests set status = 'cancelled' where id = b.id returning * into a;
  perform private.audit(p_actor, 'correction.cancel', 'correction_requests', a.id::text, to_jsonb(b), to_jsonb(a));
  return jsonb_build_object('result', 'cancelled');
end $$;

create or replace function public.svc_decide_correction(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); b public.correction_requests; a public.correction_requests; att public.attendance_days;
  v_approve boolean := coalesce((p ->> 'approve')::boolean, false);
  v_channel public.decision_channel := coalesce((p ->> 'channel')::public.decision_channel, 'dashboard');
  v_comment text := nullif(btrim(coalesce(p ->> 'comment', '')), ''); v_reason text; v_att uuid; v_out_ts timestamptz; r jsonb;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  select * into b from public.correction_requests where id = (p ->> 'id')::bigint for update;
  if not found then perform private.err('not_found'); end if;
  if b.status <> 'pending' then
    return jsonb_build_object('result', 'already_decided', 'status', b.status, 'id', b.id, 'employee', private.name_of(b.employee_id));
  end if;
  v_reason := 'طلب تصحيح #' || b.id || ': ' || b.reason;
  if v_approve then
    -- the same rules as a manual correction by the owner (points by the corrected time)
    if b.kind in ('check_in', 'both') then
      r := public.svc_manual_check_in(p_actor, jsonb_build_object('employee_id', b.employee_id, 'date', b.work_date,
             'time', to_char(b.check_in_time, 'HH24:MI:SS'), 'reason', v_reason));
      v_att := (r ->> 'attendance_id')::uuid;
    else
      v_att := b.attendance_id;
    end if;
    if b.kind in ('check_out', 'both') then
      select * into att from public.attendance_days where id = v_att;
      if att.id is null or att.checked_in_at is null then perform private.err('not_checked_in'); end if;
      if att.checked_out_at is not null then perform private.err('already_checked_out'); end if;
      v_out_ts := (b.work_date + b.check_out_time) at time zone s.business_timezone;
      if v_out_ts <= att.checked_in_at then v_out_ts := v_out_ts + interval '1 day'; end if;
      perform public.svc_correct_attendance(p_actor, jsonb_build_object('attendance_id', v_att, 'checked_out_at', v_out_ts, 'reason', v_reason));
    end if;
  end if;
  update public.correction_requests set status = (case when v_approve then 'approved' else 'rejected' end)::public.request_status,
    decided_by = p_actor, decided_at = now(), decision_channel = v_channel, attendance_id = coalesce(v_att, attendance_id),
    admin_comment = v_comment where id = b.id returning * into a;
  perform private.audit(p_actor, 'correction.' || a.status, 'correction_requests', a.id::text, to_jsonb(b), to_jsonb(a), a.admin_comment,
    case when v_channel = 'telegram' then 'telegram' else 'user' end);
  perform private.enqueue_push(a.employee_id, 'correction_decision', a.id::text || ':' || a.status,
    'Zintra حاضر', case when a.status = 'approved' then 'تمام 👍 اتصحّح حضورك يوم ' || private.dmy(a.work_date) || '.'
                        else 'للأسف طلب تصحيح الحضور اترفض.' || coalesce(' السبب: ' || a.admin_comment, '') end,
    'Zintra حاضر', case when a.status = 'approved' then 'Your attendance for ' || a.work_date || ' was corrected.'
                        else 'Your attendance correction was declined.' end, false);
  return jsonb_build_object('result', 'decided', 'status', a.status, 'id', a.id, 'employee', private.name_of(a.employee_id), 'date', a.work_date);
end $$;

-- =====================================================================
-- 2. Per-employee schedule
-- =====================================================================
create or replace function public.svc_employee_schedule(p_actor uuid, p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_emp uuid;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_emp := (p ->> 'employee_id')::uuid; exception when others then perform private.err('invalid_employee'); end;
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff') then perform private.err('invalid_employee'); end if;
  return jsonb_build_object('employee_id', v_emp, 'company_start', s.work_start_time, 'company_end', s.work_end_time,
    'days', (select jsonb_agg(jsonb_build_object('day_of_week', g, 'company_work_day', coalesce(r.is_work_day, false),
        'is_work_day', coalesce(r.is_work_day, false) and coalesce(es.is_work_day, true),
        'start_time', es.start_time, 'end_time', es.end_time) order by g)
      from generate_series(0, 6) g
      left join public.day_rules r on r.day_of_week = g
      left join public.employee_schedules es on es.employee_id = v_emp and es.day_of_week = g));
end $$;

create or replace function public.svc_save_employee_schedule(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; d jsonb; v_dow int; v_work boolean; v_st time; v_en time; v_company boolean; v_seen int[] := '{}'; v_before jsonb;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_emp := (p ->> 'employee_id')::uuid; exception when others then perform private.err('invalid_employee'); end;
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff') then perform private.err('invalid_employee'); end if;
  if jsonb_typeof(p -> 'days') is distinct from 'array' or jsonb_array_length(p -> 'days') > 7 then perform private.err('invalid_schedule'); end if;
  select coalesce(jsonb_agg(to_jsonb(es) - 'updated_at' - 'updated_by' order by es.day_of_week), '[]'::jsonb) into v_before
    from public.employee_schedules es where es.employee_id = v_emp;
  for d in select * from jsonb_array_elements(p -> 'days') loop
    begin
      v_dow := (d ->> 'day_of_week')::int; v_work := coalesce((d ->> 'is_work_day')::boolean, true);
      v_st := nullif(d ->> 'start_time', '')::time; v_en := nullif(d ->> 'end_time', '')::time;
    exception when others then perform private.err('invalid_schedule'); end;
    if v_dow is null or v_dow not between 0 and 6 or v_dow = any (v_seen) then perform private.err('invalid_schedule'); end if;
    v_seen := v_seen || v_dow;
    if (v_st is null) <> (v_en is null) or (v_st is not null and v_st >= v_en) then
      perform private.err('invalid_time', jsonb_build_object('day_of_week', v_dow));
    end if;
    select coalesce(is_work_day, false) into v_company from public.day_rules where day_of_week = v_dow;
    if v_work and not coalesce(v_company, false) then perform private.err('not_company_work_day', jsonb_build_object('day_of_week', v_dow)); end if;
    if v_work and v_st is null then
      delete from public.employee_schedules where employee_id = v_emp and day_of_week = v_dow;   -- back to the company default
    else
      insert into public.employee_schedules (employee_id, day_of_week, is_work_day, start_time, end_time, updated_by, updated_at)
      values (v_emp, v_dow, v_work, case when v_work then v_st end, case when v_work then v_en end, p_actor, now())
      on conflict (employee_id, day_of_week) do update set is_work_day = excluded.is_work_day, start_time = excluded.start_time,
        end_time = excluded.end_time, updated_by = p_actor, updated_at = now();
    end if;
  end loop;
  perform private.audit(p_actor, 'schedule.set', 'employee_schedules', v_emp::text, v_before,
    (select coalesce(jsonb_agg(to_jsonb(es) - 'updated_at' - 'updated_by' order by es.day_of_week), '[]'::jsonb)
       from public.employee_schedules es where es.employee_id = v_emp), nullif(btrim(coalesce(p ->> 'reason', '')), ''));
  return public.svc_employee_schedule(p_actor, jsonb_build_object('employee_id', v_emp));
end $$;

-- =====================================================================
-- 3. Leave balance
-- =====================================================================
create or replace function public.svc_my_leave_balance(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_year int := coalesce(nullif(p ->> 'year', '')::int, extract(year from private.local_now())::int);
begin
  if v_year not between 2020 and 2100 then perform private.err('invalid_dates'); end if;
  return private.leave_balance(p_actor, v_year);
end $$;

create or replace function public.svc_leave_balances(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_year int := coalesce(nullif(p ->> 'year', '')::int, extract(year from private.local_now())::int);
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  if v_year not between 2020 and 2100 then perform private.err('invalid_dates'); end if;
  return jsonb_build_object('year', v_year, 'default_days', (select annual_leave_days from public.settings where id),
    'employees', coalesce((select jsonb_agg(private.leave_balance(pr.id, v_year) || jsonb_build_object('employee_id', pr.id,
        'name_ar', pr.full_name_ar, 'name_en', pr.full_name_en, 'active', pr.active) order by pr.full_name_ar)
      from public.profiles pr where pr.role = 'staff' and (pr.active or (p ->> 'employee_id') = pr.id::text)
        and ((p ->> 'employee_id') is null or (p ->> 'employee_id') = pr.id::text)), '[]'::jsonb));
end $$;

create or replace function public.svc_set_leave_balance(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; v_year int; v_days numeric; v_note text := nullif(btrim(coalesce(p ->> 'note', '')), ''); v_before jsonb;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_emp := (p ->> 'employee_id')::uuid; v_year := (p ->> 'year')::int; v_days := (p ->> 'entitled_days')::numeric;
  exception when others then perform private.err('invalid_value'); end;
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff') then perform private.err('invalid_employee'); end if;
  if v_year is null or v_year not between 2020 and 2100 or v_days is null or v_days < 0 or v_days > 365 or v_days * 2 <> round(v_days * 2) then
    perform private.err('invalid_value');
  end if;
  if char_length(v_note) > 200 then perform private.err('invalid_value'); end if;
  v_before := private.leave_balance(v_emp, v_year);
  insert into public.leave_balances (employee_id, year, entitled_days, note, updated_by, updated_at)
  values (v_emp, v_year, v_days, v_note, p_actor, now())
  on conflict (employee_id, year) do update set entitled_days = excluded.entitled_days, note = excluded.note, updated_by = p_actor, updated_at = now();
  perform private.audit(p_actor, 'leave_balance.set', 'leave_balances', v_emp::text, v_before, private.leave_balance(v_emp, v_year), v_note);
  return private.leave_balance(v_emp, v_year);
end $$;

-- =====================================================================
-- 7. Change log (what the owner / the system changed for an employee)
-- =====================================================================
create or replace function private.employee_changes(p_emp uuid, p_limit int, p_with_pay boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'at', x.occurred_at, 'action', x.action, 'reason', x.reason,
           'by', x.by_ar, 'kind', x.actor_kind, 'before', x.before, 'after', x.after, 'date', x.work_date) order by x.occurred_at desc, x.id desc), '[]'::jsonb)
  from (
    select a.id, a.occurred_at, a.action, a.reason, a.actor_kind, a.before, a.after,
           (select pr.full_name_ar from public.profiles pr where pr.id = a.actor_id) as by_ar,
           coalesce((select ad.work_date from public.attendance_days ad where a.target_table = 'attendance_days' and ad.id::text = a.target_id),
                    (select pe.effective_work_date from public.point_events pe where a.target_table = 'point_events' and pe.id::text = a.target_id)) as work_date
      from public.audit_log a
     where a.actor_id is distinct from p_emp
       and (a.action = any (array['attendance.correct', 'attendance.manual_check_in', 'points.manual', 'points.outcome',
              'points.absence_cancelled', 'points.absence_reversed', 'black.approve', 'black.decline',
              'leave.approved', 'leave.rejected', 'leave.comment', 'early_leave.approved', 'early_leave.rejected',
              'reward.approve', 'reward.paid', 'reward.reject', 'permission.approved', 'permission.rejected',
              'correction.approved', 'correction.rejected', 'leave_balance.set', 'schedule.set'])
            or (p_with_pay and a.action = any (array['salary_payment.record', 'salary_payment.reverse', 'salary.set'])))
       and case a.target_table
             when 'attendance_days' then exists (select 1 from public.attendance_days t where t.id::text = a.target_id and t.employee_id = p_emp)
             when 'point_events' then a.target_id = p_emp::text
               or exists (select 1 from public.point_events t where t.id::text = a.target_id and t.employee_id = p_emp)
             when 'leave_requests' then exists (select 1 from public.leave_requests t where t.id::text = a.target_id and t.employee_id = p_emp)
             when 'early_leave_requests' then exists (select 1 from public.early_leave_requests t where t.id::text = a.target_id and t.employee_id = p_emp)
             when 'reward_requests' then exists (select 1 from public.reward_requests t where t.id::text = a.target_id and t.employee_id = p_emp)
             when 'permission_requests' then exists (select 1 from public.permission_requests t where t.id::text = a.target_id and t.employee_id = p_emp)
             when 'correction_requests' then exists (select 1 from public.correction_requests t where t.id::text = a.target_id and t.employee_id = p_emp)
             when 'salary_payments' then exists (select 1 from public.salary_payments t where t.id::text = a.target_id and t.employee_id = p_emp)
             when 'leave_balances' then a.target_id = p_emp::text
             when 'employee_schedules' then a.target_id = p_emp::text
             when 'employee_salaries' then a.target_id = p_emp::text
             else false end
     order by a.occurred_at desc, a.id desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))) x
$$;
revoke all on function private.employee_changes(uuid, int, boolean) from public, anon, authenticated;

create or replace function public.svc_my_changes(p_actor uuid, p jsonb default '{}')
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.employee_changes(p_actor, coalesce(nullif(p ->> 'limit', '')::int, 50),
    (select staff_pay_visible from public.settings where id))
$$;

create or replace function public.svc_employee_changes(p_actor uuid, p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_emp := (p ->> 'employee_id')::uuid; exception when others then perform private.err('invalid_employee'); end;
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff') then perform private.err('invalid_employee'); end if;
  return private.employee_changes(v_emp, coalesce(nullif(p ->> 'limit', '')::int, 100), true);
end $$;

-- =====================================================================
-- 9. My pay (employee)
-- =====================================================================
create or replace function public.svc_my_pay(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_now date := private.period_of(private.local_now()::date); v_month date; e jsonb;
begin
  begin v_month := private.period_of(coalesce(nullif(p ->> 'month', '')::date, v_now)); exception when others then perform private.err('invalid_dates'); end;
  if v_month > v_now or v_month < v_now - interval '12 months' then perform private.err('invalid_dates'); end if;
  e := private.pay_entitlement(p_actor, v_month);
  if not s.staff_pay_visible then
    e := e - 'base_piastres' - 'net_piastres' - 'remaining_piastres' - 'payments' - 'salary_paid_piastres' - 'paid_piastres'
           - 'status' - 'flags' - 'salary_set' - 'net_adjustment_piastres';
  end if;
  return e || jsonb_build_object('pay_visible', s.staff_pay_visible, 'month', v_month, 'is_current', v_month = v_now,
    'attendance', private.month_attendance(p_actor, v_month),
    'events', coalesce((select jsonb_agg(jsonb_build_object('date', pe.effective_work_date, 'color', pe.color, 'delta', pe.delta,
        'status', pe.status, 'warning', pe.warning_only, 'source', pe.source, 'reason', pe.reason, 'reversed', private.is_reversed(pe.id),
        'deduction_piastres', case when pe.status = 'active' and pe.delta > 0 and not pe.warning_only and not private.is_reversed(pe.id)
                                   then pe.deduction_amount_piastres else 0 end) order by pe.effective_work_date, pe.created_at)
      from public.point_events pe where pe.employee_id = p_actor and pe.reward_period = v_month and pe.color in ('red', 'black')
        and pe.reverses_event_id is null and pe.status in ('active', 'pending_approval')), '[]'::jsonb));
end $$;

-- =====================================================================
-- Owner settings for these tools
-- =====================================================================
create or replace function public.svc_save_staff_tools(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
end $$;

create or replace function public.svc_staff_tools(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.settings := private.settings();
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  return jsonb_build_object('permission_monthly_limit', s.permission_monthly_limit, 'permission_max_minutes', s.permission_max_minutes,
    'annual_leave_days', s.annual_leave_days, 'checkout_overdue_reminder', s.checkout_overdue_reminder,
    'checkout_overdue_min', s.checkout_overdue_min, 'staff_pay_visible', s.staff_pay_visible);
end $$;

-- ================================================== patched existing functions (exact copies of the live definitions + the marked changes)
-- 3/2: check-in — personal day off (no points); an approved permission excuses lateness and allows check-in after the close time
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
end $function$;

-- 2/1: absence job — personal days off and approved permissions over the cutoff are not absences
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
    elsif not (select x.is_work from private.emp_day(emp.id, p_date) x) then
      v_lines := v_lines || jsonb_build_object('employee', emp.full_name_en, 'line', 'Personal Day Off -> No Absence');
    elsif private.permission_covers(emp.id, p_date, s.absence_cutoff) then
      v_lines := v_lines || jsonb_build_object('employee', emp.full_name_en, 'line', 'Approved Permission Covers Cutoff -> No Absence');
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
end $function$;

-- 2: absence streaks — a personal day off is not a work day
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
  if not (select x.is_work from private.emp_day(p_emp, d) x) then return 'nonwork'; end if;
  if exists (select 1 from public.leave_requests where employee_id = p_emp and status = 'approved' and d between from_date and to_date) then return 'leave'; end if;
  if exists (select 1 from public.point_events e where e.employee_id = p_emp and e.effective_work_date = d and e.source = 'auto_absence'
              and e.color = 'black' and e.delta > 0 and e.status in ('pending_approval', 'active') and not private.is_reversed(e.id)) then return 'absent'; end if;
  return 'open';
end $function$;

-- 2: early leave — the employee's own end time and day off
CREATE OR REPLACE FUNCTION public.svc_request_early_leave(p_actor uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.settings := private.settings(); v_local timestamp := private.local_now(); v_date date := v_local::date;
  v_time time; di record; r public.early_leave_requests; ed record;
begin
  begin v_time := (p ->> 'leave_time')::time; exception when others then perform private.err('invalid_time'); end;
  select * into di from private.day_info(v_date);
  if di.holiday_name_ar is not null then perform private.err('holiday'); end if;
  select * into ed from private.emp_day(p_actor, v_date);
  if not di.is_work_day or not ed.is_work then perform private.err('not_work_day'); end if;
  if v_time is null or v_time <= v_local::time or v_time >= ed.end_time then
    perform private.err('invalid_time', jsonb_build_object('work_end_time', ed.end_time));
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
end $function$;

-- 2/1: my day — the employee's own day off / hours and today's permissions
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
end $function$;

-- 10: points goal — work days left this month
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
    'work_days_left', private.emp_workdays(p_actor, v_today + 1, (v_period + interval '1 month - 1 day')::date),
    'today_is_work', (select x.is_work from private.emp_day(p_actor, v_today) x),
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
end $function$;

-- 3: leave request — personal leave is checked against the annual balance (work days only)
CREATE OR REPLACE FUNCTION public.svc_request_leave(p_actor uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.leave_requests; v_from date; v_to date; v_today date := private.local_now()::date; y int; v_req int; v_bal jsonb; v_total int := 0;
begin
  begin v_from := (p ->> 'from_date')::date; v_to := (p ->> 'to_date')::date; exception when others then perform private.err('invalid_dates'); end;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 60 or v_from < v_today - 31 or v_from > v_today + 365 then
    perform private.err('invalid_dates');
  end if;
  if (p ->> 'type') not in ('personal', 'sick') then perform private.err('invalid_type'); end if;
  perform 1 from public.profiles where id = p_actor for update;      -- serialise this employee's requests (balance check)
  for y in select generate_series(extract(year from v_from)::int, extract(year from v_to)::int) loop
    v_req := private.emp_workdays(p_actor, greatest(v_from, make_date(y, 1, 1)), least(v_to, make_date(y, 12, 31)));
    v_total := v_total + v_req;
    if (p ->> 'type') = 'personal' and v_req > 0 then
      v_bal := private.leave_balance(p_actor, y);
      if v_req > (v_bal ->> 'available')::numeric then
        perform private.err('leave_balance_insufficient', jsonb_build_object('year', y, 'requested', v_req, 'available', v_bal -> 'available'));
      end if;
    end if;
  end loop;
  if v_total = 0 then perform private.err('no_work_days'); end if;
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
end $function$;

-- 1/4: approvals — permissions and attendance corrections
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
$function$;

-- 2/1/4: dashboard — pending permissions/corrections and personal day off
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
end $function$;

-- notifications — permission and correction requests (same in-app / push / Telegram text)
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
end $function$;

-- notifications — route the new requests through the owner fan-out
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
end $function$;

-- 5: monthly statement — personal days off, permissions and the leave balance
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
  ed record; v_perm jsonb; t_off int := 0; t_perm int := 0; t_perm_min int := 0; v_corr jsonb;
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
    select * into ed from private.emp_day(v_emp, d);
    select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'from', r.from_time, 'to', r.to_time, 'minutes', r.minutes,
        'over_limit', r.over_limit, 'deducted', r.deduction_event_id is not null) order by r.from_time)
      into v_perm from public.permission_requests r where r.employee_id = v_emp and r.work_date = d and r.status in ('approved', 'pending');
    select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'kind', r.kind) order by r.created_at)
      into v_corr from public.correction_requests r where r.employee_id = v_emp and r.work_date = d;
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
      when ed.day_off then 'day_off'
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
    if ed.is_work and d <= v_today then t_work := t_work + 1; end if;
    if v_status = 'day_off' then t_off := t_off + 1; end if;
    select t_perm + count(*) filter (where x ->> 'status' = 'approved'), t_perm_min + coalesce(sum((x ->> 'minutes')::int) filter (where x ->> 'status' = 'approved'), 0)
      into t_perm, t_perm_min from jsonb_array_elements(coalesce(v_perm, '[]')) x;
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
      'leave', v_leave, 'early_leave', v_el, 'events', v_ev, 'deduction_piastres', v_ded, 'permissions', v_perm, 'corrections', v_corr);
  end loop;
  return jsonb_build_object('employee', jsonb_build_object('id', prof.id, 'code', private.emp_code(prof.id), 'name_ar', prof.full_name_ar,
      'name_en', prof.full_name_en, 'job_title_ar', prof.job_title_ar, 'job_title_en', prof.job_title_en, 'active', prof.active),
    'from', v_from, 'to', v_to, 'today', v_today, 'days', v_days,
    'totals', jsonb_build_object('working_days_elapsed', t_work, 'present', t_present, 'late', t_late, 'absent', t_abs, 'absent_pending', t_abs_pending,
      'absence_excused', t_excused, 'no_record', t_norecord, 'leave_days', t_leave, 'worked_minutes', t_minutes, 'missing_checkouts', t_missing,
      'deductions_piastres', t_ded, 'days_off', t_off, 'permissions', t_perm, 'permission_minutes', t_perm_min),
    -- leave by type/status, counted once per calendar day inside the range (overlaps de-duplicated)
    'leave_summary', coalesce((select jsonb_agg(jsonb_build_object('type', x.type, 'status', x.status, 'taken_days', x.taken, 'planned_days', x.planned, 'requests', x.reqs))
      from (select l.type, l.status,
              count(distinct g::date) filter (where g::date <= v_today) as taken, count(distinct g::date) filter (where g::date > v_today) as planned,
              count(distinct l.id) as reqs
              from public.leave_requests l, generate_series(greatest(l.from_date, v_from), least(l.to_date, v_to), interval '1 day') g
             where l.employee_id = v_emp and l.to_date >= v_from and l.from_date <= v_to group by l.type, l.status) x), '[]'::jsonb),
    'leave_allowance', private.leave_balance(v_emp, extract(year from v_to)::int),
    'months', (select jsonb_agg(to_char(m, 'YYYY-MM') order by m) from generate_series(private.period_of(v_from), private.period_of(v_to), interval '1 month') m));
end $function$;

-- 2/8: reminders — the employee's own day off and hours; NEW: a check-out
-- reminder when the (own / early-leave) end time passed and there is no
-- check-out yet (once a day, within 2 hours, respects the reminder toggle).
create or replace function private.enqueue_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_local timestamp := private.local_now(); v_date date := v_local::date;
  v_t time := v_local::time; di record; emp record; w record; v_n int := 0; ed record; v_end time; v_due timestamp;
begin
  select * into di from private.day_info(v_date);
  if not di.is_work_day then return 0; end if;  -- holidays & weekends: nothing
  for emp in select * from public.profiles where role = 'staff' and active loop
    if exists (select 1 from public.leave_requests where employee_id = emp.id and status = 'approved' and v_date between from_date and to_date) then
      continue;
    end if;
    select * into ed from private.emp_day(emp.id, v_date);
    if not ed.is_work then continue; end if;                    -- personal day off
    -- shift start
    if v_t >= ed.start_time - make_interval(mins => s.shift_reminder_lead_min) and v_t < ed.start_time then
      v_n := v_n + private.enqueue_push(emp.id, 'shift_start', v_date::text,
        'Zintra حاضر', 'يبدأ العمل بعد ' || s.shift_reminder_lead_min || ' دقيقة — سجّل حضورك عند وصولك.',
        'Zintra حاضر', 'Work starts in ' || s.shift_reminder_lead_min || ' minutes — check in when you arrive.');
    end if;
    -- shift end (only if checked in and not yet checked out)
    if v_t >= ed.end_time - make_interval(mins => s.shift_reminder_lead_min) and v_t < ed.end_time
       and exists (select 1 from public.attendance_days where employee_id = emp.id and work_date = v_date and checked_in_at is not null and checked_out_at is null) then
      v_n := v_n + private.enqueue_push(emp.id, 'shift_end', v_date::text,
        'Zintra حاضر', 'ينتهي العمل بعد ' || s.shift_reminder_lead_min || ' دقيقة — لا تنسَ تسجيل الانصراف.',
        'Zintra حاضر', 'Work ends in ' || s.shift_reminder_lead_min || ' minutes — remember to check out.');
    end if;
    -- check-out overdue (end time + N minutes, no check-out yet)
    if s.checkout_overdue_reminder then
      v_end := coalesce((select r.requested_leave_time from public.early_leave_requests r where r.employee_id = emp.id and r.work_date = v_date
                          and r.status = 'approved' order by r.decided_at desc limit 1), ed.end_time);
      v_due := v_date + v_end + make_interval(mins => s.checkout_overdue_min);
      if v_local >= v_due and v_local < v_due + interval '2 hours'
         and exists (select 1 from public.attendance_days where employee_id = emp.id and work_date = v_date and checked_in_at is not null and checked_out_at is null) then
        v_n := v_n + private.enqueue_push(emp.id, 'checkout_overdue', v_date::text,
          'Zintra حاضر', 'لسه ما سجّلتش انصرافك — موعد انتهاء عملك كان ' || private.fmt12(v_end, 'ar') || '. سجّل الانصراف دلوقتي.',
          'Zintra حاضر', 'You have not checked out yet — your work ended at ' || private.fmt12(v_end, 'en') || '. Check out now.');
      end if;
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

-- 6: daily summary — counts first, then one line per employee (present /
-- late / leave / personal day off / permission / absent) and what still
-- waits for the owner's decision.
create or replace function private.run_digest(p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); di record; emp record; v_lines jsonb := '[]'::jsonb; v_rows jsonb := '[]'::jsonb;
  a public.attendance_days; v_status text; ed record; v_perm text;
  n_present int := 0; n_late int := 0; n_leave int := 0; n_off int := 0; n_absent int := 0; n_none int := 0; v_pend text;
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
      select * into ed from private.emp_day(emp.id, p_date);
      select string_agg('إذن ' || private.fmt12(r.from_time, 'ar') || '–' || private.fmt12(r.to_time, 'ar'), '، ' order by r.from_time)
        into v_perm from public.permission_requests r where r.employee_id = emp.id and r.work_date = p_date and r.status = 'approved';
      if a.id is not null and a.check_in_outcome = 'red' then
        n_present := n_present + 1; n_late := n_late + 1;
        v_status := 'متأخر ' || private.fmt12_ts(a.checked_in_at, 'ar') ||
          case when (select warning_only from public.point_events where id = a.point_event_id) then ' (إنذار)' else ' (خصم)' end;
      elsif a.id is not null then
        n_present := n_present + 1;
        v_status := 'حاضر ' || private.fmt12_ts(a.checked_in_at, 'ar') || coalesce(' · ' || (
          select label_ar from public.check_in_windows w where w.id = a.window_id), '');
      elsif exists (select 1 from public.leave_requests where employee_id = emp.id and status = 'approved' and p_date between from_date and to_date) then
        n_leave := n_leave + 1; v_status := 'إجازة معتمدة';
      elsif not ed.is_work then
        n_off := n_off + 1; v_status := 'يوم راحة';
      elsif exists (select 1 from public.point_events where employee_id = emp.id and effective_work_date = p_date and source = 'auto_absence' and status = 'pending_approval') then
        n_absent := n_absent + 1; v_status := 'غائب — نقطة سوداء بانتظار الموافقة';
      else
        n_none := n_none + 1; v_status := 'لم يسجّل حضورًا';
      end if;
      v_rows := v_rows || jsonb_build_object('line', emp.full_name_ar || ': ' || v_status || coalesce(' · ' || v_perm, ''));
    end loop;
    v_lines := jsonb_build_array(jsonb_build_object('line', format('حاضر %s · متأخر %s · غائب %s · إجازة %s · راحة %s%s',
      n_present, n_late, n_absent, n_leave, n_off, case when n_none > 0 then ' · لم يسجّل ' || n_none else '' end))) || v_rows;
    v_lines := v_lines || coalesce((select jsonb_agg(jsonb_build_object('line', 'طلب مكافأة: ' || pr.full_name_ar || ' — ' || r.status))
       from public.reward_requests r join public.profiles pr on pr.id = r.employee_id
      where (r.created_at at time zone s.business_timezone)::date = p_date or (r.decided_at at time zone s.business_timezone)::date = p_date), '[]'::jsonb);
    select nullif(concat_ws(' · ',
        nullif('إذن ' || (select count(*) from public.permission_requests where status = 'pending'), 'إذن 0'),
        nullif('تصحيح حضور ' || (select count(*) from public.correction_requests where status = 'pending'), 'تصحيح حضور 0'),
        nullif('إجازة ' || (select count(*) from public.leave_requests where status = 'pending'), 'إجازة 0'),
        nullif('انصراف مبكر ' || (select count(*) from public.early_leave_requests where status = 'pending'), 'انصراف مبكر 0'),
        nullif('غياب ' || (select count(*) from public.point_events where status = 'pending_approval'), 'غياب 0')), '')
      into v_pend;
    if v_pend is not null then v_lines := v_lines || jsonb_build_object('line', 'بانتظار قرارك: ' || v_pend); end if;
  end if;
  perform private.enqueue_owner_alert('digest', 'digest:' || p_date, jsonb_build_object('kind', 'digest', 'date', p_date, 'lines', v_lines));
  perform private.record_job('digest', p_date::text, 'succeeded', jsonb_build_object('lines', v_lines));
  return jsonb_build_object('lines', v_lines);
end $$;

-- ------------------------------------------------------------ grants
do $$ declare f text; begin
  foreach f in array array[
    'public.svc_request_permission(uuid, jsonb)', 'public.svc_cancel_permission(uuid, jsonb)', 'public.svc_decide_permission(uuid, jsonb)',
    'public.svc_request_correction(uuid, jsonb)', 'public.svc_cancel_correction(uuid, jsonb)', 'public.svc_decide_correction(uuid, jsonb)',
    'public.svc_employee_schedule(uuid, jsonb)', 'public.svc_save_employee_schedule(uuid, jsonb)',
    'public.svc_my_leave_balance(uuid, jsonb)', 'public.svc_leave_balances(uuid, jsonb)', 'public.svc_set_leave_balance(uuid, jsonb)',
    'public.svc_my_changes(uuid, jsonb)', 'public.svc_employee_changes(uuid, jsonb)', 'public.svc_my_pay(uuid, jsonb)',
    'public.svc_save_staff_tools(uuid, jsonb)', 'public.svc_staff_tools(uuid, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
