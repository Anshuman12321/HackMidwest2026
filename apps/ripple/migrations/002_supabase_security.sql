-- Plans, actor tokens and write ledgers are server-only. No browser policies.
ALTER TABLE ripple_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ripple_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ripple_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ripple_actions ENABLE ROW LEVEL SECURITY;
-- These roles exist on Supabase, but not necessarily standalone PostgreSQL.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON ripple_plans, ripple_decisions, ripple_jobs, ripple_actions FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
