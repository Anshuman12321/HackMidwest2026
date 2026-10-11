import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RippleService, failure } from './service.ts';
import { Store } from './store.ts';
import { Secrets } from './security.ts';
import { Controller } from './controller.ts';
import { body, json } from './http.ts';
import { graphPng } from './graph.ts';
import { DevRevGateway } from './native.ts';
import { Postgres } from './postgres.ts';
import { makeEnrich, readOnlyActions, actionName, isApproval, needsReview, modeLabel } from './shared-app.ts';
import { RippleError } from './types.ts';
import type { Auth } from './types.ts';

export type HostedConfig = {
  controller: Controller; auth: Auth; issue: string; accessCode: string; publicUrl: string;
  writesEnabled: boolean; cronSecret?: string; now?: () => number;
  /** Verifies X-Ripple-Bridge proofs for /native/status. Must be a separate Secrets instance from the UI-state one. */
  bridgeSecrets?: Secrets;
  /** e.g. https://app.devrev.ai/<org slug>; used only to build ticket URLs. */
  appUrl?: string;
};
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
/** Raised for missing/invalid environment. The message names variables, never values. */
export class HostedConfigError extends Error {}

const COOKIE = 'ripple_session', SESSION_MS = 12 * 60 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
}
function secureHeaders(res: ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

const ISSUE_REF = /^[A-Za-z0-9:_\/.\-]{1,200}$/;
const STATUS_PATH = '/native/status';
const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];

