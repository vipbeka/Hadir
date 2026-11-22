-- =====================================================================
-- Zintra حاضر — server-only functions for login, sessions and employee
-- management, plus the two public read helpers.
-- ---------------------------------------------------------------------
-- `svc_*` functions live in `public` so the Edge Functions can call them
-- through the Data API with the service-role key, but EXECUTE is revoked
-- from PUBLIC/anon/authenticated: a browser session cannot call them.
-- Every svc_* that changes data takes p_actor and writes audit_log.
-- No function here ever receives or stores a plaintext login code.
-- =====================================================================

-- ------------------------------------------------------------ helpers
create or replace function private.settings()
returns public.settings
language sql stable security definer set search_path = ''
as $$ select * from public.settings where id $$;

create or replace function private.audit(
  p_actor uuid, p_action text, p_table text, p_target text,
  p_before jsonb, p_after jsonb, p_reason text default null, p_kind text default 'user')
returns void
language sql security definer set search_path = ''
as $$
  insert into public.audit_log (actor_id, actor_kind, action, target_table, target_id, before, after, reason)
  values (p_actor, p_kind, p_action, p_table, p_target, p_before, p_after, p_reason)
$$;

-- Queue an owner Telegram alert (sent by the outbox dispatcher, Step 5).
-- Respects the owner alert channel and the enabled event types. The
-- payload must be a SAFE summary: never codes, never salary.
create or replace function private.enqueue_owner_alert(p_event text, p_dedupe text, p_payload jsonb, p_ref text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare s public.settings := private.settings();
begin
  if s.owner_alert_channel <> 'telegram' or not (p_event = any (s.notify_events)) then
    return;
  end if;
  insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload)
  values (p_dedupe || ':telegram:' || s.owner_telegram_chat_id, p_event, p_ref, 'telegram', s.owner_telegram_chat_id, p_payload)
  on conflict (dedupe_key) do nothing;
end $$;

-- Business "today" in the configured timezone (server clock only).
create or replace function private.business_today()
returns date
language sql stable security definer set search_path = ''
as $$ select (now() at time zone (select business_timezone from public.settings where id))::date $$;

-- ======================================================= public reads
-- Server time for display. The browser never trusts its own clock.
create or replace function public.get_server_time()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'now', now(),
    'timezone', s.business_timezone,
    'business_date', (now() at time zone s.business_timezone)::date,
    'business_time', to_char(now() at time zone s.business_timezone, 'HH24:MI:SS'))
  from public.settings s where s.id
$$;

-- Safe settings subset for any signed-in, active session. Excludes the
-- Telegram chat id and the login-security thresholds.
create or replace function public.get_app_config()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare s public.settings;
begin
  if private.current_uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into s from public.settings where id;
  return jsonb_build_object(
    'business_timezone', s.business_timezone,
    'default_language', s.default_language,
    'geofence', jsonb_build_object('lat', s.geofence_lat, 'lng', s.geofence_lng, 'radius_m', s.geofence_radius_m),
    'work_start_time', s.work_start_time, 'work_end_time', s.work_end_time,
    'red_penalty_piastres', s.red_penalty_piastres, 'black_penalty_piastres', s.black_penalty_piastres,
    'first_red_warning', s.first_red_warning,
    'green_reward_threshold', s.green_reward_threshold, 'reward_amount_piastres', s.reward_amount_piastres,
    'payout_methods', s.payout_methods, 'leaderboard_visible', s.leaderboard_visible,
    'shift_reminders_default', s.shift_reminders_default,
    'rule_version', s.rule_version);
end $$;

revoke all on function public.get_server_time() from public;
grant execute on function public.get_server_time() to anon, authenticated, service_role;
revoke all on function public.get_app_config() from public, anon;
grant execute on function public.get_app_config() to authenticated, service_role;

-- ====================================================== caller checks
-- Used by Edge Functions after auth.getUser(): confirms the profile is
-- active, the JWT session still exists, and returns the role.
create or replace function public.svc_caller(p_user uuid, p_session uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('id', p.id, 'role', p.role, 'active', p.active,
                              'full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en)
    from public.profiles p
    where p.id = p_user and p.active
      and exists (select 1 from auth.sessions s where s.id = p_session and s.user_id = p.id)
  ), jsonb_build_object('active', false))
$$;

