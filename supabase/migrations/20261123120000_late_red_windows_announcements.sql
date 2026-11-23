-- =====================================================================
-- Late window → red point, atomic multi-day save, weekly summary day
-- default, provisional (lunar) holidays, announcement titles + deletion.
-- Non-destructive: no table/column/function is removed.
-- =====================================================================

-- (1) Per-window red point. A window awards green, red, or nothing —
--     never both. evaluate_time honours it (still one point per day:
--     the check-in uses one dedupe key).
alter table public.check_in_windows add column if not exists awards_red_point boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'check_in_windows_one_point_kind') then
    alter table public.check_in_windows add constraint check_in_windows_one_point_kind
      check (not (awards_green_point and awards_red_point));
  end if;
end $$;

create or replace function private.evaluate_time(d date, t time)
returns table (outcome text, window_id uuid, label_ar text, label_en text, config_warning boolean)
language plpgsql stable security definer set search_path = '' as $$
declare w record; v_last time;
begin
  select max(cw.end_time) into v_last from public.check_in_windows cw
   where cw.day_of_week = extract(dow from d) and cw.enabled;
  if v_last is null then
    return query select 'none'::text, null::uuid, null::text, null::text, true; return;
  end if;
  for w in select * from public.check_in_windows cw
            where cw.day_of_week = extract(dow from d) and cw.enabled order by cw.start_time loop
    if t >= w.start_time and t < w.end_time then
      return query select case when w.awards_green_point then 'green' when w.awards_red_point then 'red' else 'none' end,
                          w.id, w.label_ar, w.label_en, false;
      return;
    end if;
  end loop;
  if t >= v_last then
    return query select 'red'::text, null::uuid, null::text, null::text, false;
  else
    return query select 'none'::text, null::uuid, null::text, null::text, false;
  end if;
end $$;

