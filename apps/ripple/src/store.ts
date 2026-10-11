import type { Plan, Ledger } from './types.ts';
export interface SQL {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
}
export interface Database {
  connection<T>(fn: (sql: SQL) => Promise<T>): Promise<T>;
}
export class Store {
  db: Database;
  constructor(db: Database) { this.db = db; }
  async transaction<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
    return this.db.connection(async sql => {
      await sql.query('BEGIN');
      try { const value = await fn(sql); await sql.query('COMMIT'); return value; }
      catch (error) { await sql.query('ROLLBACK'); throw error; }
    });
  }
  async plan(sql: SQL, workspace: string, id: string, lock = false): Promise<Plan | null> {
    const { rows } = await sql.query('SELECT * FROM ripple_plans WHERE workspace=$1 AND plan_id=$2' + (lock ? ' FOR UPDATE' : ''), [workspace, id]);
    const row = rows[0];
    return row ? { workspace: row.workspace, actorId: row.actor_id, startingIssue: row.starting_issue,
      response: row.response, state: row.state, decision: row.decision, result: row.result } : null;
  }
  async save(sql: SQL, plan: Plan): Promise<void> {
    await sql.query(`INSERT INTO ripple_plans (workspace,plan_id,actor_id,starting_issue,response,state,decision,result)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (workspace,plan_id) DO UPDATE
      SET response=EXCLUDED.response,state=EXCLUDED.state,decision=EXCLUDED.decision,result=EXCLUDED.result`,
    [plan.workspace, plan.response.action_graph!.plan_id, plan.actorId, plan.startingIssue,
      JSON.stringify(plan.response), plan.state, JSON.stringify(plan.decision), JSON.stringify(plan.result)]);
  }
  async ledger(sql: SQL, workspace: string, key: string): Promise<Ledger | null> {
    const row = (await sql.query('SELECT * FROM ripple_actions WHERE workspace=$1 AND action_key=$2', [workspace, key])).rows[0];
    return row ? { workspace: row.workspace, key: row.action_key, fingerprint: row.fingerprint,
      input: row.input, state: row.state, native: row.native, error: row.error } : null;
  }
  async putLedger(sql: SQL, row: Ledger): Promise<void> {
    await sql.query(`INSERT INTO ripple_actions (workspace,action_key,fingerprint,input,state,native,error)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace,action_key) DO UPDATE
      SET state=EXCLUDED.state,native=EXCLUDED.native,error=EXCLUDED.error,updated_at=now()`,
    [row.workspace, row.key, row.fingerprint, JSON.stringify(row.input), row.state, JSON.stringify(row.native), JSON.stringify(row.error)]);
  }
}
