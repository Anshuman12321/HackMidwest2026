import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TestDatabase, FakeNative, FixtureAgent, auth, actor, fixture, memberToken } from './testing.ts';
import { Store } from './store.ts';
import { RippleService } from './service.ts';
import { Secrets } from './security.ts';
import { Controller } from './controller.ts';
import { createHostedHandler } from './hosted-app.ts';
import hostedEntry from './hosted-app.ts';

type Snap = { type: string; action_id?: string; block_id?: string; value?: unknown; elements?: Snap[] };
const flatten = (snaps: Snap[]): Snap[] => snaps.flatMap(s => [s, ...flatten(s.elements ?? [])]);
const PUBLIC = 'https://ripple.example.test', CODE = 'correct horse battery';

async function boot(t: { after: (fn: () => unknown) => void }, writesEnabled: boolean, now?: () => number) {
  const db = await TestDatabase.create(); t.after(() => db.pg.close());
  const native = new FakeNative();
  const service = new RippleService(new Store(db), native, new FixtureAgent(), new Secrets('hosted-app-integration-secret-32-chars'));
  const controller = new Controller(service, PUBLIC, false);
  const handler = createHostedHandler({ controller, auth, issue: 'ISS-42', accessCode: CODE, publicUrl: PUBLIC, writesEnabled, cronSecret: 'cron-test-secret', now,
    appUrl: 'https://app.devrev.ai/acme/' });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()); }));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { db, native, base };
}
const login = async (base: string, code = CODE, origin = PUBLIC) => fetch(base + '/login', { method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
const sessionCookie = async (base: string) => (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
const post = (base: string, cookie: string, snap: Snap, origin = PUBLIC) => fetch(base + '/action', { method: 'POST',
  headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action_id: snap.action_id, block_id: snap.block_id, value: snap.value }) });

test('protected routes require a session; bad codes are rejected', async t => {
  const { base } = await boot(t, true);
  for (const path of ['/config', '/initialize', '/graph/x.png']) assert.equal((await fetch(base + path)).status, 401, path);
  assert.equal((await fetch(base + '/config', { headers: { Cookie: 'ripple_session=forged.value' } })).status, 401);
  const bad = await login(base, 'wrong code');
  assert.equal(bad.status, 401); assert.equal(bad.headers.get('set-cookie'), null);
  const good = await login(base);
  assert.equal(good.status, 200);
  const header = good.headers.get('set-cookie')!;
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(header.includes(flag), flag);
  assert.equal(good.headers.get('x-content-type-options'), 'nosniff');
  const cookie = header.split(';')[0]!;
  const config = await fetch(base + '/config', { headers: { Cookie: cookie } });
  assert.equal(config.status, 200);
  assert.equal(((await config.json()) as { mode: string }).mode, 'connected');
});

test('sessions expire after 12 hours', async t => {
  let clock = 1_000_000;
  const { base } = await boot(t, true, () => clock);
  const cookie = await sessionCookie(base);
  assert.equal((await fetch(base + '/config', { headers: { Cookie: cookie } })).status, 200);
  clock += 12 * 60 * 60_000 + 1;
  assert.equal((await fetch(base + '/config', { headers: { Cookie: cookie } })).status, 401);
});

test('mutations require the configured public origin', async t => {
  const { base, db } = await boot(t, true);
  assert.equal((await login(base, CODE, 'https://attacker.invalid')).status, 403);
  const cookie = await sessionCookie(base);
  const response = await post(base, cookie, { type: 'button', action_id: 'investigate:x', block_id: 'invalid' }, 'https://attacker.invalid');
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { error: string }).error, 'invalid_origin');
  assert.equal((await db.connection(sql => sql.query('SELECT * FROM ripple_plans'))).rows.length, 0);
});

async function reviewed(base: string, cookie: string) {
  const initial = await fetch(base + '/initialize', { headers: { Cookie: cookie } }).then(r => r.json()) as { snaps: Snap[] };
  const investigate = flatten(initial.snaps).find(s => s.action_id?.startsWith('investigate:'))!;
  const view = await post(base, cookie, investigate).then(r => r.json()) as { snaps: Snap[]; preview_review?: unknown; preview_owners?: unknown };
  assert.ok('preview_review' in view && 'preview_owners' in view, 'enrich fields are present');
  return view;
}

