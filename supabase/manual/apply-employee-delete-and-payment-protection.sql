-- حاضر: الصقه كله في Supabase → SQL Editor ثم Run.
-- ينشئ دالة الحذف النهائي للموظف وحماية سجلات الدفع والقسائم من التعديل.
-- آمن عند التشغيل: لا يحذف أي بيانات بنفسه؛ الحذف يتم فقط حين يؤكده المالك من التطبيق.

-- =====================================================================
-- حاضر (Hadir) — owner-confirmed PERMANENT employee deletion.
-- One transaction: either everything of this employee is erased, or
-- nothing is. Only a staff member; never an owner, never oneself.
-- The preview token must still match (records changed → refused, the
-- owner re-confirms the new counts). Only the minimal audit entry remains:
-- action, owner id, opaque employee id, time.
-- Sign-in account (auth.users) removal is finished by the owner-employees
-- Edge Function right after commit; access is already blocked here
-- (profile, login codes and sessions are gone).
-- =====================================================================
-- Financial history is append-only. The ONLY exception is the owner's
-- confirmed permanent employee deletion, which sets hadir.allow_purge.
create or replace function private.trg_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('hadir.allow_purge', true) = 'on' then return old; end if;
  raise exception 'ZH:immutable_record' using errcode = 'P0001';
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'salary_payments_append_only') then
    create trigger salary_payments_append_only before update or delete on public.salary_payments
      for each row execute function private.trg_append_only();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'payslip_snapshots_append_only') then
    create trigger payslip_snapshots_append_only before update or delete on public.payslip_snapshots
      for each row execute function private.trg_append_only();
  end if;
end $$;

