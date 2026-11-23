-- =====================================================================
-- حاضر (Hadir) — owner Telegram reports (features 5–8)
--   5. scheduled announcements (staff app or the owner's private chat),
--      optional auto-removal after publication
--   6. Sunday weekly summary (previous closed Sunday–Saturday week)
--   7. private month-end payroll summary (versioned snapshots)
--   8. repeated-absence alert (2+ consecutive absent working days)
-- Every owner report is a server-side snapshot in the PRIVATE schema; the
-- outbox row carries only a reference (never amounts or text). Delivery is
-- only to the owner's VERIFIED PRIVATE Telegram chat. All four features are
-- OFF by default. Additive only: nothing is dropped or removed.
-- Single-tenant app: one organisation = the singleton settings row.
-- =====================================================================

-- ------------------------------------------------ settings (all OFF by default)
alter table public.settings
  add column if not exists sunday_summary_enabled boolean not null default false,
  add column if not exists payroll_summary_enabled boolean not null default false,
  add column if not exists payroll_summary_time time not null default '10:00',
  add column if not exists absence_streak_enabled boolean not null default false,
  add column if not exists absence_streak_enabled_at timestamptz,
  add column if not exists absence_streak_leave_policy text not null default 'pause',
  add column if not exists owner_chat_verified_id text,
  add column if not exists owner_chat_verified_at timestamptz,
  add column if not exists owner_chat_check text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_streak_leave_policy') then
    alter table public.settings add constraint settings_streak_leave_policy check (absence_streak_leave_policy in ('pause', 'break'));
  end if;
end $$;

-- ------------------------------------------------ private report snapshots
create table if not exists private.owner_reports (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('weekly_owner', 'payroll_summary', 'payroll_blocked', 'absence_streak', 'announcement')),
  report_key  text not null,                 -- e.g. week start, payroll month, streak id, announcement id
  version     integer not null default 1,
  parts       text[] not null,               -- rendered plain-text messages (already split ≤ 3500 chars)
  meta        jsonb not null default '{}'::jsonb,   -- figures snapshot (may hold salary: private schema only)
  chat_id     text not null,                 -- the verified owner chat at queue time
  created_at  timestamptz not null default now(),
  constraint owner_reports_unique unique (kind, report_key, version)
);
revoke all on private.owner_reports from public, anon, authenticated;

