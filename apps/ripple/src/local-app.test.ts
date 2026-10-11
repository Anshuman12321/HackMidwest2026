import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestDatabase, FakeNative, FixtureAgent, auth, actor, fixture } from './testing.ts';
import { Store } from './store.ts';
import { RippleService } from './service.ts';
import { Secrets } from './security.ts';
import { Controller } from './controller.ts';
import { createLocalApp, startLocalApp, type LocalMode } from './local-app.ts';

type Snap = { type: string; action_id?: string; block_id?: string; value?: unknown; text?: string; title?: unknown; elements?: Snap[] };
const flatten = (snaps: Snap[]): Snap[] => snaps.flatMap(s => [s, ...flatten(s.elements ?? [])]);

function runtime(db: TestDatabase, native: FakeNative) {
  const secrets = new Secrets('local-app-integration-secret-with-32-chars');
  const service = new RippleService(new Store(db), native, new FixtureAgent(), secrets);
  const controller = new Controller(service, `http://127.0.0.1:${process.env.PORT}`, true);
  return { service, controller };
}

async function launch(t: { after: (fn: () => void | Promise<void>) => void }, controller: Controller,
  mode: LocalMode = 'fixture', runWorker: boolean | null = false) {
  const local = createLocalApp({ controller, auth, issue: 'ISS-42', mode, ...(runWorker === null ? {} : { runWorker }) });
  const port = Number(process.env.PORT);
  await new Promise<void>((resolve, reject) => {
    local.app.once('error', reject);
    local.app.listen(port, '127.0.0.1', resolve);
  });
  let stopped = false;
  const stop = () => stopped ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    local.app.closeAllConnections();
    local.app.close(error => { stopped = true; error ? reject(error) : resolve(); });
  });
  t.after(stop);
  return { base: `http://127.0.0.1:${port}`, stop };
}

const get = async (base: string, path: string) => {
  try { return await fetch(base + path, { headers: { Connection: 'close' } }); }
  catch (error) { throw new Error(`GET ${path} failed: ${String(error)}`); }
};
async function act(base: string, snap: Snap) {
  assert.ok(snap.action_id && snap.block_id, `Expected actionable ${snap.type} snap`);
  try { return await fetch(base + '/action', { method: 'POST', headers: { Origin: base, Connection: 'close', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_id: snap.action_id, block_id: snap.block_id, value: snap.value }) }); }
  catch (error) { throw new Error(`POST /action failed: ${String(error)}`); }
}

