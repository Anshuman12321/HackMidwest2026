import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpOwnerSearch } from './mcp.ts';
import { actor, auth } from './testing.ts';
test('delegated MCP discovers actual schemas and blocks unsupported required ticket fields', async t => {
  const prior = globalThis.fetch, calls: any[] = []; let required = ['title', 'applies_to_part', 'owned_by'];
  globalThis.fetch = async (_url, init) => {
    assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${auth.token}`);
    const message = JSON.parse(init!.body as string); calls.push(message);
    if (!message.id) return new Response(null, { status: 202 });
    let result: any = {};
    if (message.method === 'tools/list') result = { tools: [
      { name: 'discover_schema', inputSchema: {} }, { name: 'hybrid_search', inputSchema: { properties: { namespace: { enum: ['dev_user'] } } } },
    ] };
    if (message.method === 'tools/call') {
      const a = message.params.arguments;
      const value = message.params.name === 'hybrid_search' ? { results: [{ id: actor }] } : a.action_name === 'create_ticket' ? {
        properties: { title: {}, body: {}, applies_to_part: {}, owned_by: {}, visibility: { enum: [1, 2] }, external_ref: {} }, required,
      } : a.action_name === 'list_tickets' ? { properties: { external_ref: {} } } : { actions: ['create_ticket', 'list_tickets'] };
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  };
  t.after(() => { globalThis.fetch = prior; });
  assert.deepEqual(await mcpOwnerSearch('https://devrev.example/mcp')(auth, 'Maanav'), [actor]);
  assert.deepEqual(calls.filter(c => c.params?.name === 'discover_schema').map(c => c.params.arguments), [{}, { action_name: 'create_ticket' }, { action_name: 'list_tickets' }]);
  required = [...required, 'ctype__required_customer_field']; calls.length = 0;
  await assert.rejects(mcpOwnerSearch('https://devrev.example/mcp')(auth, ''), /ticket fields differ/);
  assert.ok(!calls.some(c => c.params?.name === 'hybrid_search'));
});