-- ============================================================ login
-- Pre-check: is this client (ip or device) or the whole system locked?
create or replace function public.svc_login_precheck(p_ip_hash text, p_device_hash text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  select max(locked_until) into v_until
  from public.login_lockouts
  where key_hash in (p_ip_hash, p_device_hash, 'global') and locked_until > now();
  if v_until is not null then
    return jsonb_build_object('allowed', false, 'retry_after_s', ceil(extract(epoch from v_until - now()))::int);
  end if;
  return jsonb_build_object('allowed', true);
end $$;

-- All current codes to compare against (hashes only). Inactive profiles
-- are included so timing does not depend on who is active.
create or replace function public.svc_login_candidates()
returns table (profile_id uuid, code_hash text, active boolean)
language sql stable security definer set search_path = ''
as $$
  select c.profile_id, c.code_hash, p.active
  from public.login_codes c join public.profiles p on p.id = c.profile_id
  where c.revoked_at is null
$$;

-- Record an attempt; on failure, evaluate client lockout (escalating) and
-- the global throttle. Queues a Telegram security alert on lockout.
create or replace function public.svc_login_record(
  p_ip_hash text, p_device_hash text, p_success boolean, p_profile uuid, p_refused_locked boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.settings := private.settings();
  v_fail_ip int; v_fail_dev int; v_fail_global int;
  v_level int; v_minutes int; v_key text; v_locked boolean := false;
begin
  insert into public.login_attempts (client_ip_hash, device_id_hash, success, refused_locked, matched_profile_id)
  values (p_ip_hash, p_device_hash, p_success, p_refused_locked, case when p_success then p_profile end);

  if p_success or p_refused_locked then
    return jsonb_build_object('locked', false);
  end if;

  -- failures since the last success / lockout window, per key
  select count(*) into v_fail_ip from public.login_attempts a
   where a.client_ip_hash = p_ip_hash and not a.success and not a.refused_locked
     and a.attempted_at > now() - make_interval(mins => s.lockout_window_min)
     and a.attempted_at > coalesce((select max(l.created_at) from public.login_lockouts l where l.key_hash = p_ip_hash), '-infinity');
  select count(*) into v_fail_dev from public.login_attempts a
   where a.device_id_hash = p_device_hash and not a.success and not a.refused_locked
     and a.attempted_at > now() - make_interval(mins => s.lockout_window_min)
     and a.attempted_at > coalesce((select max(l.created_at) from public.login_lockouts l where l.key_hash = p_device_hash), '-infinity');

  if greatest(v_fail_ip, v_fail_dev) >= s.lockout_max_failures then
    v_key := case when v_fail_ip >= v_fail_dev then p_ip_hash else p_device_hash end;
    -- escalation: count this key's lockouts in the last 24h
    select count(*) + 1 into v_level from public.login_lockouts
     where key_hash in (p_ip_hash, p_device_hash) and created_at > now() - interval '24 hours';
    v_minutes := s.lockout_durations_min[least(v_level, cardinality(s.lockout_durations_min))];
    insert into public.login_lockouts (scope, key_hash, level, locked_until)
    values ('client', p_ip_hash, v_level, now() + make_interval(mins => v_minutes));
    if p_device_hash <> p_ip_hash then
      insert into public.login_lockouts (scope, key_hash, level, locked_until)
      values ('client', p_device_hash, v_level, now() + make_interval(mins => v_minutes));
    end if;
    v_locked := true;
    perform private.enqueue_owner_alert('security',
      'lockout:' || left(v_key, 16) || ':' || to_char(now(), 'YYYYMMDDHH24MI'),
      jsonb_build_object('kind', 'client_lockout', 'level', v_level, 'minutes', v_minutes,
                         'failures', greatest(v_fail_ip, v_fail_dev), 'at', now()));
  end if;

  -- global throttle across all clients
  select count(*) into v_fail_global from public.login_attempts a
   where not a.success and not a.refused_locked and a.attempted_at > now() - interval '1 hour';
  if v_fail_global >= s.global_failure_limit_per_hour
     and not exists (select 1 from public.login_lockouts where key_hash = 'global' and locked_until > now()) then
    insert into public.login_lockouts (scope, key_hash, level, locked_until)
    values ('global', 'global', 1, now() + interval '15 minutes');
    perform private.enqueue_owner_alert('security',
      'global_throttle:' || to_char(now(), 'YYYYMMDDHH24MI'),
      jsonb_build_object('kind', 'global_throttle', 'failures_last_hour', v_fail_global, 'minutes', 15, 'at', now()));
    v_locked := true;
  end if;

  return jsonb_build_object('locked', v_locked);
end $$;

-- After a session is minted: remember device info, mark code used.
create or replace function public.svc_login_success(
  p_profile uuid, p_session uuid, p_user_agent text, p_approx_ip text)
returns void
language sql security definer set search_path = ''
as $$
  update public.login_codes set last_used_at = now() where profile_id = p_profile and revoked_at is null;
  insert into public.device_sessions (session_id, profile_id, user_agent_summary, approx_ip)
  values (p_session, p_profile, left(p_user_agent, 120), left(p_approx_ip, 64))
  on conflict (session_id) do nothing;
$$;

-- ==================================================== sessions (owner)
create or replace function public.svc_list_sessions(p_profile uuid)
returns table (session_id uuid, created_at timestamptz, last_active_at timestamptz,
               user_agent_summary text, approx_ip text)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.created_at, coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at),
         d.user_agent_summary, d.approx_ip
  from auth.sessions s
  left join public.device_sessions d on d.session_id = s.id
  where s.user_id = p_profile
  order by coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at) desc
