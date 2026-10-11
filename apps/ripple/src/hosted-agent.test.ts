import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { createHostedInvestigator, ZipArchive, parseSse } from './hosted-agent.ts';
import { RippleError } from './types.ts';
import { auth, actor } from './testing.ts';
import type { InvestigationRequest } from '../../../contracts/investigation.ts';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('imports/maple-payments/manifest.json', root), 'utf8'));
const zipBytes = readFileSync(new URL('imports/maple-payments/data.zip', root));
const zip = new ZipArchive(zipBytes);
const issues: any[] = JSON.parse(zip.read('pm_json_data/issues.json').toString('utf8'));
const tickets: any[] = JSON.parse(zip.read('crm_json_data/tickets.json').toString('utf8'));
const TOKEN = 'test-actor-pat';
const issueRow = () => structuredClone(issues.find(i => i.issue_id === 'ISS-031'));
const ticketRows = ['TKT-124', 'TKT-125', 'TKT-126'].map(id => tickets.find(t => t.ticket_id === id));

const tool = (name: string, required: string[], properties: string[]) => ({ name, annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', required, properties: Object.fromEntries(properties.map(p => [p, {}])) } });
const TOOLS = [tool('discover_schema', [], ['action_name']), tool('hybrid_search', ['query'], ['query', 'namespace', 'limit', 'projection_type']),
  tool('fetch_object_context', ['object_id'], ['object_id']), tool('execute_dql', ['dql_query'], ['dql_query', 'fields']),
  { name: 'create_ticket', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: {} } }];

/** A fake DevRev MCP+REST server over `fetch`, built from the real manifest and archive rows. */
function fakeDevRev() {
  const state = { issue: issueRow(), tickets: ticketRows.map(t => structuredClone(t)), status: 200, calls: [] as string[], redirects: [] as (string | undefined)[], writes: 0 };
  const work = (kind: 'issue' | 'ticket', row: any) => {
    const key = row[kind + '_id'], mapping = manifest[kind + 's'][key];
    return { id: mapping.id, display_id: mapping.display_id, title: `[Maple ${key}] ${row.title ?? row.subject}`,
      body: `${row.description}\n\n---\n\`\`\`json\n${JSON.stringify(row, null, 2)}\n\`\`\``, external_ref: 'enterprise-bench/maple/' + key,
      applies_to_part: { id: manifest.parts[row.components[0]].id } };
  };
  const all = () => [work('issue', state.issue), ...state.tickets.map(t => work('ticket', t))];
  const partObj = (key: string) => ({ ...manifest.parts[key], name: key + ' part', description: 'Maple ' + key });
  const accountObj = (key: string) => ({ ...manifest.accounts[key], display_name: key, external_refs: ['enterprise-bench/maple/' + key] });
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
  const sse = (body: unknown) => new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 's1' } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), headers = init?.headers as Record<string, string>;
    state.redirects.push(init?.redirect);
    if (headers.Authorization !== 'Bearer ' + TOKEN) return new Response('no', { status: 401 });
    if (state.status !== 200) return new Response('no', { status: state.status });
    const body = JSON.parse(String(init?.body));
    if (url === 'https://api.devrev.ai/dev-users.self') return json({ dev_user: { id: actor, state: 'active' } });
    assert.equal(url, 'https://api.devrev.ai/mcp/v1');
    state.calls.push(body.method === 'tools/call' ? body.params.name : body.method);
    if (body.method === 'initialize') return sse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } });
    assert.equal(body.method, 'tools/call');
    if (!['discover_schema', 'hybrid_search', 'fetch_object_context', 'execute_dql'].includes(body.params.name)) state.writes++;
    const args = body.params.arguments;
    let result: any = {};
    switch (body.params.name) {
      case 'hybrid_search': {
        const ns = args.namespace;
        result = { results: ns === 'article' ? [] : all().filter(w => w.id.includes(`:${ns}/`)).map(w => ({ id: w.id })) };
        break;
      }
      case 'execute_dql': {
        const filter = args.dql_query.filter;
        if (filter?.field === 'issue.id') result = { issues: all().filter(w => filter.value.includes(w.id) && w.id.includes(':issue/')) };
        else if (filter?.field === 'ticket.id') result = { tickets: all().filter(w => filter.value.includes(w.id) && w.id.includes(':ticket/')) };
        else result = { articles: [] };
        break;
      }
      case 'fetch_object_context': {
        const key = [...Object.keys(manifest.parts)].find(k => manifest.parts[k].id === args.object_id)
          ?? Object.keys(manifest.accounts).find(k => manifest.accounts[k].id === args.object_id);
        const object = key?.startsWith('PART') ? partObj(key) : accountObj(key!);
        result = { object_context: JSON.stringify({ object }) };
        break;
      }
    }
    return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  };
  return { state, fetcher };
}
const request = (outcome = 'Restore Brazil subscription renewals without double billing.'): InvestigationRequest => ({
  schema_version: '2.0', request_id: randomUUID(), outcome, constraints: ['Keep customer updates as drafts'],
  reference_time: null, scope_hints: { part_ids: [], account_ids: [], starting_object: { ...manifest.issues['ISS-031'], url: null } } });
