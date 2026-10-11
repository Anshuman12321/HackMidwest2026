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
test('signed content control edits title and body into a new revision and approval covers the edited text', async t => {
  const s = await setup(t);
  const intake = flatten((await s.controller.initialize(auth, s.issue)).snaps).find(n => n.type === 'form')!;
  let ui = await s.controller.action(auth, { action_id: intake.action_id, block_id: intake.block_id, value: {} }, s.issue);
  const owner = flatten(ui.snaps).find(n => n.type === 'user_picker')!;
  ui = await s.controller.action(auth, { action_id: owner.action_id, block_id: owner.block_id, value: [actor] }, s.issue);
  const form = flatten(ui.snaps).find(n => String(n.action_id).startsWith('content:'))!;
  assert.equal(form.type, 'form'); assert.equal(form.action_type, 'remote');
  assert.ok(String(form.block_id).length > 20, 'content control carries the signed state');
  assert.deepEqual((form.elements as Snap[]).map(n => (n.element as Snap).action_id), ['title', 'body_markdown']);
  const before = flatten(ui.snaps).find(n => String(n.action_id).startsWith('approve:'))!;
  const edited = await s.controller.action(auth, { action_id: form.action_id, block_id: form.block_id,
    value: { title: { value: 'Edited by reviewer' }, body_markdown: 'Edited body' } }, s.issue);
  const text = JSON.stringify(edited);
  assert.ok(text.includes('Edited by reviewer') && text.includes('Edited body'));
  assert.ok(text.includes('Revision 3'), 'edit sealed a new revision');
  const approve = flatten(edited.snaps).find(n => String(n.action_id).startsWith('approve:'))!;
  assert.equal(approve.disabled, false);
  // The pre-edit signed state is stale: it cannot approve the edited revision.
  const stale = await s.controller.action(auth, { action_id: before.action_id, block_id: before.block_id, value: 'approve' }, s.issue);
  assert.ok(JSON.stringify(stale).includes('Stale') || JSON.stringify(stale).toLowerCase().includes('stale') || JSON.stringify(stale).includes('revision'));
  assert.equal(s.native.creates, 0);
  const bad = await s.controller.action(auth, { action_id: form.action_id, block_id: approve.block_id, value: { title: { value: 'Edited by reviewer' } } }, s.issue);
  assert.ok(JSON.stringify(bad).includes('changes nothing'));
  await s.controller.action(auth, { action_id: approve.action_id, block_id: approve.block_id, value: 'approve' }, s.issue);
  await s.service.workOnce();
  const made = [...s.native.tickets.values()][0]!.input;
  assert.equal(made.title, 'Edited by reviewer'); assert.equal(made.body, 'Edited body');
  // After the decision the editing control is gone.
  const resumed = await s.controller.initialize(auth, s.issue);
  assert.ok(!flatten(resumed.snaps).some(n => String(n.action_id).startsWith('content:')));
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
  const layout = graphData(response, view);
  assert.ok(layout.nodes.some(n => n.id === 'article-node' && n.column === 3));
  assert.ok(layout.columns.some(c => c.label === 'REFERENCE DOCUMENTS'));
  assert.ok(layout.width >= layout.columns.length * 295 + 15);
  const article = response.context_bundle.entities.at(-1)!;
  article.source_ref = { record_id: 'ART-22', path: 'docs' };
  assert.equal(graphData(response, view).nodes.find(n => n.id === 'article-node')?.subtitle, 'ART-22');
  response.context_bundle.evidence.push({ ...response.context_bundle.evidence[0]!, entity_id: 'article-node', coverage: 'archive_only',
    source_ref: { ...response.context_bundle.evidence[0]!.source_ref, record_id: 'ART-22' } });
  assert.equal(graphData(response, view).nodes.find(n => n.id === 'article-node')?.subtitle, 'Archive · ART-22');
  const referencesOnly = structuredClone(response);
  referencesOnly.context_bundle.entities = [referencesOnly.context_bundle.entities.at(-1)!];
  const compact = graphData(referencesOnly, view);
  assert.deepEqual(compact.columns.map(c => c.label), ['REFERENCE DOCUMENTS']);
  assert.equal(compact.width, 620);
  assert.equal(compact.nodes[0]?.x, 35);
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
test('one-click investigation derives the goal from the current issue without an intake form', async t => {
  const s = await setup(t);
  const original = s.native.issueBrief.bind(s.native);
  s.native.issueBrief = async (a, id) => ({ ...await original(a, id), title: 'Renewals stall for a newly reported region' });
  const initial = await s.controller.initialize(auth, s.issue);
  const refinement = flatten(initial.snaps).find(n => (n.title as { text?: string } | undefined)?.text === 'Refine goal or add constraints')!;
  assert.equal(refinement.default_collapsed, true);
  const goalInput = flatten(initial.snaps).find(n => n.type === 'input_layout' && (n.element as Snap).action_id === 'outcome')!.element as Snap;
  assert.equal(goalInput.initial_value, '');
  const run = flatten(initial.snaps).find(n => n.type === 'button' && String(n.action_id).startsWith('investigate:'))!;
  const ui = await s.controller.action(auth, { action_id: run.action_id, block_id: run.block_id, value: run.value }, s.issue);
  const row = await s.service.store.db.connection(sql => sql.query('SELECT response FROM ripple_plans'));
  assert.equal(row.rows[0]!.response.outcome.statement, 'Resolve ISS-42: Renewals stall for a newly reported region');
  assert.deepEqual(row.rows[0]!.response.outcome.constraints, ['Do not change production settings', 'Keep customer updates as drafts']);
  assert.ok(JSON.stringify(ui.snaps).includes('Proposed ticket'));
  assert.equal(s.native.creates, 0);
});

test('blank optional goals use the issue; explicit refinements survive re-investigation', async t => {
  const s = await setup(t);
  const intake = flatten((await s.controller.initialize(auth, s.issue)).snaps).find(n => n.type === 'form')!;
  await s.controller.action(auth, { action_id: intake.action_id, block_id: intake.block_id,
    value: { outcome: { value: '   ' }, constraints: { value: '' } } }, s.issue);
  let row = await s.service.store.db.connection(sql => sql.query('SELECT response FROM ripple_plans ORDER BY created_at DESC'));
  const current = await s.native.issueBrief(auth, s.issue);
  assert.equal(row.rows[0]!.response.outcome.statement, `Resolve ISS-42: ${current.title}`);
  let ui = await s.controller.initialize(auth, s.issue);
  const form = flatten(ui.snaps).find(n => n.type === 'form')!;
  ui = await s.controller.action(auth, { action_id: form.action_id, block_id: form.block_id,
    value: { outcome: { value: '  Verify subscription recovery for one affected account  ' }, constraints: { value: 'Keep customer updates as drafts' } } }, s.issue);
  const run = flatten(ui.snaps).find(n => n.type === 'button' && String(n.action_id).startsWith('investigate:'))!;
  await s.controller.action(auth, { action_id: run.action_id, block_id: run.block_id, value: run.value }, s.issue);
  row = await s.service.store.db.connection(sql => sql.query('SELECT response FROM ripple_plans ORDER BY created_at DESC'));
  assert.equal(row.rows[0]!.response.outcome.statement, 'Verify subscription recovery for one affected account');
  assert.deepEqual(row.rows[0]!.response.outcome.constraints, ['Keep customer updates as drafts']);
});

test('fresh review accepts a valueless control after rejection and restores one-click intake', async t => {
  const s = await setup(t);
  const run = flatten((await s.controller.initialize(auth, s.issue)).snaps).find(n => n.type === 'button' && String(n.action_id).startsWith('investigate:'))!;
  const view = await s.controller.action(auth, { action_id: run.action_id, block_id: run.block_id }, s.issue);
  const reject = flatten(view.snaps).find(n => String(n.action_id).startsWith('reject:'))!;
  const rejected = await s.controller.action(auth, { action_id: reject.action_id, block_id: reject.block_id }, s.issue);
  assert.ok(JSON.stringify(rejected).includes('Plan rejected'));
  const fresh = flatten(rejected.snaps).find(n => String(n.action_id).startsWith('new-review:'))!;
  const reset = await s.controller.action(auth, { action_id: fresh.action_id, block_id: fresh.block_id }, s.issue);
  assert.ok(flatten(reset.snaps).some(n => n.type === 'button' && n.text && (n.text as Snap).text === 'Investigate issue'));
  assert.ok(!JSON.stringify(reset).includes('Plan rejected'));
  assert.equal(s.native.creates, 0);
});
