-- Rollback of 20261124090000_owner_bot_reports (tick/claim revert with the earlier down files in the local harness)
drop trigger if exists absence_streak_points on public.point_events;
drop trigger if exists absence_streak_attendance on public.attendance_days;
drop trigger if exists absence_streak_leave on public.leave_requests;
drop function if exists private.trg_absence_streak(), private.check_absence_streaks(uuid, date), private.absence_streak(uuid, date),
  private.emp_day_status(uuid, date), private.run_sunday_summary(date), private.run_payroll_summary(date, uuid),
  private.payroll_month_open_items(date), private.process_scheduled_announcements(), private.queue_owner_report(text, text, int, text, text[], jsonb),
  private.split_report(text, text[], int), private.ar_month(date), private.dmy(date), private.egp(bigint), private.owner_private_chat(),
  private.cairo_local_to_utc(timestamp);
drop function if exists public.svc_owner_report_part(uuid), public.svc_owner_chat_verified(text, text), public.svc_owner_chat_needs_check(),
  public.svc_outbox_result_v2(uuid, boolean, text, text, boolean, int, boolean), public.svc_payroll_summary_resend(uuid, jsonb),
  public.svc_sched_ann_save(uuid, jsonb), public.svc_sched_ann_cancel(uuid, jsonb), public.svc_sched_ann_list(uuid, jsonb),
  public.svc_save_report_settings(uuid, jsonb), public.svc_bot_reports_status(uuid, jsonb);
drop table if exists public.absence_streak_alerts, public.scheduled_announcements, private.owner_reports;
alter table if exists public.settings drop constraint if exists settings_streak_leave_policy,
  drop column if exists sunday_summary_enabled, drop column if exists payroll_summary_enabled, drop column if exists payroll_summary_time,
  drop column if exists absence_streak_enabled, drop column if exists absence_streak_enabled_at, drop column if exists absence_streak_leave_policy,
  drop column if exists owner_chat_verified_id, drop column if exists owner_chat_verified_at, drop column if exists owner_chat_check;
