-- =====================================================================
-- حاضر (Hadir) — one payroll calculation, payslips, salary payments,
-- employee statement, deletion preview. Additive; nothing is dropped.
-- All money is integer piastres (1 EGP = 100 piastres).
--
--   base        = employee_salaries.monthly_salary_piastres (NULL = missing,
--                 never treated as 0; no proration: no policy exists)
--   earnings    = reward_requests for the month with status approved|paid
--                 (owner-approved). pending = shown, NOT included.
--   deductions  = point_events of the month, status active, delta > 0,
--                 not reversed: red that is not warning_only + black
--                 (approved). Amount = the event's own snapshot
--                 (deduction_amount_piastres) → rule changes are respected.
--                 Pending/declined absences and warnings never deduct.
--   net         = base + earnings − deductions               (NULL if base NULL)
--   paid        = salary payments (net of reversals) + rewards already paid
--                 separately (reward status = paid)
--   remaining   = net − paid
--   net_adjustment (legacy, secondary) = earnings − deductions
-- No taxes, insurance, advances, overtime, proration or carry-forward:
-- the project has no such policy. Missing salary / negative net /
-- overpayment are review flags, never clamped.
-- =====================================================================

-- ------------------------------------------------ salary payments (external, recorded)
create table if not exists public.salary_payments (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references public.profiles (id),
  month            date not null check (extract(day from month) = 1),
  kind             text not null check (kind in ('payment', 'reversal')),
  amount_piastres  bigint not null check (amount_piastres <> 0 and abs(amount_piastres) <= 100000000000),
  reverses_id      uuid unique references public.salary_payments (id),
  paid_on          date not null,
  method           text check (method is null or method in ('cash', 'bank', 'instapay', 'vodafone_cash', 'other')),
  reference        text check (reference is null or char_length(reference) <= 100),
  note             text check (note is null or char_length(note) <= 300),
  idempotency_key  text not null unique check (char_length(idempotency_key) between 8 and 80),
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  check ((kind = 'payment' and amount_piastres > 0 and reverses_id is null) or (kind = 'reversal' and amount_piastres < 0 and reverses_id is not null))
);
create index if not exists salary_payments_emp_month on public.salary_payments (employee_id, month);
alter table public.salary_payments enable row level security;
revoke all on public.salary_payments from public, anon, authenticated;

-- ------------------------------------------------ immutable payslip versions
create table if not exists public.payslip_snapshots (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles (id),
  month       date not null check (extract(day from month) = 1),
  version     integer not null,
  kind        text not null check (kind in ('finalized', 'payment')),
  slip_no     text not null unique,
  data        jsonb not null,
  created_by  uuid not null references public.profiles (id),
  created_at  timestamptz not null default now(),
  constraint payslip_version_unique unique (employee_id, month, version)
);
alter table public.payslip_snapshots enable row level security;
revoke all on public.payslip_snapshots from public, anon, authenticated;

-- (append-only triggers for these two tables are in 20261125090100)

-- ------------------------------------------------ deletion workflow (no personal data)
create table if not exists public.employee_deletions (
  id                  uuid primary key default gen_random_uuid(),
  deleted_employee_id uuid not null,                       -- opaque id only
  requested_by        uuid not null,
  status              text not null default 'db_done' check (status in ('db_done', 'complete', 'auth_failed')),
  attempts            integer not null default 0,
  last_error          text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);
alter table public.employee_deletions enable row level security;
revoke all on public.employee_deletions from public, anon, authenticated;

-- =====================================================================
-- the ONE calculation
-- =====================================================================
create or replace function private.emp_code(p_emp uuid) returns text language sql immutable set search_path = '' as $$
  select 'EMP-' || upper(right(replace(p_emp::text, '-', ''), 8))
$$;

