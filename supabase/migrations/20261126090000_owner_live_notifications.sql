-- =====================================================================
-- حاضر (Hadir) — live owner notifications (Telegram + in-app + device push)
--
-- ONE server-side fan-out for every employee event the owner follows:
--   check_in  (on time / late, with minutes late; location warning)
--   check_out
--   absence   (the absence job's "no check-in, no approved leave" result)
--   request   (leave / absence, early departure, reward)
-- Every event already passes through private.enqueue_owner_alert inside
-- the SAME transaction that saved the row (svc_check_in, svc_check_out,
-- private.run_absence, svc_request_*). That function now also:
--   • writes one owner_notifications row (in-app list, live via Realtime)
--   • queues one Web Push per owner device (dispatch Edge Function)
--   • queues the Telegram message (as before) with the SAME Arabic text
-- All three share one dedupe key per event → never sent twice.
-- Delivery is asynchronous through notification_outbox (retries with
-- backoff, every attempt's result kept). Any error in the fan-out is
-- caught and logged: the employee's own action is never blocked.
-- Additive only; no data is removed.
-- =====================================================================

-- ------------------------------------------------ owner preferences
-- per type × channel; telegram defaults follow the existing notify_events
alter table public.settings
  add column if not exists owner_alert_prefs jsonb not null default
    '{"v":1,"check_in":{"telegram":true,"app":true,"push":true},"check_out":{"telegram":true,"app":true,"push":true},"absence":{"telegram":true,"app":true,"push":true},"request":{"telegram":true,"app":true,"push":true}}'::jsonb;
update public.settings set owner_alert_prefs = jsonb_build_object('v', 1,
    'check_in',  jsonb_build_object('telegram', 'check_in' = any (notify_events) or 'red_point' = any (notify_events), 'app', true, 'push', true),
    'check_out', jsonb_build_object('telegram', 'check_out' = any (notify_events), 'app', true, 'push', true),
    'absence',   jsonb_build_object('telegram', 'black_pending' = any (notify_events), 'app', true, 'push', true),
    'request',   jsonb_build_object('telegram', 'leave_request' = any (notify_events) or 'early_leave_request' = any (notify_events), 'app', true, 'push', true))
 where id and not (owner_alert_prefs ? 'migrated');
update public.settings set owner_alert_prefs = owner_alert_prefs || '{"migrated":true}'::jsonb where id;

-- ------------------------------------------------ in-app notifications
create table if not exists public.owner_notifications (
  id           bigint generated always as identity primary key,
  dedupe_key   text not null unique,
  type         text not null check (type in ('check_in', 'check_out', 'absence', 'request', 'test')),
  event        text not null,                     -- original event (check_in, red_point, leave_request…)
  employee_id  uuid references public.profiles (id) on delete cascade,
  ref_id       text,
  title_ar     text not null check (char_length(title_ar) <= 120),
  body_ar      text not null check (char_length(body_ar) <= 1000),
  link         text check (link is null or link ~ '^#/owner/'),
  flags        jsonb not null default '{}'::jsonb, -- {late_minutes, outside_location}
  event_at     timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index if not exists owner_notifications_recent on public.owner_notifications (created_at desc);
create index if not exists owner_notifications_unread on public.owner_notifications (created_at desc) where read_at is null;
create index if not exists owner_notifications_employee on public.owner_notifications (employee_id) where employee_id is not null;
alter table public.owner_notifications enable row level security;
revoke all on public.owner_notifications from public, anon, authenticated;
grant select on public.owner_notifications to authenticated;
grant update (read_at) on public.owner_notifications to authenticated;   -- only the read flag
drop policy if exists owner_notifications_select on public.owner_notifications;
create policy owner_notifications_select on public.owner_notifications
  for select to authenticated using ((select private.is_owner()));
drop policy if exists owner_notifications_read on public.owner_notifications;
create policy owner_notifications_read on public.owner_notifications
  for update to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));

-- live updates in the owner's open app (Realtime honours the RLS above)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'owner_notifications') then
    execute 'alter publication supabase_realtime add table public.owner_notifications';
  end if;
end $$;

-- the delivery log (notification_outbox) records which employee an owner alert is about
alter table public.notification_outbox add column if not exists subject_id uuid;
create index if not exists outbox_subject on public.notification_outbox (subject_id, created_at desc) where subject_id is not null;

-- ------------------------------------------------ helpers
create or replace function private.ar_date(d date) returns text
language sql immutable set search_path = '' as $$
  select (array['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'])[extract(dow from d)::int + 1]
         || ' ' || to_char(d, 'FMDD/FMMM/YYYY')
$$;

-- Minutes after the on-time limit: the end of the day's last enabled
-- green window that ended before t (or the first window's start).
create or replace function private.late_minutes(d date, t time) returns int
language sql stable security definer set search_path = '' as $$
  select greatest(0, floor(extract(epoch from (t - coalesce(
           (select max(cw.end_time) from public.check_in_windows cw
             where cw.day_of_week = extract(dow from d) and cw.enabled and cw.awards_green_point and cw.end_time <= t),
           (select min(cw.start_time) from public.check_in_windows cw
             where cw.day_of_week = extract(dow from d) and cw.enabled),
           t))) / 60))::int
$$;

create or replace function private.owner_pref(p_type text, p_channel text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((s.owner_alert_prefs -> p_type ->> p_channel)::boolean, true) from public.settings s where s.id
$$;

-- ------------------------------------------------ the fan-out
-- Returns the in-app row id (null if it already existed or app is off).
create or replace function private.owner_fanout(p_type text, p_event text, p_dedupe text, p_payload jsonb, p_ref text, p_force boolean default false)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  s public.settings := private.settings();
  a public.attendance_days; e public.point_events; lr public.leave_requests; er public.early_leave_requests; rr public.reward_requests;
  v_emp uuid; v_name text; v_title text; v_body text; v_link text; v_at timestamptz := now();
  v_flags jsonb := '{}'::jsonb; v_late int; v_dist float8; v_id bigint; v_payload jsonb; sub record; v_today date := private.local_now()::date;
begin
  if p_event in ('check_in', 'check_out') then
    select * into a from public.attendance_days where id::text = p_ref;
  elsif p_event in ('red_point', 'black_pending') then
    select * into e from public.point_events where id::text = p_ref;
    if p_event = 'red_point' then select * into a from public.attendance_days where employee_id = e.employee_id and work_date = e.effective_work_date; end if;
  elsif p_event = 'leave_request' then select * into lr from public.leave_requests where id::text = p_ref;
  elsif p_event = 'early_leave_request' then select * into er from public.early_leave_requests where id::text = p_ref;
  elsif p_event = 'reward_request' then select * into rr from public.reward_requests where id::text = p_ref;
  end if;
  v_emp := coalesce(a.employee_id, e.employee_id, lr.employee_id, er.employee_id, rr.employee_id, nullif(p_payload ->> 'employee_id', '')::uuid);
  v_name := coalesce((select nullif(btrim(full_name_ar), '') from public.profiles where id = v_emp), p_payload ->> 'employee', 'موظف');

  if p_type = 'check_in' then
    v_at := coalesce(a.checked_in_at, now());
    v_title := 'حضور';
    v_body := format('%s حضر الساعة %s', v_name, private.fmt12_ts(v_at, 'ar')) || E'\n' || private.ar_date(coalesce(a.work_date, v_today));
    if coalesce(a.check_in_outcome, case when p_event = 'red_point' then 'red' end) = 'red' then
      v_late := private.late_minutes(coalesce(a.work_date, v_today), (v_at at time zone s.business_timezone)::time);
      v_title := 'حضور متأخر';
      v_body := v_body || E'\n' || format('⏰ متأخر %s دقيقة', v_late)
        || case when e.warning_only then ' (أول تأخير هذا الشهر: إنذار بدون خصم)' when e.id is not null then ' (نقطة حمراء)' else '' end;
      v_flags := v_flags || jsonb_build_object('late_minutes', v_late);
    end if;
    if a.check_in_lat is not null and s.geofence_lat is not null then
      v_dist := private.distance_m(a.check_in_lat::float8, a.check_in_lng::float8, s.geofence_lat::float8, s.geofence_lng::float8);
      if v_dist > s.geofence_radius_m then
        v_body := v_body || E'\n' || format('⚠️ تسجيل خارج الموقع المسموح (على بعد %s م)', round(v_dist));
        v_flags := v_flags || jsonb_build_object('outside_location', true);
      end if;
    end if;
    v_link := '#/owner/employee?id=' || v_emp;
  elsif p_type = 'check_out' then
    v_at := coalesce(a.checked_out_at, now());
    v_title := 'انصراف';
    v_body := format('%s انصرف الساعة %s', v_name, private.fmt12_ts(v_at, 'ar')) || E'\n' || private.ar_date(coalesce(a.work_date, v_today))
      || case when a.worked_minutes is not null then E'\n' || format('مدة العمل %s س %s د', a.worked_minutes / 60, a.worked_minutes % 60) else '' end;
    v_link := '#/owner/employee?id=' || v_emp;
  elsif p_type = 'absence' then
    v_title := 'غياب';
    v_body := case when e.effective_work_date = v_today or e.effective_work_date is null then format('%s غاب اليوم', v_name)
                   else format('%s غاب يوم %s', v_name, private.ar_date(e.effective_work_date)) end
      || E'\n' || private.ar_date(coalesce(e.effective_work_date, v_today))
      || E'\n' || 'لم يسجّل حضوره حتى نهاية موعد الحضور ولا توجد إجازة معتمدة.'
      || E'\n' || 'نقطة سوداء بانتظار موافقتك في «الموافقات».';
    v_link := '#/owner/approvals';
  elsif p_type = 'request' then
    v_link := '#/owner/approvals';
    if p_event = 'early_leave_request' then
      v_at := coalesce(er.created_at, now());
      v_title := 'طلب انصراف مبكر';
      v_body := format('%s طلب انصراف مبكر %s الساعة %s', v_name,
                  case when er.work_date = v_today then 'اليوم' else private.ar_date(er.work_date) end, private.fmt12(er.requested_leave_time, 'ar'));
      if er.reason is not null then v_body := v_body || '، السبب: ' || er.reason; end if;
    elsif p_event = 'leave_request' then
      v_at := coalesce(lr.created_at, now());
      v_title := case when lr.type = 'sick' then 'طلب إجازة مرضية' else 'طلب غياب / إجازة' end;
      v_body := format('%s طلب %s %s', v_name, case when lr.type = 'sick' then 'إجازة مرضية' else 'إجازة (غياب)' end,
                  case when lr.from_date = lr.to_date then 'يوم ' || private.ar_date(lr.from_date)
                       else format('من %s إلى %s (%s يوم)', private.ar_date(lr.from_date), private.ar_date(lr.to_date), lr.to_date - lr.from_date + 1) end);
      if lr.reason is not null then v_body := v_body || '، السبب: ' || lr.reason; end if;
    elsif p_event = 'reward_request' then
      v_at := coalesce(rr.created_at, now());
      v_title := 'طلب صرف مكافأة';
      v_body := format('%s طلب صرف مكافأة شهر %s', v_name, to_char(rr.period_month, 'FMMM/YYYY'));
    else
      v_title := 'طلب'; v_body := v_name || ' أرسل طلبًا';
    end if;
    v_body := v_body || E'\n' || format('وقت الطلب: %s — %s', private.fmt12_ts(v_at, 'ar'), private.ar_date((v_at at time zone s.business_timezone)::date));
  else  -- test
    v_title := 'إشعار تجريبي';
    v_body := 'الإشعارات تعمل ✅' || E'\n' || format('%s — %s', private.fmt12_ts(now(), 'ar'), private.ar_date(v_today));
    v_link := '#/owner/notifications';
  end if;
  v_body := left(v_body, 1000);

  -- 1) in-app (also the anchor: an existing row means this event was already handled)
  if p_force or private.owner_pref(p_type, 'app') then
    insert into public.owner_notifications (dedupe_key, type, event, employee_id, ref_id, title_ar, body_ar, link, flags, event_at)
    values (p_dedupe, p_type, p_event, v_emp, p_ref, v_title, v_body, v_link, v_flags, v_at)
    on conflict (dedupe_key) do nothing returning id into v_id;
    if v_id is null then return null; end if;
  end if;

  -- 2) device push (every enabled device of an active owner)
  if p_force or private.owner_pref(p_type, 'push') then
    for sub in select p.id, p.employee_id from public.push_subscriptions p join public.profiles r on r.id = p.employee_id
                where r.role = 'owner' and r.active and p.enabled loop
      insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload, employee_id, subscription_id, subject_id)
      values (p_dedupe || ':push:' || sub.id, 'owner_' || p_type, p_ref, 'web_push', sub.id::text,
              jsonb_build_object('kind', 'owner_' || p_type, 'title', v_title, 'body', v_body, 'lang', 'ar',
                'url', './index.html#/owner/notifications' || coalesce('?id=' || v_id, ''), 'tag', p_dedupe),
              sub.employee_id, sub.id, v_emp)
      on conflict (dedupe_key) do nothing;
    end loop;
  end if;

  -- 3) Telegram (same text; existing payload keeps the approve/reject buttons)
  if (p_force or private.owner_pref(p_type, 'telegram')) and s.owner_alert_channel = 'telegram'
     and nullif(btrim(coalesce(s.owner_telegram_chat_id, '')), '') is not null then
    v_payload := coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('kind', coalesce(p_payload ->> 'kind', p_event),
      'text_ar', v_title || E'\n' || v_body, 'link', v_link, 'employee_id', v_emp);
    insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload, subject_id)
    values (p_dedupe || ':telegram:' || s.owner_telegram_chat_id, p_event, p_ref, 'telegram', s.owner_telegram_chat_id, v_payload, v_emp)
    on conflict (dedupe_key) do nothing;
  end if;
  return v_id;
