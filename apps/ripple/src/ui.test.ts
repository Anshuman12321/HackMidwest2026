import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { RippleService } from './service.ts';
import { Secrets } from './security.ts';
import { Controller } from './controller.ts';
import { graphSvg, graphPng, graphData } from './graph.ts';
import type { Snap } from './ui.ts';
import { TestDatabase, FakeNative, FixtureAgent, auth, actor, fixture } from './testing.ts';
import { bridge } from '../snap-in/src/bridge.ts';
import type { Event } from '../snap-in/src/bridge.ts';
const flatten = (s: Snap[]): Snap[] => s.flatMap(v => [v, ...flatten((v.elements ?? []) as Snap[])]);
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const db = await TestDatabase.create(); t.after(() => db.pg.close());
  const native = new FakeNative(), service = new RippleService(new Store(db), native, new FixtureAgent(), new Secrets(randomUUID() + randomUUID()));
  return { native, service, controller: new Controller(service, 'https://ripple.example'), issue: 'ISS-42' };
}
test('native presentation investigates, revises owner, opens every citation and records exact approval', async t => {
  const s = await setup(t);
  const intake = flatten((await s.controller.initialize(auth, s.issue)).snaps).find(n => n.type === 'form')!;
  let ui = await s.controller.action(auth, { action_id: intake.action_id, block_id: intake.block_id,
    value: { outcome: { value: 'Restore Brazil subscription renewals without double billing' }, constraints: { value: 'Keep customer updates as drafts' } } }, s.issue);
  assert.equal(flatten(ui.snaps).find(n => String(n.action_id).startsWith('approve:'))!.disabled, true);
  const owner = flatten(ui.snaps).find(n => n.type === 'user_picker')!;
  ui = await s.controller.action(auth, { action_id: owner.action_id, block_id: owner.block_id, value: [actor] }, s.issue);
  const approve = flatten(ui.snaps).find(n => String(n.action_id).startsWith('approve:'))!;
  assert.equal(approve.disabled, false);
  const evidenceButtons = flatten(ui.snaps).filter(n => String(n.action_id).startsWith('evidence:'));
  assert.deepEqual(new Set(evidenceButtons.map(n => n.value)), new Set(fixture().context_bundle.claims.flatMap(c => c.evidence_ids)));
  const selection = flatten(ui.snaps).find(n => n.action_id === 'selection')!;
  for (const relationship of fixture().context_bundle.relationships) {
    const selected = await s.controller.action(auth, { action_id: 'selection', block_id: selection.block_id, value: { value: relationship.relationship_id } }, s.issue);
    const citations = flatten(selected.snaps).filter(n => String(n.action_id).startsWith('evidence:'));
    assert.ok(relationship.evidence_ids.every(id => citations.some(c => c.value === id)));
  }
  for (const citation of evidenceButtons) {
    const opened = await s.controller.action(auth, { action_id: citation.action_id, block_id: citation.block_id, value: citation.value }, s.issue);
    const excerpt = fixture().context_bundle.evidence.find(e => e.evidence_id === citation.value)!.excerpt.text;
    assert.ok(flatten(opened.snaps).some(snap => snap.text === excerpt));
  }
  const approved = await s.controller.action(auth, { action_id: approve.action_id, block_id: approve.block_id, value: 'approve' }, s.issue);
  assert.ok(JSON.stringify(approved).includes('Creating approved tickets')); assert.equal(s.native.creates, 0);
  await s.service.workOnce(); assert.equal(s.native.creates, 1);
  const resumed = await s.controller.initialize(auth, s.issue);
  assert.ok(JSON.stringify(resumed).includes('Execution result'));
  assert.ok(JSON.stringify(resumed).includes('Start a fresh review'));
});
test('live local preview labels simulated approval and supplies the current owner roster', async t => {
  const s = await setup(t);
  const controller = new Controller(s.service, 'http://127.0.0.1:8788', 'live');
  const intake = flatten((await controller.initialize(auth, s.issue)).snaps).find(n => n.type === 'form')!;
  const ui = await controller.action(auth, { action_id: intake.action_id, block_id: intake.block_id,
    value: { outcome: { value: 'Restore Brazil subscription renewals without double billing' }, constraints: { value: '' } } }, s.issue);
  assert.ok(JSON.stringify(ui.snaps).includes('Live DevRev reads; simulated ticket creation'));
  assert.ok(JSON.stringify(ui.snaps).includes('Approve & simulate 1 ticket'));
  assert.deepEqual('preview_owners' in ui ? ui.preview_owners : [], await s.native.owners());
  const approval = flatten(ui.snaps).find(n => String(n.action_id).startsWith('approve:'))!;
  const failed = await controller.action(auth, { action_id: approval.action_id, block_id: approval.block_id, value: 'approve' }, s.issue);
  assert.ok(JSON.stringify(failed.snaps).includes('Review needed'));
  const refresh = flatten(failed.snaps).find(n => String(n.action_id).startsWith('refresh:'))!;
  const refreshed = await controller.action(auth, { action_id: refresh.action_id, block_id: refresh.block_id, value: 'refresh' }, s.issue);
  assert.ok(!JSON.stringify(refreshed.snaps).includes('Review needed'));
  assert.equal(s.native.creates, 0);
});
test('graph grants expire, cannot cross users, and become invalid after owner revisions', async t => {
  const s = await setup(t), issue = await s.native.issue(auth, s.issue);
  const response = await s.service.investigate(auth, { schema_version: '2.0', request_id: randomUUID(), outcome: 'Brazil renewal review', constraints: [],
    reference_time: null, scope_hints: { starting_object: issue, part_ids: [], account_ids: [] } });
  const grant = { workspace: auth.workspace, actorId: actor, planId: response.action_graph!.plan_id,
    digest: response.action_graph!.plan_digest, expires: Date.now() + 60_000, view: { mode: 'context', selected: null, evidenceId: null } };
  const sign = (g: unknown) => s.service.secrets.sign(g, 'graph');
  await s.controller.graph(sign(grant));
  await assert.rejects(s.controller.graph(sign({ ...grant, actorId: 'different-user' })));
  await assert.rejects(s.controller.graph(sign({ ...grant, expires: 0 })));
  await s.service.revise(auth, { schema_version: '2.0', plan_id: grant.planId, expected_revision: 1,
    owner_assignments: [{ action_id: response.action_graph!.actions[0]!.action_id, owner_id: actor }] });
  await assert.rejects(s.controller.graph(sign(grant)), /older review/);
});
test('graph is deterministic, escapes labels, highlights selection, and renders a PNG', async () => {
  const response = fixture(), view = { mode: 'context' as const, selected: null, evidenceId: null };
  const svg = graphSvg(response, view);
  assert.equal(svg, graphSvg(response, view));
  assert.notEqual(svg, graphSvg(response, { ...view, selected: response.context_bundle.relationships[0]!.relationship_id }));
  response.context_bundle.entities[0]!.label = '<script> & "unsafe"';
  assert.ok(!graphSvg(response, view).includes('<script>'));
  response.context_bundle.entities.push({ entity_id: 'article-node', kind: 'article', label: 'Replay guidance', native: null, source_ref: { record_id: 'DOC-1', path: 'docs' } });
  assert.ok(graphData(response, view).nodes.some(n => n.id === 'article-node'));
  const png = await graphPng(response, view);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
});
test('signed state separates purposes and encrypted credentials reject tampering', () => {
  const secrets = new Secrets(randomUUID() + randomUUID()), token = secrets.sign({ actor: actor }, 'ui');
  assert.deepEqual(secrets.verify(token, 'ui'), { actor });
  assert.throws(() => secrets.verify(token, 'graph'));
  assert.throws(() => secrets.verify(token + 'x', 'ui'));
  const encrypted = secrets.encrypt(auth.token); assert.equal(secrets.decrypt(encrypted), auth.token);
  assert.ok(!encrypted.includes(auth.token));
  const b = Buffer.from(encrypted, 'base64url'); b[30] = b[30]! ^ 1;
  assert.throws(() => secrets.decrypt(b.toString('base64url')));
});
test('snap-in forwards platform actor token, signed issue context and native action payload', async t => {
  const key = randomUUID() + randomUUID(), prior = globalThis.fetch;
  const captured: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { captured.push({ url: String(url), init: init! }); return Response.json({ snap_kit_body: { body: { snaps: [] } } }); };
  t.after(() => { globalThis.fetch = prior; });
  const event: Event = { payload: { context: { object_id: 'ISS-42' }, action: { id: 'owner:test', block_id: 'signed', value: [actor] } },
    context: { secrets: { actor_session_token: 'platform-token' } }, input_data: { global_values: { ripple_service_url: 'https://ripple.example' }, keyrings: { ripple_bridge_secret: key } } };
  await bridge([event], false);
  assert.equal(captured[0]!.url, 'https://ripple.example/native/action');
  const headers = captured[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer platform-token');
  const proof = new Secrets(key).verify<{ path: string }>(headers['X-Ripple-Bridge']!, 'bridge'); assert.equal(proof.path, '/native/action');
  assert.deepEqual(JSON.parse(captured[0]!.init.body as string), { issue: 'ISS-42', action: { action_id: 'owner:test', block_id: 'signed', value: [actor] } });
  await assert.rejects(bridge([{ ...event, context: { secrets: {} } }], false), /actor context/);
});
