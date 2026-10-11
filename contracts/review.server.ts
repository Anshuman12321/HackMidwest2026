import { createHash } from 'node:crypto';
import {
  InvestigationResponseSchema, PlanDecisionRequestSchema, RevisePlanRequestSchema, ExecutionResultSchema,
  type InvestigationResponse, type PlanDecisionRequest, type RevisePlanRequest, type ExecutionResult,
} from './investigation.ts';

// Contract sorted-key JSON, UTF-8, no whitespace. Arrays retain their order.
// Only parsed contract data is permitted: no undefined, non-finite numbers, or Date objects.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(object[k])).join(',') + '}';
  }
  throw new Error('Review digests accept only plain JSON data');
}
export function reviewSnapshot(response: InvestigationResponse) {
  const { action_graph: graph } = response;
  if (!graph) throw new Error('No plan to review');
  const { plan_digest: _, ...plan } = graph;
  return {
    schema_version: response.schema_version,
    investigation_id: response.investigation_id,
    outcome: response.outcome,
    summary: response.summary,
    context_bundle: response.context_bundle,
    action_graph: plan,
  };
}
export function computePlanDigest(response: InvestigationResponse): string {
  return createHash('sha256').update(canonicalJson(reviewSnapshot(response)), 'utf8').digest('hex');
}
export function sealPlan(response: InvestigationResponse): InvestigationResponse {
  const parsed = InvestigationResponseSchema.parse(response);
  if (!parsed.action_graph) return parsed;
  parsed.action_graph.plan_digest = computePlanDigest(parsed);
  return parsed;
}

// Pure contract guard, NOT an approval authority or a write executor.
// The handler must load a trusted stored plan, authenticate the caller, validate
// current permissions/evidence freshness, and atomically enforce a durable ledger.
export function assertDecisionMatches(
  response: InvestigationResponse,
  decision: PlanDecisionRequest,
  now: Date,
): void {
  const r = InvestigationResponseSchema.parse(response);
  const d = PlanDecisionRequestSchema.parse(decision);
  const graph = r.action_graph;
  if (r.status !== 'review_required' || !graph) throw new Error('No reviewable plan');
  if (d.plan_id !== graph.plan_id || d.expected_revision !== graph.revision) throw new Error('Stale plan');
  const digest = computePlanDigest(r);
  if (graph.plan_digest !== digest || d.plan_digest !== digest) throw new Error('Plan digest mismatch');
  if (d.decision === 'reject') return;
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid server time');
  if (Date.parse(graph.expires_at) <= now.getTime()) throw new Error('Plan expired');
  if (graph.actions.some(a => !a.owner_id)) throw new Error('Select a current owner for every task');
  if (r.context_bundle.gaps.some(g => ['investigation', 'execution'].includes(g.blocks))) throw new Error('Unresolved blocking evidence gap');
}

// Caller must first verify each selected user is assignable in this workspace.
// A revision keeps the existing expiry; it cannot extend a plan's lifetime.
export function applyOwnerAssignments(
  response: InvestigationResponse, request: RevisePlanRequest, now: Date,
): InvestigationResponse {
  const r = InvestigationResponseSchema.parse(response);
  const q = RevisePlanRequestSchema.parse(request);
  const graph = r.action_graph;
  if (r.status !== 'review_required' || !graph) throw new Error('No reviewable plan');
  if (q.plan_id !== graph.plan_id || q.expected_revision !== graph.revision) throw new Error('Stale plan');
  if (graph.plan_digest !== computePlanDigest(r)) throw new Error('Plan digest mismatch');
  if (!Number.isFinite(now.getTime()) || Date.parse(graph.expires_at) <= now.getTime()) throw new Error('Plan expired');
  for (const assignment of q.owner_assignments) {
    const action = graph.actions.find(a => a.action_id === assignment.action_id);
    if (!action) throw new Error('Unknown action in owner assignment');
    action.owner_id = assignment.owner_id;
  }
  graph.revision++;
  return sealPlan(r);
}

// Compare a reported batch with the complete approved plan, not just its own rows.
export function assertExecutionMatches(response: InvestigationResponse, result: ExecutionResult, decision: PlanDecisionRequest): void {
  const r = InvestigationResponseSchema.parse(response);
  const e = ExecutionResultSchema.parse(result);
  const d = PlanDecisionRequestSchema.parse(decision);
  const graph = r.action_graph;
  if (!graph || e.investigation_id !== r.investigation_id || e.plan_id !== graph.plan_id ||
      e.revision !== graph.revision || e.plan_digest !== graph.plan_digest ||
      graph.plan_digest !== computePlanDigest(r)) throw new Error('Execution does not match the reviewed plan');
  if (d.plan_id !== e.plan_id || d.expected_revision !== e.revision || d.plan_digest !== e.plan_digest ||
      d.idempotency_key !== e.idempotency_key) throw new Error('Execution does not match the decision request');
  if ((d.decision === 'reject') !== (e.status === 'rejected')) throw new Error('Execution contradicts the decision');
  if (e.status === 'rejected' || (e.status === 'blocked' && !e.results.length)) return;
  if (e.results.length !== graph.actions.length) throw new Error('Execution must report every planned action');
  for (const item of e.results) {
    const action = graph.actions.find(a => a.action_id === item.action_id);
    if (!action || action.action_key !== item.action_key) throw new Error('Execution action identity mismatch');
  }
}
