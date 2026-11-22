-- @remote-only (pg_net is a hosted Supabase extension)
-- pg_net: async HTTP from Postgres. Used by scheduled jobs (pg_cron →
-- Edge Functions) and by server-side integration tests.
create extension if not exists pg_net;