$$;

-- Revoke one session (p_session) or all sessions of a profile (null).
-- Deleting the auth.sessions row kills its refresh tokens (cascade) and,
-- through private.current_uid(), makes its access token useless at once.
create or replace function public.svc_revoke_sessions(
  p_actor uuid, p_profile uuid, p_session uuid default null, p_reason text default null, p_keep_session uuid default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_count int;
begin
  with gone as (
    delete from auth.sessions s
    where s.user_id = p_profile and (p_session is null or s.id = p_session)
      and (p_keep_session is null or s.id <> p_keep_session)
    returning s.id)
  select count(*) into v_count from gone;
  update public.device_sessions
     set revoked_at = now(), revoked_by = p_actor
   where profile_id = p_profile and revoked_at is null and (p_session is null or session_id = p_session)
     and (p_keep_session is null or session_id <> p_keep_session);
  perform private.audit(p_actor, case when p_session is null then 'sessions.revoke_all' else 'sessions.revoke' end,
    'auth.sessions', coalesce(p_session::text, p_profile::text), null,
    jsonb_build_object('profile_id', p_profile, 'revoked', v_count), p_reason);
  return v_count;
end $$;

-- ================================================ employee management
create or replace function public.svc_list_employees()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.role, x.full_name_en), '[]'::jsonb) from (
    select p.id, p.full_name_ar, p.full_name_en, p.phone, p.role, p.active, p.created_at, p.deactivated_at,
           (select c.created_at from public.login_codes c where c.profile_id = p.id and c.revoked_at is null) as code_created_at,
           (select c.last_used_at from public.login_codes c where c.profile_id = p.id and c.revoked_at is null) as code_last_used_at,
           sal.monthly_salary_piastres,
           (select count(*) from auth.sessions s where s.user_id = p.id) as session_count
    from public.profiles p
    left join public.employee_salaries sal on sal.employee_id = p.id
  ) x
$$;

