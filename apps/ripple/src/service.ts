import { createHash, randomUUID } from 'node:crypto';
import {
  InvestigationRequestSchema, InvestigationResponseSchema, RevisePlanRequestSchema,
  PlanDecisionRequestSchema, ExecutionResultSchema,
} from '../../../contracts/investigation.ts';
import type { InvestigationResponse, ExecutionResult, PlanDecisionRequest } from '../../../contracts/investigation.ts';
import { applyOwnerAssignments, assertDecisionMatches, assertExecutionMatches, canonicalJson, sealPlan } from '../../../contracts/review.server.ts';
import { Store } from './store.ts';
import type { SQL } from './store.ts';
import { Secrets } from './security.ts';
import { RippleError, ticketInput } from './types.ts';
import type { Auth, Investigator, NativeGateway, Plan, Failure, Ledger } from './types.ts';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const ambiguous: Failure = { code: 'ambiguous_write', message: 'The write may have completed. Check write status before retrying.', retry: 'reconcile_first' };
const skipped: Failure = { code: 'blocked', message: 'This ticket has not been attempted.', retry: 'safe' };
export function failure(error: unknown): Failure {
  if (error instanceof RippleError) return error.failure;
  const text = error instanceof Error ? error.message : '';
  const code = text.includes('expired') ? 'expired_plan' : text.includes('Stale') || text.includes('digest') ? 'stale_plan'
    : text.includes('owner') ? 'missing_owner' : text.includes('blocking') ? 'blocked' : 'invalid_request';
  return { code, message: code === 'invalid_request' ? 'The request could not be validated.' : text, retry: 'never' };
}
export class RippleService {
  store: Store; native: NativeGateway; agent: Investigator; secrets: Secrets;
  constructor(store: Store, native: NativeGateway, agent: Investigator, secrets: Secrets) {
    this.store = store; this.native = native; this.agent = agent; this.secrets = secrets;
  }
  async load(sql: SQL, auth: Auth, id: string, lock = false): Promise<Plan> {
    const plan = await this.store.plan(sql, auth.workspace, id, lock);
    if (!plan || plan.actorId !== auth.actorId) throw new RippleError('not_found', 'This review is not available to this user.');
    plan.response = InvestigationResponseSchema.parse(plan.response);
    return plan;
  }
  async read(auth: Auth, id: string): Promise<Plan> {
    const plan = await this.store.db.connection(sql => this.load(sql, auth, id));
    await this.native.authorize(auth, plan.response, plan.startingIssue, false);
    return plan;
  }
  async investigate(auth: Auth, raw: unknown): Promise<InvestigationResponse> {
    const request = InvestigationRequestSchema.parse(raw);
    const issue = request.scope_hints.starting_object;
    if (!issue || !/:issue\/[^/]+$/.test(issue.id)) throw new RippleError('invalid_request', 'Start Ripple from a native issue brief.');
    const response = InvestigationResponseSchema.parse(await this.agent.investigate(request, auth));
    if (!response.context_bundle.entities.some(e => e.kind === 'issue' && e.native?.id === issue.id))
      throw new RippleError('invalid_response', 'The investigation omitted the starting issue.');
    if (response.request_id !== request.request_id || response.outcome.statement !== request.outcome ||
        canonicalJson(response.outcome.constraints) !== canonicalJson(request.constraints) ||
        (request.reference_time && response.outcome.reference_time !== request.reference_time))
      throw new RippleError('invalid_response', 'The investigation changed the requested outcome, constraints, or reference date.');
    if (response.action_graph) {
      // Server issues identities and expiry, then binds every reviewed field.
      response.action_graph.plan_id = randomUUID(); response.action_graph.revision = 1;
      response.action_graph.expires_at = new Date(Math.min(Date.parse(response.action_graph.expires_at), Date.now() + 30 * 60_000)).toISOString();
      if (Date.parse(response.action_graph.expires_at) <= Date.now()) throw new RippleError('invalid_response', 'The agent returned an expired plan.');
    }
    const sealed = sealPlan(response);
    await this.native.authorize(auth, sealed, issue.id, false);
    await this.agent.revalidate(sealed, auth);
    if (sealed.action_graph) await this.store.transaction(sql => this.store.save(sql, {
      workspace: auth.workspace, actorId: auth.actorId, startingIssue: issue.id,
      response: sealed, state: 'review', decision: null, result: null,
    }));
    return sealed;
  }
  async revise(auth: Auth, raw: unknown): Promise<InvestigationResponse> {
    const request = RevisePlanRequestSchema.parse(raw);
    return this.store.transaction(async sql => {
      const plan = await this.load(sql, auth, request.plan_id, true);
      if (plan.state !== 'review') throw new RippleError('stale_plan', 'This revision is locked by its decision.');
      const revised = applyOwnerAssignments(plan.response, request, new Date());
      await this.native.authorize(auth, revised, plan.startingIssue, false);
      await this.agent.revalidate(revised, auth);
      plan.response = revised; await this.store.save(sql, plan); return revised;
    });
  }
  async decide(auth: Auth, raw: unknown): Promise<Plan> {
    const request = PlanDecisionRequestSchema.parse(raw);
    return this.store.transaction(async sql => {
      const plan = await this.load(sql, auth, request.plan_id, true);
      const previous = (await sql.query(`SELECT * FROM ripple_decisions WHERE workspace=$1 AND plan_id=$2 AND decision_key=$3`,
        [auth.workspace, request.plan_id, request.idempotency_key])).rows[0];
      await this.native.authorize(auth, plan.response, plan.startingIssue, false);
      if (previous) {
        if (previous.request_hash !== hash(request)) throw new RippleError('idempotency_conflict', 'This decision key belongs to a different request.');
        return plan;
      }
      if (plan.state !== 'review') throw new RippleError('stale_plan', 'This plan already has a decision. Open its recorded result.');
      assertDecisionMatches(plan.response, request, new Date());
      if (request.decision === 'approve') {
        await this.native.authorize(auth, plan.response, plan.startingIssue, true);
        await this.agent.revalidate(plan.response, auth);
        for (const action of plan.response.action_graph!.actions) {
          const old = await this.store.ledger(sql, auth.workspace, action.action_key);
          if (old && old.fingerprint !== hash(ticketInput(plan.response, action))) throw new RippleError('action_conflict', 'Existing work differs from this proposed ticket. Generate a fresh plan.');
        }
      }
      // Access/freshness checks may take time; expiry must still hold at receipt issuance.
      assertDecisionMatches(plan.response, request, new Date());
      const graph = plan.response.action_graph!;
      const receipt = request.decision === 'approve' ? {
        approval_id: randomUUID(), actor_id: auth.actorId, recorded_at: new Date().toISOString(), plan_digest: graph.plan_digest,
      } : null;
      plan.state = request.decision === 'approve' ? 'approved' : 'rejected'; plan.decision = request;
      if (!receipt) plan.result = ExecutionResultSchema.parse({ schema_version: '2.0',
        investigation_id: plan.response.investigation_id, plan_id: graph.plan_id, revision: graph.revision,
        plan_digest: graph.plan_digest, idempotency_key: request.idempotency_key, approval: null, status: 'rejected', results: [], error: null });
      await sql.query(`INSERT INTO ripple_decisions (workspace,plan_id,decision_key,request_hash,request,receipt) VALUES ($1,$2,$3,$4,$5,$6)`,
        [auth.workspace, graph.plan_id, request.idempotency_key, hash(request), JSON.stringify(request), JSON.stringify(receipt)]);
      if (receipt) await sql.query(`INSERT INTO ripple_jobs (workspace,plan_id,actor_id,encrypted_token) VALUES ($1,$2,$3,$4)`,
        [auth.workspace, graph.plan_id, auth.actorId, this.secrets.encrypt(auth.token)]);
      await this.store.save(sql, plan); return plan;
    });
  }
  async executeAction(auth: Auth, plan: Plan, index: number, reconciliationOnly: boolean): Promise<ExecutionResult['results'][number]> {
    const action = plan.response.action_graph!.actions[index]!;
    const input = ticketInput(plan.response, action), fingerprint = hash(input);
    const success = (status: 'created' | 'reused', native: Ledger['native']) => ({ action_id: action.action_id, action_key: action.action_key, status, native, error: null });
    const failed = (status: 'failed' | 'uncertain' | 'not_attempted', error: Failure) => ({ action_id: action.action_id, action_key: action.action_key, status, native: null, error });
    let ledger = await this.store.db.connection(sql => this.store.ledger(sql, auth.workspace, action.action_key));
    let writeStarted = false;
    if (ledger && ledger.fingerprint !== fingerprint) return failed('failed', { code: 'action_conflict', message: 'This action key has different approved content.', retry: 'never' });
    try {
      const found = await this.native.findTicket(auth, action.action_key);
      if (found) {
        if (hash(found.input) !== fingerprint) return failed('failed', { code: 'action_conflict', message: 'The native ticket differs from the approved preview.', retry: 'never' });
        ledger = { workspace: auth.workspace, key: action.action_key, fingerprint, input, state: 'done', native: found.native, error: null };
        await this.store.transaction(sql => this.store.putLedger(sql, ledger!));
        return success('reused', found.native);
      }
      if (ledger?.state === 'done') return failed('failed', { code: 'action_conflict', message: 'Recorded work is missing or no longer accessible. Review before creating more work.', retry: 'never' });
      if (ledger?.state === 'intent' || ledger?.state === 'uncertain') return failed('uncertain', ambiguous);
      if (reconciliationOnly) return failed(ledger?.state === 'failed' ? 'failed' : 'not_attempted', ledger?.error ?? skipped);
      const reserved = await this.store.transaction(async sql => {
        // Unique insert is the cross-plan fence. A crashed intent is never a create permission.
        const rows = (await sql.query(`INSERT INTO ripple_actions (workspace,action_key,fingerprint,input,state) VALUES ($1,$2,$3,$4,'intent')
          ON CONFLICT (workspace,action_key) DO NOTHING RETURNING action_key`, [auth.workspace, action.action_key, fingerprint, JSON.stringify(input)])).rows;
        if (rows.length) return true;
        const existing = await this.store.ledger(sql, auth.workspace, action.action_key);
        if (existing?.state !== 'failed' || existing.fingerprint !== fingerprint || existing.error?.retry === 'reconcile_first') return false;
        const updated = await sql.query(`UPDATE ripple_actions SET state='intent',error=NULL WHERE workspace=$1 AND action_key=$2 AND state='failed' RETURNING action_key`, [auth.workspace, action.action_key]);
        return updated.rows.length === 1;
      });
      if (!reserved) return failed('uncertain', ambiguous);
      ledger = { workspace: auth.workspace, key: action.action_key, fingerprint, input, state: 'intent', native: null, error: null };
      await this.native.authorize(auth, plan.response, plan.startingIssue, true);
      writeStarted = true;
      const created = await this.native.createTicket(auth, input);
      if (hash(created.input) !== fingerprint) throw new RippleError('ambiguous_write', 'The created ticket could not be matched to the approved content.', 'reconcile_first');
      ledger.state = 'done'; ledger.native = created.native;
      await this.store.transaction(sql => this.store.putLedger(sql, ledger!));
      return success('created', created.native);
    } catch (error) {
      const detail = failure(error);
      // Once create intent exists, an unexpected exception is uncertain unless the
      // gateway explicitly proves rejection. Storage errors after create also reconcile.
      const uncertain = detail.retry === 'reconcile_first' || (!(error instanceof RippleError) && writeStarted);
      const reason = uncertain ? ambiguous : detail;
      if (ledger && (ledger.state === 'intent' || uncertain)) {
        ledger.state = uncertain ? 'uncertain' : 'failed'; ledger.error = reason;
        try { await this.store.transaction(sql => this.store.putLedger(sql, ledger!)); } catch { /* Durable intent already fences a retry. */ }
      }
      return failed(uncertain ? 'uncertain' : 'failed', reason);
    }
  }
  async execute(auth: Auth, id: string, reconciliationOnly = false): Promise<ExecutionResult> {
    const plan = await this.read(auth, id);
    if (plan.state !== 'approved') throw new RippleError('blocked', 'Only an approved revision can execute.');
    if (plan.result && !reconciliationOnly) return plan.result;
    const decision = PlanDecisionRequestSchema.parse(plan.decision), graph = plan.response.action_graph!;
    const row = await this.store.db.connection(async sql => (await sql.query(`SELECT receipt FROM ripple_decisions WHERE workspace=$1 AND plan_id=$2 AND decision_key=$3`,
      [auth.workspace, id, decision.idempotency_key])).rows[0]);
    const receipt = row?.receipt;
    if (!receipt || receipt.actor_id !== auth.actorId || receipt.plan_digest !== graph.plan_digest ||
      Date.parse(receipt.recorded_at) >= Date.parse(graph.expires_at)) throw new RippleError('permission_denied', 'Approval receipt could not be verified.');
    let reason: Failure | null = null;
    try { await this.native.authorize(auth, plan.response, plan.startingIssue, true); await this.agent.revalidate(plan.response, auth); }
    catch (error) { reason = failure(error); }
    const results: ExecutionResult['results'] = [];
    for (let i = 0; i < graph.actions.length; i++) {
      const action = graph.actions[i]!;
      if (reason) {
        const old = await this.store.db.connection(sql => this.store.ledger(sql, auth.workspace, action.action_key));
        const matching = old?.fingerprint === hash(ticketInput(plan.response, action));
        results.push({ action_id: action.action_id, action_key: action.action_key,
          status: matching && old?.state === 'done' ? 'reused' : matching && ['intent', 'uncertain'].includes(old?.state ?? '') ? 'uncertain' : 'not_attempted',
          native: matching && old?.state === 'done' ? old.native : null,
          error: matching && old?.state === 'done' ? null : matching && ['intent', 'uncertain'].includes(old?.state ?? '') ? ambiguous : reason });
      }
      else results.push(await this.executeAction(auth, plan, i, reconciliationOnly));
    }
    const succeeded = results.filter(r => r.native).length;
    const error = reason ?? results.find(r => r.error)?.error ?? null;
    const status = succeeded === results.length ? 'completed' : succeeded ? 'partial' : reason ? 'blocked' : 'failed';
    const result = ExecutionResultSchema.parse({ schema_version: '2.0', investigation_id: plan.response.investigation_id,
      plan_id: id, revision: graph.revision, plan_digest: graph.plan_digest, idempotency_key: decision.idempotency_key,
      approval: receipt, status, results, error: status === 'completed' ? null : error });
    assertExecutionMatches(plan.response, result, decision);
    await this.store.transaction(async sql => {
      const current = await this.load(sql, auth, id, true);
      current.result = result; await this.store.save(sql, current);
      await sql.query(`UPDATE ripple_jobs SET state='done',encrypted_token='',lease_until=NULL WHERE workspace=$1 AND plan_id=$2`, [auth.workspace, id]);
    });
    return result;
  }
  async reconcile(auth: Auth, id: string): Promise<Plan> {
    const plan = await this.read(auth, id);
    if (plan.state === 'approved' && plan.result && plan.result.results.some(r => r.status === 'uncertain')) await this.execute(auth, id, true);
    return this.read(auth, id);
  }
  async workOnce(): Promise<boolean> {
    const job = await this.store.transaction(async sql => {
      const row = (await sql.query(`SELECT * FROM ripple_jobs WHERE state='pending' OR (state='running' AND lease_until<now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!row) return null;
      await sql.query(`UPDATE ripple_jobs SET state='running',lease_until=now()+interval '10 minutes' WHERE workspace=$1 AND plan_id=$2`, [row.workspace, row.plan_id]);
      return row;
    });
    if (!job) return false;
    try {
      const auth = await this.native.authenticate(this.secrets.decrypt(job.encrypted_token));
      if (auth.workspace !== job.workspace || auth.actorId !== job.actor_id) throw new RippleError('permission_denied', 'Execution identity changed.');
      await this.execute(auth, job.plan_id);
    } catch (error) {
      // Don't retain tokens or crash the queue forever. Existing intents still reconcile.
      await this.store.transaction(async sql => {
        const plan = await this.store.plan(sql, job.workspace, job.plan_id, true);
        if (!plan) return;
        const decision = PlanDecisionRequestSchema.parse(plan.decision), graph = plan.response.action_graph!;
        const receipt = (await sql.query('SELECT receipt FROM ripple_decisions WHERE workspace=$1 AND plan_id=$2 AND decision_key=$3', [job.workspace, job.plan_id, decision.idempotency_key])).rows[0]?.receipt;
        const results: ExecutionResult['results'] = [];
        for (const action of graph.actions) {
          const ledger = await this.store.ledger(sql, job.workspace, action.action_key);
          const done = ledger?.state === 'done';
          results.push({ action_id: action.action_id, action_key: action.action_key, status: done ? 'reused' : ledger?.state === 'intent' || ledger?.state === 'uncertain' ? 'uncertain' : 'not_attempted',
            native: done ? ledger.native : null, error: done ? null : ledger?.state === 'intent' || ledger?.state === 'uncertain' ? ambiguous : failure(error) });
        }
        const success = results.filter(r => r.native).length;
        plan.result = ExecutionResultSchema.parse({ schema_version: '2.0', investigation_id: plan.response.investigation_id, plan_id: graph.plan_id,
          revision: graph.revision, plan_digest: graph.plan_digest, idempotency_key: decision.idempotency_key, approval: receipt,
          status: success === results.length ? 'completed' : success ? 'partial' : 'blocked', results,
          error: success === results.length ? null : failure(error) });
        assertExecutionMatches(plan.response, plan.result, decision); await this.store.save(sql, plan);
        await sql.query(`UPDATE ripple_jobs SET state='done',encrypted_token='',lease_until=NULL WHERE workspace=$1 AND plan_id=$2`, [job.workspace, job.plan_id]);
      });
    }
    return true;
  }
}
