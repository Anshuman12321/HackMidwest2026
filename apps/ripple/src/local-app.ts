import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestDatabase, FakeNative, FixtureAgent, auth as fixtureAuth, fixture } from './testing.ts';
import { Store } from './store.ts';
import type { Database } from './store.ts';
import { RippleService, failure } from './service.ts';
import { Secrets } from './security.ts';
import { Controller } from './controller.ts';
import { body, json } from './http.ts';
import { graphPng } from './graph.ts';
import { LocalNative } from './local-native.ts';
import { AgentClient, DevRevGateway } from './native.ts';
import { mcpOwnerSearch } from './mcp.ts';
import { Postgres } from './postgres.ts';
import { runAgentBridge } from './agent-process.ts';
import { createAgentServer } from './agent-http.ts';
import type { Auth, Investigator, NativeGateway, Ticket, TicketInput } from './types.ts';
import { makeEnrich, readOnlyActions, actionName, isApproval, needsReview as needsReviewCard, modeLabel } from './shared-app.ts';

export type LocalMode = 'fixture' | 'live-preview' | 'read-only' | 'connected';
export type LocalAppOptions = { controller: Controller; auth: Auth; issue: string; mode: LocalMode; assetDir?: string;
  runWorker?: boolean; onClose?: () => Promise<void> };
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function portValue(raw: string | undefined): number {
  const port = Number(raw ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Local Ripple port must be an integer from 1 to 65535.');
  return port;
}
async function closeServer(server: ReturnType<typeof createServer> | undefined) {
  if (!server?.listening) return;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}
async function closeDatabase(db: TestDatabase | Postgres | undefined) {
  if (db instanceof TestDatabase) await db.pg.close();
  else if (db instanceof Postgres) await db.pool.end();
}
const env = (name: string) => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error('Configure ' + name + ' before selecting connected mode.');
  return value.trim();
};
function stableSecret(): string {
  if (process.env.RIPPLE_SECRET) return env('RIPPLE_SECRET');
  const dir = resolve(process.env.RIPPLE_LOCAL_DATA_DIR ?? 'apps/ripple/.preview-data');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, 'secret');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const value = randomUUID() + randomUUID();
  writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
  return value;
}
class PersistentSimulationNative implements NativeGateway {
  inner: NativeGateway;
  db: Database;
  tickets = new Map<string, Ticket>();
  constructor(inner: NativeGateway, db: Database) { this.inner = inner; this.db = db; }
  static async create(inner: NativeGateway, db: Database) {
    const native = new PersistentSimulationNative(inner, db);
    await db.connection(async sql => {
      const rows = await sql.query('SELECT ticket FROM ripple_local_simulated_tickets');
      for (const row of rows.rows) {
        const ticket = row.ticket as Ticket;
        native.tickets.set(ticket.input.external_ref, ticket);
        const sequence = Number(ticket.native.display_id.match(/PREVIEW-([0-9]+)/)?.[1] ?? 0);
        const target = inner as NativeGateway & { creates?: number };
        if (target.creates !== undefined) target.creates = Math.max(target.creates, sequence);
      }
    });
    return native;
  }
  authenticate(token: string) { return this.inner.authenticate(token); }
  issue(auth: Auth, id: string) { return this.inner.issue(auth, id); }
  issueBrief(auth: Auth, id: string) { return this.inner.issueBrief(auth, id); }
  owners(auth: Auth, query: string) { return this.inner.owners(auth, query); }
  authorize(auth: Auth, response: import('../../../contracts/investigation.ts').InvestigationResponse, issue: string, checkOwners: boolean) {
    return this.inner.authorize(auth, response, issue, checkOwners);
  }
  async findTicket(auth: Auth, key: string) { return this.tickets.get(key) ?? this.inner.findTicket(auth, key); }
  async createTicket(auth: Auth, input: TicketInput): Promise<Ticket> {
    try { return await this.inner.createTicket(auth, input); }
    finally {
      const current = await this.inner.findTicket(auth, input.external_ref).catch(() => null);
      if (current) {
        this.tickets.set(input.external_ref, current);
        await this.db.connection(sql => sql.query(
          'INSERT INTO ripple_local_simulated_tickets (external_ref,ticket) VALUES ($1,$2) ON CONFLICT (external_ref) DO UPDATE SET ticket=EXCLUDED.ticket',
          [input.external_ref, JSON.stringify(current)]));
      }
    }
  }
}