-- ------------------------------------------------ scheduled announcements
create table if not exists public.scheduled_announcements (
  id                   uuid primary key default gen_random_uuid(),
  title                text check (title is null or char_length(title) between 1 and 120),
  body                 text not null check (char_length(body) between 1 and 4000),
  destination          text not null check (destination in ('staff_app', 'owner_telegram')),
  publish_local        timestamp not null,            -- the owner's Cairo wall-clock intent
  publish_at           timestamptz not null,          -- the resolved instant (UTC)
  delete_after_minutes integer check (delete_after_minutes is null or delete_after_minutes between 5 and 43200),
  status               text not null default 'scheduled'
                       check (status in ('scheduled', 'sending', 'published', 'failed', 'canceled', 'uncertain')),
  delete_status        text not null default 'none' check (delete_status in ('none', 'pending', 'deleting', 'deleted', 'failed')),
  delete_at            timestamptz,
  announcement_id      uuid,                          -- staff_app: the published announcement
  report_id            uuid,                          -- owner_telegram: the private snapshot
  telegram_message_ids bigint[] not null default '{}',
  parts_total          integer not null default 0,
  deleted_message_ids  bigint[] not null default '{}',
  last_error           text,
  created_by           uuid not null references public.profiles (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  published_at         timestamptz
);
create index if not exists sched_ann_due on public.scheduled_announcements (publish_at) where status = 'scheduled';
create index if not exists sched_ann_del on public.scheduled_announcements (delete_at) where delete_status = 'pending';
alter table public.scheduled_announcements enable row level security;
revoke all on public.scheduled_announcements from public, anon, authenticated;

-- ------------------------------------------------ absence streak alerts
create table if not exists public.absence_streak_alerts (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.profiles (id),
  streak_start   date not null,
  last_date      date not null,
  streak_length  integer not null,
  absent_dates   date[] not null,
  status         text not null default 'alerted' check (status in ('alerted', 'invalidated')),
  alerted_at     timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidated_reason text,
  constraint absence_streak_unique unique (employee_id, streak_start)
);
alter table public.absence_streak_alerts enable row level security;
revoke all on public.absence_streak_alerts from public, anon, authenticated;

-- =====================================================================
-- helpers
-- =====================================================================
-- Cairo wall-clock → instant. Rejects times that do not exist (spring
-- forward) or happen twice (fall back) instead of silently shifting them.
create or replace function private.cairo_local_to_utc(p_local timestamp)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare v timestamptz := p_local at time zone 'Africa/Cairo';
begin
  if (v at time zone 'Africa/Cairo') <> p_local then perform private.err('local_time_nonexistent'); end if;
  if ((v - interval '1 hour') at time zone 'Africa/Cairo') = p_local or ((v + interval '1 hour') at time zone 'Africa/Cairo') = p_local then
    perform private.err('local_time_ambiguous');
  end if;
  return v;
end $$;

-- The owner's verified PRIVATE chat, or NULL (fail closed). A private chat
-- id is a positive integer; groups/channels are negative. Verification is
-- recorded only from Telegram itself (getChat type=private, or a private
-- message from the owner to the bot) for this exact chat id.
create or replace function private.owner_private_chat()
returns text language sql stable security definer set search_path = '' as $$
  select s.owner_telegram_chat_id from public.settings s
   where s.id and s.owner_alert_channel = 'telegram'
     and s.owner_telegram_chat_id ~ '^[1-9][0-9]{3,15}$'
     and s.owner_chat_verified_id = s.owner_telegram_chat_id
$$;

create or replace function private.egp(p bigint) returns text language sql immutable set search_path = '' as $$
  select regexp_replace(to_char(coalesce(p, 0) / 100.0, 'FM999,999,999,990.00'), '\.00$', '') || ' ج.م'
$$;
create or replace function private.dmy(d date) returns text language sql immutable set search_path = '' as $$
  select to_char(d, 'DD/MM/YYYY')
$$;
create or replace function private.ar_month(d date) returns text language sql immutable set search_path = '' as $$
  select (array['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'])[extract(month from d)::int]
         || ' ' || extract(year from d)::int
$$;

-- Split a report into Telegram-safe parts (≤ p_max chars each). Every part
-- keeps the header; a single over-long line is cut into pieces, never lost.
create or replace function private.split_report(p_header text, p_lines text[], p_max int default 3500)
returns text[] language plpgsql immutable set search_path = '' as $$
declare lines text[] := '{}'; ln text; parts text[] := '{}'; cur text := ''; room int := p_max - char_length(p_header) - 20; n int; i int;
begin
  foreach ln in array coalesce(p_lines, '{}') loop
    while char_length(ln) > room loop lines := lines || left(ln, room); ln := substr(ln, room + 1); end loop;
    lines := lines || ln;
  end loop;
  foreach ln in array lines loop
    if cur <> '' and char_length(cur) + 1 + char_length(ln) > room then parts := parts || cur; cur := ''; end if;
    cur := case when cur = '' then ln else cur || E'\n' || ln end;
  end loop;
  if cur <> '' or cardinality(parts) = 0 then parts := parts || cur; end if;
  n := cardinality(parts);
  for i in 1 .. n loop
    parts[i] := p_header || case when n > 1 then ' (' || i || '/' || n || ')' else '' end || E'\n\n' || parts[i];
  end loop;
  return parts;
end $$;

-- Store a snapshot and queue one outbox row per part (reference only).
-- Returns the report id, or NULL when no verified private owner chat exists.
create or replace function private.queue_owner_report(p_kind text, p_key text, p_version int, p_header text, p_lines text[], p_meta jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_chat text := private.owner_private_chat(); v_id uuid; v_parts text[]; i int;
begin
  if v_chat is null then return null; end if;
  select id into v_id from private.owner_reports where kind = p_kind and report_key = p_key and version = p_version;
  if v_id is not null then return v_id; end if;            -- idempotent: same report, same version
  v_parts := private.split_report(p_header, p_lines);
  insert into private.owner_reports (kind, report_key, version, parts, meta, chat_id)
  values (p_kind, p_key, p_version, v_parts, coalesce(p_meta, '{}'::jsonb), v_chat) returning id into v_id;
  for i in 1 .. cardinality(v_parts) loop
    insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload, created_at)
    values ('report:' || v_id || ':' || i, 'owner_report', p_kind || ':' || p_key || ':v' || p_version, 'telegram', v_chat,
            jsonb_build_object('kind', 'owner_report', 'report_id', v_id, 'part', i, 'of', cardinality(v_parts)),
            clock_timestamp())
    on conflict (dedupe_key) do nothing;
  end loop;
  return v_id;
end $$;

-- Dispatcher: the text of one part, only if it still goes to the verified
-- owner private chat (re-checked at send time; otherwise blocked).
create or replace function public.svc_owner_report_part(p_outbox uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.notification_outbox; r private.owner_reports; v_chat text := private.owner_private_chat(); i int;
begin
  select * into o from public.notification_outbox where id = p_outbox and event_type = 'owner_report';
  if not found then return jsonb_build_object('blocked', 'not_found'); end if;
  select * into r from private.owner_reports where id = (o.payload ->> 'report_id')::uuid;
  i := (o.payload ->> 'part')::int;
  if r.id is null or i is null or i < 1 or i > cardinality(r.parts) then return jsonb_build_object('blocked', 'not_found'); end if;
  if v_chat is null or v_chat <> o.recipient or r.chat_id <> o.recipient then return jsonb_build_object('blocked', 'owner_chat_unverified'); end if;
  return jsonb_build_object('chat_id', v_chat, 'text', r.parts[i]);
end $$;

-- Owner chat verification (called by the dispatcher after getChat, and by
-- the webhook when the owner writes to the bot from a private chat).
create or replace function public.svc_owner_chat_verified(p_chat text, p_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings();
begin
  if p_chat is distinct from s.owner_telegram_chat_id then return jsonb_build_object('verified', false, 'reason', 'not_owner_chat'); end if;
  if p_type = 'private' and p_chat ~ '^[1-9][0-9]{3,15}$' then
    update public.settings set owner_chat_verified_id = p_chat, owner_chat_verified_at = now(), owner_chat_check = 'private' where id;
    return jsonb_build_object('verified', true);
  end if;
  update public.settings set owner_chat_verified_id = null, owner_chat_check = left(coalesce(p_type, 'unreachable'), 40) where id;
  return jsonb_build_object('verified', false, 'reason', p_type);
end $$;
create or replace function public.svc_owner_chat_needs_check()
returns text language sql stable security definer set search_path = '' as $$
  select case when s.owner_alert_channel = 'telegram' and coalesce(s.owner_telegram_chat_id, '') <> ''
               and s.owner_chat_verified_id is distinct from s.owner_telegram_chat_id then s.owner_telegram_chat_id end
  from public.settings s where s.id
$$;

-- =====================================================================
-- Outbox: retry-after, jitter, uncertain outcomes, Telegram deletions
-- =====================================================================
create or replace function public.svc_outbox_result_v2(p_id uuid, p_ok boolean, p_ref text, p_error text,
  p_gone boolean default false, p_retry_after_s int default null, p_uncertain boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.notification_outbox; sa public.scheduled_announcements; v_mid bigint;
begin
  select * into o from public.notification_outbox where id = p_id for update;
  if not found or o.status = 'sent' then return; end if;
  if p_ok then
    update public.notification_outbox set status = 'sent', sent_at = now(), provider_reference = left(p_ref, 200), last_error = null where id = p_id;
    if o.subscription_id is not null then update public.push_subscriptions set last_success_at = now() where id = o.subscription_id; end if;
  elsif p_uncertain then
    -- Telegram may have accepted it: never re-sent automatically (no floods)
    update public.notification_outbox set status = 'dead', last_error = left('uncertain: ' || coalesce(p_error, ''), 300) where id = p_id;
  elsif p_gone then
    update public.notification_outbox set status = 'dead', last_error = left(p_error, 300) where id = p_id;
    if o.subscription_id is not null then update public.push_subscriptions set enabled = false, disabled_at = now() where id = o.subscription_id; end if;
  else
    update public.notification_outbox set
      status = (case when o.attempt_count >= 6 then 'dead' else 'failed' end)::public.delivery_status,
      next_attempt_at = now() + case when p_retry_after_s is not null then make_interval(secs => least(greatest(p_retry_after_s, 1), 3600) + 1)
        else make_interval(secs => (least(power(2, o.attempt_count)::int, 120) * 60 * (0.75 + random() * 0.5))::int) end,
      last_error = left(p_error, 300) where id = p_id;
  end if;

  -- scheduled announcement bookkeeping (owner_telegram destination)
  if o.event_type = 'owner_report' and o.event_ref like 'announcement:%' then
    select * into sa from public.scheduled_announcements where report_id = (o.payload ->> 'report_id')::uuid for update;
    if sa.id is not null then
      if p_ok then
        v_mid := nullif(regexp_replace(coalesce(p_ref, ''), '\D', '', 'g'), '')::bigint;
        update public.scheduled_announcements set telegram_message_ids = telegram_message_ids || coalesce(v_mid, -1), updated_at = now()
         where id = sa.id returning * into sa;
        if cardinality(sa.telegram_message_ids) >= sa.parts_total then
          update public.scheduled_announcements set status = 'published', published_at = now(), last_error = null,
            delete_status = case when delete_after_minutes is null then 'none' else 'pending' end,
            delete_at = case when delete_after_minutes is null then null else now() + make_interval(mins => delete_after_minutes) end,
            updated_at = now() where id = sa.id;
        end if;
      elsif p_uncertain or p_gone or o.attempt_count >= 6 then
        update public.scheduled_announcements set status = case when p_uncertain then 'uncertain' else 'failed' end,
          last_error = left(coalesce(p_error, 'failed'), 200), updated_at = now() where id = sa.id;
      end if;
    end if;
  elsif o.event_type = 'telegram_delete' then
    select * into sa from public.scheduled_announcements where id = (o.payload ->> 'sched_id')::uuid for update;
    if sa.id is not null then
      if p_ok then
        update public.scheduled_announcements set deleted_message_ids = deleted_message_ids || (o.payload ->> 'message_id')::bigint, updated_at = now()
         where id = sa.id returning * into sa;
        if cardinality(sa.deleted_message_ids) >= cardinality(array_remove(sa.telegram_message_ids, -1::bigint)) then
          update public.scheduled_announcements set delete_status = 'deleted', updated_at = now() where id = sa.id;
        end if;
      elsif p_uncertain or p_gone or o.attempt_count >= 6 then
        -- the publication record stays; the deletion is reported as failed
        update public.scheduled_announcements set delete_status = 'failed', last_error = left(coalesce(p_error, 'removal failed'), 200), updated_at = now()
         where id = sa.id;
      end if;
    end if;
  end if;
end $$;

-- Claim due messages (unchanged), except: an expired lease on an owner
-- report or deletion means the worker stopped mid-send — the outcome is
-- unknown, so it is marked uncertain instead of being re-sent.
create or replace function public.svc_claim_outbox(p_limit int default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  update public.notification_outbox o set status = 'skipped', last_error = 'checked in before send'
   where o.status in ('pending', 'failed') and o.event_type = 'missed_checkin'
     and exists (select 1 from public.attendance_days a where a.employee_id = o.employee_id
                  and a.work_date = (o.created_at at time zone private.tz())::date);
  update public.notification_outbox o set status = 'skipped', last_error = 'subscription disabled'
   where o.status in ('pending', 'failed') and o.channel = 'web_push'
     and not exists (select 1 from public.push_subscriptions p where p.id = o.subscription_id and p.enabled);
  with due as (
    select id from public.notification_outbox
     where status in ('pending', 'failed') and next_attempt_at <= now()
     order by created_at limit p_limit for update skip locked),
  upd as (
    update public.notification_outbox o set status = 'sending', attempt_count = o.attempt_count + 1,
           next_attempt_at = now() + interval '10 minutes'   -- lease
      from due where o.id = due.id
    returning o.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'channel', u.channel, 'recipient', u.recipient,
      'event_type', u.event_type, 'payload', u.payload, 'attempt', u.attempt_count,
      'push', (select jsonb_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth_key)
                 from public.push_subscriptions p where p.id = u.subscription_id)) order by u.created_at), '[]'::jsonb)
    into v_rows from upd u;
  -- expired leases
  perform public.svc_outbox_result_v2(o.id, false, null, 'worker stopped mid-send (lease expired)', false, null, true)
     from public.notification_outbox o
    where o.status = 'sending' and o.next_attempt_at < now() and o.event_type in ('owner_report', 'telegram_delete');
  update public.notification_outbox set status = 'failed', last_error = 'dispatcher timeout'
   where status = 'sending' and next_attempt_at < now();
  return v_rows;
end $$;

-- =====================================================================
-- 8. Repeated-absence alert
-- =====================================================================
-- One employee-day, using the SAME rules as the absence job: a working day
-- is a work day with check-in enabled, enabled windows and no holiday; an
-- absence is the job's black point (pending or approved, not declined or
-- reversed). No record yet = not final ('open').
create or replace function private.emp_day_status(p_emp uuid, d date)
returns text language plpgsql stable security definer set search_path = '' as $$
declare di record; s public.settings := private.settings();
begin
  select * into di from private.day_info(d);
  if di.holiday_name_ar is not null or not di.is_work_day or not di.check_in_enabled or di.enabled_windows = 0 then return 'nonwork'; end if;
  if (select created_at from public.profiles where id = p_emp) >= ((d + s.absence_cutoff) at time zone s.business_timezone) then return 'nonwork'; end if;
  if exists (select 1 from public.attendance_days where employee_id = p_emp and work_date = d and checked_in_at is not null) then return 'present'; end if;
  if exists (select 1 from public.leave_requests where employee_id = p_emp and status = 'approved' and d between from_date and to_date) then return 'leave'; end if;
  if exists (select 1 from public.point_events e where e.employee_id = p_emp and e.effective_work_date = d and e.source = 'auto_absence'
              and e.color = 'black' and e.delta > 0 and e.status in ('pending_approval', 'active') and not private.is_reversed(e.id)) then return 'absent'; end if;
  return 'open';
end $$;

-- The streak of consecutive absent working days that contains day d.
create or replace function private.absence_streak(p_emp uuid, d date, out streak_start date, out streak_end date, out dates date[])
language plpgsql stable security definer set search_path = '' as $$
declare s public.settings := private.settings(); x date; st text; v_today date := private.local_now()::date;
begin
  dates := '{}';
  if private.emp_day_status(p_emp, d) <> 'absent' then return; end if;
  dates := array[d]; streak_start := d; streak_end := d;
  x := d - 1;
  while x >= d - 62 loop
    st := private.emp_day_status(p_emp, x);
    exit when st in ('present', 'open') or (st = 'leave' and s.absence_streak_leave_policy = 'break');
    if st = 'absent' then dates := x || dates; streak_start := x; end if;
    x := x - 1;
  end loop;
  x := d + 1;
  while x <= least(d + 62, v_today) loop
    st := private.emp_day_status(p_emp, x);
    exit when st in ('present', 'open') or (st = 'leave' and s.absence_streak_leave_policy = 'break');
    if st = 'absent' then dates := dates || x; streak_end := x; end if;
    x := x + 1;
  end loop;
end $$;

-- Re-evaluate around a changed employee-day: alert once when a streak first
-- reaches 2; extend the record silently; invalidate records a correction
-- broke. Never changes attendance or points.
create or replace function private.check_absence_streaks(p_emp uuid, d date)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); st record; a public.absence_streak_alerts; v_new boolean; x date; y date;
  v_lines text[]; v_name text; v_found boolean;
