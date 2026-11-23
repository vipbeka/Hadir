-- =====================================================================
-- Payroll entitlement, payments, payslip versions, statement, deletion.
-- One transaction, rolled back. Synthetic fixtures only.
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
create function pg_temp.ent(e uuid, k text) returns bigint language sql as $$
  select (private.pay_entitlement(e, '2026-10-01') ->> k)::bigint
$$;

-- fixtures ------------------------------------------------------------
-- O owner · A 10,000 EGP · B 10,000 EGP · C no salary · D salary 0 (intentional)
insert into auth.users (id, email) values
  ('00000000-0000-4000-d000-000000000001', 'o3@staff.invalid'), ('00000000-0000-4000-d000-00000000000a', 'a3@staff.invalid'),
  ('00000000-0000-4000-d000-00000000000b', 'b3@staff.invalid'), ('00000000-0000-4000-d000-00000000000c', 'c3@staff.invalid'),
  ('00000000-0000-4000-d000-00000000000d', 'd3@staff.invalid'), ('00000000-0000-4000-d000-0000000000ee', 'e3@staff.invalid');
insert into auth.sessions (id, user_id) values ('40000000-0000-4000-d000-00000000000a', '00000000-0000-4000-d000-00000000000a'),
  ('40000000-0000-4000-d000-0000000000ee', '00000000-0000-4000-d000-0000000000ee');
insert into public.profiles (id, full_name_ar, full_name_en, role, created_at) values
  ('00000000-0000-4000-d000-000000000001', 'المالك', 'Owner', 'owner', '2026-01-01'),
  ('00000000-0000-4000-d000-00000000000a', 'أمل', 'Amal', 'staff', '2026-01-01'),
  ('00000000-0000-4000-d000-00000000000b', 'بلال', 'Belal', 'staff', '2026-01-01'),
  ('00000000-0000-4000-d000-00000000000c', 'شريف', 'Sherif', 'staff', '2026-01-01'),
  ('00000000-0000-4000-d000-00000000000d', 'دينا', 'Dina', 'staff', '2026-01-01'),
  ('00000000-0000-4000-d000-0000000000ee', 'إيهاب عبد الرحمن', 'Ehab Abdelrahman', 'staff', '2026-01-01');
insert into public.employee_salaries (employee_id, monthly_salary_piastres) values
  ('00000000-0000-4000-d000-00000000000a', 1000000), ('00000000-0000-4000-d000-00000000000b', 1000000),
  ('00000000-0000-4000-d000-00000000000d', 0), ('00000000-0000-4000-d000-0000000000ee', 800000);
update public.settings set jobs_start_date = '2026-10-01', red_penalty_piastres = 5000, black_penalty_piastres = 100000, first_red_warning = true;

-- ---------------------------------------------------------------- 1. the formula
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000a', 'net_piastres') = 1000000, 'base 10,000, no adjustments → net 10,000');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000a', 'net_adjustment_piastres') = 0, 'legacy net adjustment stays 0 (secondary)');
-- B: first red = warning, second red = chargeable 50, reward 100 approved
select private.add_event('00000000-0000-4000-d000-00000000000b', '2026-10-05', 'r1-b', 'red', 1, 'auto_window', 'active', 5000, 5000, null, 'late');
select private.add_event('00000000-0000-4000-d000-00000000000b', '2026-10-06', 'r2-b', 'red', 1, 'auto_window', 'active', 5000, 5000, null, 'late');
select private.recalc_reds('00000000-0000-4000-d000-00000000000b', '2026-10-01');
insert into public.reward_requests (id, employee_id, period_month, reward_amount_piastres, applied_rule_version, payout_method, payout_number, status)
values ('51000000-0000-4000-d000-000000000001', '00000000-0000-4000-d000-00000000000b', '2026-10-01', 10000, 1, 'instapay', '01000000000', 'approved');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'deductions_piastres') = 5000, 'first red is a warning; the second deducts 50');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'warnings_count') = 1, 'warning counted, not charged');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'net_piastres') = 1005000, '10,000 + approved reward 100 − deduction 50 = 10,050');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'remaining_piastres') = 1005000, 'nothing paid → remaining 10,050');
update public.reward_requests set status = 'paid', paid_at = now(), paid_reference = 'IP-1' where id = '51000000-0000-4000-d000-000000000001';
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'net_piastres') = 1005000
  and pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'remaining_piastres') = 995000
  and pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'reward_paid_piastres') = 10000, 'reward paid separately → entitlement 10,050, remaining 9,950');
