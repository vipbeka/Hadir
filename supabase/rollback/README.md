# Rollback scripts

Supabase CLI migrations are forward-only. Each migration has a matching
`<version>_<name>.down.sql` here. To roll back, run the down files in
**reverse version order**, then remove the matching rows from
`supabase_migrations.schema_migrations`:

```bash
psql "$DB_URL" -f supabase/rollback/20261122085342_reference_data.down.sql
psql "$DB_URL" -c "delete from supabase_migrations.schema_migrations where version = '20261122085342'"
```

Rolling back `core_schema` deletes all application data. Take a backup first (see the main README).
`tools/sql-test/run.sh` checks up → down → up on a scratch Postgres.
