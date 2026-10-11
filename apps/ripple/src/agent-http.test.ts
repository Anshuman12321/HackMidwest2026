import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAgentServer } from './agent-http.ts';
import { BridgeError } from './agent-process.ts';
import { AgentClient } from './native.ts';
import { Store } from './store.ts';
import { RippleService } from './service.ts';
import { Secrets } from './security.ts';
import { Controller } from './controller.ts';
import { TestDatabase, FakeNative, auth, actor, fixture } from './testing.ts';
import { applyOwnerAssignments, sealPlan } from '../../../contracts/review.server.ts';
import type { InvestigationRequest } from '../../../contracts/investigation.ts';
import type { Retrieval } from '../../../contracts/investigate.server.ts';
import type { Snap } from './ui.ts';

function sources(): Retrieval {
  const example = fixture(), timestamp = new Date().toISOString();
  const records: Retrieval['records'] = example.context_bundle.entities.filter(e => ['issue', 'ticket'].includes(e.kind)).map(entity => {
    const item = example.context_bundle.evidence.find(e => e.entity_id === entity.entity_id && e.excerpt.field_path === 'original_record.description')!;
    const account = example.context_bundle.evidence.find(e => e.entity_id === entity.entity_id && e.excerpt.field_path === 'original_record.account_id');
    return { kind: entity.kind as 'issue' | 'ticket', source_id: entity.source_ref!.record_id, path: entity.source_ref!.path,
      label: entity.label, native: entity.native, coverage: 'native_imported', retrieved_at: timestamp,
      part_source_id: 'PART-003', account_source_id: account?.excerpt.text ?? null,
      original: { [entity.kind + '_id']: entity.source_ref!.record_id, description: item.excerpt.text,
        components: ['PART-003'], created_at: item.original_event_at, assignee_id: 'USER-002',
        ...(account ? { account_id: account.excerpt.text } : {}) } };
  });
  records.push({ kind: 'article', source_id: 'test-guide.md', path: 'test-guide.md', label: 'Retry guide',
    native: null, original: '# Retry guide\nWhen a payment fails, investigate retry policy.\n', coverage: 'archive_only',
    retrieved_at: timestamp, part_source_id: null, account_source_id: null });
  return { records, entities: example.context_bundle.entities.filter(e => ['part', 'account'].includes(e.kind)).map(e => ({
    kind: e.kind as 'part' | 'account', source_id: e.source_ref!.record_id, path: e.source_ref!.path, label: e.label, native: e.native!,
  })), archive_sha256: example.context_bundle.coverage.archive_sha256, limitations: ['Offline HTTP integration sources; no live reads'],
  discovered_tools: [], trace: [], started_at: timestamp };
}
const request = (): InvestigationRequest => ({ schema_version: '2.0', request_id: randomUUID(),
  outcome: 'Restore Brazil subscription renewals without double billing.', constraints: ['Keep customer updates as drafts'],
  reference_time: null, scope_hints: { part_ids: [], account_ids: [], starting_object: fixture().context_bundle.entities.find(e => e.kind === 'issue')!.native! } });