-- pending / rejected rewards never count
insert into public.reward_requests (employee_id, period_month, reward_amount_piastres, applied_rule_version, payout_method, payout_number, status)
values ('00000000-0000-4000-d000-00000000000a', '2026-10-01', 10000, 1, 'instapay', '01000000000', 'pending');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000a', 'net_piastres') = 1000000
  and pg_temp.ent('00000000-0000-4000-d000-00000000000a', 'pending_rewards_piastres') = 10000, 'pending reward shown but not added');
-- absences: approved deducts, pending/declined do not
select private.add_event('00000000-0000-4000-d000-00000000000a', '2026-10-07', 'abs-a1', 'black', 1, 'auto_absence', 'active', 100000, 100000, null, 'absent');
select private.add_event('00000000-0000-4000-d000-00000000000a', '2026-10-08', 'abs-a2', 'black', 1, 'auto_absence', 'pending_approval', 100000, 0, null, 'absent');
select private.add_event('00000000-0000-4000-d000-00000000000a', '2026-10-11', 'abs-a3', 'black', 1, 'auto_absence', 'declined', 100000, 0, null, 'absent');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000a', 'deductions_piastres') = 100000, 'only the approved absence deducts (1,000)');
select pg_temp.ok((private.pay_entitlement('00000000-0000-4000-d000-00000000000a', '2026-10-01') -> 'flags') ? 'unresolved_items', 'pending absence flagged for review');
-- rule change mid-month: each event keeps its own snapshot rate
select private.add_event('00000000-0000-4000-d000-00000000000b', '2026-10-20', 'r3-b', 'red', 1, 'auto_window', 'active', 7500, 7500, null, 'late');
select private.recalc_reds('00000000-0000-4000-d000-00000000000b', '2026-10-01');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'deductions_piastres') = 12500
  and jsonb_array_length(private.pay_entitlement('00000000-0000-4000-d000-00000000000b', '2026-10-01') -> 'deductions') = 2, 'deductions across a rule change: 50 + 75, itemised by rate');
-- missing salary is not zero; zero salary is intentional; negative net is flagged
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000c', 'net_piastres') is null
  and (private.pay_entitlement('00000000-0000-4000-d000-00000000000c', '2026-10-01') ->> 'status') = 'review', 'missing salary → no net, review');
select pg_temp.ok((private.pay_entitlement('00000000-0000-4000-d000-00000000000d', '2026-10-01') ->> 'status') = 'nothing_due', 'salary 0 (configured) → nothing due');
select private.add_event('00000000-0000-4000-d000-00000000000d', '2026-10-07', 'abs-d1', 'black', 1, 'auto_absence', 'active', 100000, 100000, null, 'absent');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000d', 'net_piastres') = -100000
  and (private.pay_entitlement('00000000-0000-4000-d000-00000000000d', '2026-10-01') -> 'flags') ? 'negative_net', 'negative net kept (not clamped) and flagged');

-- ---------------------------------------------------------------- 2. payments
select pg_temp.expect_err($$select public.svc_salary_payment_record('00000000-0000-4000-d000-00000000000a', '{}')$$, 'forbidden', 'staff cannot record payments');
select pg_temp.expect_err($$select public.svc_salary_payment_record('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000c","month":"2026-10-01","amount_piastres":100,"paid_on":"2026-10-31","idempotency_key":"pay-c-0001"}')$$,
  'salary_missing', 'no payment against a missing salary');
select public.svc_salary_payment_record('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000b","month":"2026-10-01","amount_piastres":500000,"paid_on":"2026-10-31","method":"cash","idempotency_key":"pay-b-0001"}');
select pg_temp.ok((public.svc_salary_payment_record('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000b","month":"2026-10-01","amount_piastres":500000,"paid_on":"2026-10-31","method":"cash","idempotency_key":"pay-b-0001"}') ->> 'duplicate')::boolean,
  'double tap / retry → same payment, not twice');
select pg_temp.ok((select count(*) from public.salary_payments where employee_id = '00000000-0000-4000-d000-00000000000b') = 1, 'one payment row');
select pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'remaining_piastres') = 1000000 - 12500 + 10000 - 10000 - 500000
  and (private.pay_entitlement('00000000-0000-4000-d000-00000000000b', '2026-10-01') ->> 'status') = 'partial', 'partial payment → remaining and status');
