-- =====================================================================
-- Zintra حاضر — Row Level Security
-- ---------------------------------------------------------------------
-- A request is trusted only when ALL of these hold (private.current_uid):
--   * it carries a valid Supabase JWT (auth.uid() not null),
--   * the profile exists and is ACTIVE,
--   * the JWT's session_id still exists in auth.sessions.
-- The last check makes owner revocation, code regeneration and
-- deactivation take effect on the very next request, not only at the
-- next token refresh.
--
-- Staff read only their own rows. The owner reads everything. Writes
-- that need server authority (check-in/out, points, approvals, settings,
-- salaries, codes) have NO insert/update/delete policy here: they go
-- through Edge Functions → service-role SECURITY DEFINER functions.
-- =====================================================================

create or replace function private.current_uid()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  join auth.sessions s on s.user_id = p.id
  where p.id = auth.uid()
    and p.active
    and s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
  limit 1
$$;

create or replace function private.is_owner()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join auth.sessions s on s.user_id = p.id
    where p.id = auth.uid()
      and p.active
      and p.role = 'owner'
      and s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
  )
$$;

revoke all on function private.current_uid() from public, anon;
revoke all on function private.is_owner() from public, anon;
grant execute on function private.current_uid() to authenticated, service_role;
grant execute on function private.is_owner() to authenticated, service_role;

-- ------------------------------------------------------------ profiles
create policy profiles_select_self_or_owner on public.profiles
  for select to authenticated
  using (id = (select private.current_uid()) or (select private.is_owner()));

-- ---------------------------------------------- employee_salaries
-- Owner only. There is deliberately NO staff policy of any kind.
create policy salaries_owner_select on public.employee_salaries
  for select to authenticated
  using ((select private.is_owner()));

-- login_codes, login_attempts, login_lockouts, private.bootstrap_tokens:
-- RLS enabled with NO policies → no browser access at all.

-- ------------------------------------------------ device_sessions
create policy device_sessions_select on public.device_sessions
  for select to authenticated
  using (profile_id = (select private.current_uid()) or (select private.is_owner()));

-- ------------------------------------------------------------ settings
-- Owner only (contains the Telegram chat id). Staff get the safe subset
-- through public.get_app_config().
create policy settings_owner_select on public.settings
  for select to authenticated
  using ((select private.is_owner()));

-- -------------------------------------- calendar/config (all signed-in)
create policy windows_select on public.check_in_windows
  for select to authenticated using ((select private.current_uid()) is not null);
create policy day_rules_select on public.day_rules
  for select to authenticated using ((select private.current_uid()) is not null);
create policy holidays_select on public.public_holidays
  for select to authenticated using ((select private.current_uid()) is not null);

-- ------------------------------------- own-rows-or-owner read tables
create policy attendance_select on public.attendance_days
  for select to authenticated
  using (employee_id = (select private.current_uid()) or (select private.is_owner()));
create policy point_events_select on public.point_events
  for select to authenticated
  using (employee_id = (select private.current_uid()) or (select private.is_owner()));
create policy monthly_deductions_select on public.monthly_deductions
  for select to authenticated
  using (employee_id = (select private.current_uid()) or (select private.is_owner()));
create policy reward_requests_select on public.reward_requests
  for select to authenticated
  using (employee_id = (select private.current_uid()) or (select private.is_owner()));

-- ------------------------------------------------------ leave_requests
create policy leave_select on public.leave_requests
  for select to authenticated
  using (employee_id = (select private.current_uid()) or (select private.is_owner()));
create policy leave_insert_own on public.leave_requests
  for insert to authenticated
  with check (employee_id = (select private.current_uid()));

-- ------------------------------------------------ early_leave_requests
create policy early_leave_select on public.early_leave_requests
  for select to authenticated
  using (employee_id = (select private.current_uid()) or (select private.is_owner()));
create policy early_leave_insert_own on public.early_leave_requests
  for insert to authenticated
  with check (employee_id = (select private.current_uid()));

-- -------------------------------------------------- push_subscriptions
create policy push_select on public.push_subscriptions
  for select to authenticated
  using (employee_id = (select private.current_uid()) or (select private.is_owner()));
create policy push_insert_own on public.push_subscriptions
  for insert to authenticated
  with check (employee_id = (select private.current_uid()));
create policy push_update_own on public.push_subscriptions
  for update to authenticated
  using (employee_id = (select private.current_uid()))
  with check (employee_id = (select private.current_uid()));
create policy push_delete_own on public.push_subscriptions
  for delete to authenticated
  using (employee_id = (select private.current_uid()));

-- ---------------------------------------------------- owner-only reads
create policy payroll_owner_select on public.payroll_reports
  for select to authenticated using ((select private.is_owner()));
create policy outbox_owner_select on public.notification_outbox
  for select to authenticated using ((select private.is_owner()));
create policy audit_owner_select on public.audit_log
  for select to authenticated using ((select private.is_owner()));
create policy job_runs_owner_select on public.job_runs
  for select to authenticated using ((select private.is_owner()));