end $$;
revoke all on function private.owner_fanout(text, text, text, jsonb, text, boolean) from public, anon, authenticated;

-- ------------------------------------------------ enqueue_owner_alert: route employee events through the fan-out
create or replace function private.enqueue_owner_alert(p_event text, p_dedupe text, p_payload jsonb, p_ref text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings();
  v_type text := case p_event when 'check_in' then 'check_in' when 'red_point' then 'check_in' when 'check_out' then 'check_out'
                              when 'black_pending' then 'absence'
                              when 'leave_request' then 'request' when 'early_leave_request' then 'request' when 'reward_request' then 'request' end;
begin
  if v_type is not null then
    begin
      perform private.owner_fanout(v_type, p_event, p_dedupe, p_payload, p_ref);
    exception when others then
      -- never block the employee's check-in / request: keep the error visible instead
      insert into public.job_runs (job_name, run_key, status, finished_at, detail)
      values ('owner_notify', p_dedupe, 'failed', now(), jsonb_build_object('event', p_event, 'error', left(sqlerrm, 200)))
      on conflict (job_name, run_key) do update set status = 'failed', finished_at = now(), detail = excluded.detail;
    end;
    return;
  end if;
  -- other owner alerts (security, digest, weekly…): unchanged
  if s.owner_alert_channel <> 'telegram' or not (p_event = any (s.notify_events))
     or nullif(btrim(coalesce(s.owner_telegram_chat_id, '')), '') is null then
    return;
  end if;
  insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload)
  values (p_dedupe || ':telegram:' || s.owner_telegram_chat_id, p_event, p_ref, 'telegram', s.owner_telegram_chat_id, p_payload)
  on conflict (dedupe_key) do nothing;