create or replace function private.pay_entitlement(p_emp uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
end $$;

-- comparable core of an entitlement (what a snapshot must not silently change)
create or replace function private.entitlement_core(e jsonb) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('base', e -> 'base_piastres', 'earn', e -> 'earnings', 'ded', e -> 'deductions',
    'net', e -> 'net_piastres', 'payments', e -> 'payments', 'reward_paid', e -> 'reward_paid_piastres')
$$;

-- Attendance/leave summary for a month (shown on the payslip; never money).
create or replace function private.month_attendance(p_emp uuid, p_month date)
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (select private.period_of(p_month) as a, (private.period_of(p_month) + interval '1 month - 1 day')::date as b)
  select jsonb_build_object(
    'present_days', (select count(*) from public.attendance_days, m where employee_id = p_emp and work_date between m.a and m.b and checked_in_at is not null),
    'late_days', (select count(*) from public.attendance_days, m where employee_id = p_emp and work_date between m.a and m.b and check_in_outcome = 'red'),
    'worked_minutes', (select coalesce(sum(worked_minutes), 0) from public.attendance_days, m where employee_id = p_emp and work_date between m.a and m.b),
    'absence_days', (select count(*) from public.point_events e, m where e.employee_id = p_emp and e.effective_work_date between m.a and m.b
                       and e.source = 'auto_absence' and e.status = 'active' and e.delta > 0 and not private.is_reversed(e.id)),
    'leave_days', (select count(distinct d) from m, public.leave_requests l, generate_series(greatest(l.from_date, m.a), least(l.to_date, m.b), interval '1 day') d
                    where l.employee_id = p_emp and l.status = 'approved' and l.to_date >= m.a and l.from_date <= m.b))
$$;

create or replace function private.payslip_data(p_emp uuid, p_month date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'company', jsonb_build_object('name_ar', 'حاضر', 'name_en', 'Hadir'),
    'employee', jsonb_build_object('id', p.id, 'code', private.emp_code(p.id), 'name_ar', p.full_name_ar, 'name_en', p.full_name_en,
       'job_title_ar', p.job_title_ar, 'job_title_en', p.job_title_en, 'active', p.active),
    'period', jsonb_build_object('month', private.period_of(p_month), 'from', private.period_of(p_month),
       'to', (private.period_of(p_month) + interval '1 month - 1 day')::date),
    'rules', jsonb_build_object('rule_version', s.rule_version, 'red_penalty_piastres', s.red_penalty_piastres,
       'black_penalty_piastres', s.black_penalty_piastres, 'threshold', s.green_reward_threshold,
       'reward_amount_piastres', s.reward_amount_piastres, 'first_red_warning', s.first_red_warning),
    'entitlement', private.pay_entitlement(p_emp, p_month),
    'attendance', private.month_attendance(p_emp, p_month),
    'generated_at', now())
  from public.profiles p, public.settings s where p.id = p_emp and s.id
$$;

-- Payroll for a month: the existing report (points, minutes, flags) + the
-- entitlement + payslip status for every employee with activity.
create or replace function public.svc_payroll_v2(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_month date := private.period_of(coalesce((p ->> 'month')::date, private.local_now()::date)); r jsonb; rows jsonb := '[]'::jsonb;
  x jsonb; e jsonb; snap public.payslip_snapshots; v_tot jsonb;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  r := public.svc_payroll(p_actor, jsonb_build_object('month', v_month));
  for x in select * from jsonb_array_elements(r -> 'rows') loop
    e := private.pay_entitlement((x ->> 'employee_id')::uuid, v_month);
    select * into snap from public.payslip_snapshots where employee_id = (x ->> 'employee_id')::uuid and month = v_month order by version desc limit 1;
    rows := rows || (x || jsonb_build_object('employee_code', private.emp_code((x ->> 'employee_id')::uuid), 'entitlement', e,
      'snapshot', case when snap.id is null then null else jsonb_build_object('version', snap.version, 'slip_no', snap.slip_no, 'kind', snap.kind,
        'created_at', snap.created_at, 'changed', private.entitlement_core(snap.data -> 'entitlement') is distinct from private.entitlement_core(e)) end));
  end loop;
  select jsonb_build_object(
    'base_piastres', coalesce(sum((y -> 'entitlement' ->> 'base_piastres')::bigint), 0),
    'earnings_piastres', coalesce(sum((y -> 'entitlement' ->> 'earnings_piastres')::bigint), 0),
    'deductions_piastres', coalesce(sum((y -> 'entitlement' ->> 'deductions_piastres')::bigint), 0),
    'net_piastres', coalesce(sum((y -> 'entitlement' ->> 'net_piastres')::bigint), 0),
    'salary_paid_piastres', coalesce(sum((y -> 'entitlement' ->> 'salary_paid_piastres')::bigint), 0),
    'reward_paid_piastres', coalesce(sum((y -> 'entitlement' ->> 'reward_paid_piastres')::bigint), 0),
    'remaining_piastres', coalesce(sum((y -> 'entitlement' ->> 'remaining_piastres')::bigint), 0),
    'net_adjustment_piastres', coalesce(sum((y -> 'entitlement' ->> 'net_adjustment_piastres')::bigint), 0),
    'salary_missing', count(*) filter (where not (y -> 'entitlement' ->> 'salary_set')::boolean))
    into v_tot from jsonb_array_elements(rows) y;
  return (r - 'rows') || jsonb_build_object('rows', rows, 'totals_v2', v_tot, 'month_closed', v_month < private.period_of(private.local_now()::date));
end $$;

-- Payslip: live draft + saved versions (or one saved version).
create or replace function public.svc_payslip(p_actor uuid, p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid; v_month date; snap public.payslip_snapshots; v_draft jsonb;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_emp := (p ->> 'employee_id')::uuid; v_month := private.period_of((p ->> 'month')::date);
  exception when others then perform private.err('not_found'); end;
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff') then perform private.err('not_found'); end if;
  if p ? 'version' then
    select * into snap from public.payslip_snapshots where employee_id = v_emp and month = v_month and version = (p ->> 'version')::int;
    if snap.id is null then perform private.err('not_found'); end if;
    return jsonb_build_object('mode', 'snapshot', 'version', snap.version, 'kind', snap.kind, 'slip_no', snap.slip_no,
      'created_at', snap.created_at, 'data', snap.data);
  end if;
  v_draft := private.payslip_data(v_emp, v_month);
  return jsonb_build_object('mode', 'draft', 'data', v_draft,
    'draft_ref', 'DRAFT-' || to_char(v_month, 'YYYYMM') || '-' || private.emp_code(v_emp),
    'month_closed', v_month < private.period_of(private.local_now()::date),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('version', s.version, 'kind', s.kind, 'slip_no', s.slip_no, 'created_at', s.created_at,
        'net_piastres', s.data -> 'entitlement' -> 'net_piastres', 'remaining_piastres', s.data -> 'entitlement' -> 'remaining_piastres',
        'changed', private.entitlement_core(s.data -> 'entitlement') is distinct from private.entitlement_core(v_draft -> 'entitlement')) order by s.version desc)
      from public.payslip_snapshots s where s.employee_id = v_emp and s.month = v_month), '[]'::jsonb));