test('local HTTP flow seals investigation, citation and owner actions, and resumes after a server restart', async t => {
  const oldEnv = new Map(['PORT', 'PREVIEW_PORT', 'DATABASE_URL', 'RIPPLE_SECRET', 'RIPPLE_LOCAL_MODE', 'RIPPLE_LOCAL_DATA_DIR']
    .map(key => [key, process.env[key]]));
  const port = String(19000 + Math.floor(Math.random() * 1000));
  process.env.PORT = port; delete process.env.PREVIEW_PORT; delete process.env.DATABASE_URL; delete process.env.RIPPLE_SECRET;
  process.env.RIPPLE_LOCAL_MODE = 'fixture';
  const dir = await mkdtemp(join(tmpdir(), 'ripple-local-durable-'));
  process.env.RIPPLE_LOCAL_DATA_DIR = dir;
  let local = await startLocalApp();
  if (!local.app.listening) await once(local.app, 'listening');
  const base = `http://127.0.0.1:${port}`;
  let closed = false;
  const stop = async () => {
    if (closed) return;
    await local.close();
    closed = true;
  };
  t.after(async () => {
    await stop();
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  });

  const config = await get(base, '/config').then(r => r.json()) as { mode: string; live: boolean; label: string; issue: { display_id: string } };
  assert.equal(config.mode, 'fixture'); assert.equal(config.live, false); assert.equal(config.issue.display_id, 'ISS-42');
  const initial = await get(base, '/initialize').then(r => r.json()) as { snaps: Snap[] };
  const investigate = flatten(initial.snaps).find(s => s.type === 'button' && s.action_id?.startsWith('investigate:'))!;
  const investigated = await act(base, investigate);
  assert.equal(investigated.status, 200);
  let view = await investigated.json() as { snaps: Snap[] };
  assert.match(JSON.stringify(view), /Investigation|Evidence|review/i);

  const citation = flatten(view.snaps).find(s => s.action_id?.startsWith('evidence:'))!;
  assert.ok(citation, 'investigation exposes signed citation controls');
  const cited = await act(base, citation).then(r => r.json()) as { snaps: Snap[] };
  const citedId = citation.value as string;
  const excerpt = fixture().context_bundle.evidence.find(e => e.evidence_id === citedId)!.excerpt.text;
  assert.ok(flatten(cited.snaps).some(s => s.type === 'plain_text' && s.text === excerpt));

  const owner = flatten(view.snaps).find(s => s.type === 'user_picker')!;
  const assigned = await act(base, { ...owner, value: [actor] }).then(r => r.json()) as { snaps: Snap[] };
  const approve = flatten(assigned.snaps).find(s => s.action_id?.startsWith('approve:'))!;
  assert.ok(approve); assert.equal(flatten(assigned.snaps).find(s => s.action_id?.startsWith('approve:'))?.type, 'button');

  const approved = await act(base, approve);
  assert.equal(approved.status, 200);
  // The production local composition persists simulated DevRev IDs in the same disk database.
  await stop();
  local = await startLocalApp();
  if (!local.app.listening) await once(local.app, 'listening');
  closed = false;
  let resumed = await get(base, '/initialize').then(r => r.json()) as { snaps: Snap[] };
  assert.match(JSON.stringify(resumed), /approved|queued|PREVIEW/i);
  for (let i = 0; i < 30 && !JSON.stringify(resumed).includes('PREVIEW-1'); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    resumed = await get(base, '/initialize').then(r => r.json()) as { snaps: Snap[] };
  }
  resumed = await get(base, '/initialize').then(r => r.json()) as { snaps: Snap[] };
  assert.match(JSON.stringify(resumed), /PREVIEW-1/);

  const repeated = await act(base, approve);
  assert.equal(repeated.status, 200);
  assert.match(JSON.stringify(await repeated.json()), /PREVIEW-1/);
  await stop();
  const dbPath = join(dir, 'fixture-db');
  const durable = await TestDatabase.create(dbPath);
  const rows = await durable.connection(sql => sql.query('SELECT ticket FROM ripple_local_simulated_tickets'));
  assert.equal(rows.rows.length, 1, 'the durable simulated ticket registry contains exactly one ticket');
  assert.equal((rows.rows[0]!.ticket as any).native.display_id, 'PREVIEW-1');
  await durable.pg.close();
});

test('local action endpoint rejects cross-origin requests before controller actions', async t => {
  const oldPort = process.env.PORT;
  process.env.PORT = String(20000 + Math.floor(Math.random() * 1000));
  t.after(() => { if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort; });
  const db = await TestDatabase.create(); t.after(() => db.pg.close());
  const native = new FakeNative(), rt = runtime(db, native), app = await launch(t, rt.controller), base = app.base;
  const response = await fetch(base + '/action', { method: 'POST', headers: { Origin: 'http://attacker.invalid', Connection: 'close', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_id: 'investigate:anything', block_id: 'invalid' }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: string }).error, 'invalid_origin');
  assert.equal((await db.connection(sql => sql.query('SELECT * FROM ripple_plans'))).rows.length, 0);
});

