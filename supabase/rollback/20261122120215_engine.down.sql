-- Rollback of the engine migration (Steps 3–10).
-- Note: the enum value point_source 'absence_cancel' cannot be removed by
-- Postgres; it stays harmlessly (core rollback drops the whole type).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname = 'public' and p.proname in ('svc_check_in','svc_check_out','svc_my_day','svc_correct_attendance',
             'svc_update_settings','svc_save_day','svc_save_holiday','svc_decide_black','svc_award_outcome','svc_manual_adjust',
             'svc_request_reward','svc_decide_reward','svc_request_leave','svc_cancel_leave','svc_decide_leave','svc_comment_leave',
             'svc_request_early_leave','svc_cancel_early_leave','svc_decide_early_leave','svc_my_summary','svc_owner_dashboard',
             'svc_pending','svc_employee_points','svc_payroll','svc_export_raw','get_leaderboard','svc_run_job','svc_claim_outbox',
             'svc_outbox_result','svc_telegram_context','svc_set_reminders','svc_set_job_title'))
              or (n.nspname = 'private' and p.proname in ('err','tz','local_now','period_of','distance_m','day_info','evaluate_time',
             'is_reversed','recalc_reds','lang_of','name_of','enqueue_push','add_event','clear_absence','validate_coords',
             'check_geofence','period_total','job_done','record_job','run_absence','run_digest','run_weekly','enqueue_reminders','tick'))
  loop execute format('drop function %s', f.sig); end loop;
end $$;
alter table public.notification_outbox drop column if exists subscription_id, drop column if exists employee_id;
alter table public.settings drop column if exists jobs_start_date;
alter table public.point_events alter column created_at set default now();
alter table public.point_events drop column if exists request_key, drop column if exists rate_snapshot_piastres;
alter table public.profiles drop column if exists job_title_en, drop column if exists job_title_ar;
-- restore the Step-2 version of svc_list_employees (without job titles)
create or replace function public.svc_list_employees()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.role, x.full_name_en), '[]'::jsonb) from (
    select p.id, p.full_name_ar, p.full_name_en, p.phone, p.role, p.active, p.created_at, p.deactivated_at,
           (select c.created_at from public.login_codes c where c.profile_id = p.id and c.revoked_at is null) as code_created_at,
           (select c.last_used_at from public.login_codes c where c.profile_id = p.id and c.revoked_at is null) as code_last_used_at,
           sal.monthly_salary_piastres,
           (select count(*) from auth.sessions s where s.user_id = p.id) as session_count
    from public.profiles p left join public.employee_salaries sal on sal.employee_id = p.id) x
$$;
revoke all on function public.svc_list_employees() from public, anon, authenticated;
grant execute on function public.svc_list_employees() to service_role;
