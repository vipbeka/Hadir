-- Rollback of 20261125090000 + 20261125090100 (run_payroll_summary reverts with the earlier file)
drop function if exists public.svc_employee_delete(uuid, jsonb);
drop function if exists public.svc_employee_deletion_result(uuid, boolean, text), public.svc_employee_deletions(uuid, jsonb),
  public.svc_employee_delete_preview(uuid, jsonb), private.employee_footprint(uuid), public.svc_employee_statement(uuid, jsonb),
  public.svc_salary_payment_reverse(uuid, jsonb), public.svc_salary_payment_record(uuid, jsonb), public.svc_payslip_finalize(uuid, jsonb),
  private.issue_payslip(uuid, uuid, date, text), public.svc_payslip(uuid, jsonb), public.svc_payroll_v2(uuid, jsonb),
  private.payslip_data(uuid, date), private.month_attendance(uuid, date), private.entitlement_core(jsonb), private.pay_entitlement(uuid, date), private.emp_code(uuid);
drop table if exists public.employee_deletions, public.payslip_snapshots, public.salary_payments;
drop function if exists private.trg_append_only();