create or replace function public.svc_employee_delete(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; prof public.profiles; f jsonb; v_names text[]; ids text[]; v_del uuid; v_typed text := btrim(coalesce(p ->> 'confirm_name', ''));
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_emp := (p ->> 'employee_id')::uuid; exception when others then perform private.err('not_found'); end;
  -- lock the employee: concurrent check-ins/requests for them wait, then fail
  select * into prof from public.profiles where id = v_emp for update;
  if prof.id is null then perform private.err('not_found'); end if;
  if prof.role <> 'staff' or v_emp = p_actor then perform private.err('cannot_delete_owner'); end if;
  if v_typed = '' or not (v_typed = btrim(prof.full_name_ar) or lower(v_typed) = lower(btrim(prof.full_name_en))) then
    perform private.err('confirm_name_mismatch');
  end if;
  f := private.employee_footprint(v_emp);
  if md5(f::text || prof.updated_at::text) is distinct from (p ->> 'preview_token') then
    perform private.err('preview_changed', jsonb_build_object('counts', f, 'preview_token', md5(f::text || prof.updated_at::text)));
  end if;

  perform set_config('hadir.allow_purge', 'on', true);
  v_names := array[private.name_of(v_emp), prof.full_name_ar, prof.full_name_en];
  ids := array[v_emp::text]
    || coalesce((select array_agg(id::text) from public.point_events where employee_id = v_emp), '{}')
    || coalesce((select array_agg(id::text) from public.attendance_days where employee_id = v_emp), '{}')
    || coalesce((select array_agg(id::text) from public.leave_requests where employee_id = v_emp), '{}')
    || coalesce((select array_agg(id::text) from public.early_leave_requests where employee_id = v_emp), '{}')
    || coalesce((select array_agg(id::text) from public.reward_requests where employee_id = v_emp), '{}')
    || coalesce((select array_agg(id::text) from public.payroll_reports where employee_id = v_emp), '{}')
    || coalesce((select array_agg(id::text) from public.payslip_snapshots where employee_id = v_emp), '{}')
    || coalesce((select array_agg(id::text) from public.salary_payments where employee_id = v_emp), '{}')
    || coalesce((select array_agg(id::text) from public.absence_streak_alerts where employee_id = v_emp), '{}');

  -- 1) access: sign-in sessions and refresh tokens die now
  delete from auth.sessions where user_id = v_emp;
  delete from public.device_sessions where profile_id = v_emp;
  delete from public.login_codes where profile_id = v_emp;
  delete from public.push_subscriptions where employee_id = v_emp;

  -- 2) shared artefacts: remove this employee's embedded details
  delete from public.notification_outbox o where o.employee_id = v_emp or o.event_ref = any (ids)
     or o.dedupe_key like '%' || v_emp || '%' or o.payload ->> 'employee' = any (v_names) or o.payload::text like '%' || v_emp || '%';
  delete from public.telegram_actions t where t.action::text like '%' || v_emp || '%';
  update public.telegram_bot_state set state = '{}'::jsonb where state::text like '%' || v_emp || '%';
  update public.job_runs j set detail = jsonb_set(j.detail, '{lines}', coalesce((select jsonb_agg(l) from jsonb_array_elements(j.detail -> 'lines') l
      where not coalesce(l ->> 'employee' = any (v_names), false) and not coalesce(l ->> 'line' like prof.full_name_ar || ':%', false)), '[]'::jsonb)) || jsonb_build_object('revised', 'employee deleted')
   where jsonb_typeof(j.detail -> 'lines') = 'array' and exists (select 1 from jsonb_array_elements(j.detail -> 'lines') l
      where l ->> 'employee' = any (v_names) or l ->> 'line' like prof.full_name_ar || ':%');
  delete from private.owner_reports r where r.report_key like v_emp || ':%';
  -- shared Telegram report snapshots that mention them cannot be cleaned line
  -- by line safely → invalidated (text and figures removed, marked revised)
  update private.owner_reports r set parts = array['تم سحب هذا التقرير من التطبيق بعد حذف موظف نهائيًا.'], meta = jsonb_build_object('revised', 'employee deleted')
   where r.meta::text like '%' || v_emp || '%' or exists (select 1 from unnest(r.parts) x where x like '%' || prof.full_name_ar || '%');

  -- 3) other rows that merely point at them (no-action foreign keys)
  update public.attendance_days set corrected_by = null where corrected_by = v_emp;
  update public.point_events set created_by = null where created_by = v_emp;
  update public.point_events set approved_by = null where approved_by = v_emp;
  update public.point_events set amount_confirmed_by = null where amount_confirmed_by = v_emp;
  update public.leave_requests set decided_by = null where decided_by = v_emp;
  update public.early_leave_requests set decided_by = null where decided_by = v_emp;
  update public.reward_requests set decided_by = null where decided_by = v_emp;
  update public.employee_salaries set updated_by = null where updated_by = v_emp;
  update public.device_sessions set revoked_by = null where revoked_by = v_emp;
  update public.settings set updated_by = null where updated_by = v_emp;

  -- 4) the employee's own records (cycles broken first)
  update public.attendance_days set point_event_id = null where employee_id = v_emp;
  update public.point_events set attendance_day_id = null where employee_id = v_emp;
  update public.point_events set reverses_event_id = null where employee_id = v_emp;
  update public.reward_requests set replaces_request_id = null where employee_id = v_emp;
  delete from public.salary_payments where employee_id = v_emp and kind = 'reversal';
  delete from public.salary_payments where employee_id = v_emp;
  delete from public.payslip_snapshots where employee_id = v_emp;
  delete from public.absence_streak_alerts where employee_id = v_emp;
  delete from public.point_events where employee_id = v_emp;
  delete from public.attendance_days where employee_id = v_emp;
  delete from public.leave_requests where employee_id = v_emp;
  delete from public.early_leave_requests where employee_id = v_emp;
  delete from public.reward_requests where employee_id = v_emp;
  delete from public.payroll_reports where employee_id = v_emp;
  delete from public.monthly_deductions where employee_id = v_emp;
  delete from public.employee_salaries where employee_id = v_emp;
  delete from public.login_attempts where matched_profile_id = v_emp;
  -- 5) audit: erase entries about them, keep ONE minimal entry
  delete from public.audit_log a where a.actor_id = v_emp or a.target_id = any (ids)
     or coalesce(a.before::text, '') like '%' || v_emp || '%' or coalesce(a.after::text, '') like '%' || v_emp || '%';
  delete from public.profiles where id = v_emp;
  insert into public.employee_deletions (deleted_employee_id, requested_by) values (v_emp, p_actor) returning id into v_del;
  perform private.audit(p_actor, 'employee.delete', 'profiles', v_emp::text, null, null);
  return jsonb_build_object('deletion_id', v_del, 'employee_id', v_emp, 'status', 'db_done');
end $$;
revoke all on function public.svc_employee_delete(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.svc_employee_delete(uuid, jsonb) to service_role;