end $$;

-- Save an immutable version (idempotent: same figures → the same version).
create or replace function private.issue_payslip(p_actor uuid, p_emp uuid, p_month date, p_kind text)
returns public.payslip_snapshots language plpgsql security definer set search_path = '' as $$
declare v_data jsonb := private.payslip_data(p_emp, p_month); last public.payslip_snapshots; snap public.payslip_snapshots; v_ver int;
begin
  select * into last from public.payslip_snapshots where employee_id = p_emp and month = p_month order by version desc limit 1;
  if last.id is not null and private.entitlement_core(last.data -> 'entitlement') = private.entitlement_core(v_data -> 'entitlement') then
    return last;
  end if;
  v_ver := coalesce(last.version, 0) + 1;
  insert into public.payslip_snapshots (employee_id, month, version, kind, slip_no, data, created_by)
  values (p_emp, p_month, v_ver, p_kind, 'PS-' || to_char(p_month, 'YYYYMM') || '-' || private.emp_code(p_emp) || '-V' || v_ver,
          v_data || jsonb_build_object('issued_at', now()), p_actor)
  returning * into snap;
  perform private.audit(p_actor, 'payslip.issue', 'payslip_snapshots', snap.id::text, null,
    jsonb_build_object('employee_id', p_emp, 'month', p_month, 'version', v_ver, 'kind', p_kind, 'slip_no', snap.slip_no));
  return snap;
end $$;