select pg_temp.expect_err($$select public.svc_salary_payment_record('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000b","month":"2026-10-01","amount_piastres":900000,"paid_on":"2026-10-31","idempotency_key":"pay-b-0002"}')$$,
  'overpayment', 'more than remaining is refused unless confirmed');
select pg_temp.expect_err($$select public.svc_salary_payment_record('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000b","month":"2026-10-01","amount_piastres":1.5,"paid_on":"2026-10-31","idempotency_key":"pay-b-0003"}')$$,
  'invalid_amount', 'fractional piastres refused');
select pg_temp.expect_err($$select public.svc_salary_payment_record('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000b","month":"2026-10-01","amount_piastres":100,"paid_on":"2099-01-01","idempotency_key":"pay-b-0004"}')$$,
  'invalid_time', 'future payment date refused');
do $$ declare v jsonb; begin
  v := public.svc_salary_payment_reverse('00000000-0000-4000-d000-000000000001', jsonb_build_object('payment_id',
    (select id from public.salary_payments where idempotency_key = 'pay-b-0001'), 'reason', 'recorded twice by mistake', 'idempotency_key', 'rev-b-0001'));
  perform pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'salary_paid_piastres') = 0, 'reversal cancels the payment (history kept)');
  perform pg_temp.ok((select count(*) from public.salary_payments where employee_id = '00000000-0000-4000-d000-00000000000b') = 2, 'payment + reversal both kept');
  perform pg_temp.expect_err(format($q$select public.svc_salary_payment_reverse('00000000-0000-4000-d000-000000000001', '{"payment_id":"%s","reason":"again","idempotency_key":"rev-b-0002"}')$q$,
    (select id from public.salary_payments where idempotency_key = 'pay-b-0001')), 'already_reversed', 'a payment is reversed once');
end $$;
do $$ begin update public.salary_payments set amount_piastres = 1 where idempotency_key = 'pay-b-0001'; raise exception 'ASSERTION FAILED: payment edited';
exception when others then if sqlerrm like 'ASSERTION%' then raise; end if; raise notice 'ok: payments are append-only (no edit)'; end $$;
-- full payment → paid
select public.svc_salary_payment_record('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-d000-00000000000a', 'month', '2026-10-01',
  'amount_piastres', pg_temp.ent('00000000-0000-4000-d000-00000000000a', 'remaining_piastres'), 'paid_on', '2026-10-31', 'idempotency_key', 'pay-a-full-1'));
select pg_temp.ok((private.pay_entitlement('00000000-0000-4000-d000-00000000000a', '2026-10-01') ->> 'status') = 'paid', 'paid in full → paid');
select public.svc_salary_payment_record('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000a","month":"2026-10-01","amount_piastres":100,"paid_on":"2026-10-31","idempotency_key":"pay-a-over-1","allow_overpay":true}');
select pg_temp.ok((private.pay_entitlement('00000000-0000-4000-d000-00000000000a', '2026-10-01') ->> 'status') = 'overpaid', 'confirmed overpayment → overpaid (review)');

-- ---------------------------------------------------------------- 3. payslip versions
select pg_temp.expect_err($$select public.svc_payslip_finalize('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","month":"2099-01-01"}')$$, 'month_not_closed', 'open month cannot be finalised');
select pg_temp.expect_err($$select public.svc_payslip_finalize('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000c","month":"2026-10-01"}')$$, 'salary_missing', 'missing salary blocks finalising');
select public.svc_payslip_finalize('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","month":"2026-10-01"}');
select public.svc_payslip_finalize('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","month":"2026-10-01"}');
select pg_temp.ok((select count(*) from public.payslip_snapshots where employee_id = '00000000-0000-4000-d000-0000000000ee') = 1, 'repeated finalise/print → same version');
select pg_temp.ok((select slip_no from public.payslip_snapshots where employee_id = '00000000-0000-4000-d000-0000000000ee') = 'PS-202610-EMP-000000EE-V1', 'stable slip number');
update public.employee_salaries set monthly_salary_piastres = 900000 where employee_id = '00000000-0000-4000-d000-0000000000ee';
update public.settings set red_penalty_piastres = 9900;
select pg_temp.ok((public.svc_payslip('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","month":"2026-10-01","version":1}')
  -> 'data' -> 'entitlement' ->> 'base_piastres')::bigint = 800000, 'reprint v1 after salary/settings change → original figures');