-- (2) Save several days in ONE transaction (all or nothing). Each day goes
--     through svc_save_day (validation + audit), then the red flags are set.
--     A window that omits its point flags inherits them from the existing
--     window with the same Arabic label (the bot's «مواعيد النوافذ» flow),
--     so editing times never resets a flag the owner turned off.
create or replace function public.svc_save_days(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d jsonb; w jsonb; v_dow smallint; v_wins jsonb; old record; v_out jsonb := '[]'::jsonb; v_seen int[] := '{}';
begin
  if jsonb_typeof(p -> 'days') <> 'array' or jsonb_array_length(p -> 'days') = 0 then perform private.err('invalid_day'); end if;
  for d in select * from jsonb_array_elements(p -> 'days') loop
    v_dow := (d ->> 'day_of_week')::smallint;
    if v_dow is null or v_dow not between 0 and 6 or v_dow = any (v_seen) then perform private.err('invalid_day'); end if;
    v_seen := v_seen || v_dow::int;
    if d ? 'windows' then
      if jsonb_typeof(d -> 'windows') <> 'array' then perform private.err('invalid_window'); end if;
      v_wins := '[]'::jsonb;
      for w in select * from jsonb_array_elements(d -> 'windows') loop
        select cw.awards_green_point, cw.awards_red_point into old from public.check_in_windows cw
         where cw.day_of_week = v_dow and cw.label_ar = btrim(w ->> 'label_ar') limit 1;
        w := w || jsonb_build_object(
          'awards_green_point', coalesce((w ->> 'awards_green_point')::boolean,
              case when (w ->> 'awards_red_point')::boolean then false end, old.awards_green_point, true),
          'awards_red_point', coalesce((w ->> 'awards_red_point')::boolean,
              case when (w ->> 'awards_green_point')::boolean then false end, old.awards_red_point, false));
        if (w ->> 'awards_green_point')::boolean and (w ->> 'awards_red_point')::boolean then
          perform private.err('invalid_window', jsonb_build_object('reason', 'green_and_red'));
        end if;
        v_wins := v_wins || jsonb_build_array(w);
      end loop;
      d := jsonb_set(d, '{windows}', v_wins);
    end if;
    perform public.svc_save_day(p_actor, d);
    if d ? 'windows' then
      for w in select * from jsonb_array_elements(d -> 'windows') loop
        update public.check_in_windows set awards_red_point = (w ->> 'awards_red_point')::boolean
         where day_of_week = v_dow and start_time = (w ->> 'start')::time
           and awards_red_point is distinct from (w ->> 'awards_red_point')::boolean;
      end loop;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('rule', (select to_jsonb(r) from public.day_rules r where r.day_of_week = v_dow),
      'windows', coalesce((select jsonb_agg(to_jsonb(x) order by x.start_time) from public.check_in_windows x where x.day_of_week = v_dow), '[]'::jsonb)));
  end loop;
  perform private.audit(p_actor, 'day_rules.save_all', 'day_rules', array_to_string(v_seen, ','), null, v_out);
  return jsonb_build_object('days', v_out);
end $$;

-- (3) Weekly summary day: always an explicit day 0–6 (no hidden NULL).
--     Persist the current effective value (the last work day) once.
update public.settings s set weekly_summary_dow = (select max(day_of_week) from public.day_rules where is_work_day)
 where s.id and s.weekly_summary_dow is null and exists (select 1 from public.day_rules where is_work_day);
alter table public.settings alter column weekly_summary_dow set default 4;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_weekly_summary_dow_required') then
    alter table public.settings add constraint settings_weekly_summary_dow_required check (weekly_summary_dow is not null) not valid;
    alter table public.settings validate constraint settings_weekly_summary_dow_required;
  end if;
end $$;

-- (4) Holidays: provisional flag + source note. Lunar (Hijri) dates for
--     2027 are astronomical estimates until Dar al-Ifta / the Cabinet
--     announce them; they stay enabled (so nobody gets an absence on an
--     Eid) but are shown as «تقديري».
alter table public.public_holidays add column if not exists provisional boolean not null default false;
alter table public.public_holidays add column if not exists source_note text check (source_note is null or char_length(source_note) <= 500);

-- Idempotent 2027 official list: insert only missing dates, never touch
-- an existing row (manual / company holidays and owner edits are kept).
insert into public.public_holidays (holiday_date, name_ar, name_en, kind, enabled, provisional, source_note)
select v.d::date, v.ar, v.en, 'official', true, v.prov, v.src
from (values
  ('2027-01-07', 'عيد الميلاد المجيد', 'Coptic Christmas', false, 'fixed date'),
  ('2027-01-25', 'عيد الشرطة وثورة 25 يناير', 'Police Day & 25 January Revolution', false, 'fixed date'),
  ('2027-03-10', 'عيد الفطر (اليوم الأول)', 'Eid al-Fitr (day 1)', true, 'astronomical estimate (NRIAG); awaiting Dar al-Ifta'),
  ('2027-03-11', 'عيد الفطر (اليوم الثاني)', 'Eid al-Fitr (day 2)', true, 'astronomical estimate (NRIAG); awaiting Dar al-Ifta'),
  ('2027-03-12', 'عيد الفطر (اليوم الثالث)', 'Eid al-Fitr (day 3)', true, 'astronomical estimate (NRIAG); awaiting Dar al-Ifta'),
  ('2027-04-25', 'عيد تحرير سيناء', 'Sinai Liberation Day', false, 'fixed date'),
  ('2027-05-01', 'عيد العمال', 'Labour Day', false, 'fixed date'),
  ('2027-05-03', 'شم النسيم', 'Sham El-Nessim', false, 'day after Orthodox Easter (2 May 2027)'),
  ('2027-05-16', 'وقفة عرفات', 'Arafat Day', true, 'astronomical estimate; awaiting Dar al-Ifta'),
  ('2027-05-17', 'عيد الأضحى (اليوم الأول)', 'Eid al-Adha (day 1)', true, 'astronomical estimate; awaiting Dar al-Ifta'),
  ('2027-05-18', 'عيد الأضحى (اليوم الثاني)', 'Eid al-Adha (day 2)', true, 'astronomical estimate; awaiting Dar al-Ifta'),
  ('2027-05-19', 'عيد الأضحى (اليوم الثالث)', 'Eid al-Adha (day 3)', true, 'astronomical estimate; awaiting Dar al-Ifta'),
  ('2027-06-06', 'رأس السنة الهجرية', 'Islamic New Year', true, 'astronomical estimate; awaiting Dar al-Ifta'),
  ('2027-06-30', 'ذكرى ثورة 30 يونيو', '30 June Revolution', false, 'fixed date'),
  ('2027-07-23', 'عيد ثورة 23 يوليو', '23 July Revolution Day', false, 'fixed date'),
  ('2027-08-15', 'المولد النبوي الشريف', 'Prophet''s Birthday', true, 'astronomical estimate; awaiting Dar al-Ifta'),
  ('2027-10-06', 'عيد القوات المسلحة', 'Armed Forces Day', false, 'fixed date')
) as v(d, ar, en, prov, src)
on conflict (holiday_date) do nothing;

-- Mark the seeded lunar 2027 rows provisional — only official rows whose
-- name is still the seeded one (an owner-renamed or company row is kept).
update public.public_holidays h
   set provisional = true, source_note = coalesce(h.source_note, 'astronomical estimate; awaiting Dar al-Ifta')
 where h.kind = 'official' and not h.provisional
   and (h.holiday_date, h.name_ar) in (
     ('2027-03-10', 'عيد الفطر (اليوم الأول)'), ('2027-03-11', 'عيد الفطر (اليوم الثاني)'), ('2027-03-12', 'عيد الفطر (اليوم الثالث)'),
     ('2027-05-16', 'وقفة عرفات'), ('2027-05-17', 'عيد الأضحى (اليوم الأول)'), ('2027-05-18', 'عيد الأضحى (اليوم الثاني)'),
     ('2027-05-19', 'عيد الأضحى (اليوم الثالث)'), ('2027-06-06', 'رأس السنة الهجرية'), ('2027-08-15', 'المولد النبوي الشريف'));
update public.public_holidays h set source_note = 'fixed date'
 where h.kind = 'official' and h.source_note is null and extract(year from h.holiday_date) = 2027 and not h.provisional;

-- Owner can confirm a provisional date (save_holiday with provisional=false).
create or replace function public.svc_save_holiday(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.public_holidays; a public.public_holidays; v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  if v_id is not null then select * into b from public.public_holidays where id = v_id for update; end if;
  begin
    if v_id is null then
      insert into public.public_holidays (holiday_date, name_ar, name_en, kind, enabled)
      values ((p ->> 'holiday_date')::date, btrim(p ->> 'name_ar'), btrim(p ->> 'name_en'),
              coalesce((p ->> 'kind')::public.holiday_kind, 'company'), coalesce((p ->> 'enabled')::boolean, true))
      returning * into a;
    else
      update public.public_holidays set
        holiday_date = coalesce((p ->> 'holiday_date')::date, holiday_date),
        name_ar = coalesce(btrim(p ->> 'name_ar'), name_ar), name_en = coalesce(btrim(p ->> 'name_en'), name_en),
        enabled = coalesce((p ->> 'enabled')::boolean, enabled),
        provisional = coalesce((p ->> 'provisional')::boolean, provisional)
      where id = v_id returning * into a;
      if a.id is null then perform private.err('not_found'); end if;
    end if;
  exception
    when unique_violation then perform private.err('holiday_exists');
    when check_violation or not_null_violation or invalid_datetime_format then perform private.err('invalid_holiday');
  end;
  perform private.audit(p_actor, case when v_id is null then 'holiday.create' else 'holiday.update' end,
    'public_holidays', a.id::text, to_jsonb(b), to_jsonb(a));
  return to_jsonb(a);
end $$;

-- (5) Announcements: optional title, owner list, owner delete (physical
--     delete — the project has no soft delete). Same records for the web
--     panel and the Telegram bot.
alter table public.announcements add column if not exists title text check (title is null or char_length(title) between 1 and 120);

create or replace function private.is_active_owner(p_actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = p_actor and role = 'owner' and active)
$$;

create or replace function public.svc_broadcast(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_body text := btrim(coalesce(p ->> 'text', '')); v_title text := nullif(btrim(coalesce(p ->> 'title', '')), '');
  v_id uuid; emp record; v_n int := 0; v_people int := 0;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  if char_length(v_body) not between 1 and 1000 then perform private.err('invalid_text'); end if;
  if v_title is not null and char_length(v_title) > 120 then perform private.err('invalid_text'); end if;
  insert into public.announcements (body, title, created_by) values (v_body, v_title, p_actor) returning id into v_id;
  for emp in select id from public.profiles where role = 'staff' and active loop
    v_people := v_people + 1;
    v_n := v_n + private.enqueue_push(emp.id, 'announcement', v_id::text, coalesce('حاضر — ' || v_title, 'حاضر — إعلان'), left(v_body, 240),
                                      coalesce('Hadir — ' || v_title, 'Hadir — Announcement'), left(v_body, 240), false);
  end loop;
  perform private.audit(p_actor, 'announcement.send', 'announcements', v_id::text, null,
    jsonb_build_object('title', v_title, 'body', v_body, 'devices', v_n));
  return jsonb_build_object('id', v_id, 'people', v_people, 'devices', v_n);
end $$;

-- Newest first, id as the tie-break (same order everywhere).
create or replace function public.svc_list_announcements(p_actor uuid, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100); v_off int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  return jsonb_build_object('total', (select count(*) from public.announcements),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id desc) from (
      select a.id, a.title, a.body, a.created_at, private.name_of(a.created_by) as created_by_name
        from public.announcements a order by a.created_at desc, a.id desc limit v_limit offset v_off) x), '[]'::jsonb));
