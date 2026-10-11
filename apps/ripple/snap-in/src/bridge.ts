export type Event = {
  payload: { object_id?: string; context?: { object_id?: string }; action?: unknown };
  context: { secrets: { actor_session_token?: string } };
  input_data: { global_values: { ripple_service_url?: string } };
};
export type Status = {
  issue?: { id?: string; display_id?: string; title?: string };
  status: 'none' | 'review' | 'approved' | 'rejected';
  revision?: number;
  ticket?: { display_id?: string; url?: string } | null;
  open_url?: string;
};

const STATUS_PATH = '/native/status';

function serviceBase(value: string | undefined): URL | undefined {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' ? url : undefined; } catch { return undefined; }
}
export function openUrl(base: URL, issue: string): string {
  return `${base.origin}/?issue=${encodeURIComponent(issue)}`;
}
function httpsUrl(value: unknown): string | undefined {
  try { const url = new URL(String(value)); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; }
}

const text = (value: string) => ({ type: 'plain_text', text: value });
export function render(issue: string, base: URL | undefined, status: Status | undefined) {
  let line = 'Ripple status unavailable right now.';
  if (status) {
    const rev = status.revision ? ` ${status.revision}` : '';
    const ticket = status.ticket?.display_id;
    line = status.status === 'review' ? `In review (revision${rev || ' 1'})`
      : status.status === 'approved' ? (ticket ? `Ticket created: ${ticket}` : 'Approved')
      : status.status === 'rejected' ? 'Rejected'
      : status.status === 'none' ? 'No Ripple review yet' : 'Ripple status unavailable right now.';
  }
  const ticketUrl = httpsUrl(status?.ticket?.url);
  // Prefer the service's own open_url only if it stays on the configured origin.
  let link = base ? openUrl(base, issue) : undefined;
  const supplied = httpsUrl(status?.open_url);
  if (base && supplied && new URL(supplied).origin === base.origin) link = supplied;
  const elements: unknown[] = [{ type: 'content', elements: [text(line)] }];
  const buttons: unknown[] = [];
  if (link) buttons.push({ type: 'button', action_id: 'ripple_open', style: 'primary', text: text('Open in Ripple'), value: 'open', href: link });
  if (ticketUrl && status?.ticket?.display_id) buttons.push({ type: 'button', action_id: 'ripple_ticket', text: text(`View ${status.ticket.display_id}`), value: 'ticket', href: ticketUrl });
  if (buttons.length) elements.push({ type: 'actions', direction: 'row', elements: buttons });
  return { snap_kit_body: { body: { snaps: [{ type: 'card', title: text('Ripple'), elements }] } } };
}

export async function fetchStatus(event: Event, issue: string, base: URL): Promise<Status> {
  const token = event.context.secrets.actor_session_token;
  if (!token) throw new Error('missing actor session token');
  const raw = JSON.stringify({ issue });
  const response = await fetch(new URL(STATUS_PATH, base), { method: 'POST', redirect: 'error', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, body: raw, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const value = await response.json() as Status;
  if (!['none', 'review', 'approved', 'rejected'].includes(value?.status)) throw new Error('invalid status response');
  return value;
}

// Every snap-kit invocation (initializer or any card action) re-renders the launcher; no decision is ever submitted from DevRev.
export async function launcher(events: Event[]) {
  const event = events[0];
  // Snap-kit invocations carry the issue at payload.object_id; keep payload.context as a fallback.
  const issue = event?.payload?.object_id ?? event?.payload?.context?.object_id;
  const base = serviceBase(event?.input_data?.global_values?.ripple_service_url);
  if (!event || !issue) return render('', undefined, undefined);
  if (!base) return render(issue, undefined, undefined);
  try { return render(issue, base, await fetchStatus(event, issue, base)); }
  catch (error) {
    console.log('ripple_status_failed', error instanceof Error ? error.message : 'unknown');
    return render(issue, base, undefined);
  }
}