begin
  if not s.absence_streak_enabled then return; end if;
  -- 1) re-check alerted streaks near d: follow a streak whose start moved
  --    (same absences, no new alert); invalidate one that no longer holds
  for a in select * from public.absence_streak_alerts where employee_id = p_emp and status = 'alerted'
            and last_date >= d - 62 and streak_start <= d + 62 for update loop
    v_found := false;
    foreach y in array a.absent_dates loop
      if private.emp_day_status(p_emp, y) = 'absent' then
        select * into st from private.absence_streak(p_emp, y); v_found := true; exit;
      end if;
    end loop;
    if not v_found or cardinality(st.dates) < 2 then
      update public.absence_streak_alerts set status = 'invalidated', invalidated_at = now(),
        invalidated_reason = case when not v_found then 'no longer absences after a correction' else 'fewer than 2 consecutive absent working days after a correction' end
       where id = a.id;
      perform private.audit(null, 'absence_streak.invalidate', 'absence_streak_alerts', a.id::text, to_jsonb(a), null, 'attendance/absence correction', 'system');
    elsif (st.streak_start, st.streak_end, cardinality(st.dates)) is distinct from (a.streak_start, a.last_date, a.streak_length) then
      begin
        update public.absence_streak_alerts set streak_start = st.streak_start, last_date = st.streak_end,
          streak_length = cardinality(st.dates), absent_dates = st.dates where id = a.id;
      exception when unique_violation then null;
      end;
    end if;
  end loop;
  -- 2) a streak reaching 2 that no alerted record covers → ONE alert
  foreach x in array array[d, d - 1, d + 1] loop
    select * into st from private.absence_streak(p_emp, x);
    continue when cardinality(st.dates) < 2;
    -- catch-up policy: never alert for streaks that ended before the feature was enabled
    continue when st.streak_end < (coalesce(s.absence_streak_enabled_at, now()) at time zone s.business_timezone)::date - 1;
    continue when exists (select 1 from public.absence_streak_alerts where employee_id = p_emp and status = 'alerted' and absent_dates && st.dates);
    insert into public.absence_streak_alerts (employee_id, streak_start, last_date, streak_length, absent_dates)
    values (p_emp, st.streak_start, st.streak_end, cardinality(st.dates), st.dates)
    on conflict (employee_id, streak_start) do nothing
    returning true into v_new;
    if v_new then
      v_name := private.name_of(p_emp);
      v_lines := array['الموظف: ' || v_name,
        'أيام عمل متتالية غائب فيها: ' || cardinality(st.dates),
        'التواريخ: ' || (select string_agg(private.dmy(z), '، ' order by z) from unnest(st.dates) z),
        'الغياب محسوب بنفس قاعدة التطبيق (بدون تسجيل حضور ولا إجازة معتمدة بعد موعد احتساب الغياب).'];
      perform private.queue_owner_report('absence_streak', p_emp || ':' || st.streak_start, 1,
        '⚠️ غياب متكرر — ' || v_name, v_lines, jsonb_build_object('employee_id', p_emp, 'dates', st.dates));
    end if;
    v_new := null;
  end loop;