select pg_temp.ok((public.svc_payslip('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","month":"2026-10-01"}')
  -> 'versions' -> 0 ->> 'changed')::boolean, 'draft shows that figures changed since v1');
do $$ begin update public.payslip_snapshots set data = '{}' where employee_id = '00000000-0000-4000-d000-0000000000ee'; raise exception 'ASSERTION FAILED: snapshot edited';
exception when others then if sqlerrm like 'ASSERTION%' then raise; end if; raise notice 'ok: issued payslips are immutable'; end $$;
select public.svc_payslip_finalize('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","month":"2026-10-01"}');
select pg_temp.ok((select max(version) from public.payslip_snapshots where employee_id = '00000000-0000-4000-d000-0000000000ee') = 2, 'changed figures → new version v2');
select pg_temp.ok((select count(*) from public.payslip_snapshots where employee_id = '00000000-0000-4000-d000-00000000000b') >= 2, 'payments create paid versions');
update public.settings set red_penalty_piastres = 5000;

-- ---------------------------------------------------------------- 4. payroll page = same calculation
do $$ declare r jsonb := public.svc_payroll_v2('00000000-0000-4000-d000-000000000001', '{"month":"2026-10-01"}'); b jsonb; begin
  select x into b from jsonb_array_elements(r -> 'rows') x where x ->> 'employee_id' = '00000000-0000-4000-d000-00000000000b';
  perform pg_temp.ok((b -> 'entitlement' ->> 'net_piastres')::bigint = pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'net_piastres'), 'payroll page row = entitlement');
  perform pg_temp.ok((r -> 'totals_v2' ->> 'salary_missing')::int >= 1, 'totals count missing salaries');
  perform pg_temp.ok((r -> 'totals_v2' ->> 'net_piastres')::bigint = (select sum((x -> 'entitlement' ->> 'net_piastres')::bigint) from jsonb_array_elements(r -> 'rows') x), 'totals = sum of rows');
end $$;
select pg_temp.expect_err($$select public.svc_payroll_v2('00000000-0000-4000-d000-00000000000a', '{}')$$, 'forbidden', 'staff cannot open payroll');

-- ---------------------------------------------------------------- 5. statement
insert into public.attendance_days (employee_id, work_date, checked_in_at, checked_out_at, worked_minutes, check_in_outcome)
values ('00000000-0000-4000-d000-00000000000b', '2026-10-05', '2026-10-05 07:30+00', '2026-10-05 15:00+00', 450, 'red'),
       ('00000000-0000-4000-d000-00000000000b', '2026-10-12', '2026-10-12 06:00+00', null, null, 'green'),
       ('00000000-0000-4000-d000-00000000000b', '2026-10-13', '2026-10-13 20:00+00', '2026-10-14 03:00+00', 420, 'none');
insert into public.leave_requests (employee_id, from_date, to_date, type, status, reason) values
  ('00000000-0000-4000-d000-00000000000b', '2026-10-28', '2026-11-03', 'personal', 'approved', 'travel'),
  ('00000000-0000-4000-d000-00000000000b', '2026-10-29', '2026-10-29', 'sick', 'cancelled', 'x'),
  ('00000000-0000-4000-d000-00000000000b', '2099-01-04', '2099-01-05', 'personal', 'approved', 'future');
do $$ declare st jsonb := public.svc_employee_statement('00000000-0000-4000-d000-000000000001',
    '{"employee_id":"00000000-0000-4000-d000-00000000000b","from":"2026-10-01","to":"2026-10-31"}'); dd jsonb;