async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const bearer = randomUUID(), initial = sources(); let changed = false, revoked = false, reads = 0;
  const server = createAgentServer({ bearer, authenticate: async context => {
    if (context.actor_id !== actor || context.workspace !== auth.workspace || context.actor_session_token !== auth.token)
      throw new BridgeError('permission_denied', 'Wrong actor');
  }, retrieve: async operation => {
    reads++;
    if (revoked) throw new BridgeError('permission_denied', 'Revoked');
    const result = structuredClone(initial);
    if (operation === 'revalidate') {
      result.started_at = new Date().toISOString();
      result.records.forEach(r => { r.retrieved_at = result.started_at; });
    }
    if (changed) (result.records[0]!.original as Record<string, unknown>).description += ' Changed source.';
    return result;
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port, url = `http://127.0.0.1:${port}`;
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  return { client: new AgentClient(url, bearer), url, bearer, get reads() { return reads; }, change() { changed = true; }, revoke() { revoked = true; } };
}
test('v2 HTTP agent supports resealed plan identity and owner revisions with fresh read timestamps', async t => {
  const s = await setup(t), response = await s.client.investigate(request(), auth);
  assert.equal(response.schema_version, '2.0'); assert.equal(response.action_graph!.actions.length, 1);
  assert.equal(response.action_graph!.actions[0]!.operation, 'create_ticket');
  assert.equal(response.action_graph!.actions[0]!.visibility, 'internal');
  response.action_graph!.plan_id = randomUUID(); response.action_graph!.expires_at = new Date(Date.now() + 30 * 60_000).toISOString();
  const resealed = sealPlan(response), revised = applyOwnerAssignments(resealed, { schema_version: '2.0', plan_id: resealed.action_graph!.plan_id,
    expected_revision: 1, owner_assignments: [{ action_id: resealed.action_graph!.actions[0]!.action_id, owner_id: actor }] }, new Date());
  const before = JSON.stringify(revised);
  await s.client.revalidate(revised, auth);
  assert.equal(JSON.stringify(revised), before); assert.equal(s.reads, 2);
});
test('HTTP bearer, actor identity and request version are checked before source reads', async t => {
  const s = await setup(t), context = { workspace: auth.workspace, actor_id: actor, actor_session_token: auth.token };
  for (const [secret, body, status] of [
    ['wrong', { payload: request(), context }, 401],
    [s.bearer, { payload: request(), context: { ...context, actor_id: actor + 'x' } }, 403],
    [s.bearer, { payload: { ...request(), schema_version: '1.0' }, context }, 400],
  ] as const) {
    const result = await fetch(s.url + '/investigate', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(result.status, status);
  }
  assert.equal(s.reads, 0);
});
test('HTTP revalidation fails on altered source bytes and revoked access', async t => {
  const s = await setup(t), response = await s.client.investigate(request(), auth);
  s.change(); await assert.rejects(s.client.revalidate(response, auth), /Evidence or its access changed/);
  s.revoke(); await assert.rejects(s.client.revalidate(response, auth), error => (error as any).failure.code === 'permission_denied');
});
const flatten = (snaps: Snap[]): Snap[] => snaps.flatMap(s => [s, ...flatten((s.elements ?? []) as Snap[])]);
test('browser controller completes real planner over HTTP: investigate, citation, owner, approve, simulated result', async t => {
  const s = await setup(t), db = await TestDatabase.create(); t.after(() => db.pg.close());
  const native = new FakeNative(), service = new RippleService(new Store(db), native, s.client, new Secrets(randomUUID() + randomUUID()));
  const controller = new Controller(service, 'http://127.0.0.1:8788', true), issue = request().scope_hints.starting_object!.id;
  const investigate = flatten((await controller.initialize(auth, issue)).snaps).find(n => n.type === 'button' && String(n.action_id).startsWith('investigate:'))!;
  let view = await controller.action(auth, { action_id: investigate.action_id, block_id: investigate.block_id, value: investigate.value }, issue);
  assert.ok(!JSON.stringify(view).includes('could not complete'));
  const citation = flatten(view.snaps).find(n => String(n.action_id).startsWith('evidence:'))!;
  assert.ok(citation); const opened = await controller.action(auth, { action_id: citation.action_id, block_id: citation.block_id, value: citation.value }, issue);
  const saved = await db.connection(sql => sql.query('SELECT response FROM ripple_plans'));
  const excerpt = saved.rows[0]!.response.context_bundle.evidence.find((e: { evidence_id: string }) => e.evidence_id === citation.value).excerpt.text;
  assert.ok(flatten(opened.snaps).some(n => n.type === 'plain_text' && n.text === excerpt));
  const owner = flatten(view.snaps).find(n => n.type === 'user_picker')!;
  view = await controller.action(auth, { action_id: owner.action_id, block_id: owner.block_id, value: [actor] }, issue);
  const approve = flatten(view.snaps).find(n => String(n.action_id).startsWith('approve:'))!;
  assert.equal(approve.disabled, false);
  await controller.action(auth, { action_id: approve.action_id, block_id: approve.block_id, value: 'approve' }, issue);
  assert.equal(native.creates, 0); await service.workOnce(); assert.equal(native.creates, 1);
  const finished = await controller.initialize(auth, issue);
  assert.ok(JSON.stringify(finished).includes('PREVIEW-1')); assert.ok(s.reads >= 5);
});
test('changed live evidence blocks approval without scheduling a simulated write', async t => {
  const s = await setup(t), db = await TestDatabase.create(); t.after(() => db.pg.close());
  const native = new FakeNative(), service = new RippleService(new Store(db), native, s.client, new Secrets(randomUUID() + randomUUID()));
  const response = await service.investigate(auth, request());
  const revised = await service.revise(auth, { schema_version: '2.0', plan_id: response.action_graph!.plan_id, expected_revision: 1,
    owner_assignments: [{ action_id: response.action_graph!.actions[0]!.action_id, owner_id: actor }] });
  s.change(); await assert.rejects(service.decide(auth, { schema_version: '2.0', plan_id: revised.action_graph!.plan_id,
    expected_revision: 2, plan_digest: revised.action_graph!.plan_digest, decision: 'approve', idempotency_key: randomUUID() }));
  await service.workOnce(); assert.equal(native.creates, 0);
  const jobs = await db.connection(sql => sql.query('SELECT * FROM ripple_jobs')); assert.equal(jobs.rows.length, 0);
});