const code = (error: unknown) => (error as RippleError).failure?.code;

test('real archive: checksum matches the manifest and the central-directory reader returns documents', () => {
  assert.equal(createHash('sha256').update(zipBytes).digest('hex'), manifest.archive_sha256);
  assert.ok(statSync(new URL('imports/maple-payments/data.zip', root)).size > 3_000_000);
  assert.match(zip.read('maple_kb/art-044-failed-payment-retry-logic-dunning-strategy.md').toString('utf8'), /^#/);
  assert.throws(() => zip.read('missing.md'));
});
test('SSE parser joins data lines and ignores non-matching events', () => {
  assert.deepEqual(parseSse('data: {"id":9}\n\ndata: {"id":2,\ndata: "result":1}\n\n', 2), { id: 2, result: 1 });
  assert.throws(() => parseSse('data: {"id":1}\n\n', 2), /matching/);
});
test('hosted investigate returns a validated v2 review through read-only MCP calls with redirects refused', async () => {
  const { state, fetcher } = fakeDevRev();
  const investigator = createHostedInvestigator({ token: TOKEN, fetch: fetcher });
  const req = request(), response = await investigator.investigate(req, auth);
  assert.equal(response.request_id, req.request_id);
  assert.equal(response.status, 'review_required');
  assert.ok(response.context_bundle.entities.some(e => e.native?.display_id === 'ISS-42'));
  assert.ok(response.context_bundle.entities.some(e => e.kind === 'article') && response.context_bundle.entities.some(e => e.kind === 'part'));
  assert.equal(response.action_graph!.actions.length, 1);
  assert.equal(state.writes, 0);
  assert.ok(state.redirects.length > 5 && state.redirects.every(r => r === 'error'));
});
test('hosted revalidation accepts unchanged evidence and returns void', async () => {
  const { fetcher } = fakeDevRev();
  const investigator = createHostedInvestigator({ token: TOKEN, fetch: fetcher });
  const response = await investigator.investigate(request(), auth);
  await investigator.revalidate(response, auth);
});
test('changed cited evidence maps to evidence_changed', async () => {
  const { state, fetcher } = fakeDevRev();
  const investigator = createHostedInvestigator({ token: TOKEN, fetch: fetcher });
  const response = await investigator.investigate(request(), auth);
  state.issue.description += '\nEdited after review.';
  await assert.rejects(investigator.revalidate(response, auth), (e: unknown) => code(e) === 'evidence_changed');
});
test('a cited work that is no longer returned is treated as lost access or changed evidence, never success', async () => {
  const { state, fetcher } = fakeDevRev();
  const investigator = createHostedInvestigator({ token: TOKEN, fetch: fetcher });
  const response = await investigator.investigate(request(), auth);
  state.tickets = [];
  await assert.rejects(investigator.revalidate(response, auth), (e: unknown) => ['permission_denied', 'evidence_changed'].includes(code(e)!));
});
test('401 from DevRev is permission_denied for investigate and revalidate', async () => {
  const { state, fetcher } = fakeDevRev();
  const investigator = createHostedInvestigator({ token: TOKEN, fetch: fetcher });
  const response = await investigator.investigate(request(), auth);
  state.status = 401;
  await assert.rejects(investigator.investigate(request(), auth), (e: unknown) => code(e) === 'permission_denied');
  await assert.rejects(investigator.revalidate(response, auth), (e: unknown) => code(e) === 'permission_denied');
  const wrong = createHostedInvestigator({ token: 'someone-else', fetch: fakeDevRev().fetcher });
  await assert.rejects(wrong.investigate(request(), auth), (e: unknown) => code(e) === 'permission_denied');
});
test('server errors are blocked, an actor mismatch is denied, and bad tokens are refused up front', async () => {
  const { state, fetcher } = fakeDevRev();
  state.status = 500;
  await assert.rejects(createHostedInvestigator({ token: TOKEN, fetch: fetcher }).investigate(request(), auth), (e: unknown) => code(e) === 'blocked');
  state.status = 200;
  await assert.rejects(createHostedInvestigator({ token: TOKEN, fetch: fetcher }).investigate(request(), { ...auth, actorId: actor.replace('/6', '/7') }),
    (e: unknown) => code(e) === 'permission_denied');
  await assert.rejects(createHostedInvestigator({ token: 'bad\nvalue', fetch: fetcher }).investigate(request(), auth), (e: unknown) => code(e) === 'permission_denied');
});
