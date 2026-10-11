import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  InvestigationRequestSchema, InvestigationResponseSchema, RevisePlanRequestSchema,
  PlanDecisionRequestSchema, ExecutionResultSchema, OperationErrorSchema,
  type InvestigationResponse, type ExecutionResult,
} from './investigation.ts';
import {
  canonicalJson, computePlanDigest, sealPlan, assertDecisionMatches,
  applyOwnerAssignments, assertExecutionMatches,
} from './review.server.ts';

const example = (name: string) => JSON.parse(readFileSync(new URL(`./examples/${name}.json`, import.meta.url), 'utf8'));
const initial = () => InvestigationResponseSchema.parse(example('multi-investigation-response'));
const ready = () => InvestigationResponseSchema.parse(example('multi-revised-investigation-response'));
const decision = () => PlanDecisionRequestSchema.parse({ ...example('plan-decision-request'), plan_digest: ready().action_graph!.plan_digest });
const now = new Date('2026-10-10T23:00:00Z');
const invalidResponse = (edit: (r: InvestigationResponse) => void) => {
  const r = ready(); edit(r); assert.equal(InvestigationResponseSchema.safeParse(r).success, false);
};
// Mock writes exist only in this test. These IDs do not describe real DevRev records.
function mockCompleted(): ExecutionResult {
  const r = ready(), g = r.action_graph!, d = decision();
  return {
    schema_version: '2.0', investigation_id: r.investigation_id, plan_id: g.plan_id,
    revision: g.revision, plan_digest: g.plan_digest, idempotency_key: d.idempotency_key,
    approval: { approval_id: '00000000-0000-4000-8000-000000000099',
      actor_id: g.actions[0]!.owner_id!, recorded_at: now.toISOString(), plan_digest: g.plan_digest },
    status: 'completed', results: g.actions.map((a, i) => ({
      action_id: a.action_id, action_key: a.action_key, status: 'created',
      native: { id: `don:core:test:devo/test:ticket/unit-${i}`, display_id: `TEST-${i}`, url: null }, error: null,
    })), error: null,
  };
}

