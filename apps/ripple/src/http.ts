import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { Controller } from './controller.ts';
import { graphPng } from './graph.ts';
import { failure } from './service.ts';
export async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; let count = 0;
  for await (const chunk of req) { count += chunk.length; if (count > 256 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
}
export function server(controller: Controller) {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return json(res, { ok: true });
      const path = new URL(req.url!, 'http://localhost').pathname;
      if (req.method === 'GET' && path.startsWith('/graph/') && path.endsWith('.png')) {
        const data = await controller.graph(path.slice('/graph/'.length, -4));
        const image = await graphPng(data.response, data.view);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); return res.end(image);
      }
      if (req.method !== 'POST' || !['/native/initialize', '/native/action'].includes(path)) return json(res, { error: 'not_found' }, 404);
      const raw = await body(req), signature = req.headers['x-ripple-bridge'];
      if (typeof signature !== 'string') return json(res, { error: 'permission_denied' }, 403);
      const proof = controller.service.secrets.verify<{ path: string; hash: string; timestamp: number }>(signature, 'bridge');
      if (proof.path !== path || Math.abs(Date.now() - proof.timestamp) > 60_000 || proof.hash !== createHash('sha256').update(raw).digest('hex'))
        return json(res, { error: 'permission_denied' }, 403);
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (!token) return json(res, { error: 'permission_denied' }, 401);
      const auth = await controller.service.native.authenticate(token), value = JSON.parse(raw);
      if (typeof value.issue !== 'string') return json(res, { error: 'invalid_request' }, 400);
      const result = path === '/native/initialize' ? await controller.initialize(auth, value.issue) : await controller.action(auth, value.action, value.issue);
      return json(res, { snap_kit_body: { body: result } });
    } catch (error) { const detail = failure(error); return json(res, { error: detail }, detail.code === 'permission_denied' ? 403 : 400); }
  });
}
