import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TestDatabase, FakeNative, FixtureAgent, auth as fixtureAuth, fixture } from './testing.ts';
import { Store } from './store.ts';
import { RippleService, failure } from './service.ts';
import { Secrets } from './security.ts';
import { Controller } from './controller.ts';
import { body, json } from './http.ts';
import { graphPng } from './graph.ts';
import { LocalNative } from './local-native.ts';
import { AgentClient } from './native.ts';
import { runAgentBridge } from './agent-process.ts';
import { createAgentServer } from './agent-http.ts';
import type { Auth, Investigator } from './types.ts';
const db = await TestDatabase.create();
const live = process.env.PREVIEW_LIVE === '1' || process.argv.includes('--live');
let auth: Auth = fixtureAuth;
let agentServer: ReturnType<typeof createAgentServer> | undefined;
let agent: Investigator = new FixtureAgent();
let native: FakeNative | LocalNative = new FakeNative();
if (live) {
  const identity = await runAgentBridge('identity', {}, undefined, true);
  if (typeof identity.actor_id !== 'string' || typeof identity.workspace !== 'string') throw new Error('The local reader identity could not be verified.');
  auth = { actorId: identity.actor_id, workspace: identity.workspace, token: 'local-preview-token' };
  native = new LocalNative(auth, (endpoint, args) => runAgentBridge('native', { endpoint, args },
    { workspace: auth.workspace, actor_id: auth.actorId, actor_session_token: auth.token }, true));
  const bearer = randomUUID() + randomUUID();
  agentServer = createAgentServer({ bearer, local: true });
  await new Promise<void>(resolve => agentServer!.listen(0, '127.0.0.1', resolve));
  const address = agentServer.address();
  if (!address || typeof address === 'string') throw new Error('The local investigation server did not start.');
  agent = new AgentClient(`http://127.0.0.1:${address.port}`, bearer);
}
const service = new RippleService(new Store(db), native, agent, new Secrets(randomUUID() + randomUUID()));
const port = Number(process.env.PREVIEW_PORT ?? 8788);
const controller = new Controller(service, `http://127.0.0.1:${port}`, live ? 'live' : true);
const issue = process.env.PREVIEW_ISSUE_ID ?? fixture().context_bundle.entities.find(e => e.kind === 'issue')!.native!.id;
const assets = new Map(['index.html', 'preview.js', 'preview.css'].map(name => ['/' + (name === 'index.html' ? '' : name),
  { bytes: readFileSync(new URL('../preview/' + name, import.meta.url)), type: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }]));
const app = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(res, { error: 'invalid_host' }, 403);
    const path = new URL(req.url!, `http://127.0.0.1:${port}`).pathname;
    if (req.method === 'GET' && assets.has(path)) {
      const asset = assets.get(path)!;
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'" }); return res.end(asset.bytes);
    }
    if (req.method === 'GET' && path.startsWith('/graph/')) {
      const data = await controller.graph(path.slice(7, -4));
      const image = await graphPng(data.response, data.view);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(image);
    }
    if (req.method === 'GET' && path === '/config') return json(res, { live,
      label: live ? 'LIVE READS · SIMULATED WRITES' : 'LOCAL FIXTURE PREVIEW',
      issue: await native.issue(auth, issue), issue_brief: await native.issueBrief(auth, issue), owners: await native.owners(auth, '') });
    if (req.method === 'GET' && path === '/initialize') return json(res, await controller.initialize(auth, issue));
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, { error: 'invalid_origin' }, 403);
      const input = JSON.parse(await body(req));
      if (path === '/settings') {
        if (agent instanceof FixtureAgent) agent.multi = input.multi === true;
        native.behavior = ['ok', 'commit_timeout', 'timeout'].includes(input.behavior) ? input.behavior : 'ok';
        if (native instanceof FakeNative) native.failKey = input.partial === true ? fixture(true).action_graph!.actions[1]!.action_key : null;
        return json(res, { ok: true });
      }
      if (path === '/action') {
        const result = await controller.action(auth, input, issue);
        await service.workOnce();
        const needsReview = result.snaps.some(s => (s.title as { text?: string } | undefined)?.text === 'Review needed');
        if (!needsReview && (String(input.action_id).startsWith('approve:') || String(input.action_id).startsWith('reconcile:')))
          return json(res, await controller.initialize(auth, issue));
        return json(res, result);
      }
    }
    return json(res, { error: 'not_found' }, 404);
  } catch (error) { return json(res, { error: failure(error).message }, 400); }
});
app.listen(port, '127.0.0.1', () => console.log(`Ripple ${live ? 'live-read, simulated-write' : 'fixture'} preview: http://127.0.0.1:${port}`));
const stop = () => { agentServer?.close(); app.close(() => { void db.pg.close(); }); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