test('source-derived examples conform to all six message schemas', () => {
  InvestigationRequestSchema.parse(example('investigation-request'));
  initial(); ready(); RevisePlanRequestSchema.parse({ ...example('revise-plan-request'), owner_assignments: initial().action_graph!.actions.map(a => ({ action_id: a.action_id, owner_id: ready().action_graph!.actions[0]!.owner_id! })) });
  decision(); PlanDecisionRequestSchema.parse(example('reject-plan-request'));
  ExecutionResultSchema.parse(example('rejected-execution-result'));
  OperationErrorSchema.parse(example('operation-error'));
});
test('client requests cannot supply an actor or an approval flag', () => {
  assert.equal(PlanDecisionRequestSchema.safeParse({ ...decision(), approved_by: 'DEVU-6' }).success, false);
  assert.equal(InvestigationRequestSchema.safeParse({ ...example('investigation-request'), approved: true }).success, false);
});
test('unknown citations and inconsistent source mappings are rejected', () => {
  invalidResponse(r => { r.context_bundle.claims[0]!.evidence_ids.push('evidence-does-not-exist'); });
  invalidResponse(r => { r.context_bundle.evidence[0]!.source_ref.record_id = 'ISS-999'; });
});
test('native evidence requires a mapped object; archive coverage must be declared', () => {
  invalidResponse(r => { r.context_bundle.entities[0]!.native = null; });
  invalidResponse(r => { r.context_bundle.evidence[0]!.coverage = 'archive_only'; });
});
test('Unicode excerpt offsets count code points, not UTF-16 units', () => {
  const r = ready(), e = r.context_bundle.evidence[0]!;
  e.excerpt = { ...e.excerpt, text: 'A😀B', start: 2, end: 5 };
  InvestigationResponseSchema.parse(r);
  e.excerpt.end = 6;
  assert.equal(InvestigationResponseSchema.safeParse(r).success, false);
});
test('relationships cannot hide an inference as a source-backed link', () => {
  invalidResponse(r => { r.context_bundle.relationships[0]!.basis = 'inference'; });
});
test('tasks require native parts and nonduplicate stable action keys', () => {
  invalidResponse(r => { r.action_graph!.actions[0]!.part_entity_id = 'entity-iss-031'; });
  invalidResponse(r => { r.action_graph!.actions[1]!.action_key = r.action_graph!.actions[0]!.action_key; });
});
test('missing dependency endpoints and cyclic plans are rejected', () => {
  invalidResponse(r => { r.action_graph!.dependencies[0]!.dependent_action_id = 'task-missing'; });
  invalidResponse(r => { r.action_graph!.dependencies.push({ prerequisite_action_id: 'task-replay', dependent_action_id: 'task-scheduler', reason: 'Cycle' }); });
});
test('questions and plan presence follow the response state', () => {
  invalidResponse(r => { r.status = 'needs_input'; });
  invalidResponse(r => { r.questions.push('Which owner?'); });
});
test('historical USER IDs cannot be used as current DevRev assignees', () => {
  invalidResponse(r => { r.action_graph!.actions[0]!.owner_id = 'USER-001'; });
});
test('owner edits produce the example revision and invalidate the prior digest', () => {
  const r = applyOwnerAssignments(initial(), { ...example('revise-plan-request'), owner_assignments: initial().action_graph!.actions.map(a => ({ action_id: a.action_id, owner_id: ready().action_graph!.actions[0]!.owner_id! })) }, now);
  assert.deepEqual(r, ready());
  assert.notEqual(r.action_graph!.plan_digest, initial().action_graph!.plan_digest);
  assert.throws(() => applyOwnerAssignments(r, { ...example('revise-plan-request'), owner_assignments: initial().action_graph!.actions.map(a => ({ action_id: a.action_id, owner_id: ready().action_graph!.actions[0]!.owner_id! })) }, now), /Stale/);
});
test('duplicate or unknown owner assignments are rejected', () => {
  const q = { ...example('revise-plan-request'), owner_assignments: initial().action_graph!.actions.map(a => ({ action_id: a.action_id, owner_id: ready().action_graph!.actions[0]!.owner_id! })) };
  q.owner_assignments.push(q.owner_assignments[0]);
  assert.equal(RevisePlanRequestSchema.safeParse(q).success, false);
  const unknown = { ...example('revise-plan-request'), owner_assignments: initial().action_graph!.actions.map(a => ({ action_id: a.action_id, owner_id: ready().action_graph!.actions[0]!.owner_id! })) }; unknown.owner_assignments[0].action_id = 'task-missing';
  assert.throws(() => applyOwnerAssignments(initial(), unknown, now), /Unknown action/);
});
test('plan digest is stable under object key ordering and rejects non-JSON values', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: NaN }));
  assert.equal(computePlanDigest(ready()), decision().plan_digest);
});
test('approval detects changed body, evidence, owner, revision and expired plans', () => {
  for (const edit of [
    (r: InvestigationResponse) => { r.action_graph!.actions[0]!.body_markdown += ' Changed'; },
    (r: InvestigationResponse) => { r.context_bundle.evidence[0]!.excerpt.text += '!'; r.context_bundle.evidence[0]!.excerpt.end++; },
    (r: InvestigationResponse) => { r.action_graph!.actions[0]!.owner_id = null; },
  ]) { const r = ready(); edit(r); assert.throws(() => assertDecisionMatches(r, decision(), now), /digest/); }
  assert.throws(() => assertDecisionMatches(ready(), { ...decision(), expected_revision: 1 }, now), /Stale/);
  assert.throws(() => assertDecisionMatches(ready(), decision(), new Date('2026-10-12T00:00:00Z')), /expired/);
});
test('unassigned tasks block approval; runtime production gaps permit investigation tasks', () => {
  const r = initial();
  const d = { ...decision(), expected_revision: 1, plan_digest: r.action_graph!.plan_digest };
  assert.throws(() => assertDecisionMatches(r, d, now), /owner/);
  assertDecisionMatches(ready(), decision(), now);
  const blocked = ready(); blocked.context_bundle.gaps[0]!.blocks = 'execution';
  const sealed = sealPlan(blocked);
  assert.throws(() => assertDecisionMatches(sealed, { ...decision(), plan_digest: sealed.action_graph!.plan_digest }, now), /gap/);
});
test('a current plan can be rejected after expiry without assigning owners', () => {
  const r = initial();
  assertDecisionMatches(r, { ...decision(), decision: 'reject', expected_revision: 1, plan_digest: r.action_graph!.plan_digest }, new Date('2027-01-01T00:00:00Z'));
  assertExecutionMatches(ready(), { ...example('rejected-execution-result'), plan_digest: ready().action_graph!.plan_digest }, { ...decision(), decision: 'reject', idempotency_key: example('rejected-execution-result').idempotency_key });
});
test('execution requires approval and ticket-shaped distinct output identities', () => {
  const e = mockCompleted(); ExecutionResultSchema.parse(e);
  e.approval = null; assert.equal(ExecutionResultSchema.safeParse(e).success, false);
  const missing = mockCompleted(); missing.results[0]!.native = null;
  assert.equal(ExecutionResultSchema.safeParse(missing).success, false);
  const duplicate = mockCompleted(); duplicate.results[1]!.native = duplicate.results[0]!.native;
  assert.equal(ExecutionResultSchema.safeParse(duplicate).success, false);
  const wrongType = mockCompleted(); wrongType.results[0]!.native!.id = 'don:core:test:devo/test:issue/unit';
  assert.equal(ExecutionResultSchema.safeParse(wrongType).success, false);
});
test('completed batches must cover the whole plan and match the exact decision', () => {
  const e = mockCompleted(); assertExecutionMatches(ready(), e, decision());
  e.results.pop(); assert.throws(() => assertExecutionMatches(ready(), e, decision()), /every planned/);
  const wrong = mockCompleted(); wrong.results[0]!.action_key = 'wrong';
  assert.throws(() => assertExecutionMatches(ready(), wrong, decision()), /identity/);
  assert.throws(() => assertExecutionMatches(ready(), mockCompleted(), { ...decision(), idempotency_key: '00000000-0000-4000-8000-000000000098' }), /decision request/);
});
test('uncertain writes require reconciliation and cannot be reported completed', () => {
  const e = mockCompleted(); e.status = 'partial';
  e.results[0] = { ...e.results[0]!, status: 'uncertain', native: null,
    error: { code: 'ambiguous_write', message: 'Create timed out', retry: 'safe' } };
  assert.equal(ExecutionResultSchema.safeParse(e).success, false);
  e.results[0]!.error!.retry = 'reconcile_first';
  assertExecutionMatches(ready(), e, decision());
  e.status = 'completed'; assert.equal(ExecutionResultSchema.safeParse(e).success, false);
});

