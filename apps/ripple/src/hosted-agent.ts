// Hosted (serverless-safe) read-only investigator. Faithful TypeScript port of
// scripts/devrev_mcp.py, scripts/retrieve_investigation.py (retrieve) and
// scripts/agent_bridge.py (identity, exact_revalidate). No Python, no subprocess,
// no personal connector config: the caller supplies the actor bearer explicitly.
// It never calls a write tool; the allowlist below is enforced before every call.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { InvestigationRequestSchema } from '../../../contracts/investigation.ts';
import type { InvestigationRequest, InvestigationResponse } from '../../../contracts/investigation.ts';
import { prepareInvestigation, RetrievalSchema, validateEvidence } from '../../../contracts/investigate.server.ts';
import type { Retrieval } from '../../../contracts/investigate.server.ts';
import { RippleError } from './types.ts';
import type { Auth, Investigator } from './types.ts';

const ORG = '1mWckJhGyy';
const MCP_URL = 'https://api.devrev.ai/mcp/v1';
const REST_BASE = 'https://api.devrev.ai/';
const READ_TOOLS = new Set(['discover_schema', 'hybrid_search', 'fetch_object_context', 'execute_dql']);
const NATIVE_READS = new Set(['dev-users.self', 'dev-users.get', 'works.get', 'parts.get', 'accounts.get']);
const STOP = new Set(['restore', 'investigate', 'resolve', 'fix', 'without', 'double', 'billing', 'the', 'and', 'for', 'with', 'of', 'in', 'to', 'a', 'an', 'payments']);

type Json = any;
type Fetch = typeof fetch;
type Code = 'permission_denied' | 'evidence_changed' | 'invalid_request' | 'blocked';
/** Internal failure carrying the same code vocabulary as scripts/agent_bridge.py. */
class HostedError extends Error {
  code: Code;
  constructor(code: Code, message: string) { super(message); this.code = code; }
}
class HttpStatusError extends Error {
  status: number;
  constructor(status: number) { super('HTTP ' + status); this.status = status; }
}

const now = () => new Date().toISOString();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Matches Python json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False) closely enough
// for the contract's own canonicalJson comparison; the contract hash is what is authoritative.
function sortValue(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortValue(value[k])]));
  return value;
}
const sourceHash = (value: unknown) => sha256(JSON.stringify(sortValue(value)));
const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortValue(a)) === JSON.stringify(sortValue(b));

