CREATE TABLE IF NOT EXISTS ripple_plans (
  workspace text NOT NULL, plan_id uuid NOT NULL, actor_id text NOT NULL,
  starting_issue text NOT NULL, response jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('review','approved','rejected')),
  decision jsonb, result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, plan_id)
);
CREATE TABLE IF NOT EXISTS ripple_decisions (
  workspace text NOT NULL, plan_id uuid NOT NULL, decision_key uuid NOT NULL,
  request_hash text NOT NULL, request jsonb NOT NULL, receipt jsonb,
  PRIMARY KEY (workspace, plan_id, decision_key),
  FOREIGN KEY (workspace, plan_id) REFERENCES ripple_plans(workspace, plan_id)
);
CREATE TABLE IF NOT EXISTS ripple_jobs (
  workspace text NOT NULL, plan_id uuid NOT NULL, actor_id text NOT NULL,
  encrypted_token text NOT NULL, state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','done')),
  lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, plan_id),
  FOREIGN KEY (workspace, plan_id) REFERENCES ripple_plans(workspace, plan_id)
);
CREATE TABLE IF NOT EXISTS ripple_actions (
  workspace text NOT NULL, action_key text NOT NULL, fingerprint text NOT NULL,
  input jsonb NOT NULL, state text NOT NULL CHECK (state IN ('intent','uncertain','done','failed')),
  native jsonb, error jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, action_key)
);
CREATE INDEX IF NOT EXISTS ripple_job_queue ON ripple_jobs (state, lease_until, created_at);
CREATE INDEX IF NOT EXISTS ripple_issue_reviews ON ripple_plans (workspace, actor_id, starting_issue, created_at DESC);
