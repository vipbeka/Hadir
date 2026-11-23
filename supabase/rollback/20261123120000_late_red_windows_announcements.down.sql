-- Rollback of 20261123120000_late_red_windows_announcements
-- Restores the previous evaluate_time / svc_broadcast / svc_save_holiday /
-- svc_bot_settings definitions by re-running their earlier migrations' bodies
-- is not needed for the local test harness: the earlier down files drop them.
drop function if exists public.svc_save_days(uuid, jsonb);
drop function if exists public.svc_list_announcements(uuid, jsonb);
drop function if exists public.svc_delete_announcement(uuid, jsonb);
drop function if exists private.is_active_owner(uuid);
alter table if exists public.announcements drop column if exists title;
alter table if exists public.public_holidays drop column if exists provisional, drop column if exists source_note;
alter table if exists public.settings drop constraint if exists settings_weekly_summary_dow_required;
alter table if exists public.settings alter column weekly_summary_dow drop default;
alter table if exists public.check_in_windows drop constraint if exists check_in_windows_one_point_kind;
alter table if exists public.check_in_windows drop column if exists awards_red_point;
