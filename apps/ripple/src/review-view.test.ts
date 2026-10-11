import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { reviewView } from './review-view.ts';
import type { Plan, View } from './types.ts';

const view: View = { mode: 'context', selected: null, evidenceId: null };
const owner = { id: 'don:identity:dvrv-us-1:devo/1mWckJhGyy:devu/6', name: 'Test Owner', displayId: 'DEVU-6' };
const plan = (response = fixture(), state: Plan['state'] = 'review', result: Plan['result'] = null): Plan =>
  ({ workspace: 'w', actorId: owner.id, startingIssue: 'i', response, state, decision: null, result });

test('findings are capped, cited, and reference real evidence', () => {
  const p = plan(), v = reviewView(p, view, [owner]);
  assert.ok(v.findings.length >= 1 && v.findings.length <= 5);
  const ids = new Set(p.response.context_bundle.evidence.map(e => e.evidence_id));
  for (const f of v.findings) { assert.ok(f.statement); f.evidence_ids.forEach(id => assert.ok(ids.has(id))); }
});

test('plan exposes exact title, body, revision and digest; blocks approval until every ticket has an owner', () => {
  const p = plan(), graph = p.response.action_graph!;
  const unowned = structuredClone(p); unowned.response.action_graph!.actions.forEach(a => { a.owner_id = null; });
  const blocked = reviewView(unowned, view, [owner]).plan!;
  assert.equal(blocked.approvable, false);
  assert.match(blocked.blocked_reason!, /owner/i);
  const v = reviewView(p, view, [owner]).plan!;
  assert.equal(v.revision, graph.revision);
  assert.equal(v.digest, graph.plan_digest);
  assert.deepEqual(v.tickets.map(t => [t.title, t.body]), graph.actions.map(a => [a.title, a.body_markdown]));
  assert.ok(v.tickets.every(t => t.part.label && t.evidence_ids.length));
});

test('owner names resolve and expired revisions are not approvable', () => {
  const p = structuredClone(plan()); const a = p.response.action_graph!;
  a.actions.forEach(x => { x.owner_id = owner.id; }); a.expires_at = '2000-01-01T00:00:00Z';
  const v = reviewView(p, view, [owner]).plan!;
  assert.equal(v.tickets[0]!.owner!.name, 'Test Owner');
  assert.equal(v.approvable, false); assert.match(v.blocked_reason!, /expired/i);
});

test('evidence appears only for the selected excerpt; rejected and approved states map to results', () => {
  const p = plan(), id = p.response.context_bundle.evidence[0]!.evidence_id;
  assert.equal(reviewView(p, view, []).evidence, null);
  assert.equal(reviewView(p, { ...view, evidenceId: id }, []).evidence?.id, id);
  assert.deepEqual(reviewView(plan(fixture(), 'rejected'), view, []).result, { pending: false, status: 'rejected', error: null, approval: null, results: [] });
  const pending = reviewView(plan(fixture(), 'approved'), view, []);
  assert.equal(pending.plan!.approvable, false);
  assert.equal(pending.result!.pending, true);
});
