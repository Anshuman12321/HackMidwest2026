import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalNative } from './local-native.ts';
import { auth, actor, fixture } from './testing.ts';
import { ticketInput } from './types.ts';

function setup() {
  const calls: string[] = [];
  const response = fixture();
  const records = response.context_bundle.entities.flatMap(e => e.native ? [e.native] : []);
  let revoked = false;
  const native = new LocalNative(auth, async (endpoint, args) => {
    calls.push(endpoint);
    if (revoked) throw new Error('access revoked');
    if (endpoint === 'dev-users.self' || endpoint === 'dev-users.get')
      return { dev_user: { id: actor, state: 'active', full_name: 'Verified reader', display_id: 'DEVU-6' } };
    const record = records.find(r => r.id === args.id);
    const key = endpoint === 'works.get' ? 'work' : endpoint === 'parts.get' ? 'part' : 'account';
    return { [key]: { ...record, title: 'Current renewal issue', body: 'Acceptance criteria: avoid double billing.', type: record?.id.includes(':issue/') ? 'issue' : 'ticket' } };
  });
  const issue = records.find(r => r.id.includes(':issue/'))!;
  response.action_graph!.actions[0]!.owner_id = actor;
  return { native, calls, response, issue, revoke: () => { revoked = true; } };
}
test('local gateway verifies current sources and reader, then simulates without calling a write API', async () => {
  const s = setup();
  assert.equal((await s.native.authenticate(auth.token)).actorId, actor);
  assert.deepEqual(await s.native.issue(auth, s.issue.id), s.issue);
  assert.equal((await s.native.issueBrief(auth, s.issue.id)).title, 'Current renewal issue');
  assert.match((await s.native.issueBrief(auth, s.issue.id)).body, /Acceptance criteria/);
  assert.equal((await s.native.owners(auth, ''))[0]!.name, 'Verified reader');
  await s.native.authorize(auth, s.response, s.issue.id, true);
  const reads = s.calls.length;
  const input = ticketInput(s.response, s.response.action_graph!.actions[0]!);
  const ticket = await s.native.createTicket(auth, input);
  assert.equal(ticket.native.display_id, 'PREVIEW-1');
  assert.equal(await s.native.findTicket(auth, input.external_ref), ticket);
  assert.equal(s.calls.length, reads);
  assert.ok(s.calls.every(endpoint => endpoint.endsWith('.get') || endpoint === 'dev-users.self'));
  await assert.rejects(s.native.call('works.create', input), /source reads only/);
  assert.equal(s.calls.length, reads);
});
test('local gateway blocks unverified owners, cross-workspace sources and revoked access', async () => {
  const s = setup();
  s.response.action_graph!.actions[0]!.owner_id = 'another-reader';
  await assert.rejects(s.native.authorize(auth, s.response, s.issue.id, true), /verified local reader/);
  await assert.rejects(s.native.issue(auth, 'don:core:test:devo/other:issue/1'), /another workspace/);
  await assert.rejects(s.native.authenticate('wrong-token'), /Invalid local/);
  s.revoke();
  await assert.rejects(s.native.owners(auth, ''), /verify current access/);
  assert.equal(s.native.creates, 0);
});
test('simulated timeout after creation reconciles to one PREVIEW ticket', async () => {
  const s = setup();
  const input = ticketInput(s.response, s.response.action_graph!.actions[0]!);
  s.native.behavior = 'commit_timeout';
  await assert.rejects(s.native.createTicket(auth, input), /after creation/);
  const ticket = await s.native.findTicket(auth, input.external_ref);
  assert.equal(ticket?.native.display_id, 'PREVIEW-1');
  assert.equal(s.native.creates, 1);
  assert.equal(s.calls.length, 0);
});
test('fresh source authorization overlaps reads with a four-read limit and still fails closed', async () => {
  const response = fixture();
  const ids = response.context_bundle.entities.flatMap(e => e.native ? [e.native.id] : []);
  const issue = ids.find(id => id.includes(':issue/'))!;
  let inFlight = 0, peak = 0, changed = false;
  const native = new LocalNative(auth, async (endpoint, args) => {
    if (endpoint === 'dev-users.self') return { dev_user: { id: actor, state: 'active', full_name: 'Verified reader', display_id: 'DEVU-6' } };
    inFlight++; peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    return { object: { id: changed && args.id === issue ? 'changed-source' : args.id } };
  });
  await native.authorize(auth, response, issue, false);
  assert.equal(peak, Math.min(4, ids.length));
  assert.equal(inFlight, 0);
  changed = true;
  await assert.rejects(native.authorize(auth, response, issue, false), /could not be verified/);
  assert.equal(native.creates, 0);
});