create or replace function public.svc_payslip_finalize(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; v_month date; e jsonb; snap public.payslip_snapshots;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_emp := (p ->> 'employee_id')::uuid; v_month := private.period_of((p ->> 'month')::date);
  exception when others then perform private.err('not_found'); end;
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff') then perform private.err('not_found'); end if;
  if v_month >= private.period_of(private.local_now()::date) then perform private.err('month_not_closed'); end if;
  perform pg_advisory_xact_lock(hashtext('payslip:' || v_emp || ':' || v_month));
  e := private.pay_entitlement(v_emp, v_month);
  if not (e ->> 'salary_set')::boolean then perform private.err('salary_missing'); end if;
  snap := private.issue_payslip(p_actor, v_emp, v_month, 'finalized');
  return jsonb_build_object('version', snap.version, 'slip_no', snap.slip_no, 'kind', snap.kind, 'created_at', snap.created_at);
end $$;

-- Record a salary payment made OUTSIDE the app (no money moves here).
create or replace function public.svc_salary_payment_record(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; v_month date; v_amount bigint; v_on date; v_key text := btrim(coalesce(p ->> 'idempotency_key', ''));
  sp public.salary_payments; e jsonb; snap public.payslip_snapshots;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin
    v_emp := (p ->> 'employee_id')::uuid; v_month := private.period_of((p ->> 'month')::date);
    v_amount := (p ->> 'amount_piastres')::bigint; v_on := (p ->> 'paid_on')::date;
  exception when others then perform private.err('invalid_amount'); end;
  if char_length(v_key) not between 8 and 80 then perform private.err('invalid_request'); end if;
  select * into sp from public.salary_payments where idempotency_key = v_key;
  if sp.id is not null then                                   -- retry / double tap: same result
    return jsonb_build_object('payment', to_jsonb(sp), 'duplicate', true, 'entitlement', private.pay_entitlement(sp.employee_id, sp.month));
  end if;
  if not exists (select 1 from public.profiles where id = v_emp and role = 'staff') then perform private.err('not_found'); end if;
  if v_amount is null or v_amount <= 0 or v_amount > 100000000000 then perform private.err('invalid_amount'); end if;
  if v_on is null or v_on > private.local_now()::date or v_on < v_month - 366 then perform private.err('invalid_time'); end if;
  perform pg_advisory_xact_lock(hashtext('payslip:' || v_emp || ':' || v_month));   -- concurrent owners serialise
  e := private.pay_entitlement(v_emp, v_month);
  if not (e ->> 'salary_set')::boolean then perform private.err('salary_missing'); end if;
  if v_amount > (e ->> 'remaining_piastres')::bigint and not coalesce((p ->> 'allow_overpay')::boolean, false) then
    perform private.err('overpayment', jsonb_build_object('remaining_piastres', (e ->> 'remaining_piastres')::bigint));
  end if;
  begin
    insert into public.salary_payments (employee_id, month, kind, amount_piastres, paid_on, method, reference, note, idempotency_key, created_by)
    values (v_emp, v_month, 'payment', v_amount, v_on, nullif(p ->> 'method', ''), nullif(btrim(coalesce(p ->> 'reference', '')), ''),
            nullif(btrim(coalesce(p ->> 'note', '')), ''), v_key, p_actor)
    returning * into sp;
  exception when check_violation then perform private.err('invalid_request');
  end;
  perform private.audit(p_actor, 'salary_payment.record', 'salary_payments', sp.id::text, null,
    jsonb_build_object('employee_id', v_emp, 'month', v_month, 'amount_piastres', v_amount, 'paid_on', v_on, 'method', sp.method));
  snap := private.issue_payslip(p_actor, v_emp, v_month, 'payment');
  return jsonb_build_object('payment', to_jsonb(sp), 'duplicate', false, 'entitlement', private.pay_entitlement(v_emp, v_month),
    'snapshot', jsonb_build_object('version', snap.version, 'slip_no', snap.slip_no));
end $$;

-- Correct a mistaken record by a reversal entry (history is never erased).
create or replace function public.svc_salary_payment_reverse(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; sp public.salary_payments; rv public.salary_payments; v_reason text := btrim(coalesce(p ->> 'reason', ''));
  v_key text := btrim(coalesce(p ->> 'idempotency_key', '')); snap public.payslip_snapshots;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_id := (p ->> 'payment_id')::uuid; exception when others then perform private.err('not_found'); end;
  if char_length(v_reason) < 3 then perform private.err('reason_required'); end if;
  if char_length(v_key) not between 8 and 80 then perform private.err('invalid_request'); end if;
  select * into rv from public.salary_payments where idempotency_key = v_key;
  if rv.id is not null then return jsonb_build_object('reversal', to_jsonb(rv), 'duplicate', true); end if;
  select * into sp from public.salary_payments where id = v_id and kind = 'payment';
  if sp.id is null then perform private.err('not_found'); end if;
  perform pg_advisory_xact_lock(hashtext('payslip:' || sp.employee_id || ':' || sp.month));
  if exists (select 1 from public.salary_payments where reverses_id = v_id) then perform private.err('already_reversed'); end if;
  insert into public.salary_payments (employee_id, month, kind, amount_piastres, reverses_id, paid_on, note, idempotency_key, created_by)
  values (sp.employee_id, sp.month, 'reversal', -sp.amount_piastres, sp.id, private.local_now()::date, left(v_reason, 300), v_key, p_actor)
  returning * into rv;
  perform private.audit(p_actor, 'salary_payment.reverse', 'salary_payments', rv.id::text, to_jsonb(sp), to_jsonb(rv), v_reason);
  snap := private.issue_payslip(p_actor, sp.employee_id, sp.month, 'payment');
  return jsonb_build_object('reversal', to_jsonb(rv), 'duplicate', false, 'entitlement', private.pay_entitlement(sp.employee_id, sp.month),
    'snapshot', jsonb_build_object('version', snap.version, 'slip_no', snap.slip_no));
end $$;

-- =====================================================================
-- Employee statement (every day of the range, Cairo calendar)
-- =====================================================================
create or replace function public.svc_employee_statement(p_actor uuid, p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
end $$;

-- =====================================================================
-- Deletion preview (counts the employee's footprint; changes nothing)
-- =====================================================================
create or replace function private.employee_footprint(p_emp uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare prof public.profiles; ids text[]; v_names text[];
begin
  select * into prof from public.profiles where id = p_emp;
  v_names := array[private.name_of(p_emp), prof.full_name_ar, prof.full_name_en];
  ids := array[p_emp::text]
    || coalesce((select array_agg(id::text) from public.point_events where employee_id = p_emp), '{}')
    || coalesce((select array_agg(id::text) from public.attendance_days where employee_id = p_emp), '{}')
    || coalesce((select array_agg(id::text) from public.leave_requests where employee_id = p_emp), '{}')
    || coalesce((select array_agg(id::text) from public.early_leave_requests where employee_id = p_emp), '{}')
    || coalesce((select array_agg(id::text) from public.reward_requests where employee_id = p_emp), '{}')
    || coalesce((select array_agg(id::text) from public.payroll_reports where employee_id = p_emp), '{}')
    || coalesce((select array_agg(id::text) from public.payslip_snapshots where employee_id = p_emp), '{}')
    || coalesce((select array_agg(id::text) from public.salary_payments where employee_id = p_emp), '{}')
    || coalesce((select array_agg(id::text) from public.absence_streak_alerts where employee_id = p_emp), '{}');
  return jsonb_build_object(
    'attendance_days', (select count(*) from public.attendance_days where employee_id = p_emp),
    'attendance_corrections', (select count(*) from public.attendance_days where employee_id = p_emp and corrected),
    'point_events', (select count(*) from public.point_events where employee_id = p_emp),
    'leave_requests', (select count(*) from public.leave_requests where employee_id = p_emp),
    'early_leave_requests', (select count(*) from public.early_leave_requests where employee_id = p_emp),
    'reward_requests', (select count(*) from public.reward_requests where employee_id = p_emp),
    'payroll_reports', (select count(*) from public.payroll_reports where employee_id = p_emp),
    'monthly_deductions', (select count(*) from public.monthly_deductions where employee_id = p_emp),
    'payslip_snapshots', (select count(*) from public.payslip_snapshots where employee_id = p_emp),
    'salary_payments', (select count(*) from public.salary_payments where employee_id = p_emp),
    'salary_record', (select count(*) from public.employee_salaries where employee_id = p_emp),
    'login_codes', (select count(*) from public.login_codes where profile_id = p_emp),
    'device_sessions', (select count(*) from public.device_sessions where profile_id = p_emp),
    'push_subscriptions', (select count(*) from public.push_subscriptions where employee_id = p_emp),
    'login_attempts', (select count(*) from public.login_attempts where matched_profile_id = p_emp),
    'absence_alerts', (select count(*) from public.absence_streak_alerts where employee_id = p_emp),
    'notifications', (select count(*) from public.notification_outbox o where o.employee_id = p_emp or o.event_ref = any (ids)
        or o.dedupe_key like '%' || p_emp || '%' or o.payload ->> 'employee' = any (v_names) or o.payload::text like '%' || p_emp || '%'),
    'audit_entries', (select count(*) from public.audit_log a where a.actor_id = p_emp or a.target_id = any (ids)
        or coalesce(a.before::text, '') like '%' || p_emp || '%' or coalesce(a.after::text, '') like '%' || p_emp || '%'),
    'job_report_lines', (select count(*) from public.job_runs j, jsonb_array_elements(case when jsonb_typeof(j.detail -> 'lines') = 'array' then j.detail -> 'lines' else '[]' end) l
        where l ->> 'employee' = any (v_names) or l ->> 'line' like prof.full_name_ar || ':%'),
    'owner_reports', (select count(*) from private.owner_reports r where r.report_key like p_emp || ':%' or r.meta::text like '%' || p_emp || '%'
        or exists (select 1 from unnest(r.parts) x where x like '%' || prof.full_name_ar || '%')),
    'telegram_pending', (select count(*) from public.telegram_actions t where t.action::text like '%' || p_emp || '%'),
    'files', 0);
end $$;

create or replace function public.svc_employee_delete_preview(p_actor uuid, p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid; prof public.profiles; f jsonb;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_emp := (p ->> 'employee_id')::uuid; exception when others then perform private.err('not_found'); end;
  select * into prof from public.profiles where id = v_emp;
  if prof.id is null then perform private.err('not_found'); end if;
  if prof.role <> 'staff' or v_emp = p_actor then perform private.err('cannot_delete_owner'); end if;
  f := private.employee_footprint(v_emp);
  return jsonb_build_object('employee_id', v_emp, 'name_ar', prof.full_name_ar, 'name_en', prof.full_name_en, 'active', prof.active,
    'counts', f, 'preview_token', md5(f::text || prof.updated_at::text));
end $$;

create or replace function public.svc_employee_deletions(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  return coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc) from (select id, deleted_employee_id, status, attempts, created_at, completed_at
    from public.employee_deletions where status <> 'complete' order by created_at desc limit 20) d), '[]'::jsonb);
end $$;
create or replace function public.svc_employee_deletion_result(p_id uuid, p_ok boolean, p_error text)
returns void language sql security definer set search_path = '' as $$
  update public.employee_deletions set status = case when p_ok then 'complete' else 'auth_failed' end, attempts = attempts + 1,
    last_error = case when p_ok then null else left(p_error, 200) end, completed_at = case when p_ok then now() end
  where id = p_id
$$;

-- =====================================================================
-- Telegram month-end payroll summary: the SAME entitlement
-- =====================================================================
create or replace function private.run_payroll_summary(p_month date, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_open jsonb := private.payroll_month_open_items(p_month); v_rows jsonb; v_lines text[] := '{}'; r jsonb; e jsonb;
  v_prev private.owner_reports; v_ver int; v_id uuid; v_fig jsonb := '[]'::jsonb; v_key text := to_char(p_month, 'YYYY-MM');
  v_sal bigint := 0; v_add bigint := 0; v_ded bigint := 0; v_net bigint := 0; v_paid bigint := 0; v_rem bigint := 0; v_missing int := 0;
begin
  if (v_open ->> 'open')::boolean then
    v_id := private.queue_owner_report('payroll_blocked', v_key, 1, '⏳ رواتب ' || private.ar_month(p_month) || ' — لم تكتمل بعد',
      array['لن يُرسل ملخص الرواتب النهائي حتى تُغلق هذه البنود (لا توجد أرقام في هذه الرسالة):',
        '• أيام عمل لم يُحتسب غيابها بعد: ' || (v_open ->> 'absence_days_not_closed'),
        '• نقاط سوداء بانتظار قرارك: ' || (v_open ->> 'black_pending'),
        '• تسجيلات انصراف ناقصة: ' || (v_open ->> 'missing_checkouts'),
        'بعد إغلاقها يصلك الملخص النهائي تلقائيًا.'], v_open);
    perform private.record_job('payroll_summary', v_key, 'failed', jsonb_build_object('waiting', v_open, 'notice_report', v_id));
    return jsonb_build_object('waiting', v_open);
  end if;
  v_rows := public.svc_payroll(p_actor, jsonb_build_object('month', p_month)) -> 'rows';
  for r in select x from jsonb_array_elements(v_rows) x order by x ->> 'full_name_ar' loop
    e := private.pay_entitlement((r ->> 'employee_id')::uuid, p_month);
    v_fig := v_fig || jsonb_build_object('id', r ->> 'employee_id', 'core', private.entitlement_core(e), 'remaining', e -> 'remaining_piastres');
    v_lines := v_lines || ('• ' || (r ->> 'full_name_ar') ||
      E'\n   المرتب الأساسي: ' || case when (e ->> 'salary_set')::boolean then private.egp((e ->> 'base_piastres')::bigint) else 'غير مسجل (مطلوب مراجعة)' end ||
      E'\n   إضافات معتمدة: ' || private.egp((e ->> 'earnings_piastres')::bigint) ||
      E'\n   خصومات معتمدة: ' || private.egp((e ->> 'deductions_piastres')::bigint) ||
      E'\n   صافي المستحق: ' || coalesce(private.egp((e ->> 'net_piastres')::bigint), '—') ||
      E'\n   مدفوع: ' || private.egp((e ->> 'paid_piastres')::bigint) ||
      E'\n   المتبقي: ' || coalesce(private.egp((e ->> 'remaining_piastres')::bigint), '—'));
    if (e ->> 'salary_set')::boolean then
      v_sal := v_sal + (e ->> 'base_piastres')::bigint; v_net := v_net + (e ->> 'net_piastres')::bigint; v_rem := v_rem + (e ->> 'remaining_piastres')::bigint;
    else v_missing := v_missing + 1; end if;
    v_add := v_add + (e ->> 'earnings_piastres')::bigint; v_ded := v_ded + (e ->> 'deductions_piastres')::bigint; v_paid := v_paid + (e ->> 'paid_piastres')::bigint;
  end loop;
  select * into v_prev from private.owner_reports where kind = 'payroll_summary' and report_key = v_key order by version desc limit 1;
  if v_prev.id is not null and v_prev.meta -> 'figures' = v_fig then
    perform private.record_job('payroll_summary', v_key, 'succeeded', jsonb_build_object('report_id', v_prev.id, 'unchanged', true));
    return jsonb_build_object('report_id', v_prev.id, 'version', v_prev.version, 'unchanged', true);
  end if;
  v_ver := coalesce(v_prev.version, 0) + 1;
  if jsonb_array_length(v_rows) = 0 then v_lines := v_lines || 'لا يوجد موظفون في هذا الشهر.'::text; end if;
  v_lines := v_lines || ''::text || '— إجمالي الشركة —'::text ||
    ('المرتبات الأساسية المسجلة: ' || private.egp(v_sal) || case when v_missing > 0 then ' (' || v_missing || ' موظف بدون مرتب مسجل — غير محسوب)' else '' end) ||
    ('الإضافات المعتمدة: ' || private.egp(v_add)) || ('الخصومات المعتمدة: ' || private.egp(v_ded)) ||
    ('صافي المستحق: ' || private.egp(v_net)) || ('مدفوع: ' || private.egp(v_paid)) || ('المتبقي: ' || private.egp(v_rem)) ||
    ''::text || 'صافي المستحق = المرتب + الإضافات المعتمدة − الخصومات المعتمدة. التطبيق يسجّل المدفوعات فقط ولا يحوّل أي مبلغ.'::text ||
    ('رقم التقرير: PR-' || v_key || '-v' || v_ver);
  v_id := private.queue_owner_report('payroll_summary', v_key, v_ver,
    '💰 ملخص الرواتب — ' || private.ar_month(p_month) || ' (نهائي)' ||
      case when v_ver > 1 then ' — تصحيح: النسخة ' || v_ver || ' تحل محل النسخة ' || (v_ver - 1) else '' end || E'\nالعملة: جنيه مصري (ج.م)',
    v_lines, jsonb_build_object('figures', v_fig, 'totals', jsonb_build_object('salary', v_sal, 'add', v_add, 'ded', v_ded, 'net', v_net,
      'paid', v_paid, 'remaining', v_rem), 'month', p_month));
  if v_id is null then
    perform private.record_job('payroll_summary', v_key, 'failed', jsonb_build_object('blocked', 'owner_chat_unverified'));
    return jsonb_build_object('blocked', 'owner_chat_unverified');
  end if;
  perform private.record_job('payroll_summary', v_key, 'succeeded', jsonb_build_object('report_id', v_id, 'version', v_ver));
  perform private.audit(p_actor, 'payroll_summary.queue', 'owner_reports', v_id::text, null, jsonb_build_object('month', p_month, 'version', v_ver),
    null, case when p_actor is null then 'system' else 'user' end);
  return jsonb_build_object('report_id', v_id, 'version', v_ver);
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