/** Compose the local React BFF. Every route is loopback-only and same-origin. */
export function createLocalApp(options: LocalAppOptions) {
  const port = portValue(process.env.PORT ?? process.env.PREVIEW_PORT);
  const originSet = new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port]);
  const assetDir = resolve(options.assetDir ?? 'apps/ripple/web/build');
  const workerEnabled = options.mode === 'read-only' ? false : options.runWorker ?? true;
  const enrich = makeEnrich(options.controller, options.auth);
  let busy = false;
  const timer = workerEnabled ? setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await options.controller.service.workOnce(); }
    catch { console.error('Ripple local worker failed; durable jobs will be resumed.'); }
    finally { busy = false; }
  }, 1000) : undefined;
  const app = createServer(async (req, res) => {
    try {
      if (!loopback.has(req.socket.remoteAddress ?? '')) return json(res, { error: 'loopback_only' }, 403);
      const host = req.headers.host;
      if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return json(res, { error: 'invalid_host' }, 403);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1:' + port), path = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && path === '/health') return json(res, { ok: true, mode: options.mode });
      if (req.method === 'GET' && path === '/config') {
        const issue_brief = await options.controller.service.native.issueBrief(options.auth, options.issue);
        const issue = issue_brief.native;
        const live = options.mode !== 'fixture';
        const label = modeLabel(options.mode);
        return json(res, { mode: options.mode, live, label, issue, issue_brief,
          owners: await options.controller.service.native.owners(options.auth, '') });
      }
      if (req.method === 'GET' && path === '/initialize')
        return json(res, await enrich(await options.controller.initialize(options.auth, options.issue)));
      if (req.method === 'GET' && path.startsWith('/graph/') && path.endsWith('.png')) {
        const data = await options.controller.graph(path.slice(7, -4));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        return res.end(await graphPng(data.response, data.view));
      }
      if (req.method === 'POST') {
        if (!originSet.has(req.headers.origin ?? '')) return json(res, { error: 'invalid_origin' }, 403);
        if (path !== '/action') return json(res, { error: 'not_found' }, 404);
        const input = JSON.parse(await body(req));
        if (options.mode === 'read-only') {
          if (!readOnlyActions.has(actionName(input)))
            return json(res, { error: 'read_only', code: 'read_only' }, 403);
        }
        const result = await options.controller.action(options.auth, input, options.issue);
        const approval = isApproval(input);
        if (approval && workerEnabled) await options.controller.service.workOnce();
        const needsReview = needsReviewCard(result);
        if (!needsReview && approval) return json(res, await enrich(await options.controller.initialize(options.auth, options.issue)));
        return json(res, await enrich(result));
      }
      if (req.method === 'GET') {
        const candidate = resolve(assetDir, '.' + (path === '/' ? '/index.html' : path));
        if (candidate !== assetDir && !candidate.startsWith(assetDir + sep)) return json(res, { error: 'not_found' }, 404);
        if (!existsSync(candidate)) return json(res, { error: 'not_found' }, 404);
        const ext = candidate.split('.').at(-1)?.toLowerCase();
        const contentType = ext === 'html' ? 'text/html; charset=utf-8' : ext === 'js' ? 'text/javascript; charset=utf-8'
          : ext === 'css' ? 'text/css; charset=utf-8' : ext === 'svg' ? 'image/svg+xml' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
        return res.end(readFileSync(candidate));
      }
      return json(res, { error: 'not_found' }, 404);
    } catch (error) {
      const detail = failure(error);
      return json(res, { error: detail.message, code: detail.code }, detail.code === 'permission_denied' ? 403 : 400);
    }
  });
  let closePromise: Promise<void> | undefined;
  return { app, close: () => closePromise ??= (async () => {
    if (timer) clearInterval(timer);
    await closeServer(app);
    await closeDatabase(options.controller.service.store.db as TestDatabase | Postgres);
    await options.onClose?.();
  })() };
}

