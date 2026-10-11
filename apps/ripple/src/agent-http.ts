import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { InvestigationRequestSchema, InvestigationResponseSchema } from '../../../contracts/investigation.ts';
import { prepareInvestigation, RetrievalSchema, validateEvidence } from '../../../contracts/investigate.server.ts';
import type { Retrieval } from '../../../contracts/investigate.server.ts';
import { body, json } from './http.ts';
import { BridgeError, runAgentBridge } from './agent-process.ts';
import type { AgentContext } from './agent-process.ts';

const Context = z.strictObject({ workspace: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  actor_id: z.string().regex(/^don:identity:[A-Za-z0-9_./:-]+:devu\/[A-Za-z0-9_.-]+$/).max(512),
  actor_session_token: z.string().min(1).max(16000) });
const Envelope = z.strictObject({ payload: z.unknown(), context: Context });
export type AgentServerOptions = {
  bearer: string; local?: boolean;
  authenticate?: (context: AgentContext) => Promise<void>;
  retrieve?: (operation: 'investigate' | 'revalidate', payload: any, context: AgentContext) => Promise<Retrieval>;
};
export async function authenticateAgentActor(context: AgentContext): Promise<void> {
  if (!context.actor_id.includes(`:devo/${context.workspace}:devu/`)) throw new BridgeError('permission_denied', 'Actor workspace mismatch.');
  const result = await fetch('https://api.devrev.ai/dev-users.self', { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${context.actor_session_token}`, 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(15_000) });
  if (!result.ok) throw new BridgeError('permission_denied', 'Actor authentication failed.');
  const value = await result.json();
  if (value.dev_user?.id !== context.actor_id || value.dev_user?.state !== 'active')
    throw new BridgeError('permission_denied', 'Actor authentication failed.');
}
/** Service-to-service endpoint; local config credentials are explicitly opt-in and loopback only. */
export function createAgentServer(options: AgentServerOptions) {
  if (options.bearer.length < 24) throw new Error('Use an agent bearer secret of at least 24 characters.');
  const authenticate = options.authenticate ?? (async (context: AgentContext) => {
    if (!options.local) return authenticateAgentActor(context);
    if (context.actor_session_token !== 'local-preview-token') throw new BridgeError('permission_denied', 'Invalid local session.');
    const identity = await runAgentBridge('identity', {}, undefined, true);
    if (identity.actor_id !== context.actor_id || identity.workspace !== context.workspace)
      throw new BridgeError('permission_denied', 'Local actor mismatch.');
  });
  const retrieve = options.retrieve ?? ((operation, payload, context) => runAgentBridge(operation, payload, context, options.local === true));
  return createServer(async (req, res) => {
    try {
      if (options.local && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? ''))
        return json(res, { error: 'permission_denied' }, 403);
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method !== 'POST' || !['/investigate', '/revalidate'].includes(path)) return json(res, { error: 'not_found' }, 404);
      const expected = Buffer.from(`Bearer ${options.bearer}`), supplied = Buffer.from(req.headers.authorization ?? '');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return json(res, { error: 'permission_denied' }, 401);
      const { payload, context } = Envelope.parse(JSON.parse(await body(req)));
      await authenticate(context);
      if (path === '/investigate') {
        const request = InvestigationRequestSchema.parse(payload);
        const retrieved = RetrievalSchema.parse(await retrieve('investigate', request, context));
        return json(res, prepareInvestigation(request, retrieved));
      }
      const response = InvestigationResponseSchema.parse(payload);
      try {
        const retrieved = RetrievalSchema.parse(await retrieve('revalidate', response, context));
        validateEvidence(response, retrieved, { fresh: true });
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : 'evidence_changed';
        return json(res, { valid: false, code: code === 'permission_denied' ? 'permission_denied' : 'evidence_changed' });
      }
      return json(res, { valid: true, investigation_id: response.investigation_id, plan_digest: response.action_graph?.plan_digest ?? null });
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_request' : 'blocked';
      return json(res, { error: code }, code === 'permission_denied' ? 403 : code === 'invalid_request' ? 400 : 503);
    }
  });
}
