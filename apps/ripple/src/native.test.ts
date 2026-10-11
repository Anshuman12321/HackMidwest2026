import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DevRevGateway } from './native.ts';
import { auth, actor, fixture } from './testing.ts';
import { ticketInput } from './types.ts';
class RecordingGateway extends DevRevGateway {
  calls: { endpoint: string; body: any }[] = []; responses: Record<string, any> = {};
  constructor() { super({ workspace: auth.workspace, actors: new Set([actor]), owners: new Set([actor]) }); }
  override async call(_auth: unknown, endpoint: string, body: unknown) { this.calls.push({ endpoint, body }); return this.responses[endpoint]; }
}
test('native ticket adapter fixes internal visibility, omits issue fields, and verifies readback', async () => {
  const gateway = new RecordingGateway(), response = fixture(), action = response.action_graph!.actions[0]!; action.owner_id = actor;
  const input = ticketInput(response, action);
  assert.equal(input.visibility, 1); assert.equal(input.type, 'ticket');
  assert.ok(!('severity' in input) && !('stage' in input) && !('priority_v2' in input));
  const work = { id: 'don:core:dvrv-us-1:devo/1mWckJhGyy:ticket/999', display_id: 'TKT-999', ...input,
    applies_to_part: { id: input.applies_to_part }, owned_by: [{ id: actor }], visibility: { id: 1 } };
  gateway.responses['works.create'] = { work: { id: work.id } }; gateway.responses['works.get'] = { work };
  const result = await gateway.createTicket(auth, input);
  assert.deepEqual(result.input, input); assert.equal(result.native.display_id, 'TKT-999');
  assert.deepEqual(gateway.calls.map(c => c.endpoint), ['works.create', 'works.get']);
  gateway.responses['works.list'] = { works: [work] };
  assert.equal((await gateway.findTicket(auth, input.external_ref))!.native.id, work.id);
  assert.deepEqual(gateway.calls.at(-1)!.body, { type: ['ticket'], external_ref: [action.action_key], limit: 2 });
  assert.throws(() => gateway.parseTicket({ ...work, type: 'issue', id: work.id.replace(':ticket/', ':issue/') }));
});
test('owner search explicitly includes authenticated self and rejects inactive or disabled users', async () => {
  const gateway = new RecordingGateway(); gateway.search = async () => [actor.replace('/6', '/8')];
  gateway.responses['dev-users.get'] = { dev_user: { id: actor, state: 'active', full_name: 'Maanav', display_id: 'DEVU-6' } };
  assert.deepEqual((await gateway.owners(auth, '')).map(o => o.id), [actor]);
  gateway.responses['dev-users.get'].dev_user.state = 'inactive';
  assert.deepEqual(await gateway.owners(auth, ''), []);
});