begin
  perform pg_temp.ok(jsonb_array_length(st -> 'days') = 31, 'every date in the range (31)');
  select x into dd from jsonb_array_elements(st -> 'days') x where x ->> 'date' = '2026-10-05';
  perform pg_temp.ok(dd ->> 'status' = 'late' and dd ->> 'check_in' = '10:30' and (dd ->> 'worked_minutes')::int = 450, 'late day, Cairo check-in time 10:30');
  select x into dd from jsonb_array_elements(st -> 'days') x where x ->> 'date' = '2026-10-12';
  perform pg_temp.ok((dd ->> 'missing_checkout')::boolean and dd ->> 'check_out' is null, 'missing checkout stays missing (no invented time)');
  select x into dd from jsonb_array_elements(st -> 'days') x where x ->> 'date' = '2026-10-13';
  perform pg_temp.ok(dd ->> 'check_out_date' = '2026-10-14', 'overnight shift: checkout on the next Cairo day');
  select x into dd from jsonb_array_elements(st -> 'days') x where x ->> 'date' = '2026-10-09';
  perform pg_temp.ok(dd ->> 'status' = 'weekend', 'Friday = weekend');
  select x into dd from jsonb_array_elements(st -> 'days') x where x ->> 'date' = '2026-10-06';
  perform pg_temp.ok(dd ->> 'status' = 'holiday', 'Armed Forces Day = holiday');
  select x into dd from jsonb_array_elements(st -> 'days') x where x ->> 'date' = '2026-10-29';
  perform pg_temp.ok(dd ->> 'status' = 'leave', 'approved leave (cancelled overlap ignored)');
  select x into dd from jsonb_array_elements(st -> 'days') x where x ->> 'date' = '2026-10-07';
  perform pg_temp.ok(dd ->> 'status' = 'no_record', 'no record ≠ absence');
  perform pg_temp.ok((st -> 'totals' ->> 'deductions_piastres')::bigint = 12500, 'statement money = payroll deductions');
  perform pg_temp.ok((select (x ->> 'taken_days')::int from jsonb_array_elements(st -> 'leave_summary') x where x ->> 'status' = 'approved' and x ->> 'type' = 'personal') = 4,
    'cross-month leave counted only inside the range (28–31 Oct = 4)');
  perform pg_temp.ok(st ->> 'leave_allowance' = 'not_configured', 'no leave balance invented');
end $$;
do $$ declare st jsonb := public.svc_employee_statement('00000000-0000-4000-d000-000000000001',
    '{"employee_id":"00000000-0000-4000-d000-00000000000b","from":"2099-01-01","to":"2099-01-10"}'); begin
  perform pg_temp.ok((select bool_and(x ->> 'status' in ('future', 'weekend', 'planned_leave', 'holiday')) from jsonb_array_elements(st -> 'days') x), 'future dates are never absences');
  perform pg_temp.ok((select (x ->> 'planned_days')::int from jsonb_array_elements(st -> 'leave_summary') x where x ->> 'status' = 'approved') = 2, 'planned future leave separate');
end $$;
select pg_temp.expect_err($$select public.svc_employee_statement('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-00000000000b","from":"2026-01-01","to":"2027-12-31"}')$$, 'invalid_range', 'range limited to 400 days');
select pg_temp.expect_err($$select public.svc_employee_statement('00000000-0000-4000-d000-00000000000a', '{"employee_id":"00000000-0000-4000-d000-00000000000b","from":"2026-10-01","to":"2026-10-31"}')$$, 'forbidden', 'staff cannot read statements');

-- ---------------------------------------------------------------- 6. staff database access
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-d000-00000000000a","session_id":"40000000-0000-4000-d000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
do $$ begin perform * from public.salary_payments; raise exception 'ASSERTION FAILED: staff read payments';
exception when insufficient_privilege then raise notice 'ok: staff cannot read salary payments'; end $$;
do $$ begin perform * from public.payslip_snapshots; raise exception 'ASSERTION FAILED: staff read payslips';
exception when insufficient_privilege then raise notice 'ok: staff cannot read payslip snapshots'; end $$;
do $$ begin perform * from public.employee_deletions; raise exception 'ASSERTION FAILED: staff read deletions';
exception when insufficient_privilege then raise notice 'ok: staff cannot read the deletion log'; end $$;
do $$ begin perform public.svc_employee_delete_preview('00000000-0000-4000-d000-000000000001'::uuid, '{}'); raise exception 'ASSERTION FAILED: staff executed a service function';
exception when insufficient_privilege then raise notice 'ok: service functions are not callable by users'; end $$;
reset role;

