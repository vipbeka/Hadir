-- @remote-only (needs pg_net and Supabase Vault)
-- The dispatcher also runs once when the owner's Telegram chat has not been
-- checked yet, so Telegram can confirm it is a private chat (getChat).
-- A failed check is not retried every minute: the owner can verify at any
-- time by sending any message to the bot from that private chat.
create or replace function private.call_dispatch()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not exists (select 1 from public.notification_outbox where status in ('pending', 'failed') and next_attempt_at <= now())
     and not exists (select 1 from public.settings s where s.id and s.owner_chat_check is null
                       and public.svc_owner_chat_needs_check() is not null) then
    return null;
  end if;
  select net.http_post(
    url := 'https://hppcujuplyjkuaxwmjhk.supabase.co/functions/v1/dispatch',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-zh-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'zh_cron_token')),
    timeout_milliseconds := 55000) into v_id;
  return v_id;
end $$;
revoke all on function private.call_dispatch() from public, anon, authenticated;