/** Build the request handler from already-composed dependencies (injectable for tests). */
export function createHostedHandler(config: HostedConfig): Handler {
  const { controller, auth, issue } = config;
  const now = config.now ?? Date.now;
  const origin = new URL(config.publicUrl).origin;
  const enrich = makeEnrich(controller, auth);
  const signedIn = (req: IncomingMessage) => {
    const token = cookie(req, COOKIE);
    if (!token) return false;
    try { return controller.service.secrets.verify<{ exp: number }>(token, 'session').exp > now(); }
    catch { return false; }
  };
  /** Drain at most a few jobs inline; serverless functions have no background timer. */
  const work = async (limit = 1) => {
    if (!config.writesEnabled) return;
    try { for (let i = 0; i < limit; i++) if (!await controller.service.workOnce()) break; }
    catch { console.error('Ripple hosted worker failed; the durable job will be resumed.'); }
  };
  /** Resolve a display id or DON to a verified, readable issue DON in the configured workspace. Defaults to the configured issue. */
  const resolveIssue = async (requested: unknown) => {
    const ref = requested === undefined || requested === null || requested === '' ? issue : requested;
    if (typeof ref !== 'string' || !ISSUE_REF.test(ref)) throw new RippleError('invalid_request', 'Invalid issue reference.');
    return (await controller.service.native.issueBrief(auth, ref)).native.id;
  };
  /**
   * POST /native/status  (server-to-server, called by the DevRev snap-in launcher card)
   *
   * Auth (no access-code cookie, no Origin check; read-only):
   *   X-Ripple-Bridge: Secrets(RIPPLE_BRIDGE_SECRET).sign({path:'/native/status', hash: sha256hex(raw body), timestamp: ms}, 'bridge')
   *     valid only within 60s. RIPPLE_BRIDGE_SECRET is separate from RIPPLE_SECRET.
   *   Authorization: Bearer <DevRev actor session token>, verified via dev-users.self (active, same workspace),
   *     then the issue must be readable with that token (works.get).
   * Request body:  {"issue": "<issue DON>"}
   * Response 200:  {"issue":{"id","display_id","title"},
   *                 "status":"none"|"review"|"approved"|"rejected", "revision": number|null,
   *                 "ticket": {"display_id","url"|null}|null,   // first created/reused ticket; url needs DEVREV_APP_URL
   *                 "open_url":"<RIPPLE_PUBLIC_URL>/?issue=<urlencoded DON>"}
   *   Status is from the latest ripple_hosted plan for the workspace + issue (any actor). Never returns evidence or tokens.
   * Errors: 403 bad/stale proof or inactive/foreign user or unreadable issue, 401 missing bearer, 400 bad body.
   */
  const nativeStatus = async (req: IncomingMessage, res: ServerResponse) => {
    const native = controller.service.native;
    const signature = req.headers['x-ripple-bridge'];
    if (!config.bridgeSecrets || !native.verifyMember) return json(res, { error: 'not_configured' }, 503);
    const raw = await body(req);
    if (typeof signature !== 'string') return json(res, { error: 'permission_denied' }, 403);
    try {
      const proof = config.bridgeSecrets.verify<{ path: string; hash: string; timestamp: number }>(signature, 'bridge');
      if (proof.path !== STATUS_PATH || typeof proof.timestamp !== 'number' || Math.abs(now() - proof.timestamp) > 60_000
        || proof.hash !== createHash('sha256').update(raw).digest('hex')) return json(res, { error: 'permission_denied' }, 403);
    } catch { return json(res, { error: 'permission_denied' }, 403); }
    const token = bearer(req);
    if (!token) return json(res, { error: 'unauthorized' }, 401);
    let ref: unknown;
    try { ref = JSON.parse(raw).issue; } catch { return json(res, { error: 'invalid_request' }, 400); }
    if (typeof ref !== 'string' || !ISSUE_REF.test(ref)) return json(res, { error: 'invalid_request' }, 400);
    const actor = await native.verifyMember(token);
    const brief = await native.issueBrief(actor, ref);
    const plan = await controller.service.store.db.connection(async sql => (await sql.query(
      `SELECT state, response, result FROM ripple_plans WHERE workspace=$1 AND starting_issue=$2 ORDER BY created_at DESC LIMIT 1`,
      [auth.workspace, brief.native.id])).rows[0]) as { state: string; response: { action_graph?: { revision?: number } | null }; result: { results?: { native?: { display_id?: string } | null; status?: string }[] } | null } | undefined;
    const made = plan?.result?.results?.find(r => r.native?.display_id && ['created', 'reused'].includes(r.status ?? ''));
    const appUrl = config.appUrl?.replace(/\/+$/, '');
    const ticket = made?.native?.display_id ? { display_id: made.native.display_id,
      url: appUrl ? `${appUrl}/works/${encodeURIComponent(made.native.display_id)}` : null } : null;
    return json(res, { issue: { id: brief.native.id, display_id: brief.native.display_id, title: brief.title },
      status: plan ? plan.state : 'none', revision: plan?.response.action_graph?.revision ?? null, ticket,
      open_url: `${origin}/?issue=${encodeURIComponent(brief.native.id)}` });
  };
  return async (req, res) => {
    secureHeaders(res);
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const method = req.method ?? 'GET';
      if (path === '/cron') {
        const supplied = req.headers.authorization ?? '';
        if (!config.cronSecret || (method !== 'POST' && method !== 'GET') || !same(supplied, 'Bearer ' + config.cronSecret))
          return json(res, { error: 'unauthorized' }, 401);
        await work(5);
        return json(res, { ok: true });
      }
      if (path === STATUS_PATH) return method === 'POST' ? await nativeStatus(req, res) : json(res, { error: 'not_found' }, 404);
      if (method === 'POST' && path === '/login') {
        if (req.headers.origin !== origin) return json(res, { error: 'invalid_origin' }, 403);
        let code: unknown;
        try { code = JSON.parse(await body(req)).code; } catch { return json(res, { error: 'invalid_request' }, 400); }
        if (typeof code !== 'string' || !same(code, config.accessCode)) return json(res, { error: 'invalid_code' }, 401);
        const token = controller.service.secrets.sign({ exp: now() + SESSION_MS }, 'session');
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
        return json(res, { ok: true });
      }
      const protectedRoute = path === '/config' || path === '/initialize' || path === '/action' || path.startsWith('/graph/');
      if (!protectedRoute) return json(res, { error: 'not_found' }, 404);
      if (!signedIn(req)) return json(res, { error: 'unauthorized', code: 'login_required' }, 401);
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      if (method === 'GET' && path === '/config') {
        const issue_brief = await controller.service.native.issueBrief(auth, await resolveIssue(query.get('issue') ?? undefined));
        const mode = config.writesEnabled ? 'connected' : 'read-only';
        return json(res, { mode, live: true, label: modeLabel(mode), issue: issue_brief.native, issue_brief,
          owners: await controller.service.native.owners(auth, '') });
      }
      if (method === 'GET' && path === '/initialize') {
        await work(); // resume a pending or lease-expired job
        return json(res, await enrich(await controller.initialize(auth, await resolveIssue(query.get('issue') ?? undefined))));
      }
      if (method === 'GET' && path.startsWith('/graph/') && path.endsWith('.png')) {
        const data = await controller.graph(path.slice(7, -4));
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(await graphPng(data.response, data.view));
      }
      if (method === 'POST' && path === '/action') {
        if (req.headers.origin !== origin) return json(res, { error: 'invalid_origin' }, 403);
        const input = JSON.parse(await body(req));
        if (!config.writesEnabled && !readOnlyActions.has(actionName(input))) return json(res, { error: 'read_only', code: 'read_only' }, 403);
        const target = await resolveIssue(input?.issue);
        const result = await controller.action(auth, input, target);
        const approval = isApproval(input);
        if (approval) await work();
        if (!needsReview(result) && approval) return json(res, await enrich(await controller.initialize(auth, target)));
        return json(res, await enrich(result));
      }
      return json(res, { error: 'not_found' }, 404);
    } catch (error) {
      const detail = failure(error);
      return json(res, { error: detail.message, code: detail.code }, detail.code === 'permission_denied' ? 403 : 400);
    }
  };
}