// ---------------------------------------------------------------------------
// MCP client (port of devrev_mcp.py DevRevMCP with an explicit bearer).
// ---------------------------------------------------------------------------
export class HostedMcp {
  private headers: Record<string, string>;
  private counter = 0;
  private fetcher: Fetch;
  constructor(token: string, fetcher: Fetch = fetch) {
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new HostedError('permission_denied', 'Explicit actor bearer is required');
    this.fetcher = fetcher;
    this.headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  }
  private async post(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
    // redirect: 'error' so the credential can never be forwarded to another origin.
    const response = await this.fetcher(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new HttpStatusError(response.status);
    return response;
  }
  async initialize(): Promise<void> {
    const result = await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ripple-readonly', version: '1.0.0' } });
    this.headers['MCP-Protocol-Version'] = result.protocolVersion;
    await this.rpc('notifications/initialized', {}, true);
  }
  async nativeRead(endpoint: string, args: Record<string, unknown>): Promise<Json> {
    if (!NATIVE_READS.has(endpoint)) throw new HostedError('invalid_request', 'Endpoint outside native read-only allowlist');
    const allowed = endpoint === 'dev-users.self' ? [] : ['id'];
    const keys = Object.keys(args);
    if (keys.length !== allowed.length || keys.some(k => !allowed.includes(k))) throw new HostedError('invalid_request', 'Invalid native read arguments');
    // Same actor bearer; MCP session headers are never sent to REST.
    const response = await this.post(REST_BASE + endpoint, { Authorization: this.headers.Authorization!, 'Content-Type': 'application/json', Accept: 'application/json' }, args);
    return response.json();
  }
  async rpc(method: string, params: Json, notification = false): Promise<Json> {
    this.counter += 1;
    const id = this.counter;
    const payload: Json = { jsonrpc: '2.0', method, params };
    if (!notification) payload.id = id;
    const response = await this.post(MCP_URL, this.headers, payload);
    const session = response.headers.get('Mcp-Session-Id');
    if (session) this.headers['Mcp-Session-Id'] = session;
    if (notification) { await response.arrayBuffer().catch(() => undefined); return null; }
    let message: Json;
    if ((response.headers.get('Content-Type') ?? '').includes('text/event-stream')) message = parseSse(await response.text(), id);
    else message = await response.json();
    if (message?.id !== id || 'error' in message) throw new HostedError('blocked', 'MCP RPC rejected or mismatched response');
    return message.result;
  }
  async discover(): Promise<Json[]> {
    let result = await this.rpc('tools/list', {});
    const tools = [...result.tools];
    while (result.nextCursor) {
      result = await this.rpc('tools/list', { cursor: result.nextCursor });
      tools.push(...result.tools);
    }
    return tools;
  }
  async call(name: string, args: Json): Promise<Json> {
    if (!READ_TOOLS.has(name)) throw new HostedError('invalid_request', 'Tool outside read-only allowlist');
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (result?.isError) throw new HostedError('blocked', 'MCP read tool returned an error');
    if (result && 'structuredContent' in result) return result.structuredContent;
    const text = (result?.content ?? []).filter((item: Json) => item.type === 'text').map((item: Json) => item.text).join('\n');
    try { return JSON.parse(text); } catch { return { text }; }
  }
}

/** Server-sent events: `data:` lines joined per event; first event with a matching id wins. */
export function parseSse(text: string, id: number): Json {
  let data: string[] = [];
  const flush = (): Json | undefined => {
    if (!data.length) return undefined;
    const message = JSON.parse(data.join('\n')); data = [];
    return message?.id === id ? message : undefined;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^\s+/, ''));
    else if (!line) { const found = flush(); if (found) return found; }
  }
  const found = flush();
  if (found) return found;
  throw new HostedError('blocked', 'MCP stream ended without a matching response');
}

