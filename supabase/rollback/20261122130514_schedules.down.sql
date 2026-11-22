-- @remote-only
-- Rollback of schedules
select cron.unschedule('zh-tick');
select cron.unschedule('zh-dispatch');
drop function if exists private.call_dispatch();
drop function if exists public.svc_verify_cron(text);
-- the Vault secret 'zh_cron_token' is left in place (harmless); delete it in the Dashboard if wanted