test('writes disabled: investigation works but approve is rejected server-side', async t => {
  const { base, native } = await boot(t, false);
  const cookie = await sessionCookie(base);
  assert.equal(((await fetch(base + '/config', { headers: { Cookie: cookie } }).then(r => r.json())) as { mode: string }).mode, 'read-only');
  const view = await reviewed(base, cookie);
  const owner = flatten(view.snaps).find(s => s.type === 'user_picker')!;
  const rejected = await post(base, cookie, { ...owner, value: [actor] });
  assert.equal(rejected.status, 403); assert.equal(((await rejected.json()) as { code: string }).code, 'read_only');
  const approve = flatten(view.snaps).find(s => s.action_id?.startsWith('approve:'));
  if (approve) assert.equal((await post(base, cookie, approve)).status, 403);
  assert.equal(native.creates, 0);
});

test('writes enabled: approval runs the worker inline and cron is guarded', async t => {
  const { base, native } = await boot(t, true);
  const cookie = await sessionCookie(base);
  const view = await reviewed(base, cookie);
  const owner = flatten(view.snaps).find(s => s.type === 'user_picker')!;
  const assigned = await post(base, cookie, { ...owner, value: [actor] }).then(r => r.json()) as { snaps: Snap[] };
  const approve = flatten(assigned.snaps).find(s => s.action_id?.startsWith('approve:'))!;
  const approved = await post(base, cookie, approve);
  assert.equal(approved.status, 200);
  assert.equal(native.creates, 1, 'ticket created within the same request');
  assert.match(JSON.stringify(await approved.json()), /PREVIEW-1/);
  assert.equal((await fetch(base + '/cron', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/cron', { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(base + '/cron', { method: 'POST', headers: { Authorization: 'Bearer cron-test-secret' } })).status, 200);
  assert.equal(native.creates, 1);
});

test('missing environment yields a clear 500 that names variables only', async () => {
  const saved = { ...process.env };
  for (const k of ['RIPPLE_SECRET', 'DATABASE_URL']) delete process.env[k];
  process.env.RIPPLE_SECRET = 'x'.repeat(10);
  try {
    let status = 0, text = '';
    await hostedEntry({ url: '/config', method: 'GET', headers: {} } as never, {
      setHeader() {}, writeHead(s: number) { status = s; }, end(b: string) { text = b; } } as never);
    assert.equal(status, 500);
    assert.doesNotMatch(text, /xxxxxxxx/);
    assert.match(text, /RIPPLE_SECRET/);
  } finally { process.env = saved; }
});

const issueNative = fixture().context_bundle.entities.find(e => e.kind === 'issue')!.native!;
const statusCall = (base: string, o: { issue?: unknown; token?: string | null; raw?: string } = {}) => {
  const raw = o.raw ?? JSON.stringify({ issue: o.issue ?? issueNative.id });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (o.token !== null) headers.Authorization = 'Bearer ' + (o.token ?? memberToken);
  return fetch(base + '/native/status', { method: 'POST', headers, body: raw });
};

test('issue param resolves display ids and DONs; foreign or unknown issues are rejected', async t => {
  const { base } = await boot(t, true);
  const cookie = await sessionCookie(base);
  const get = (path: string) => fetch(base + path, { headers: { Cookie: cookie } });
  for (const ref of [issueNative.display_id, issueNative.id]) {
    const config = await get('/config?issue=' + encodeURIComponent(ref));
    assert.equal(config.status, 200);
    assert.equal(((await config.json()) as { issue: { id: string } }).issue.id, issueNative.id);
    assert.equal((await get('/initialize?issue=' + encodeURIComponent(ref))).status, 200);
  }
  assert.equal(((await get('/config').then(r => r.json())) as { issue: { id: string } }).issue.id, issueNative.id, 'default issue');
  const foreign = 'don:core:dvrv-us-1:devo/OTHER:issue/9';
  assert.equal((await get('/config?issue=' + encodeURIComponent(foreign))).status, 403);
  assert.equal((await get('/initialize?issue=' + encodeURIComponent(foreign))).status, 403);
  assert.equal((await get('/initialize?issue=' + encodeURIComponent('bad id; drop'))).status, 400);
});

test('signed UI state cannot be replayed against another issue', async t => {
  const { base, db } = await boot(t, true);
  const cookie = await sessionCookie(base);
  const initial = await fetch(base + '/initialize', { headers: { Cookie: cookie } }).then(r => r.json()) as { snaps: Snap[] };
  const investigate = flatten(initial.snaps).find(s => s.action_id?.startsWith('investigate:'))!;
  // Same state, but the request names an issue that cannot be resolved / differs from the signed one.
  const other = await fetch(base + '/action', { method: 'POST', headers: { Origin: PUBLIC, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_id: investigate.action_id, block_id: investigate.block_id, issue: 'don:core:dvrv-us-1:devo/OTHER:issue/9' }) });
  assert.equal(other.status, 403);
  assert.equal((await db.connection(sql => sql.query('SELECT * FROM ripple_plans'))).rows.length, 0);
  // A state signed for a different issue is rejected by the controller even when the requested issue is valid.
  const secrets = new Secrets('hosted-app-integration-secret-32-chars');
  const state = secrets.verify<{ issue: string }>(investigate.block_id!, 'ui');
  const forged = secrets.sign({ ...state, issue: 'don:core:dvrv-us-1:devo/1mWckJhGyy:issue/999' }, 'ui');
  const replay = await post(base, cookie, { ...investigate, block_id: forged });
  assert.match(JSON.stringify(await replay.json()), /belongs to another user or issue/);
  assert.equal((await db.connection(sql => sql.query('SELECT * FROM ripple_plans'))).rows.length, 0);
});

test('/native/status authenticates the DevRev actor', async t => {
  const { base, native } = await boot(t, true);
  assert.equal((await statusCall(base, { token: null })).status, 401);
  assert.equal((await statusCall(base, { token: 'not-a-token' })).status, 403);
  assert.equal((await statusCall(base, { raw: '{}' })).status, 400);
  assert.equal((await statusCall(base, { issue: 'don:core:dvrv-us-1:devo/OTHER:issue/9' })).status, 403, 'unreadable issue');
  native.deny = true;
  assert.equal((await statusCall(base)).status, 403, 'actor not active');
});

test('/native/status reports none, review and approved with ticket; needs no cookie and leaks no evidence', async t => {
  const { base, db } = await boot(t, true);
  const none = await statusCall(base);
  assert.equal(none.status, 200);
  const noneBody = await none.json() as { issue: { title: string } };
  assert.ok(noneBody.issue.title);
  assert.deepEqual(noneBody, { issue: { id: issueNative.id, display_id: issueNative.display_id, title: noneBody.issue.title },
    status: 'none', revision: null, ticket: null, open_url: `${PUBLIC}/?issue=${encodeURIComponent(issueNative.id)}` });
  const cookie = await sessionCookie(base);
  const view = await reviewed(base, cookie);
  const review = await statusCall(base).then(r => r.json()) as { status: string; revision: number; ticket: unknown };
  assert.equal(review.status, 'review'); assert.ok(review.revision >= 1); assert.equal(review.ticket, null);
  const owner = flatten(view.snaps).find(s => s.type === 'user_picker')!;
  const assigned = await post(base, cookie, { ...owner, value: [actor] }).then(r => r.json()) as { snaps: Snap[] };
  await post(base, cookie, flatten(assigned.snaps).find(s => s.action_id?.startsWith('approve:'))!);
  const text = await statusCall(base).then(r => r.text());
  const approved = JSON.parse(text) as { status: string; ticket: { display_id: string; url: string } };
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.ticket, { display_id: 'PREVIEW-1', url: 'https://app.devrev.ai/acme/works/PREVIEW-1' });
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['issue', 'open_url', 'revision', 'status', 'ticket']);
  const plan = (await db.connection(sql => sql.query('SELECT response FROM ripple_plans'))).rows[0] as { response: { context_bundle: { evidence: { excerpt: { text: string } }[] } } };
  for (const e of plan.response.context_bundle.evidence) assert.ok(!text.includes(e.excerpt.text), 'evidence text must not be returned');
  assert.ok(!text.includes(memberToken) && !text.includes('local-fixture-token'));
  assert.equal((await fetch(base + '/native/status')).status, 404, 'GET not routed');
});