end $$;

-- Triggers: evaluated the moment an absence is recorded (absence job at the
-- cutoff) and again after any correction. A failure here never blocks the
-- attendance/point write; it is recorded in job_runs.
create or replace function private.trg_absence_streak()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; v_from date; v_to date; x date;
begin
  if not (select absence_streak_enabled from public.settings where id) then return null; end if;
  if tg_table_name = 'point_events' then
    if new.color <> 'black' and new.reverses_event_id is null then return null; end if;
    v_emp := new.employee_id; v_from := new.effective_work_date; v_to := v_from;
  elsif tg_table_name = 'attendance_days' then
    v_emp := new.employee_id; v_from := new.work_date; v_to := v_from;
  else  -- leave_requests
    v_emp := new.employee_id; v_from := new.from_date - 1; v_to := least(new.to_date + 1, new.from_date + 31);
  end if;
  begin
    x := v_from;
    while x <= v_to loop perform private.check_absence_streaks(v_emp, x); x := x + 1; end loop;
  exception when others then
    perform private.record_job('absence_streak_error', v_emp || ':' || v_from || ':' || extract(epoch from now())::bigint, 'failed',
      jsonb_build_object('error', left(sqlerrm, 200)));
  end;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'absence_streak_points') then
    create trigger absence_streak_points after insert or update of status on public.point_events
      for each row execute function private.trg_absence_streak();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'absence_streak_attendance') then
    create trigger absence_streak_attendance after insert or update of checked_in_at on public.attendance_days
      for each row execute function private.trg_absence_streak();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'absence_streak_leave') then
    create trigger absence_streak_leave after update of status on public.leave_requests
      for each row execute function private.trg_absence_streak();
  end if;
end $$;

