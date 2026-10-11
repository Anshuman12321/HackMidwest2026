import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { InvestigationRequestSchema } from './investigation.ts';
import { RetrievalSchema, prepareInvestigation } from './investigate.server.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const requestPath = arg('--request');
const request = InvestigationRequestSchema.parse(requestPath ? JSON.parse(readFileSync(resolve(requestPath), 'utf8')) : {
  schema_version: '1.0', request_id: randomUUID(), outcome: arg('--outcome') ?? 'Restore Brazil subscription renewals without double billing.',
  constraints: ['Do not change production settings', 'Keep customer updates as drafts'], reference_time: null,
  scope_hints: { part_ids: [], account_ids: [], starting_object: null },
});
// Use a configured Python >=3.11. Credentials are read inside the bridge and
// never passed as command arguments or copied to output artifacts.
const result = spawnSync(process.env.RIPPLE_PYTHON ?? 'python', [resolve(root, 'scripts/retrieve_investigation.py')], {
  input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 240000,
});
if (result.status !== 0 || result.error) throw new Error('MCP retrieval failed; no plan emitted. Check the server credential, endpoint and Python runtime.');
const retrieved = RetrievalSchema.parse(JSON.parse(result.stdout));
const response = prepareInvestigation(request, retrieved);
const output = resolve(arg('--output') ?? resolve(root, '.local/investigation-response.json'));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(response, null, 2) + '\n');
// Optional private capture enables deterministic revalidation of exact sources.
if (arg('--capture')) writeFileSync(resolve(arg('--capture')!), JSON.stringify({ request, retrieved }, null, 2) + '\n');
console.log(`Validated ${response.status} response: ${output}`);
console.log(`${response.context_bundle.evidence.length} citations; ${response.action_graph?.actions.length ?? 0} proposed tasks; zero DevRev writes.`);