-- ---------------------------------------------------------------- 7. permanent deletion
select pg_temp.expect_err($$select public.svc_employee_delete_preview('00000000-0000-4000-d000-00000000000a', '{"employee_id":"00000000-0000-4000-d000-0000000000ee"}')$$, 'forbidden', 'staff cannot preview deletion');
select pg_temp.expect_err($$select public.svc_employee_delete_preview('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-000000000001"}')$$, 'cannot_delete_owner', 'an owner cannot be deleted');
-- synthetic full history for Ehab
insert into public.attendance_days (employee_id, work_date, checked_in_at, checked_out_at, worked_minutes, corrected, corrected_by, correction_reason)
values ('00000000-0000-4000-d000-0000000000ee', '2026-10-05', '2026-10-05 06:00+00', '2026-10-05 14:00+00', 480, true, '00000000-0000-4000-d000-000000000001', 'fixed');
select private.add_event('00000000-0000-4000-d000-0000000000ee', '2026-10-05', 'g-ee', 'green', 1, 'auto_window', 'active', 0, 0, null, 'on time');
select private.add_event('00000000-0000-4000-d000-0000000000ee', '2026-10-07', 'abs-ee', 'black', 1, 'auto_absence', 'active', 100000, 100000, null, 'absent');
insert into public.leave_requests (employee_id, from_date, to_date, type, status, reason) values
  ('00000000-0000-4000-d000-0000000000ee', '2026-10-20', '2026-10-21', 'sick', 'approved', 'flu'),
  ('00000000-0000-4000-d000-0000000000ee', '2026-10-25', '2026-10-25', 'personal', 'rejected', 'x');
