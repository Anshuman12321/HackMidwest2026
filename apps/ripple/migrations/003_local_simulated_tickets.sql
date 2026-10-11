-- Local preview adapters persist simulated native IDs separately from real work.
CREATE TABLE IF NOT EXISTS ripple_local_simulated_tickets (
  external_ref text PRIMARY KEY,
  ticket jsonb NOT NULL
);
ALTER TABLE ripple_local_simulated_tickets ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON ripple_local_simulated_tickets FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