-- =====================================================================
-- 6. Sunday weekly summary (previous closed Sunday–Saturday week)
-- =====================================================================
create or replace function private.run_sunday_summary(p_week_start date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_end date := p_week_start + 6; v_lines text[] := '{}'; r record; v_id uuid;
  v_period date := private.period_of(p_week_start + 6); v_late int := 0; v_abs int := 0; v_top int := 0;
begin
  v_lines := v_lines || ('الفترة: من الأحد ' || private.dmy(p_week_start) || ' إلى السبت ' || private.dmy(v_end) || ' (بتوقيت القاهرة)');
  v_lines := v_lines || ''::text || '🟥 التأخير (أيام):'::text;
  for r in select pr.full_name_ar, count(*) as n
             from public.point_events e join public.profiles pr on pr.id = e.employee_id
            where e.color = 'red' and e.delta > 0 and e.status = 'active' and e.source = 'auto_window'
              and e.effective_work_date between p_week_start and v_end and not private.is_reversed(e.id)
            group by pr.id, pr.full_name_ar order by count(*) desc, pr.full_name_ar loop
    v_lines := v_lines || ('• ' || r.full_name_ar || ': ' || r.n || case when r.n = 1 then ' يوم' else ' أيام' end); v_late := v_late + 1;
  end loop;
  if v_late = 0 then v_lines := v_lines || 'لا يوجد تأخير.'::text; end if;
  v_lines := v_lines || 'ملاحظة: النظام يسجل يوم التأخير (نقطة حمراء) ولا يسجل دقائق التأخير.'::text;
  v_lines := v_lines || ''::text || '⚫ الغياب (أيام):'::text;
  for r in select pr.full_name_ar, count(*) as n,
                  count(*) filter (where e.status = 'pending_approval') as pend
             from public.point_events e join public.profiles pr on pr.id = e.employee_id
            where e.color = 'black' and e.delta > 0 and e.source = 'auto_absence' and e.status in ('pending_approval', 'active')
              and e.effective_work_date between p_week_start and v_end and not private.is_reversed(e.id)
            group by pr.id, pr.full_name_ar order by count(*) desc, pr.full_name_ar loop
    v_lines := v_lines || ('• ' || r.full_name_ar || ': ' || r.n || case when r.n = 1 then ' يوم' else ' أيام' end
      || case when r.pend > 0 then ' (' || r.pend || ' بانتظار موافقتك)' else '' end); v_abs := v_abs + 1;
  end loop;
  if v_abs = 0 then v_lines := v_lines || 'لا يوجد غياب.'::text; end if;
  v_lines := v_lines || ''::text || ('🏆 الأعلى في لوحة الصدارة — ' || private.ar_month(v_period) || ' (نقاط خضراء تراكمية للشهر حتى الآن، وليست للأسبوع فقط):');
  for r in select * from (
             select pr.full_name_ar, greatest(private.period_total(pr.id, 'green', v_period), 0) as g,
                    rank() over (order by greatest(private.period_total(pr.id, 'green', v_period), 0) desc) as rnk
               from public.profiles pr where pr.role = 'staff' and pr.active) x
            where x.rnk <= 3 and x.g > 0 order by x.rnk, x.full_name_ar loop
    v_lines := v_lines || (r.rnk || '. ' || r.full_name_ar || ' — ' || r.g || ' نقطة'); v_top := v_top + 1;
  end loop;
  if v_top = 0 then v_lines := v_lines || 'لا توجد نقاط خضراء بعد هذا الشهر.'::text;
  else v_lines := v_lines || 'المتعادلون في النقاط يأخذون نفس الترتيب.'::text; end if;

  v_id := private.queue_owner_report('weekly_owner', p_week_start::text, 1, '📊 الملخص الأسبوعي — حاضر', v_lines,
    jsonb_build_object('week_start', p_week_start, 'week_end', v_end, 'late_people', v_late, 'absent_people', v_abs));
  if v_id is null then
    perform private.record_job('sunday_summary', p_week_start::text, 'failed', jsonb_build_object('blocked', 'owner_chat_unverified'));
    return jsonb_build_object('blocked', 'owner_chat_unverified');
  end if;
  perform private.record_job('sunday_summary', p_week_start::text, 'succeeded', jsonb_build_object('report_id', v_id));
  return jsonb_build_object('report_id', v_id);
end $$;

-- =====================================================================
-- 7. Month-end payroll summary (existing payroll engine, versioned)
-- =====================================================================
-- What still keeps a month open (no amounts invented, nothing modified).
create or replace function private.payroll_month_open_items(p_month date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_end date := (p_month + interval '1 month - 1 day')::date; d date;
  v_jobs int := 0; v_pending int; v_missing int; v_nosal int;
begin
  for d in select g::date from generate_series(greatest(p_month, s.jobs_start_date), v_end, interval '1 day') g loop
    if not private.job_done('absence', d::text) then v_jobs := v_jobs + 1; end if;
  end loop;
  select count(*) into v_pending from public.point_events where reward_period = p_month and color = 'black' and status = 'pending_approval';
  select count(*) into v_missing from public.attendance_days where work_date between p_month and v_end
     and checked_in_at is not null and checked_out_at is null and not corrected;
  select count(*) into v_nosal from public.profiles pr left join public.employee_salaries sal on sal.employee_id = pr.id
   where pr.role = 'staff' and pr.active and sal.monthly_salary_piastres is null;
  return jsonb_build_object('absence_days_not_closed', v_jobs, 'black_pending', v_pending, 'missing_checkouts', v_missing,
    'salary_missing', v_nosal, 'open', v_jobs + v_pending + v_missing > 0);
end $$;

create or replace function private.run_payroll_summary(p_month date, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_open jsonb := private.payroll_month_open_items(p_month); v_rows jsonb; v_lines text[] := '{}'; r jsonb;
  v_prev private.owner_reports; v_ver int; v_id uuid; v_tot jsonb; v_sal bigint := 0; v_add bigint := 0; v_ded bigint := 0; v_net bigint := 0;
  v_fig jsonb; v_key text := to_char(p_month, 'YYYY-MM');
begin
  if (v_open ->> 'open')::boolean then
    v_id := private.queue_owner_report('payroll_blocked', v_key, 1, '⏳ رواتب ' || private.ar_month(p_month) || ' — لم تكتمل بعد',
      array['لن يُرسل ملخص الرواتب النهائي حتى تُغلق هذه البنود (لا توجد أرقام في هذه الرسالة):',
        '• أيام عمل لم يُحتسب غيابها بعد: ' || (v_open ->> 'absence_days_not_closed'),
        '• نقاط سوداء بانتظار قرارك: ' || (v_open ->> 'black_pending'),
        '• تسجيلات انصراف ناقصة: ' || (v_open ->> 'missing_checkouts'),
        'بعد إغلاقها يصلك الملخص النهائي تلقائيًا.'], v_open);
    perform private.record_job('payroll_summary', v_key, 'failed', jsonb_build_object('waiting', v_open, 'notice_report', v_id));
    return jsonb_build_object('waiting', v_open);
  end if;
  -- the existing engine (same rules/rounding as the payroll screen)
  v_rows := public.svc_payroll(p_actor, jsonb_build_object('month', p_month)) -> 'rows';
  v_fig := coalesce((select jsonb_agg(jsonb_build_object('id', x ->> 'employee_id', 'salary', x -> 'monthly_salary_piastres',
      'add', greatest((x ->> 'bonuses_earned_piastres')::bigint - (x ->> 'bonuses_paid_piastres')::bigint, 0),
      'ded', (x ->> 'deductions_piastres')::bigint, 'net', (x ->> 'net_adjustment_piastres')::bigint) order by x ->> 'full_name_ar')
    from jsonb_array_elements(v_rows) x), '[]'::jsonb);
  select * into v_prev from private.owner_reports where kind = 'payroll_summary' and report_key = v_key order by version desc limit 1;
  if v_prev.id is not null and v_prev.meta -> 'figures' = v_fig then
    perform private.record_job('payroll_summary', v_key, 'succeeded', jsonb_build_object('report_id', v_prev.id, 'unchanged', true));
    return jsonb_build_object('report_id', v_prev.id, 'version', v_prev.version, 'unchanged', true);
  end if;
  v_ver := coalesce(v_prev.version, 0) + 1;
  for r in select x from jsonb_array_elements(v_rows) x order by x ->> 'full_name_ar' loop
    v_lines := v_lines || ('• ' || (r ->> 'full_name_ar') || E'\n   المرتب الأساسي: ' ||
      case when r -> 'monthly_salary_piastres' = 'null'::jsonb or r ->> 'monthly_salary_piastres' is null then 'غير مسجل'
           else private.egp((r ->> 'monthly_salary_piastres')::bigint) end ||
      E'\n   إضافات (مكافأة مستحقة غير مصروفة): ' || private.egp(greatest((r ->> 'bonuses_earned_piastres')::bigint - (r ->> 'bonuses_paid_piastres')::bigint, 0)) ||
      E'\n   خصومات (تأخير وغياب معتمد): ' || private.egp((r ->> 'deductions_piastres')::bigint) ||
      E'\n   صافي التسوية: ' || private.egp((r ->> 'net_adjustment_piastres')::bigint));
    v_sal := v_sal + coalesce((r ->> 'monthly_salary_piastres')::bigint, 0);
    v_add := v_add + greatest((r ->> 'bonuses_earned_piastres')::bigint - (r ->> 'bonuses_paid_piastres')::bigint, 0);
    v_ded := v_ded + (r ->> 'deductions_piastres')::bigint;
    v_net := v_net + (r ->> 'net_adjustment_piastres')::bigint;
  end loop;
  if jsonb_array_length(v_rows) = 0 then v_lines := v_lines || 'لا يوجد موظفون في هذا الشهر.'::text; end if;
  v_lines := v_lines || ''::text || '— إجمالي الشركة —'::text ||
    ('المرتبات الأساسية المسجلة: ' || private.egp(v_sal) || case when (v_open ->> 'salary_missing')::int > 0
       then ' (' || (v_open ->> 'salary_missing') || ' موظف بدون مرتب مسجل — غير محسوب)' else '' end) ||
    ('الإضافات: ' || private.egp(v_add)) || ('الخصومات: ' || private.egp(v_ded)) || ('صافي التسوية: ' || private.egp(v_net)) ||
    ''::text || 'صافي التسوية = المكافأة المستحقة − الخصومات. التطبيق لا يحسب صافي المرتب ولا يصرف أي مبلغ.'::text ||
    ('رقم التقرير: PR-' || v_key || '-v' || v_ver);
  v_tot := jsonb_build_object('salary', v_sal, 'add', v_add, 'ded', v_ded, 'net', v_net);
  v_id := private.queue_owner_report('payroll_summary', v_key, v_ver,
    '💰 ملخص الرواتب — ' || private.ar_month(p_month) || ' (نهائي)' ||
      case when v_ver > 1 then ' — تصحيح: النسخة ' || v_ver || ' تحل محل النسخة ' || (v_ver - 1) else '' end || E'\nالعملة: جنيه مصري (ج.م)',
    v_lines, jsonb_build_object('figures', v_fig, 'totals', v_tot, 'month', p_month));
  if v_id is null then
    perform private.record_job('payroll_summary', v_key, 'failed', jsonb_build_object('blocked', 'owner_chat_unverified'));
    return jsonb_build_object('blocked', 'owner_chat_unverified');
  end if;
  perform private.record_job('payroll_summary', v_key, 'succeeded', jsonb_build_object('report_id', v_id, 'version', v_ver));
  perform private.audit(p_actor, 'payroll_summary.queue', 'owner_reports', v_id::text, null, jsonb_build_object('month', p_month, 'version', v_ver),
    null, case when p_actor is null then 'system' else 'user' end);
  return jsonb_build_object('report_id', v_id, 'version', v_ver);
end $$;

-- Owner: send a corrected version for a closed month (only if figures changed).
create or replace function public.svc_payroll_summary_resend(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_month date;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_month := private.period_of((p ->> 'month')::date); exception when others then perform private.err('invalid_time'); end;
  if v_month is null or v_month >= private.period_of(private.local_now()::date) then perform private.err('month_not_closed'); end if;
  if private.owner_private_chat() is null then perform private.err('owner_chat_unverified'); end if;
  return private.run_payroll_summary(v_month, p_actor);
end $$;

-- =====================================================================
-- 5. Scheduled announcements
-- =====================================================================
create or replace function public.svc_sched_ann_save(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid; b public.scheduled_announcements; a public.scheduled_announcements;
  v_title text := nullif(btrim(coalesce(p ->> 'title', '')), ''); v_body text := btrim(coalesce(p ->> 'body', ''));
  v_dest text := coalesce(p ->> 'destination', 'staff_app'); v_local timestamp; v_at timestamptz; v_del int;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  if v_dest not in ('staff_app', 'owner_telegram') then perform private.err('invalid_destination'); end if;
  if char_length(v_body) < 1 or char_length(v_body) > (case when v_dest = 'staff_app' then 1000 else 4000 end)
     or (v_title is not null and char_length(v_title) > 120) then perform private.err('invalid_text'); end if;
  begin v_local := (p ->> 'publish_local')::timestamp; exception when others then perform private.err('invalid_time'); end;
  if v_local is null then perform private.err('invalid_time'); end if;
  v_at := private.cairo_local_to_utc(v_local);
  if v_at < now() + interval '1 minute' or v_at > now() + interval '90 days' then perform private.err('schedule_out_of_range'); end if;
  v_del := nullif(p ->> 'delete_after_minutes', '')::int;
  if v_del is not null and (v_del < 5 or v_del > (case when v_dest = 'owner_telegram' then 2820 else 43200 end)) then
    perform private.err('invalid_delete_after');           -- Telegram: bots may remove only messages < 48 h old
  end if;
  if v_dest = 'owner_telegram' and private.owner_private_chat() is null then perform private.err('owner_chat_unverified'); end if;
  if v_id is null then
    insert into public.scheduled_announcements (title, body, destination, publish_local, publish_at, delete_after_minutes, created_by)
    values (v_title, v_body, v_dest, v_local, v_at, v_del, p_actor) returning * into a;
  else
    select * into b from public.scheduled_announcements where id = v_id for update;
    if b.id is null then perform private.err('not_found'); end if;
    if b.status <> 'scheduled' then perform private.err('not_editable'); end if;   -- only before sending
    update public.scheduled_announcements set title = v_title, body = v_body, destination = v_dest, publish_local = v_local,
      publish_at = v_at, delete_after_minutes = v_del, updated_at = now() where id = v_id returning * into a;
  end if;
  perform private.audit(p_actor, case when v_id is null then 'sched_ann.create' else 'sched_ann.update' end, 'scheduled_announcements',
    a.id::text, case when b.id is null then null else to_jsonb(b) end, to_jsonb(a));
  return jsonb_build_object('id', a.id, 'status', a.status, 'publish_at', a.publish_at);
end $$;

create or replace function public.svc_sched_ann_cancel(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.scheduled_announcements; v_id uuid;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_id := (p ->> 'id')::uuid; exception when others then perform private.err('not_found'); end;
  select * into b from public.scheduled_announcements where id = v_id for update;
  if b.id is null then perform private.err('not_found'); end if;
  if b.status <> 'scheduled' then perform private.err('not_editable'); end if;
  update public.scheduled_announcements set status = 'canceled', updated_at = now() where id = v_id;
  perform private.audit(p_actor, 'sched_ann.cancel', 'scheduled_announcements', v_id::text, to_jsonb(b), null);
  return jsonb_build_object('id', v_id, 'status', 'canceled');
end $$;

create or replace function public.svc_sched_ann_list(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'body', x.body, 'destination', x.destination,
      'publish_local', to_char(x.publish_local, 'YYYY-MM-DD"T"HH24:MI'), 'publish_at', x.publish_at, 'delete_after_minutes', x.delete_after_minutes,
      'status', x.status, 'delete_status', x.delete_status, 'delete_at', x.delete_at, 'published_at', x.published_at,
      'messages', cardinality(x.telegram_message_ids), 'last_error', x.last_error) order by x.publish_at desc, x.id desc)
    from (select * from public.scheduled_announcements order by publish_at desc, id desc limit 100) x), '[]'::jsonb);
end $$;

-- Publish due announcements and run due removals (called by tick()).
-- Catch-up policy: an announcement more than 6 h late (outage) is NOT sent;
-- it is marked failed («فات موعده») so nothing stale goes out unexpectedly.
create or replace function private.process_scheduled_announcements()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare sa public.scheduled_announcements; r jsonb; v_id uuid; v_n int := 0; v_d int := 0; m bigint; v_lines text[];
begin
  for sa in select * from public.scheduled_announcements where status = 'scheduled' and publish_at <= now()
             order by publish_at for update skip locked loop
    if sa.publish_at < now() - interval '6 hours' then
      update public.scheduled_announcements set status = 'failed', last_error = 'expired: missed its publish time by more than 6 hours', updated_at = now() where id = sa.id;
      continue;
    end if;
    begin
      if sa.destination = 'staff_app' then
        r := public.svc_broadcast(sa.created_by, jsonb_build_object('title', sa.title, 'text', sa.body));
        update public.scheduled_announcements set status = 'published', announcement_id = (r ->> 'id')::uuid, published_at = now(), last_error = null,
          delete_status = case when delete_after_minutes is null then 'none' else 'pending' end,
          delete_at = case when delete_after_minutes is null then null else now() + make_interval(mins => delete_after_minutes) end,
          updated_at = now() where id = sa.id;
      else
        v_lines := string_to_array(sa.body, E'\n');
        v_id := private.queue_owner_report('announcement', sa.id::text, 1, '📢 ' || coalesce(sa.title, 'إعلان'), v_lines, jsonb_build_object('sched_id', sa.id));
        if v_id is null then
          update public.scheduled_announcements set status = 'failed', last_error = 'owner private chat not verified', updated_at = now() where id = sa.id;
        else
          update public.scheduled_announcements set status = 'sending', report_id = v_id,
            parts_total = (select cardinality(parts) from private.owner_reports where id = v_id), updated_at = now() where id = sa.id;
        end if;
      end if;
      v_n := v_n + 1;
    exception when others then
      update public.scheduled_announcements set status = 'failed', last_error = left(sqlerrm, 200), updated_at = now() where id = sa.id;
    end;
  end loop;

  for sa in select * from public.scheduled_announcements where delete_status = 'pending' and delete_at <= now()
             order by delete_at for update skip locked loop
    if sa.destination = 'staff_app' then
      begin
        perform public.svc_delete_announcement(sa.created_by, jsonb_build_object('id', sa.announcement_id, 'via', 'schedule'));
        update public.scheduled_announcements set delete_status = 'deleted', updated_at = now() where id = sa.id;
      exception when others then
        update public.scheduled_announcements set delete_status = 'failed', last_error = left(sqlerrm, 200), updated_at = now() where id = sa.id;
      end;
    elsif sa.published_at < now() - interval '47 hours' then
      update public.scheduled_announcements set delete_status = 'failed',
        last_error = 'Telegram only allows deleting messages younger than 48 hours (missed)', updated_at = now() where id = sa.id;
    else
      foreach m in array array_remove(sa.telegram_message_ids, -1::bigint) loop
        insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload, created_at)
        values ('tgdel:' || sa.id || ':' || m, 'telegram_delete', 'announcement:' || sa.id, 'telegram',
                (select chat_id from private.owner_reports where id = sa.report_id),
                jsonb_build_object('kind', 'telegram_delete', 'sched_id', sa.id, 'message_id', m), clock_timestamp())
        on conflict (dedupe_key) do nothing;
      end loop;
      update public.scheduled_announcements set delete_status = case when cardinality(array_remove(sa.telegram_message_ids, -1::bigint)) = 0
          then 'failed' else 'deleting' end,
        last_error = case when cardinality(array_remove(sa.telegram_message_ids, -1::bigint)) = 0 then 'no message ids were recorded' else last_error end,
        updated_at = now() where id = sa.id;
    end if;
    v_d := v_d + 1;
  end loop;
  return jsonb_build_object('published', v_n, 'removals', v_d);
end $$;

-- =====================================================================
-- Owner settings + status (owner-only through the api function)
-- =====================================================================
create or replace function public.svc_save_report_settings(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.settings; a public.settings;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  select * into b from public.settings where id for update;
  begin
    update public.settings set
      sunday_summary_enabled = coalesce((p ->> 'sunday_summary_enabled')::boolean, sunday_summary_enabled),
      payroll_summary_enabled = coalesce((p ->> 'payroll_summary_enabled')::boolean, payroll_summary_enabled),
      payroll_summary_time = coalesce((p ->> 'payroll_summary_time')::time, payroll_summary_time),
      absence_streak_enabled = coalesce((p ->> 'absence_streak_enabled')::boolean, absence_streak_enabled),
      absence_streak_enabled_at = case when coalesce((p ->> 'absence_streak_enabled')::boolean, absence_streak_enabled)
                                        and not absence_streak_enabled then now() else absence_streak_enabled_at end,
      absence_streak_leave_policy = coalesce(p ->> 'absence_streak_leave_policy', absence_streak_leave_policy),
      updated_at = now(), updated_by = p_actor
    where id returning * into a;
  exception when check_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    perform private.err('invalid_settings');
  end;
  perform private.audit(p_actor, 'report_settings.update', 'settings', 'singleton',
    jsonb_build_object('sunday', b.sunday_summary_enabled, 'payroll', b.payroll_summary_enabled, 'payroll_time', b.payroll_summary_time,
      'streak', b.absence_streak_enabled, 'leave_policy', b.absence_streak_leave_policy),
    jsonb_build_object('sunday', a.sunday_summary_enabled, 'payroll', a.payroll_summary_enabled, 'payroll_time', a.payroll_summary_time,
      'streak', a.absence_streak_enabled, 'leave_policy', a.absence_streak_leave_policy));
  return public.svc_bot_reports_status(p_actor, '{}');
end $$;

create or replace function public.svc_bot_reports_status(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_today date := private.local_now()::date; v_sun date;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  v_sun := v_today + ((7 - extract(dow from v_today)::int) % 7);
  if v_sun = v_today and private.local_now()::time >= s.weekly_summary_time then v_sun := v_sun + 7; end if;
  return jsonb_build_object(
    'sunday_summary_enabled', s.sunday_summary_enabled, 'payroll_summary_enabled', s.payroll_summary_enabled,
    'payroll_summary_time', to_char(s.payroll_summary_time, 'HH24:MI'), 'weekly_summary_time', to_char(s.weekly_summary_time, 'HH24:MI'),
    'absence_streak_enabled', s.absence_streak_enabled, 'absence_streak_leave_policy', s.absence_streak_leave_policy,
    'owner_chat_set', coalesce(s.owner_telegram_chat_id, '') <> '', 'owner_chat_verified', private.owner_private_chat() is not null,
    'owner_chat_check', s.owner_chat_check, 'owner_chat_verified_at', s.owner_chat_verified_at,
    'next_sunday', v_sun, 'next_week_start', v_sun - 7, 'next_week_end', v_sun - 1,
    'payroll_next_month', private.period_of(v_today), 'payroll_next_send_date', (private.period_of(v_today) + interval '1 month')::date,
    'payroll_open_items', private.payroll_month_open_items((private.period_of(v_today) - interval '1 month')::date),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'key', r.report_key, 'version', r.version, 'created_at', r.created_at,
        'parts', cardinality(r.parts),
        'status', (select case when bool_and(o.status = 'sent') then 'sent'
                               when bool_or(o.last_error like 'uncertain:%') then 'uncertain'
                               when bool_or(o.status = 'dead') then 'failed'
                               else 'pending' end from public.notification_outbox o where o.dedupe_key like 'report:' || r.id || ':%'),
        'error', (select left(regexp_replace(o.last_error, '[0-9]{6,}', '…', 'g'), 120) from public.notification_outbox o
                   where o.dedupe_key like 'report:' || r.id || ':%' and o.status in ('dead', 'failed') limit 1)) order by r.created_at desc)
      from (select * from private.owner_reports order by created_at desc limit 15) r), '[]'::jsonb),
    'blocked_jobs', coalesce((select jsonb_agg(jsonb_build_object('job', j.job_name, 'key', j.run_key, 'detail', j.detail - 'lines') order by j.finished_at desc)
      from (select * from public.job_runs where job_name in ('sunday_summary', 'payroll_summary') and status = 'failed'
             order by finished_at desc nulls last limit 5) j), '[]'::jsonb),
    'streaks', coalesce((select jsonb_agg(jsonb_build_object('name', private.name_of(a.employee_id), 'dates', a.absent_dates, 'status', a.status,
        'alerted_at', a.alerted_at, 'reason', a.invalidated_reason) order by a.alerted_at desc)
      from (select * from public.absence_streak_alerts order by alerted_at desc limit 10) a), '[]'::jsonb));
