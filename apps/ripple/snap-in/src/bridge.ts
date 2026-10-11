import { createHash } from 'node:crypto';
import { Secrets } from '../../src/security.ts';

export type Event = {
  payload: { context: { object_id: string }; action?: { id: string; block_id: string; value: unknown } };
  context: { secrets: { actor_session_token?: string } };
  input_data: { global_values: { ripple_service_url: string }; keyrings?: Record<string, string>;
    resources?: { keyrings?: Record<string, string> } };
};
export async function bridge(events: Event[], initialize: boolean) {
  if (events.length !== 1) throw new Error('Expected one user-triggered event.');
  const event = events[0]!;
  const token = event.context.secrets.actor_session_token;
  const key = event.input_data.keyrings?.ripple_bridge_secret ?? event.input_data.resources?.keyrings?.ripple_bridge_secret;
  if (!token || !key) throw new Error('Configure the bridge keyring and actor context.');
  const base = new URL(event.input_data.global_values.ripple_service_url);
  if (base.protocol !== 'https:') throw new Error('The Ripple service must use HTTPS.');
  const path = initialize ? '/native/initialize' : '/native/action';
  const raw = JSON.stringify({ issue: event.payload.context.object_id,
    ...(initialize ? {} : { action: { action_id: event.payload.action?.id, block_id: event.payload.action?.block_id, value: event.payload.action?.value } }) });
  const proof = new Secrets(key).sign({ path, hash: createHash('sha256').update(raw).digest('hex'), timestamp: Date.now() }, 'bridge');
  const response = await fetch(new URL(path, base), { method: 'POST', redirect: 'error', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Ripple-Bridge': proof,
  }, body: raw, signal: AbortSignal.timeout(90_000) });
  if (!response.ok) return { snap_kit_body: { body: { snaps: [{ type: 'card', title: { type: 'plain_text', text: 'Review unavailable' },
    elements: [{ type: 'content', elements: [{ type: 'plain_text', text: 'Reload the issue to restore your review. No new decision was submitted by this error screen.' }] }] }] } } };
  const result = await response.json();
  if (!result?.snap_kit_body?.body?.snaps) throw new Error('Invalid Ripple UI response.');
  return result;
}