insert into public.early_leave_requests (employee_id, work_date, requested_leave_time, status) values ('00000000-0000-4000-d000-0000000000ee', '2026-10-05', '13:00', 'pending');
insert into public.reward_requests (employee_id, period_month, reward_amount_piastres, applied_rule_version, payout_method, payout_number, status, paid_at, paid_reference)
values ('00000000-0000-4000-d000-0000000000ee', '2026-10-01', 10000, 1, 'instapay', '01000000000', 'paid', now(), 'IP-9');
insert into public.login_codes (profile_id, code_hash) values ('00000000-0000-4000-d000-0000000000ee', '$2b$10$' || repeat('a', 53));
insert into public.device_sessions (session_id, profile_id) values ('40000000-0000-4000-d000-0000000000ee', '00000000-0000-4000-d000-0000000000ee');
select public.svc_payroll(null, '{"month":"2026-10-01"}');
select public.svc_salary_payment_record('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","month":"2026-10-01","amount_piastres":300000,"paid_on":"2026-10-31","idempotency_key":"pay-ee-0001"}');
insert into public.job_runs (job_name, run_key, status, detail) values ('digest', 'test-ee', 'succeeded',
  jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line', 'إيهاب عبد الرحمن: حاضر 09:00'), jsonb_build_object('line', 'بلال: حاضر 09:10'))));
insert into public.notification_outbox (dedupe_key, event_type, channel, recipient, payload) values
  ('black:test-ee', 'black_pending', 'telegram', '1', jsonb_build_object('kind', 'black_pending', 'employee', private.name_of('00000000-0000-4000-d000-0000000000ee')));

do $$ declare pv jsonb; v_b_net bigint := pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'net_piastres'); v_b_rows int; begin
  pv := public.svc_employee_delete_preview('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee"}');
  perform pg_temp.ok((pv -> 'counts' ->> 'attendance_days')::int = 1 and (pv -> 'counts' ->> 'point_events')::int = 2 and (pv -> 'counts' ->> 'leave_requests')::int = 2
    and (pv -> 'counts' ->> 'salary_payments')::int = 1 and (pv -> 'counts' ->> 'payslip_snapshots')::int >= 3 and (pv -> 'counts' ->> 'job_report_lines')::int = 1
    and (pv -> 'counts' ->> 'notifications')::int >= 1 and (pv -> 'counts' ->> 'files')::int = 0, 'preview counts every record type (zeros too)');
  perform pg_temp.expect_err(format($q$select public.svc_employee_delete('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","confirm_name":"Ehab","preview_token":"%s"}')$q$, pv ->> 'preview_token'),
    'confirm_name_mismatch', 'typed name must match exactly');
  perform pg_temp.expect_err(format($q$select public.svc_employee_delete('00000000-0000-4000-d000-00000000000a', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","confirm_name":"Ehab Abdelrahman","preview_token":"%s"}')$q$, pv ->> 'preview_token'),
    'forbidden', 'staff cannot delete');
  -- data changes after the preview → refused, new counts returned
  perform private.add_event('00000000-0000-4000-d000-0000000000ee', '2026-10-08', 'late-ee', 'red', 1, 'auto_window', 'active', 5000, 5000, null, 'late');
  perform pg_temp.expect_err(format($q$select public.svc_employee_delete('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","confirm_name":"Ehab Abdelrahman","preview_token":"%s"}')$q$, pv ->> 'preview_token'),
    'preview_changed', 'records changed since preview → re-confirm');
  pv := public.svc_employee_delete_preview('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee"}');
  select count(*) into v_b_rows from public.point_events where employee_id = '00000000-0000-4000-d000-00000000000b';
  perform public.svc_employee_delete('00000000-0000-4000-d000-000000000001', jsonb_build_object('employee_id', '00000000-0000-4000-d000-0000000000ee',
    'confirm_name', 'إيهاب عبد الرحمن', 'preview_token', pv ->> 'preview_token'));
  perform pg_temp.ok(not exists (select 1 from public.profiles where id = '00000000-0000-4000-d000-0000000000ee'), 'profile gone');
  perform pg_temp.ok((select (x ->> 'attendance_days')::int + (x ->> 'point_events')::int + (x ->> 'leave_requests')::int + (x ->> 'early_leave_requests')::int
      + (x ->> 'reward_requests')::int + (x ->> 'payroll_reports')::int + (x ->> 'monthly_deductions')::int + (x ->> 'payslip_snapshots')::int
      + (x ->> 'salary_payments')::int + (x ->> 'salary_record')::int + (x ->> 'login_codes')::int + (x ->> 'device_sessions')::int
      + (x ->> 'notifications')::int + (x ->> 'job_report_lines')::int + (x ->> 'telegram_pending')::int
      from (select private.employee_footprint('00000000-0000-4000-d000-0000000000ee') x) y) = 0, 'zero employee-specific rows left');
  perform pg_temp.ok(not exists (select 1 from auth.sessions where user_id = '00000000-0000-4000-d000-0000000000ee'), 'sign-in sessions revoked (refresh impossible)');
  perform pg_temp.ok(coalesce((select (detail -> 'lines')::text from public.job_runs where run_key = 'test-ee'), 'NULL') = jsonb_build_array(jsonb_build_object('line', 'بلال: حاضر 09:10'))::text, (select detail::text from public.job_runs where run_key = 'test-ee') ||
    'shared digest: only their line removed, others kept');
  perform pg_temp.ok((select count(*) from public.audit_log where target_id = '00000000-0000-4000-d000-0000000000ee') = 1
    and (select before is null and after is null and reason is null and action = 'employee.delete' from public.audit_log where target_id = '00000000-0000-4000-d000-0000000000ee'),
    'one minimal audit entry (no personal data)');
  perform pg_temp.ok(not exists (select 1 from public.audit_log where coalesce(before::text, '') || coalesce(after::text, '') like '%إيهاب%'), 'no copy of their name in the audit log');
  perform pg_temp.ok((select status from public.employee_deletions where deleted_employee_id = '00000000-0000-4000-d000-0000000000ee') = 'db_done', 'deletion recorded; sign-in account removal pending');
  perform pg_temp.ok(pg_temp.ent('00000000-0000-4000-d000-00000000000b', 'net_piastres') = v_b_net
    and (select count(*) from public.point_events where employee_id = '00000000-0000-4000-d000-00000000000b') = v_b_rows, 'other employees unaffected');
  perform pg_temp.ok((select red_penalty_piastres from public.settings where id) = 5000 and exists (select 1 from public.public_holidays), 'shared settings and holidays intact');
  perform pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.svc_payroll_v2('00000000-0000-4000-d000-000000000001', '{"month":"2026-10-01"}') -> 'rows') x
    where x ->> 'employee_id' = '00000000-0000-4000-d000-0000000000ee'), 'historical payroll no longer shows them');
  perform pg_temp.expect_err($q$select public.svc_payslip('00000000-0000-4000-d000-000000000001', '{"employee_id":"00000000-0000-4000-d000-0000000000ee","month":"2026-10-01","version":1}')$q$, 'not_found', 'old payslips no longer open');
end $$;
-- the purge switch is transaction-local: outside a deletion, history is still append-only
do $$ begin perform set_config('hadir.allow_purge', 'off', true); delete from public.salary_payments where idempotency_key = 'pay-b-0001'; raise exception 'ASSERTION FAILED: payment deleted';
exception when others then if sqlerrm like 'ASSERTION%' then raise; end if; raise notice 'ok: payments cannot be deleted outside a confirmed employee deletion'; end $$;

select 'PAYROLL TESTS PASSED' as result;