end $$;

-- ------------------------------------------------ owner API (service role via the api Edge Function)
create or replace function public.svc_owner_alert_prefs(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := '{"v":1,"migrated":true}'::jsonb; t text; c text; v_old jsonb;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  if jsonb_typeof(p -> 'prefs') <> 'object' then perform private.err('invalid_settings'); end if;
  select owner_alert_prefs into v_old from public.settings where id;
  foreach t in array array['check_in', 'check_out', 'absence', 'request'] loop
    v := v || jsonb_build_object(t, '{}'::jsonb);
    foreach c in array array['telegram', 'app', 'push'] loop
      if jsonb_typeof(p -> 'prefs' -> t -> c) is distinct from 'boolean' then perform private.err('invalid_settings'); end if;
      v := jsonb_set(v, array[t, c], p -> 'prefs' -> t -> c);
    end loop;
  end loop;
  update public.settings set owner_alert_prefs = v, updated_by = p_actor where id;
  perform private.audit(p_actor, 'settings.owner_alerts', 'settings', 'owner_alert_prefs', v_old, v);
  return v;
end $$;

-- Status for the settings card (no secrets: only whether things are set).
create or replace function public.svc_owner_notify_status(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings();
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  return jsonb_build_object(
    'prefs', s.owner_alert_prefs,
    'telegram_channel_on', s.owner_alert_channel = 'telegram',
    'telegram_chat_set', nullif(btrim(coalesce(s.owner_telegram_chat_id, '')), '') is not null,
    'push_devices', (select count(*) from public.push_subscriptions p join public.profiles r on r.id = p.employee_id
                      where r.role = 'owner' and r.active and p.enabled),
    'unread', (select count(*) from public.owner_notifications where read_at is null),
    'last_telegram', (select jsonb_build_object('status', o.status, 'at', coalesce(o.sent_at, o.created_at), 'error', o.last_error)
                        from public.notification_outbox o where o.channel = 'telegram' and o.subject_id is not null
                        order by o.created_at desc limit 1));
end $$;

-- Test: one notification through all three channels (ignores the toggles).
create or replace function public.svc_owner_notify_test(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_id bigint; v_key text := 'test:' || p_actor || ':' || floor(extract(epoch from clock_timestamp()));
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  v_id := private.owner_fanout('test', 'test', v_key, jsonb_build_object('kind', 'test'), null, true);
  return jsonb_build_object('notification_id', v_id,
    'push_queued', (select count(*) from public.notification_outbox where dedupe_key like v_key || ':push:%'),
    'telegram_queued', exists (select 1 from public.notification_outbox where dedupe_key like v_key || ':telegram:%'),
    'telegram_reason', case when s.owner_alert_channel <> 'telegram' then 'channel_off'
                            when nullif(btrim(coalesce(s.owner_telegram_chat_id, '')), '') is null then 'no_chat' end);
end $$;

-- Delivery log: the latest owner-notification attempts with their result.
create or replace function public.svc_owner_notify_log(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  return jsonb_build_object(
    'deliveries', coalesce((select jsonb_agg(x order by x.created_at desc) from (
      select o.created_at, o.sent_at, o.event_type, o.channel, o.status, o.attempt_count, o.last_error,
             private.name_of(o.subject_id) as employee
        from public.notification_outbox o
       where o.subject_id is not null or o.event_type like 'owner\_%' or o.event_type = 'test'
       order by o.created_at desc limit least(coalesce((p ->> 'limit')::int, 40), 100)) x), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('at', j.finished_at, 'event', j.detail ->> 'event', 'error', j.detail ->> 'error') order by j.finished_at desc)
                          from (select * from public.job_runs where job_name = 'owner_notify' and status = 'failed' order by finished_at desc limit 20) j), '[]'::jsonb));
end $$;

revoke all on function public.svc_owner_alert_prefs(uuid, jsonb), public.svc_owner_notify_status(uuid, jsonb),
  public.svc_owner_notify_test(uuid, jsonb), public.svc_owner_notify_log(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.svc_owner_alert_prefs(uuid, jsonb), public.svc_owner_notify_status(uuid, jsonb),
  public.svc_owner_notify_test(uuid, jsonb), public.svc_owner_notify_log(uuid, jsonb) to service_role;
