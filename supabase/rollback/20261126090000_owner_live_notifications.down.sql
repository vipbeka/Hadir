-- Rollback of 20261126090000_owner_live_notifications
create or replace function private.enqueue_owner_alert(p_event text, p_dedupe text, p_payload jsonb, p_ref text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.settings := private.settings();
begin
  if s.owner_alert_channel <> 'telegram' or not (p_event = any (s.notify_events))
     or nullif(btrim(coalesce(s.owner_telegram_chat_id, '')), '') is null then
    return;
  end if;
  insert into public.notification_outbox (dedupe_key, event_type, event_ref, channel, recipient, payload)
  values (p_dedupe || ':telegram:' || s.owner_telegram_chat_id, p_event, p_ref, 'telegram', s.owner_telegram_chat_id, p_payload)
  on conflict (dedupe_key) do nothing;
end $$;
drop function if exists public.svc_owner_alert_prefs(uuid, jsonb), public.svc_owner_notify_status(uuid, jsonb),
  public.svc_owner_notify_test(uuid, jsonb), public.svc_owner_notify_log(uuid, jsonb),
  private.owner_fanout(text, text, text, jsonb, text, boolean), private.owner_pref(text, text),
  private.late_minutes(date, time), private.ar_date(date);
drop table if exists public.owner_notifications;
drop index if exists public.outbox_subject;
alter table public.notification_outbox drop column if exists subject_id;
alter table public.settings drop column if exists owner_alert_prefs;