const env = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new HostedConfigError('Missing required environment variable ' + name + '.');
  return value;
};
const list = (name: string) => env(name).split(',').map(v => v.trim()).filter(Boolean);

/** Compose the connected-mode runtime from environment. Never migrates and never falls back to fixtures. */
export async function composeHosted(): Promise<Handler> {
  let secrets: Secrets;
  try { secrets = new Secrets(env('RIPPLE_SECRET')); }
  catch (error) { throw error instanceof HostedConfigError ? error : new HostedConfigError('RIPPLE_SECRET must contain at least 32 characters.'); }
  const accessCode = env('RIPPLE_ACCESS_CODE'), publicUrl = env('RIPPLE_PUBLIC_URL');
  try { new URL(publicUrl); } catch { throw new HostedConfigError('RIPPLE_PUBLIC_URL must be an absolute URL.'); }
  let bridgeSecrets: Secrets | undefined;
  const bridge = process.env.RIPPLE_BRIDGE_SECRET?.trim();
  if (bridge) {
    if (bridge.length < 32) throw new HostedConfigError('RIPPLE_BRIDGE_SECRET must contain at least 32 characters.');
    if (bridge === process.env.RIPPLE_SECRET?.trim()) throw new HostedConfigError('RIPPLE_BRIDGE_SECRET must differ from RIPPLE_SECRET.');
    bridgeSecrets = new Secrets(bridge);
  }
  const token = env('DEVREV_TOKEN'), issue = env('RIPPLE_ISSUE_ID');
  const native = new DevRevGateway({ workspace: env('DEVREV_WORKSPACE_ID'), actors: new Set(list('RIPPLE_ACTOR_IDS')),
    owners: new Set(list('RIPPLE_ASSIGNABLE_OWNER_IDS')) });
  const database = new Postgres(env('DATABASE_URL'), 'ripple_hosted', { ca: process.env.DATABASE_CA_CERT?.trim() || undefined, max: 2 });
  try {
    const auth = await native.authenticate(token);
    await native.issue(auth, issue);
    const root = process.env.RIPPLE_IMPORT_ROOT ?? dirname(fileURLToPath(import.meta.url));
    const { createHostedInvestigator } = await import('./hosted-agent.ts');
    const service = new RippleService(new Store(database), native, createHostedInvestigator({ token, root }), secrets);
    return createHostedHandler({ controller: new Controller(service, publicUrl, false), auth, issue, accessCode, publicUrl,
      bridgeSecrets, appUrl: process.env.DEVREV_APP_URL?.trim() || undefined,
      writesEnabled: (process.env.RIPPLE_WRITES_ENABLED ?? 'false').trim().toLowerCase() === 'true',
      cronSecret: process.env.CRON_SECRET?.trim() || undefined });
  } catch (error) { await database.pool.end().catch(() => {}); throw error; }
}

let runtime: Promise<Handler> | undefined;
/** Vercel function entry point. The runtime is composed once per warm instance; failures are retried next request. */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    runtime ??= composeHosted();
    return await (await runtime)(req, res);
  } catch (error) {
    runtime = undefined;
    secureHeaders(res);
    // Only environment-variable names reach the client; upstream error text could embed hostnames or secrets.
    if (error instanceof HostedConfigError) return json(res, { error: 'config_error', message: error.message }, 500);
    console.error('Ripple hosted startup failed:', error instanceof Error ? error.name : 'error');
    return json(res, { error: 'startup_failed', message: 'Ripple could not start. Check server configuration and logs.' }, 500);
  }
}
