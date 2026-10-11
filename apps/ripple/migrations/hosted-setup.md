# Hosted schema setup (`ripple_hosted`)

The hosted function never migrates. Apply this plan once, manually, with a privileged connection
(Supabase SQL editor, `psql`, or the Supabase MCP `execute_sql`/`apply_migration`). Do not use `public`:
it holds legacy fixture rows.

Migrations 001-004 contain unqualified table names, so run each file with `search_path` set to the new schema
in the SAME session/transaction:

```sql
CREATE SCHEMA IF NOT EXISTS ripple_hosted;
SET search_path TO ripple_hosted;
-- then paste/run, in order, in this same session:
--   apps/ripple/migrations/001_ripple.sql
--   apps/ripple/migrations/002_supabase_security.sql
--   apps/ripple/migrations/003_local_simulated_tickets.sql
--   apps/ripple/migrations/004_local_mode_isolation.sql
RESET search_path;
```

With psql from the repository root (`$DATABASE_URL` is a privileged connection string):

```sh
{ echo 'CREATE SCHEMA IF NOT EXISTS ripple_hosted; SET search_path TO ripple_hosted;'
  cat apps/ripple/migrations/00{1,2,3,4}_*.sql; } | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction
```

Then verify: `SELECT table_name FROM information_schema.tables WHERE table_schema='ripple_hosted';`
should list the ripple_* tables, and `public` must be unchanged. Review 002/004 first: if they reference
`public.` or fixed schema names, edit the copy you run (the local app does the same per-schema replay).
The Supabase API roles (`anon`, `authenticated`) must have no grants on `ripple_hosted`; do not add
`ripple_hosted` to the exposed API schemas.

Note: 004 also creates the three local-mode schemas (`ripple_fixture`, `ripple_live_preview`, `ripple_read_only`) and
revokes PUBLIC on them. Harmless if they already exist; skip 004 if you want only `ripple_hosted`.