test('signed rejection records the decision and queues no write', async t => {
  const oldPort = process.env.PORT;
  process.env.PORT = String(21000 + Math.floor(Math.random() * 1000));
  t.after(() => { if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort; });
  const db = await TestDatabase.create(); t.after(() => db.pg.close());
  const native = new FakeNative(), rt = runtime(db, native), app = await launch(t, rt.controller), base = app.base;
  const initial = await get(base, '/initialize').then(r => r.json()) as { snaps: Snap[] };
  const investigate = flatten(initial.snaps).find(s => s.action_id?.startsWith('investigate:'))!;
  const reviewed = await act(base, investigate).then(r => r.json()) as { snaps: Snap[] };
  const reject = flatten(reviewed.snaps).find(s => s.action_id?.startsWith('reject:'))!;
  assert.ok(reject);
  const response = await act(base, reject);
  assert.equal(response.status, 200);
  assert.equal(native.creates, 0);
  const dbState = await db.connection(async sql => ({
    plans: await sql.query('SELECT state, decision FROM ripple_plans'),
    jobs: await sql.query('SELECT * FROM ripple_jobs'),
  }));
  assert.equal(dbState.plans.rows[0]!.state, 'rejected');
  assert.equal(dbState.plans.rows[0]!.decision.decision, 'reject');
  assert.equal(dbState.jobs.rows.length, 0);
});

test('read-only mode renders as live read-only and rejects signed write actions without changing the plan', async t => {
  const oldPort = process.env.PORT;
  process.env.PORT = String(22000 + Math.floor(Math.random() * 1000));
  t.after(() => { if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort; });
  const db = await TestDatabase.create(); t.after(() => db.pg.close());
  const native = new FakeNative(), rt = runtime(db, native);
  const app = await launch(t, rt.controller, 'read-only', null), base = app.base;

  const config = await get(base, '/config').then(r => r.json()) as { mode: string; live: boolean; label: string };
  assert.equal(config.mode, 'read-only');
  assert.equal(config.live, true);
  assert.equal(config.label, 'LIVE DEVREV · READ-ONLY');

  const initial = await get(base, '/initialize').then(r => r.json()) as { snaps: Snap[] };
  const investigate = flatten(initial.snaps).find(s => s.action_id?.startsWith('investigate:'))!;
  const reviewed = await act(base, investigate).then(r => r.json()) as { snaps: Snap[] };
  const citation = flatten(reviewed.snaps).find(s => s.action_id?.startsWith('evidence:'))!;
  const citationResult = await act(base, citation);
  assert.equal(citationResult.status, 200, 'citation navigation remains available in read-only mode');

  // Build a current, signed owner/decision view through the controller, then verify the HTTP guard
  // rejects those otherwise valid controls before they can reach the mutating service methods.
  const owner = flatten(reviewed.snaps).find(s => s.type === 'user_picker')!;
  const assigned = await rt.controller.action(auth, { action_id: owner.action_id!, block_id: owner.block_id!, value: [actor] }, 'ISS-42') as { snaps: Snap[] };
  const actions = flatten(assigned.snaps);
  const writeActions = [
    actions.find(s => s.action_id?.startsWith('owner:'))!,
    actions.find(s => s.action_id?.startsWith('approve:'))!,
    actions.find(s => s.action_id?.startsWith('reject:'))!,
    actions.find(s => s.action_id?.startsWith('content:'))!,
  ];
  assert.ok(writeActions.every(Boolean));
  assert.equal(writeActions[1]!.type, 'button');
  const before = await db.connection(sql => sql.query('SELECT response,state,decision FROM ripple_plans'));
  for (const action of writeActions) {
    const denied = await act(base, action);
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'read_only', code: 'read_only' });
  }
  const after = await db.connection(async sql => ({
    plans: await sql.query('SELECT response,state,decision FROM ripple_plans'),
    jobs: await sql.query('SELECT * FROM ripple_jobs'),
  }));
  assert.deepEqual(after.plans.rows, before.rows);
  assert.equal(after.jobs.rows.length, 0);
  assert.equal(native.creates, 0);
});