// ---------------------------------------------------------------------------
// Zip reader: central-directory parser + inflateRawSync, no dependencies.
// ---------------------------------------------------------------------------
export class ZipArchive {
  private entries = new Map<string, { method: number; compressed: number; size: number; offset: number }>();
  private buffer: Buffer;
  constructor(buffer: Buffer) {
    this.buffer = buffer;
    let end = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new HostedError('blocked', 'Archive central directory not found');
    const count = buffer.readUInt16LE(end + 10);
    let p = buffer.readUInt32LE(end + 16);
    for (let n = 0; n < count; n++) {
      if (buffer.readUInt32LE(p) !== 0x02014b50) throw new HostedError('blocked', 'Corrupt archive directory');
      const method = buffer.readUInt16LE(p + 10), compressed = buffer.readUInt32LE(p + 20), size = buffer.readUInt32LE(p + 24);
      const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32);
      const offset = buffer.readUInt32LE(p + 42);
      this.entries.set(buffer.toString('utf8', p + 46, p + 46 + nameLen), { method, compressed, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }
  names(): string[] { return [...this.entries.keys()]; }
  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (!entry) throw new HostedError('evidence_changed', 'Archive document is missing');
    const b = this.buffer;
    if (b.readUInt32LE(entry.offset) !== 0x04034b50) throw new HostedError('blocked', 'Corrupt archive entry');
    const start = entry.offset + 30 + b.readUInt16LE(entry.offset + 26) + b.readUInt16LE(entry.offset + 28);
    const raw = b.subarray(start, start + entry.compressed);
    const out = entry.method === 0 ? Buffer.from(raw) : entry.method === 8 ? inflateRawSync(raw) : undefined;
    if (!out || out.length !== entry.size) throw new HostedError('blocked', 'Unsupported or corrupt archive entry');
    return out;
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by retrieve and exact revalidation (retrieve_investigation.py).
// ---------------------------------------------------------------------------
const terms = (outcome: string) => [...new Set((outcome.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter(w => !STOP.has(w)).map(w => w.replace(/(?:als|ions|ing|s)$/, '')))].slice(0, 8);
const score = (text: string, keywords: string[]) => keywords.filter(t => text.toLowerCase().includes(t)).length / Math.max(keywords.length, 1);
function objectValue(result: Json): Json {
  const context = result.object_context;
  if (context) return (typeof context === 'string' ? JSON.parse(context) : context).object;
  return result.object ?? result;
}
function native(value: Json) {
  if (typeof value?.id !== 'string' || !value.id.includes(`:devo/${ORG}:`)) throw new HostedError('blocked', 'Object is outside the reviewed Maple workspace');
  return { id: value.id as string, display_id: value.display_id as string, url: null };
}
function originalRows(body: string, kind: string): Json[] {
  const rows: Json[] = [];
  for (const match of String(body ?? '').matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    try { const row = JSON.parse(match[1]!); if (row && typeof row === 'object' && !Array.isArray(row) && (kind + '_id') in row) rows.push(row); } catch { /* ignore */ }
  }
  return rows;
}
const familyPath = (kind: string) => kind === 'issue' ? 'pm_json_data/issues.json' : 'crm_json_data/tickets.json';
const relatedPath = (kind: string) => kind === 'part' ? 'pm_json_data/maple_parts.json' : 'crm_json_data/accounts.json';
const checkDiscovered = (name: string, tools: Map<string, Json>, args: Json) => {
  const tool = tools.get(name);
  if (!tool || tool.annotations?.readOnlyHint !== true) throw new HostedError('blocked', 'Required read-only MCP schema is unavailable');
  const schema = tool.inputSchema ?? {};
  if (!(schema.required ?? []).every((k: string) => k in args) || Object.keys(args).some(k => !(k in (schema.properties ?? {}))))
    throw new HostedError('blocked', 'Read arguments do not match the discovered schema');
};

class Source {
  private manifest?: Json; private zip?: ZipArchive; private zipHash?: string; private root: string;
  constructor(root: string) { this.root = root; }
  get manifestJson(): Json { return this.manifest ??= JSON.parse(readFileSync(this.root + 'imports/maple-payments/manifest.json', 'utf8')); }
  archive(): { zip: ZipArchive; sha256: string } {
    if (!this.zip) {
      const bytes = readFileSync(this.root + 'imports/maple-payments/data.zip');
      this.zipHash = sha256(bytes); this.zip = new ZipArchive(bytes);
    }
    return { zip: this.zip, sha256: this.zipHash! };
  }
}

async function retrieve(request: InvestigationRequest, client: HostedMcp, src: Source): Promise<Retrieval> {
  const started = now();
  const manifest = src.manifestJson;
  const discovered = await client.discover();
  const toolMap = new Map(discovered.map(t => [t.name as string, t]));
  const trace: Json[] = [];
  const hints = request.scope_hints;
  const start = hints.starting_object;
  const scopeIds = [...hints.part_ids, ...hints.account_ids, ...(start ? [start.id] : [])];
  if (scopeIds.some(v => typeof v !== 'string' || !v.includes(`:devo/${ORG}:`))) throw new HostedError('permission_denied', 'Scope belongs to an unsupported workspace');
  if (start && !start.id.includes(':issue/')) throw new HostedError('invalid_request', 'Starting object must be an issue');
  const limitations = ['Bounded outcome searches are not an exhaustive workspace scan.',
    'March source events are benchmark history; October imports and retrieval are not current runtime observations.',
    'Historical source owners are retained as IDs but not resolved to current authorized assignees.',
    'Current scheduler, queue, payment ledger, deployment logs and duplicate-charge tests are unavailable.'];
  const call = (name: string, args: Json) => {
    checkDiscovered(name, toolMap, args);
    trace.push({ tool: name, arguments: args, at: now() });
    return client.call(name, args);
  };
  await call('discover_schema', {});
  const keywords = terms(request.outcome);
  if (!keywords.length) throw new HostedError('invalid_request', 'Outcome has no resolvable subject');
  const candidates = new Map<string, Json>();
  for (const kind of ['issue', 'ticket'] as const) {
    const search = await call('hybrid_search', { query: `Which Maple Payments ${kind}s are relevant to this outcome: ${request.outcome}?`.slice(0, 400),
      namespace: kind, limit: 10, projection_type: 'id_with_label' });
    let ids: string[] = (search.results ?? []).filter((item: Json) => item.id.includes(`:devo/${ORG}:${kind}/`)).map((item: Json) => item.id);
    if (start && start.id.includes(`:${kind}/`)) ids = [start.id, ...ids.filter(v => v !== start.id)];
    ids = ids.slice(0, 12);
    if (!ids.length) continue;
    const result = await call('execute_dql', { dql_query: { filter: { field: kind + '.id', op: 'in', value: ids, value_type: 'json' }, limit: 12 },
      fields: ['id', 'display_id', 'title', 'body', 'external_ref', 'applies_to_part'] });
    if (result.next_cursor) limitations.push('Candidate reads were capped; additional DQL pages were not retrieved.');
    for (const value of result[kind + 's'] ?? []) {
      const isStart = Boolean(start && value.id === start.id);
      if (!ids.includes(value.id)) throw new HostedError('blocked', 'MCP returned an unrequested object');
      const rows = originalRows(value.body, kind);
      if (rows.length !== 1) {
        if (isStart) throw new HostedError('evidence_changed', 'Starting issue has no complete original JSON');
        limitations.push(`${value.display_id}: complete original JSON was unavailable or ambiguous; not cited.`);
        continue;
      }
      const row = rows[0]!, sourceId = row[kind + '_id'] as string;
      const mapping = manifest[kind + 's'][sourceId];
      if (!mapping || !sameJson(native(value), { ...mapping, url: null }) || value.external_ref !== 'enterprise-bench/maple/' + sourceId)
        throw new HostedError('blocked', 'Source/native identity mismatch');
      const rank = score(String(row.title ?? row.subject ?? '') + ' ' + String(row.description ?? ''), keywords);
      if (rank < 0.8 && !isStart) continue;
      const part = value.applies_to_part ?? {};
      const partSource = Object.keys(manifest.parts).find(k => manifest.parts[k].id === part.id);
      if (!partSource || !(row.components ?? []).includes(partSource)) throw new HostedError('blocked', 'Source/native product-part mismatch');
      if (hints.part_ids.length && !hints.part_ids.includes(part.id)) {
        if (isStart) throw new HostedError('invalid_request', 'Starting issue is excluded by product-part scope');
        continue;
      }
      const accountSource: string | null = row.account_id ?? null;
      if (hints.account_ids.length && !hints.account_ids.includes(manifest.accounts[accountSource ?? '']?.id)) {
        if (isStart) throw new HostedError('invalid_request', 'Starting issue is excluded by account scope');
        continue;
      }
      if (request.reference_time) {
        const cutoff = Date.parse(request.reference_time);
        const dates = [row.created_at, row.updated_at];
        if (!row.created_at || dates.some(d => d && Date.parse(d) > cutoff)) {
          if (isStart) throw new HostedError('invalid_request', 'Starting issue is excluded by the as-of time');
          limitations.push(`${sourceId}: excluded because the available row is undated or newer than the as-of time.`);
          continue;
        }
      }
      candidates.set(sourceId, { kind, source_id: sourceId, path: familyPath(kind), label: value.title, native: native(value), original: row,
        coverage: 'native_imported', retrieved_at: now(), part_source_id: partSource, account_source_id: accountSource, rank, is_start: isStart });
    }
  }
  if (start && ![...candidates.values()].some(r => r.native.id === start.id)) throw new HostedError('permission_denied', 'Starting issue is inaccessible or could not be retrieved');
  const byKind = (kind: string) => [...candidates.values()].filter(r => r.kind === kind);
  const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const issues = byKind('issue').sort((a, b) => Number(!a.is_start) - Number(!b.is_start) || b.rank - a.rank || cmp(a.source_id, b.source_id)).slice(0, 2);
  const tickets = byKind('ticket').sort((a, b) => b.rank - a.rank || cmp(a.source_id, b.source_id)).slice(0, 6);
  const records: Json[] = [...issues, ...tickets];
  const entities: Json[] = [];
  const related: [string, string, string][] = [...new Set(records.map(r => r.part_source_id))].map(k => ['parts', 'part', k]);
  related.push(...[...new Set(records.map(r => r.account_source_id).filter(Boolean))].map(k => ['accounts', 'account', k] as [string, string, string]));
  for (const [family, kind, key] of related) {
    const mapping = manifest[family][key];
    try {
      const obj = objectValue(await call('fetch_object_context', { object_id: mapping.id }));
      if (!sameJson(native(obj), { id: mapping.id, display_id: mapping.display_id, url: null })) throw new Error('Related native ID mismatch');
      if (kind === 'part' && !String(obj.description ?? '').includes(key)) throw new Error('Part source ID not found');
      if (kind === 'account' && !(obj.external_refs ?? []).includes('enterprise-bench/maple/' + key)) throw new Error('Account source ID not found');
      entities.push({ kind, source_id: key, path: relatedPath(kind), label: obj.name ?? obj.display_name ?? key, native: native(obj) });
    } catch (error) {
      // Credential failures must not be hidden as an omitted related object.
      if (error instanceof HttpStatusError) throw error;
      limitations.push(`${key}: native related-object/source identity could not be verified; omitted.`);
    }
  }
  // Documents are scoped by the product topic, not by a fixed evidence list.
  const topic = keywords.some(t => t.includes('subscript') || t.includes('renew')) ? 'subscription' : keywords.join(' ');
  const docHits = (await call('hybrid_search', { query: `Which Maple Payments documents explain ${topic} behavior, recovery and safety?`,
    namespace: 'article', limit: 6, projection_type: 'id_with_label' })).results ?? [];
  const docResult = await call('execute_dql', { dql_query: { expression: { query: topic }, filter: { field: 'article.object_type', op: 'in', value: ['article'], value_type: 'json' }, limit: 10 },
    fields: ['id', 'display_id', 'title', 'description', 'resource', 'extracted_content'] });
  let docs: Json[] = docResult.articles ?? [];
  if (docHits.length && !docs.length) {
    docs = (await call('execute_dql', { dql_query: { filter: { field: 'article.id', op: 'in', value: docHits.map((i: Json) => i.id), value_type: 'json' }, limit: 10 },
      fields: ['id', 'display_id', 'title', 'description', 'resource', 'extracted_content'] })).articles ?? [];
  }
  const articleKeys = Object.keys(manifest.articles);
  const docKeys = articleKeys.filter(k => k.toLowerCase().includes(topic) || (topic === 'subscription' && /retry|dunning/.test(k.toLowerCase())));
  const weight = (k: string) => ['recurring', 'retry', 'dunning', 'churn'].filter(w => k.includes(w)).length;
  docKeys.sort((a, b) => weight(b) - weight(a) || cmp(a, b));
  limitations.push(docs.length
    ? 'Native article metadata is readable but exact article bytes are not normalized by this adapter; documentation is archive-only.'
    : 'Native article search returned no readable articles. Documentation below is explicitly archive-only; native permissions/indexing are unverified.');
  if (docKeys.length) {
    const { zip, sha256: archiveHash } = src.archive();
    if (archiveHash !== manifest.archive_sha256) throw new HostedError('blocked', 'Archive checksum mismatch');
    for (const path of docKeys.slice(0, 4)) {
      const content = zip.read(path).toString('utf8');
      if (request.reference_time) { limitations.push(`${path}: undated documentation excluded from an as-of investigation.`); continue; }
      records.push({ kind: 'article', source_id: path, path, label: content.split('\n').find(l => l.startsWith('# '))?.replace(/^#+\s*/, '').trim() ?? (path.split('/').pop() ?? path).replace(/\.[^.]*$/, ''),
        native: null, original: content, coverage: 'archive_only', retrieved_at: now(), part_source_id: null, account_source_id: null });
    }
  }
  return RetrievalSchema.parse({ records, entities, archive_sha256: manifest.archive_sha256, limitations: [...new Set(limitations)].slice(0, 20),
    discovered_tools: discovered, trace, started_at: started });
}

async function exactRevalidate(response: InvestigationResponse, client: HostedMcp, src: Source): Promise<Retrieval> {
  const started = now();
  const bundle = response.context_bundle;
  const manifest = src.manifestJson;
  const discovered = await client.discover();
  const toolMap = new Map(discovered.map(t => [t.name as string, t]));
  const trace: Json[] = [];
  const call = (name: string, args: Json) => {
    checkDiscovered(name, toolMap, args);
    trace.push({ tool: name, arguments: args, at: now() });
    return client.call(name, args);
  };
  await call('discover_schema', {});
  const entities = new Map(bundle.entities.map(e => [e.entity_id, e]));
  const cited = new Map<string, any>();
  for (const evidence of bundle.evidence) {
    const entity: any = entities.get(evidence.entity_id);
    if (!entity || !sameJson(entity.source_ref, { record_id: evidence.source_ref.record_id, path: evidence.source_ref.path }))
      throw new HostedError('evidence_changed', 'Citation source identity does not match its entity');
    const key = evidence.source_ref.record_id;
    if (cited.has(key) && cited.get(key).entity_id !== entity.entity_id) throw new HostedError('evidence_changed', 'Duplicate source identity');
    cited.set(key, entity);
  }
  if (cited.size > 12 || bundle.entities.length > 28) throw new HostedError('invalid_request', 'Review exceeds the bounded retrieval size');
  const records: Json[] = [];
  for (const kind of ['issue', 'ticket'] as const) {
    const ids: string[] = [];
    for (const entity of [...cited.values()].filter(e => e.kind === kind)) {
      const mapping = manifest[kind + 's'][entity.source_ref.record_id];
      if (!mapping || !sameJson(entity.native, { ...mapping, url: null })) throw new HostedError('evidence_changed', 'Native work mapping changed');
      ids.push(mapping.id);
    }
    if (!ids.length) continue;
    const result = await call('execute_dql', { dql_query: { filter: { field: kind + '.id', op: 'in', value: ids, value_type: 'json' }, limit: 12 },
      fields: ['id', 'display_id', 'title', 'body', 'external_ref', 'applies_to_part'] });
    const rows: Json[] = result[kind + 's'] ?? [];
    if (rows.length !== ids.length || !ids.every(id => rows.some(v => v.id === id)) || !rows.every(v => ids.includes(v.id)))
      throw new HostedError('permission_denied', 'A cited work is no longer accessible');
    for (const value of rows) {
      const originals = originalRows(value.body ?? '', kind);
      if (originals.length !== 1) throw new HostedError('evidence_changed', 'A cited original record is unavailable or ambiguous');
      const original = originals[0]!, key = original[kind + '_id'] as string, entity = cited.get(key);
      if (!entity || entity.kind !== kind || !sameJson(native(value), entity.native) || value.external_ref !== 'enterprise-bench/maple/' + key)
        throw new HostedError('evidence_changed', 'Cited source/native identity changed');
      const partKey = Object.keys(manifest.parts).find(k => manifest.parts[k].id === value.applies_to_part?.id);
      if (!partKey || !(original.components ?? []).includes(partKey)) throw new HostedError('evidence_changed', 'Cited source/native product-part join changed');
      const accountKey: string | null = original.account_id ?? null;
      if (accountKey !== null && !(accountKey in manifest.accounts)) throw new HostedError('evidence_changed', 'Cited account source identity changed');
      records.push({ kind, source_id: key, path: familyPath(kind), label: value.title, native: native(value), original, coverage: 'native_imported',
        retrieved_at: now(), part_source_id: partKey, account_source_id: accountKey });
    }
  }
  const relatedEntities: Json[] = [];
  for (const entity of bundle.entities as any[]) {
    const kind = entity.kind as string;
    if (kind !== 'part' && kind !== 'account') {
      if (!cited.has(entity.source_ref.record_id)) throw new HostedError('evidence_changed', 'A reviewed source has no citation');
      continue;
    }
    const key = entity.source_ref.record_id as string;
    const mapping = manifest[kind + 's'][key];
    if (!mapping || !sameJson(entity.native, { id: mapping.id, display_id: mapping.display_id, url: null })) throw new HostedError('evidence_changed', 'Related native mapping changed');
    // Permission failures propagate; a missing related read cannot become a smaller "successful" refresh.
    const obj = objectValue(await call('fetch_object_context', { object_id: mapping.id }));
    if (!obj.id) throw new HostedError('permission_denied', 'A related source is no longer accessible');
    if (!sameJson(native(obj), entity.native)) throw new HostedError('evidence_changed', 'Related native identity changed');
    if ((kind === 'part' && !String(obj.description ?? '').includes(key)) || (kind === 'account' && !(obj.external_refs ?? []).includes('enterprise-bench/maple/' + key)))
      throw new HostedError('evidence_changed', 'Related source/native join changed');
    relatedEntities.push({ kind, source_id: key, path: relatedPath(kind), label: obj.name ?? obj.display_name ?? key, native: native(obj) });
  }
  const { zip, sha256: archiveHash } = src.archive();
  if (archiveHash !== manifest.archive_sha256 || archiveHash !== bundle.coverage.archive_sha256) throw new HostedError('evidence_changed', 'Archive checksum changed');
  for (const [key, entity] of cited) {
    if (entity.kind !== 'article') continue;
    if (!(key in manifest.articles) || entity.source_ref.path !== key || entity.native !== null) throw new HostedError('evidence_changed', 'Archive document identity changed');
    records.push({ kind: 'article', source_id: key, path: key, label: entity.label, native: null, original: zip.read(key).toString('utf8'), coverage: 'archive_only',
      retrieved_at: now(), part_source_id: null, account_source_id: null });
  }
  const bySource = new Map(records.map(r => [r.source_id, r]));
  for (const evidence of bundle.evidence) {
    const source = bySource.get(evidence.source_ref.record_id);
    if (!source || source.path !== evidence.source_ref.path || sourceHash(source.original) !== evidence.source_ref.content_sha256 || source.coverage !== evidence.coverage)
      throw new HostedError('evidence_changed', 'Reviewed evidence bytes, source path or coverage changed');
  }
  return RetrievalSchema.parse({ records, entities: relatedEntities, archive_sha256: archiveHash, limitations: bundle.coverage.limitations,
    discovered_tools: discovered, trace, started_at: started });
}

async function identity(client: HostedMcp): Promise<{ actor_id: string; workspace: string }> {
  const user = (await client.nativeRead('dev-users.self', {})).dev_user ?? {};
  if (user.state !== 'active' || typeof user.id !== 'string' || !user.id.includes(`:devo/${ORG}:devu/`))
    throw new HostedError('permission_denied', 'An active actor in the supported workspace is required');
  return { actor_id: user.id, workspace: ORG };
}

/** Same mapping as agent_bridge.py main(): 401/403/404 are access failures, everything else is blocked. */
function toRippleError(error: unknown): RippleError {
  if (error instanceof RippleError) return error;
  let code: Code = 'blocked';
  if (error instanceof HttpStatusError) code = [401, 403, 404].includes(error.status) ? 'permission_denied' : 'blocked';
  else if (error instanceof HostedError) code = error.code;
  const messages: Record<Code, string> = {
    permission_denied: 'Current DevRev access was denied.',
    evidence_changed: 'The reviewed evidence changed. Start a fresh investigation.',
    invalid_request: 'The investigation request is not supported.',
    blocked: 'The read-only investigation could not complete.',
  };
  return new RippleError(code, messages[code]);
}

export function createHostedInvestigator(opts: { token: string; root?: string; fetch?: typeof fetch }): Investigator {
  const root = (opts.root ?? fileURLToPath(new URL('../../../', import.meta.url))).replace(/\/?$/, '/');
  const src = new Source(root);
  const session = async (auth: Auth) => {
    const client = new HostedMcp(opts.token, opts.fetch ?? fetch);
    const verified = await identity(client);
    if (auth.workspace !== verified.workspace || auth.actorId !== verified.actor_id) throw new HostedError('permission_denied', 'Actor identity does not match the trusted context');
    await client.initialize();
    return client;
  };
  return {
    async investigate(request, auth) {
      try {
        const parsed = InvestigationRequestSchema.parse(request);
        return prepareInvestigation(parsed, await retrieve(parsed, await session(auth), src));
      } catch (error) {
        // Planner/validator failures (plain Errors, ZodErrors) are non-retryable blocks, never leaked details.
        throw toRippleError(error);
      }
    },
    async revalidate(response, auth) {
      try {
        const retrieved = await exactRevalidate(response, await session(auth), src);
        validateEvidence(response, retrieved, { fresh: true });
      } catch (error) {
        // Mirrors agent-http.ts: only denied access stays permission_denied; every other failure is evidence_changed.
        const failure = toRippleError(error);
        throw new RippleError(failure.failure.code === 'permission_denied' ? 'permission_denied' : 'evidence_changed',
          'Evidence or its access changed. Generate a fresh investigation.');
      }
    },
  };
}
