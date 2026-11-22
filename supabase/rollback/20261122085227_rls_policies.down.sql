-- Rollback of 20261122085227_rls_policies (RLS stays ENABLED with no
-- policies, i.e. deny-all, until the core schema rollback drops tables)
do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname from pg_policies where schemaname = 'public'
  loop execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename); end loop;
end $$;
drop function if exists private.is_owner();
drop function if exists private.current_uid();
