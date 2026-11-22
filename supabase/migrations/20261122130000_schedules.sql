-- @remote-only (needs pg_cron, pg_net and Supabase Vault)
-- =====================================================================
-- Zintra حاضر — schedules
--   zh-tick      every minute: private.tick() (absence, digest, weekly,
--                monthly deductions, reminders, missing check-outs)
--   zh-dispatch  every minute: if the outbox has due messages, POST to
--                the `dispatch` Edge Function with a token from Vault.
-- Run records live in public.job_runs; catch-up is handled by tick().
-- =====================================================================
create extension if not exists pg_cron;

-- One random token, kept in Vault, proves to the dispatch function that
-- the call comes from this database. Never leaves the server.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'zh_cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'zh_cron_token', 'Zintra حاضر dispatcher token');
  end if;
end $$;

create or replace function public.svc_verify_cron(p_token text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'zh_cron_token' and decrypted_secret = p_token)
$$;
revoke all on function public.svc_verify_cron(text) from public, anon, authenticated;
grant execute on function public.svc_verify_cron(text) to service_role;

create or replace function private.call_dispatch()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not exists (select 1 from public.notification_outbox where status in ('pending', 'failed') and next_attempt_at <= now()) then
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

select cron.schedule('zh-tick', '* * * * *', $$select private.tick()$$);
select cron.schedule('zh-dispatch', '* * * * *', $$select private.call_dispatch()$$);