end $$;

-- =====================================================================
-- tick(): existing jobs unchanged + the new schedules (all flag-gated)
-- =====================================================================
create or replace function private.tick()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings(); v_local timestamp := private.local_now(); v_today date := v_local::date;
  d date; v_out jsonb := '{}'::jsonb; v_target_dow int; v_week_start date; v_prev_month date; v_sun_start date; v_closed boolean;
begin
  update public.attendance_days set missing_checkout = true
   where checked_in_at is not null and checked_out_at is null and work_date < v_today and not missing_checkout;

  v_out := v_out || jsonb_build_object('reminders', private.enqueue_reminders());

  for d in select generate_series(greatest(v_today - 7, s.jobs_start_date), v_today, interval '1 day')::date loop
    if (d < v_today or v_local::time >= s.absence_cutoff) and not private.job_done('absence', d::text) then
      perform private.run_absence(d);
    end if;
    if s.digest_enabled and not private.job_done('digest', d::text) then
      if d = v_today and v_local::time >= s.digest_time then perform private.run_digest(d);
      elsif d < v_today then perform private.record_job('digest', d::text, 'skipped', jsonb_build_object('reason', 'scheduler missed the send time'));
      end if;
    end if;
  end loop;

  -- the old mid-week summary is replaced by the Sunday summary when that is on
  if s.weekly_summary_enabled and not s.sunday_summary_enabled then
    v_week_start := v_today - extract(dow from v_today)::int;
    v_target_dow := coalesce(s.weekly_summary_dow, (select max(day_of_week) from public.day_rules where is_work_day));
    if v_target_dow is not null and not private.job_done('weekly', v_week_start::text) and v_week_start + v_target_dow <= v_today
       and (v_week_start + v_target_dow < v_today or v_local::time >= s.weekly_summary_time) then
      perform private.run_weekly(v_week_start);
    end if;
    if (v_week_start - 7) >= s.jobs_start_date - 7 and not private.job_done('weekly', (v_week_start - 7)::text) then
      perform private.record_job('weekly', (v_week_start - 7)::text, 'skipped', jsonb_build_object('reason', 'scheduler missed the send time'));
    end if;
  end if;

  -- 6. Sunday summary of the previous CLOSED week (Sun..Sat). Sent on Sunday
  -- at the weekly summary time; after an outage it is still sent until
  -- Tuesday, never later (then recorded as skipped).
  if s.sunday_summary_enabled then
    v_sun_start := v_today - extract(dow from v_today)::int - 7;      -- previous week's Sunday
    if not private.job_done('sunday_summary', v_sun_start::text) and (extract(dow from v_today) > 0 or v_local::time >= s.weekly_summary_time) then
      if extract(dow from v_today) <= 2 then
        select bool_and(private.job_done('absence', g::date::text) or g::date < s.jobs_start_date) into v_closed
          from generate_series(v_sun_start, v_sun_start + 6, interval '1 day') g;
        if v_closed then perform private.run_sunday_summary(v_sun_start); end if;
      else
        perform private.record_job('sunday_summary', v_sun_start::text, 'skipped', jsonb_build_object('reason', 'missed: older than Tuesday'));
      end if;
    end if;
  end if;

  v_prev_month := private.period_of(v_today) - interval '1 month';
  if v_prev_month >= private.period_of(s.jobs_start_date) and not private.job_done('monthly', v_prev_month::text) then
    perform public.svc_payroll(null, jsonb_build_object('month', v_prev_month));
    perform private.record_job('monthly', v_prev_month::text, 'succeeded', '{}'::jsonb);
  end if;

  -- 7. payroll summary of the previous month, from the 1st at the set time,
  -- only once the month is closed (re-checked every minute; the "not final
  -- yet" notice is sent once). Only the immediately previous month.
  if s.payroll_summary_enabled and (extract(day from v_today) > 1 or v_local::time >= s.payroll_summary_time)
     and not private.job_done('payroll_summary', to_char(v_prev_month, 'YYYY-MM')) then
    perform private.run_payroll_summary(v_prev_month);
  end if;

  v_out := v_out || jsonb_build_object('scheduled_announcements', private.process_scheduled_announcements());
  return v_out;
end $$;

-- ------------------------------------------------ lock down EXECUTE again
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'svc\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname not in ('current_uid', 'is_owner') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