end $$;

-- Delete one announcement. Idempotent: an already-deleted id returns
-- deleted=false (the caller shows «اتمسح قبل كده»). Queued, unsent push
-- notifications for it are cancelled; delivered Telegram/chat history is
-- never touched.
create or replace function public.svc_delete_announcement(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; b public.announcements;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_id := (p ->> 'id')::uuid; exception when others then perform private.err('not_found'); end;
  if v_id is null then perform private.err('not_found'); end if;
  delete from public.announcements where id = v_id returning * into b;
  if b.id is null then return jsonb_build_object('id', v_id, 'deleted', false); end if;
  update public.notification_outbox set status = 'skipped', last_error = 'announcement deleted'
   where event_type = 'announcement' and status in ('pending', 'failed') and dedupe_key like 'announcement:' || v_id::text || ':%';
  perform private.audit(p_actor, 'announcement.delete', 'announcements', v_id::text, to_jsonb(b), null, p ->> 'via');
  return jsonb_build_object('id', v_id, 'deleted', true);
end $$;

-- (6) Bot settings snapshot also reports the red flag.
create or replace function public.svc_bot_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'geofence_lat', s.geofence_lat, 'geofence_lng', s.geofence_lng, 'radius_m', s.geofence_radius_m,
    'reward_piastres', s.reward_amount_piastres, 'threshold', s.green_reward_threshold,
    'work_end', private.fmt12(s.work_end_time, 'ar'), 'notify_events', to_jsonb(s.notify_events),
    'work_days', coalesce((select jsonb_agg(r.day_of_week order by r.day_of_week) from public.day_rules r where r.is_work_day), '[]'::jsonb),
    'windows', coalesce((select jsonb_agg(jsonb_build_object('label_ar', w.label_ar, 'label_en', w.label_en, 'start', to_char(w.start_time, 'HH24:MI'),
        'end', to_char(w.end_time, 'HH24:MI'), 'green', w.awards_green_point, 'red', w.awards_red_point) order by w.start_time)
      from public.check_in_windows w where w.enabled and w.day_of_week = (select min(r.day_of_week) from public.day_rules r where r.is_work_day)), '[]'::jsonb))
  from public.settings s where s.id
$$;

-- (7) Owner decision (documented in the QA report): the «متأخر» window on
--     every work day gives a RED point, not green. Timing is unchanged.
do $$
declare b jsonb; a jsonb; v_owner uuid := (select id from public.profiles where role = 'owner' and active order by created_at limit 1);
begin
  select jsonb_agg(to_jsonb(w) order by w.day_of_week) into b from public.check_in_windows w
   where w.label_ar = 'متأخر' and w.day_of_week in (select day_of_week from public.day_rules where is_work_day);
  update public.check_in_windows w set awards_green_point = false, awards_red_point = true
   where w.label_ar = 'متأخر' and w.day_of_week in (select day_of_week from public.day_rules where is_work_day)
     and (w.awards_green_point or not w.awards_red_point);
  select jsonb_agg(to_jsonb(w) order by w.day_of_week) into a from public.check_in_windows w
   where w.label_ar = 'متأخر' and w.day_of_week in (select day_of_week from public.day_rules where is_work_day);
  if b is distinct from a then
    perform private.audit(v_owner, 'day_rules.late_red', 'check_in_windows', 'late', b, a, 'QA: late window awards a red point');
  end if;
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