create or replace function public.svc_create_employee(
  p_actor uuid, p_user_id uuid, p_name_ar text, p_name_en text, p_phone text, p_role public.app_role, p_code_hash text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_row public.profiles;
begin
  insert into public.profiles (id, full_name_ar, full_name_en, phone, role)
  values (p_user_id, btrim(p_name_ar), btrim(p_name_en), nullif(btrim(coalesce(p_phone, '')), ''), p_role)
  returning * into v_row;
  insert into public.employee_salaries (employee_id, monthly_salary_piastres, updated_by) values (p_user_id, null, p_actor);
  insert into public.login_codes (profile_id, code_hash, created_by) values (p_user_id, p_code_hash, p_actor);
  perform private.audit(p_actor, 'employee.create', 'profiles', p_user_id::text, null,
    to_jsonb(v_row) - 'updated_at');  -- never the code or its hash
  return to_jsonb(v_row);
end $$;

-- New code: revoke the old one, store the new hash, end every session
-- (except p_keep_session: the owner's own current session when they
-- regenerate their own code, so a missed copy can't lock them out).
create or replace function public.svc_set_code(p_actor uuid, p_profile uuid, p_code_hash text, p_keep_session uuid default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_sessions int;
begin
  if not exists (select 1 from public.profiles where id = p_profile) then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  update public.login_codes set revoked_at = now() where profile_id = p_profile and revoked_at is null;
  insert into public.login_codes (profile_id, code_hash, created_by) values (p_profile, p_code_hash, p_actor);
  v_sessions := public.svc_revoke_sessions(p_actor, p_profile, null, 'code regenerated', p_keep_session);
  perform private.audit(p_actor, 'code.regenerate', 'login_codes', p_profile::text, null,
    jsonb_build_object('sessions_revoked', v_sessions));
  return v_sessions;
end $$;

create or replace function public.svc_update_employee(
  p_actor uuid, p_profile uuid, p_name_ar text, p_name_en text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_before public.profiles; v_after public.profiles;
begin
  select * into v_before from public.profiles where id = p_profile for update;
  if not found then raise exception 'profile not found' using errcode = 'P0002'; end if;
  update public.profiles
     set full_name_ar = btrim(p_name_ar), full_name_en = btrim(p_name_en),
         phone = nullif(btrim(coalesce(p_phone, '')), '')
   where id = p_profile returning * into v_after;
  perform private.audit(p_actor, 'employee.update', 'profiles', p_profile::text,
    to_jsonb(v_before) - 'updated_at', to_jsonb(v_after) - 'updated_at');
  return to_jsonb(v_after);
end $$;

-- Deactivate / reactivate. Deactivation revokes all sessions server-side.
create or replace function public.svc_set_active(p_actor uuid, p_profile uuid, p_active boolean, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_before public.profiles; v_after public.profiles;
begin
  select * into v_before from public.profiles where id = p_profile for update;
  if not found then raise exception 'profile not found' using errcode = 'P0002'; end if;
  if not p_active and p_profile = p_actor then
    raise exception 'cannot deactivate yourself' using errcode = 'P0001';
  end if;
  if not p_active and v_before.role = 'owner'
     and (select count(*) from public.profiles where role = 'owner' and active) <= 1 then
    raise exception 'cannot deactivate the last owner' using errcode = 'P0001';
  end if;
  update public.profiles
     set active = p_active, deactivated_at = case when p_active then null else now() end
   where id = p_profile returning * into v_after;
  if not p_active then
    perform public.svc_revoke_sessions(p_actor, p_profile, null, 'deactivated');
  end if;
  perform private.audit(p_actor, case when p_active then 'employee.reactivate' else 'employee.deactivate' end,
    'profiles', p_profile::text, jsonb_build_object('active', v_before.active), jsonb_build_object('active', v_after.active), p_reason);
  return to_jsonb(v_after);
end $$;

create or replace function public.svc_set_salary(p_actor uuid, p_profile uuid, p_piastres bigint)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_before bigint; v_after public.employee_salaries;
begin
  if p_piastres is not null and (p_piastres < 0 or p_piastres % 100 <> 0) then
    raise exception 'salary must be whole EGP, non-negative' using errcode = '22023';
  end if;
  select monthly_salary_piastres into v_before from public.employee_salaries where employee_id = p_profile;
  insert into public.employee_salaries (employee_id, monthly_salary_piastres, updated_by, updated_at)
  values (p_profile, p_piastres, p_actor, now())
  on conflict (employee_id) do update
    set monthly_salary_piastres = excluded.monthly_salary_piastres, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_after;
  perform private.audit(p_actor, 'salary.set', 'employee_salaries', p_profile::text,
    jsonb_build_object('monthly_salary_piastres', v_before), jsonb_build_object('monthly_salary_piastres', p_piastres));
  return to_jsonb(v_after);
end $$;

-- ========================================================== bootstrap
-- Consume a one-time bootstrap token (hash). 'owner' only works while no
-- owner exists. Tokens are inserted by a developer with database access.
create or replace function public.svc_bootstrap_consume(p_token_hash text, p_purpose text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_purpose = 'owner' and exists (select 1 from public.profiles where role = 'owner') then
    return false;
  end if;
  update private.bootstrap_tokens
     set used_at = now()
   where token_hash = p_token_hash and purpose = p_purpose and used_at is null and expires_at > now();
  return found;
end $$;

-- =============================================== lock down svc_* EXECUTE
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'svc\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname not in ('current_uid', 'is_owner')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
