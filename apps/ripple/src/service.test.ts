import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.ts';
import { RippleService } from './service.ts';
import { Secrets } from './security.ts';
import { TestDatabase, FakeNative, FixtureAgent, auth, actor } from './testing.ts';
import { sealPlan, canonicalJson } from '../../../contracts/review.server.ts';
import { ticketInput } from './types.ts';
import type { InvestigationResponse } from '../../../contracts/investigation.ts';
async function setup(t: { after: (fn: () => Promise<void>) => void }, multi = false) {
  const db = await TestDatabase.create(); t.after(() => db.pg.close());
  const native = new FakeNative(), agent = new FixtureAgent(); agent.multi = multi;
  const service = new RippleService(new Store(db), native, agent, new Secrets('test-only-secret-with-at-least-32-characters'));
  const issue = await native.issue(auth, 'ISS-42');
  const response = await service.investigate(auth, { schema_version: '2.0', request_id: randomUUID(),
    outcome: 'Restore Brazil subscription renewals without double billing', constraints: ['Keep customer updates as drafts'],
    reference_time: null, scope_hints: { starting_object: issue, part_ids: [], account_ids: [] } });
  const revise = (r: InvestigationResponse) => service.revise(auth, { schema_version: '2.0', plan_id: r.action_graph!.plan_id,
    expected_revision: r.action_graph!.revision, owner_assignments: r.action_graph!.actions.map(a => ({ action_id: a.action_id, owner_id: actor })) });
  const decide = (r: InvestigationResponse, decision: 'approve' | 'reject' = 'approve', key = randomUUID()) => ({ schema_version: '2.0',
    plan_id: r.action_graph!.plan_id, expected_revision: r.action_graph!.revision, plan_digest: r.action_graph!.plan_digest, decision, idempotency_key: key });
  return { db, native, agent, service, response, revise, decide };
}
test('PostgreSQL workflow creates one ticket after approval, preserves receipt, and repeats without duplicates', async t => {
  const s = await setup(t), ready = await s.revise(s.response), request = s.decide(ready);
  await s.service.decide(auth, request); assert.equal(s.native.creates, 0);
  const job = await s.db.connection(sql => sql.query('SELECT encrypted_token FROM ripple_jobs'));
  assert.ok(!job.rows[0]!.encrypted_token.includes(auth.token));
  assert.equal(await s.service.workOnce(), true);
  const result = (await s.service.decide(auth, request)).result!;
  assert.equal(result.status, 'completed'); assert.equal(result.approval!.actor_id, actor);
  assert.equal(result.results.length, 1); assert.equal(result.results[0]!.status, 'created');
  assert.equal(s.native.creates, 1); assert.equal(await s.service.workOnce(), false);
  assert.deepEqual((await s.service.decide(auth, request)).result, result);
});
test('rejection after expiry requires no owner, creates no work and no jobs', async t => {
  const s = await setup(t);
  const expired = structuredClone(s.response); expired.action_graph!.expires_at = '2020-01-01T00:00:00Z';
  const r = sealPlan(expired);
  await s.service.store.transaction(async sql => { const plan = await s.service.load(sql, auth, r.action_graph!.plan_id); plan.response = r; await s.service.store.save(sql, plan); });
  const result = await s.service.decide(auth, s.decide(r, 'reject'));
  assert.equal(result.result!.status, 'rejected'); assert.equal(result.result!.approval, null);
  assert.equal(s.native.creates, 0); assert.equal(await s.service.workOnce(), false);
});
test('competing owner revisions allow one update and invalidate the stale approval', async t => {
  const s = await setup(t), settled = await Promise.allSettled([s.revise(s.response), s.revise(s.response)]);
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(s.service.decide(auth, s.decide(s.response)), /Stale/);
  assert.equal(s.native.creates, 0);
});
test('unknown actor, revoked evidence, invalid owner, expired and unassigned plans produce no jobs', async t => {
  const s = await setup(t);
  await assert.rejects(s.service.read({ ...auth, actorId: actor.replace('/6', '/7') }, s.response.action_graph!.plan_id));
  await assert.rejects(s.service.decide(auth, s.decide(s.response)), /owner/);
  s.native.invalidOwner = true; await assert.rejects(s.revise(s.response)); s.native.invalidOwner = false;
  const ready = await s.revise(s.response); s.agent.changed = true;
  await assert.rejects(s.service.decide(auth, s.decide(ready)), /Evidence/); s.agent.changed = false;
  s.native.deny = true; await assert.rejects(s.service.decide(auth, s.decide(ready))); s.native.deny = false;
  const expired = structuredClone(ready); expired.action_graph!.expires_at = '2020-01-01T00:00:00Z'; const r = sealPlan(expired);
  await s.service.store.transaction(async sql => { const plan = await s.service.load(sql, auth, r.action_graph!.plan_id); plan.response = r; await s.service.store.save(sql, plan); });
  await assert.rejects(s.service.decide(auth, s.decide(r)), /expired/);
  assert.equal(s.native.creates, 0); assert.equal(await s.service.workOnce(), false);
});
test('decision content conflicts and repeat clicks cannot overwrite the recorded decision', async t => {
  const s = await setup(t), ready = await s.revise(s.response), q = s.decide(ready);
  await Promise.all([s.service.decide(auth, q), s.service.decide(auth, q)]);
  await assert.rejects(s.service.decide(auth, { ...q, decision: 'reject' }), /different request/);
  await s.service.workOnce(); assert.equal(s.native.creates, 1);
});
test('timeout after create reconciles the committed ticket without another write', async t => {
  const s = await setup(t), ready = await s.revise(s.response);
  s.native.behavior = 'commit_timeout'; await s.service.decide(auth, s.decide(ready)); await s.service.workOnce();
  const first = await s.service.read(auth, ready.action_graph!.plan_id);
  assert.equal(first.result!.results[0]!.status, 'uncertain');
  const next = await s.service.reconcile(auth, ready.action_graph!.plan_id);
  assert.equal(next.result!.results[0]!.status, 'reused'); assert.equal(next.result!.status, 'completed'); assert.equal(s.native.creates, 1);
});
test('absent uncertain write remains fenced through repeated status checks', async t => {
  const s = await setup(t), ready = await s.revise(s.response);
  s.native.behavior = 'timeout'; await s.service.decide(auth, s.decide(ready)); await s.service.workOnce();
  for (let i = 0; i < 3; i++) assert.equal((await s.service.reconcile(auth, ready.action_graph!.plan_id)).result!.results[0]!.status, 'uncertain');
  assert.equal(s.native.creates, 1);
});
test('reclaimed worker with durable create intent reconciles and never blindly creates', async t => {
  const s = await setup(t), ready = await s.revise(s.response); await s.service.decide(auth, s.decide(ready));
  const input = ticketInput(ready, ready.action_graph!.actions[0]!);
  await s.service.store.transaction(async sql => {
    await s.service.store.putLedger(sql, { workspace: auth.workspace, key: input.external_ref,
      fingerprint: createHash('sha256').update(canonicalJson(input)).digest('hex'), input, state: 'intent', native: null, error: null });
    await sql.query("UPDATE ripple_jobs SET state='running',lease_until=now()-interval '1 minute'");
  });
  await s.service.workOnce();
  assert.equal(s.native.creates, 0); assert.equal((await s.service.read(auth, ready.action_graph!.plan_id)).result!.results[0]!.status, 'uncertain');
});
test('partial batches include every action and leave successful native results visible', async t => {
  const s = await setup(t, true), ready = await s.revise(s.response);
  s.native.failKey = ready.action_graph!.actions[1]!.action_key;
  await s.service.decide(auth, s.decide(ready)); await s.service.workOnce();
  const result = (await s.service.read(auth, ready.action_graph!.plan_id)).result!;
  assert.equal(result.status, 'partial'); assert.deepEqual(result.results.map(r => r.status), ['created', 'failed', 'created']);
  await s.service.reconcile(auth, ready.action_graph!.plan_id); assert.equal(s.native.creates, 3);
});
test('different reviewed content cannot reuse an action key or overwrite native work', async t => {
  const s = await setup(t), ready = await s.revise(s.response); await s.service.decide(auth, s.decide(ready)); await s.service.workOnce();
  const another = structuredClone(ready); another.action_graph!.plan_id = randomUUID(); another.action_graph!.actions[0]!.title = 'Changed ticket content';
  const r = sealPlan(another);
  await s.service.store.transaction(sql => s.service.store.save(sql, { workspace: auth.workspace, actorId: actor, startingIssue: ready.context_bundle.entities[0]!.native!.id,
    response: r, state: 'review', decision: null, result: null }));
  await assert.rejects(s.service.decide(auth, s.decide(r)), /differs/); assert.equal(s.native.creates, 1);
});
test('evidence changes during reconciliation preserve successful and uncertain actions', async t => {
  const s = await setup(t, true), ready = await s.revise(s.response);
  await s.service.decide(auth, s.decide(ready));
  const original = s.native.createTicket.bind(s.native);
  s.native.createTicket = async (auth, input) => {
    if (input.external_ref === ready.action_graph!.actions[1]!.action_key) {
      s.native.behavior = 'timeout';
      try { return await original(auth, input); } finally { s.native.behavior = 'ok'; }
    }
    return original(auth, input);
  };
  await s.service.workOnce(); s.agent.changed = true;
  const result = (await s.service.reconcile(auth, ready.action_graph!.plan_id)).result!;
  assert.deepEqual(result.results.map(r => r.status), ['reused', 'uncertain', 'reused']);
  assert.equal(result.status, 'partial'); assert.equal(s.native.creates, 3);
  assert.equal(result.results.filter(r => r.native).length, 2);
});
