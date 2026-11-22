-- Rollback of 20261122085210_core_schema. DESTROYS ALL APP DATA.
drop view if exists public.v_point_totals;
drop table if exists private.bootstrap_tokens, public.job_runs, public.audit_log, public.push_subscriptions,
  public.notification_outbox, public.payroll_reports, public.monthly_deductions, public.reward_requests,
  public.public_holidays, public.early_leave_requests, public.leave_requests cascade;
alter table if exists public.attendance_days drop constraint if exists attendance_point_event_fk;
drop table if exists public.point_events, public.attendance_days, public.day_rules, public.check_in_windows,
  public.settings, public.device_sessions, public.login_lockouts, public.login_attempts, public.login_codes,
  public.employee_salaries, public.profiles cascade;
drop function if exists private.touch_updated_at();
drop type if exists public.decision_channel, public.delivery_status, public.notify_channel, public.holiday_kind,
  public.reward_status, public.request_status, public.leave_type, public.point_status, public.point_source,
  public.point_color, public.app_role;
drop schema if exists private cascade;
