import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Secrets } from './security.ts';
import { render, signProof, launcher, openUrl } from '../snap-in/src/bridge.ts';
import type { Event } from '../snap-in/src/bridge.ts';

const secret = 'x'.repeat(40), base = new URL('https://ripple.example');
const issue = 'don:core:dvrv-us-1:devo/0:issue/42';
const card = (r: ReturnType<typeof render>) => r.snap_kit_body.body.snaps[0] as { elements: any[] };
const textOf = (r: ReturnType<typeof render>) => JSON.stringify(card(r));

test('bridge proof verifies with purpose bridge and binds path and body hash', () => {
  const raw = JSON.stringify({ issue }), now = Date.now();
  const proof = new Secrets(secret).verify<{ path: string; hash: string; timestamp: number }>(signProof(secret, '/native/status', raw, now), 'bridge');
  assert.equal(proof.path, '/native/status');
  assert.equal(proof.hash, createHash('sha256').update(raw).digest('hex'));
  assert.equal(proof.timestamp, now);
  assert.throws(() => new Secrets(secret).verify(signProof(secret, '/native/status', raw), 'other'));
  assert.throws(() => new Secrets('y'.repeat(40)).verify(signProof(secret, '/native/status', raw), 'bridge'));
});

test('renders each status with a primary Open in Ripple link', () => {
  const link = `https://ripple.example/?issue=${encodeURIComponent(issue)}`;
  for (const [status, expect] of [['none', 'No Ripple review'], ['review', 'revision 3'], ['approved', 'Approved'], ['rejected', 'Rejected']] as const) {
    const r = render(issue, base, { status, revision: 3 });
    assert.match(textOf(r), new RegExp(expect));
    const button = card(r).elements[1].elements[0];
    assert.equal(button.href, link); assert.equal(button.style, 'primary'); assert.equal(button.text.text, 'Open in Ripple');
  }
  assert.equal(openUrl(base, issue), link);
});

test('ticket created shows ticket id and https link; unsafe or foreign URLs are ignored', () => {
  const r = render(issue, base, { status: 'approved', ticket: { display_id: 'TKT-9', url: 'https://app.devrev.ai/t/TKT-9' }, open_url: 'https://evil.example/x' });
  assert.match(textOf(r), /Ticket created: TKT-9/);
  assert.ok(!textOf(r).includes('evil.example'));
  assert.equal(card(r).elements[1].elements[1].href, 'https://app.devrev.ai/t/TKT-9');
  assert.ok(!textOf(render(issue, base, { status: 'approved', ticket: { display_id: 'TKT-9', url: 'javascript:alert(1)' } })).includes('javascript'));
});

test('status failure still renders the link plus an unavailable note, with no secrets', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('no', { status: 500 })) as typeof fetch;
  try {
    const event: Event = { payload: { object_id: issue }, context: { secrets: { actor_session_token: 'TOKEN-123' } },
      input_data: { global_values: { ripple_service_url: 'https://ripple.example' }, keyrings: null as never, resources: { keyrings: { ripple_bridge_secret: secret } } } };
    const out = JSON.stringify(await launcher([event]));
    assert.match(out, /unavailable/); assert.match(out, /Open in Ripple/);
    assert.ok(out.includes(`https://ripple.example/?issue=${encodeURIComponent(issue)}`));
    assert.ok(!out.includes('TOKEN-123') && !out.includes(secret));
  } finally { globalThis.fetch = original; }
});

test('launcher sends signed status request and tolerates actions', async () => {
  const original = globalThis.fetch; let seen: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: URL, init: RequestInit) => { seen = { url: String(url), init };
    return Response.json({ status: 'review', revision: 2, ticket: null }); }) as typeof fetch;
  try {
    const event: Event = { payload: { context: { object_id: issue }, action: { id: 'whatever' } }, context: { secrets: { actor_session_token: 'T' } },
      input_data: { global_values: { ripple_service_url: 'https://ripple.example' }, keyrings: { ripple_bridge_secret: secret } } };
    assert.match(JSON.stringify(await launcher([event])), /revision 2/);
    const headers = seen!.init.headers as Record<string, string>;
    assert.equal(seen!.url, 'https://ripple.example/native/status');
    assert.equal(headers.Authorization, 'Bearer T');
    new Secrets(secret).verify(headers['X-Ripple-Bridge']!, 'bridge');
    const noUrl = JSON.stringify(await launcher([{ ...event, input_data: { global_values: {} } }]));
    assert.ok(!noUrl.includes('"href"')); assert.match(noUrl, /unavailable/);
  } finally { globalThis.fetch = original; }
});