test('Brazil v2 bundles three work sections into one internal execution ticket', () => {
 const r = InvestigationResponseSchema.parse(example('investigation-response'));
 assert.equal(r.action_graph!.actions.length, 1);
 assert.equal(r.action_graph!.actions[0]!.operation, 'create_ticket');
 assert.equal(r.action_graph!.actions[0]!.visibility, 'internal');
 assert.equal(r.action_graph!.actions[0]!.acceptance_checks.length, 6);
 assert.equal(r.action_graph!.dependencies.length, 0);
 assert.equal(InvestigationResponseSchema.safeParse({ ...r, schema_version: '1.0' }).success, false);
 const e = mockCompleted(); e.results[0]!.native!.id = 'don:core:test:devo/test:issue/1';
 assert.equal(ExecutionResultSchema.safeParse(e).success, false);
});
const editReq = (plan: InvestigationResponse, edits: unknown) => RevisePlanRequestSchema.parse({
  schema_version: '2.0', plan_id: plan.action_graph!.plan_id, expected_revision: plan.action_graph!.revision, content_edits: edits });
test('content edits seal a new revision and digest; the old digest cannot approve', () => {
  const before = ready(), id = before.action_graph!.actions[0]!.action_id;
  const after = applyOwnerAssignments(before, editReq(before, [{ action_id: id, title: 'Edited title', body_markdown: 'Edited body.' }]), now);
  const a = after.action_graph!, b = before.action_graph!;
  assert.equal(a.revision, b.revision + 1);
  assert.notEqual(a.plan_digest, b.plan_digest);
  assert.equal(a.plan_digest, computePlanDigest(after));
  assert.equal(a.actions[0]!.title, 'Edited title'); assert.equal(a.actions[0]!.body_markdown, 'Edited body.');
  for (const k of ['evidence_ids', 'context_entity_ids', 'part_entity_id', 'action_key', 'owner_id'] as const)
    assert.deepEqual(a.actions[0]![k], b.actions[0]![k]);
  assert.throws(() => assertDecisionMatches(after, decision(), now), /Stale|digest/);
  assertDecisionMatches(after, { ...decision(), expected_revision: a.revision, plan_digest: a.plan_digest }, now);
  assert.throws(() => applyOwnerAssignments(after, editReq(before, [{ action_id: id, title: 'Again' }]), now), /Stale/);
});
test('no-op, unknown, empty, duplicate and oversize content edits are rejected', () => {
  const r = ready(), t = r.action_graph!.actions[0]!;
  assert.throws(() => applyOwnerAssignments(r, editReq(r, [{ action_id: t.action_id, title: t.title }]), now), /changes nothing/);
  assert.throws(() => applyOwnerAssignments(r, editReq(r, [{ action_id: 'task-missing', title: 'x' }]), now), /Unknown action/);
  const bad = (edits: unknown) => RevisePlanRequestSchema.safeParse({ schema_version: '2.0', plan_id: r.action_graph!.plan_id,
    expected_revision: r.action_graph!.revision, content_edits: edits }).success;
  assert.equal(bad([{ action_id: t.action_id }]), false);
  assert.equal(bad([{ action_id: t.action_id, title: '   ' }]), false);
  assert.equal(bad([{ action_id: t.action_id, title: 'x'.repeat(201) }]), false);
  assert.equal(bad([{ action_id: t.action_id, body_markdown: 'x'.repeat(4001) }]), false);
  assert.equal(bad([{ action_id: t.action_id, title: 'a' }, { action_id: t.action_id, title: 'b' }]), false);
  assert.equal(bad([{ action_id: t.action_id, title: 'ok', extra: 1 }]), false);
  assert.equal(RevisePlanRequestSchema.safeParse({ schema_version: '2.0', plan_id: r.action_graph!.plan_id, expected_revision: 1 }).success, false);
});