/** Start from explicit fixture/live-preview/connected configuration. */
export async function startLocalApp() {
  const mode = (process.env.RIPPLE_LOCAL_MODE ?? 'fixture') as LocalMode;
  if (!['fixture', 'live-preview', 'read-only', 'connected'].includes(mode)) throw new Error('RIPPLE_LOCAL_MODE must be fixture, live-preview, read-only, or connected.');
  const port = portValue(process.env.PORT ?? process.env.PREVIEW_PORT);
  const publicUrl = 'http://127.0.0.1:' + port;
  const secret = new Secrets(stableSecret());
  const databaseUrl = process.env.DATABASE_URL ? env('DATABASE_URL') : undefined;
  const configuredIssue = process.env.RIPPLE_LOCAL_ISSUE_ID;
  let issue = configuredIssue ?? fixture().context_bundle.entities.find(entity => entity.kind === 'issue')!.native!.id;
  let auth: Auth = fixtureAuth;
  let native: NativeGateway = new FakeNative();
  let investigator: Investigator = new FixtureAgent();
  let agentServer: ReturnType<typeof createAgentServer> | undefined;
  if (mode === 'connected') {
    const workspace = env('DEVREV_WORKSPACE_ID');
    const actors = new Set(env('RIPPLE_ACTOR_IDS').split(',').filter(Boolean));
    const owners = new Set(env('RIPPLE_ASSIGNABLE_OWNER_IDS').split(',').filter(Boolean));
    const token = env('RIPPLE_LOCAL_ACTOR_TOKEN');
    const mcpUrl = env('DEVREV_MCP_URL');
    const agentUrl = env('AGENT_URL'), agentBearer = env('AGENT_BEARER');
    if (!configuredIssue) throw new Error('Configure RIPPLE_LOCAL_ISSUE_ID before selecting connected mode.');
    native = new DevRevGateway({ workspace, actors, owners }, mcpOwnerSearch(mcpUrl));
    auth = await native.authenticate(token);
    await native.issue(auth, issue);
    investigator = new AgentClient(agentUrl, agentBearer);
  }
  const dataDir = resolve(process.env.RIPPLE_LOCAL_DATA_DIR ?? 'apps/ripple/.preview-data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let database: TestDatabase | Postgres | undefined;
  let local: ReturnType<typeof createLocalApp> | undefined;
  try {
    if (mode === 'live-preview' || mode === 'read-only') {
      const identity = await runAgentBridge('identity', {}, undefined, true);
      if (typeof identity.actor_id !== 'string' || typeof identity.workspace !== 'string') throw new Error('The local DevRev reader identity could not be verified.');
      auth = { actorId: identity.actor_id, workspace: identity.workspace, token: 'local-preview-token' };
      native = new LocalNative(auth, (endpoint, args) => runAgentBridge('native', { endpoint, args },
        { workspace: auth.workspace, actor_id: auth.actorId, actor_session_token: auth.token }, true));
      const bearer = randomUUID() + randomUUID();
      agentServer = createAgentServer({ bearer, local: true });
      await new Promise<void>((ok, reject) => {
        const onError = (error: Error) => { agentServer?.off('listening', onListening); reject(error); };
        const onListening = () => { agentServer?.off('error', onError); ok(); };
        agentServer!.once('error', onError); agentServer!.once('listening', onListening);
        agentServer!.listen(0, '127.0.0.1');
      });
      const address = agentServer.address();
      if (!address || typeof address === 'string') throw new Error('The local investigation server did not start.');
      investigator = new AgentClient('http://127.0.0.1:' + address.port, bearer);
    }
    if (databaseUrl) {
      const schema = mode === 'connected' ? undefined : ({ fixture: 'ripple_fixture', 'live-preview': 'ripple_live_preview', 'read-only': 'ripple_read_only' } as const)[mode];
      database = new Postgres(databaseUrl, schema);
      if (schema) await database.pool.query('CREATE SCHEMA IF NOT EXISTS "' + schema + '"');
      if (schema) for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
        const migration = readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
        await database.connection(sql => sql.query(migration));
      }
    } else {
      database = await TestDatabase.create(resolve(dataDir, mode + '-db'));
      for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => /^\d+_.*\.sql$/.test(f) && f !== '001_ripple.sql').sort())
        await database.pg.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    }
    if (mode === 'fixture' || mode === 'live-preview') native = await PersistentSimulationNative.create(native, database);
    const service = new RippleService(new Store(database), native, investigator, secret);
    const controller = new Controller(service, publicUrl, mode === 'fixture' ? true : mode === 'live-preview' ? 'live' : false);
    local = createLocalApp({ controller, auth, issue, mode, runWorker: mode !== 'read-only', onClose: () => closeServer(agentServer) });
    await new Promise<void>((ok, reject) => {
      const onError = (error: Error) => { local!.app.off('listening', onListening); reject(error); };
      const onListening = () => { local!.app.off('error', onError); ok(); };
      local!.app.once('error', onError); local!.app.once('listening', onListening);
      local!.app.listen(port, '127.0.0.1');
    });
    console.log('Ripple ' + mode + ': ' + publicUrl);
    const stop = () => { void local?.close(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    return local;
  } catch (error) {
    if (local) await local.close();
    else await closeDatabase(database);
    await closeServer(agentServer);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startLocalApp();
