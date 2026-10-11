import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TestDatabase, FakeNative, FixtureAgent, auth, fixture } from './testing.ts';
import { Store } from './store.ts';
import { RippleService, failure } from './service.ts';
import { Secrets } from './security.ts';
import { Controller } from './controller.ts';
import { body, json } from './http.ts';
import { graphPng } from './graph.ts';
const db = await TestDatabase.create();
const native = new FakeNative(), agent = new FixtureAgent();
const service = new RippleService(new Store(db), native, agent, new Secrets(randomUUID() + randomUUID()));
const port = Number(process.env.PREVIEW_PORT ?? 8788);
const controller = new Controller(service, `http://127.0.0.1:${port}`, true);
const issue = fixture().context_bundle.entities.find(e => e.kind === 'issue')!.native!.id;
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
    if (req.method === 'GET' && path === '/initialize') return json(res, await controller.initialize(auth, issue));
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, { error: 'invalid_origin' }, 403);
      const input = JSON.parse(await body(req));
      if (path === '/settings') {
        agent.multi = input.multi === true;
        native.behavior = ['ok', 'commit_timeout', 'timeout'].includes(input.behavior) ? input.behavior : 'ok';
        native.failKey = input.partial === true ? fixture(true).action_graph!.actions[1]!.action_key : null;
        return json(res, { ok: true });
      }
      if (path === '/action') {
        const result = await controller.action(auth, input, issue);
        await service.workOnce();
        return json(res, result);
      }
    }
    return json(res, { error: 'not_found' }, 404);
  } catch (error) { return json(res, { error: failure(error).message }, 400); }
});
app.listen(port, '127.0.0.1', () => console.log(`Ripple local fixture preview: http://127.0.0.1:${port}`));
process.on('SIGTERM', () => app.close(() => { void db.pg.close(); }));
