-- Rollback of 20261122085341_auth_and_admin_functions
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'svc\_%' or p.proname in ('get_server_time', 'get_app_config'))
  loop execute format('drop function %s', f.sig); end loop;
end $$;
drop function if exists private.business_today();
drop function if exists private.enqueue_owner_alert(text, text, jsonb, text);
drop function if exists private.audit(uuid, text, text, text, jsonb, jsonb, text, text);
drop function if exists private.settings();
