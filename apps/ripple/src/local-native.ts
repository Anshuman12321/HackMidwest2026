import type { InvestigationResponse } from '../../../contracts/investigation.ts';
import type { Auth, NativeGateway, NativeObject, Owner, Ticket, TicketInput } from './types.ts';
import { RippleError } from './types.ts';

type Read = (endpoint: string, body: Record<string, unknown>) => Promise<any>;
const reads = new Set(['dev-users.self', 'dev-users.get', 'works.get', 'parts.get', 'accounts.get']);

/** Explicit local lab adapter: current native reads, exclusively simulated writes. */
export class LocalNative implements NativeGateway {
  auth: Auth; read: Read; tickets = new Map<string, Ticket>(); creates = 0;
  behavior: 'ok' | 'commit_timeout' | 'timeout' | 'reject' = 'ok';
  constructor(auth: Auth, read: Read) { this.auth = auth; this.read = read; }
  async call(endpoint: string, body: Record<string, unknown>) {
    if (!reads.has(endpoint)) throw new RippleError('permission_denied', 'The local connector permits source reads only.');
    try { return await this.read(endpoint, body); }
    catch { throw new RippleError('permission_denied', 'The local DevRev reader could not verify current access.'); }
  }
  scope(auth: Auth, id?: string) {
    if (auth.workspace !== this.auth.workspace || auth.actorId !== this.auth.actorId || auth.token !== this.auth.token ||
      (id && !id.includes(`:devo/${auth.workspace}:`)))
      throw new RippleError('permission_denied', 'This local review belongs to another workspace or reader.');
  }
  async authenticate(token: string) {
    if (token !== this.auth.token) throw new RippleError('permission_denied', 'Invalid local review session.');
    const value = await this.call('dev-users.self', {});
    const user = value.dev_user;
    if (user?.id !== this.auth.actorId || user.state !== 'active') throw new RippleError('permission_denied', 'The current local reader changed.');
    return this.auth;
  }
  async issue(auth: Auth, id: string): Promise<NativeObject> {
    this.scope(auth, id);
    const { work } = await this.call('works.get', { id });
    if (work?.id !== id || work.type !== 'issue' || typeof work.display_id !== 'string')
      throw new RippleError('permission_denied', 'Start from a currently readable native issue.');
    return { id: work.id, display_id: work.display_id, url: null };
  }
  async owners(auth: Auth, query: string): Promise<Owner[]> {
    this.scope(auth);
    const { dev_user: user } = await this.call('dev-users.self', {});
    if (user?.id !== auth.actorId || user.state !== 'active') throw new RippleError('permission_denied', 'The current local reader changed.');
    const name = user.full_name || user.display_name || user.display_id;
    return !query || String(name).toLowerCase().includes(query.toLowerCase())
      ? [{ id: user.id, name, displayId: user.display_id }] : [];
  }
  async authorize(auth: Auth, response: InvestigationResponse, startingIssue: string, checkOwners: boolean) {
    this.scope(auth);
    // Native reads validate access; the simulator only offers the verified local reader as owner.
    await this.owners(auth, '');
    const ids = [...new Set([startingIssue, ...response.context_bundle.entities.flatMap(e => e.native ? [e.native.id] : [])])];
    const verify = async (id: string) => {
      this.scope(auth, id);
      const endpoint = /:issue\/|:ticket\/|:opportunity\//.test(id) ? 'works.get'
        : /:product\/|:capability\/|:feature\/|:enhancement\//.test(id) ? 'parts.get'
        : /:account\//.test(id) ? 'accounts.get'
        : /:devu\//.test(id) ? 'dev-users.get' : null;
      if (!endpoint) throw new RippleError('permission_denied', 'Unsupported native source.');
      const result = await this.call(endpoint, { id });
      if (!Object.values(result ?? {}).some((value: any) => value?.id === id))
        throw new RippleError('permission_denied', 'A native source could not be verified.');
    };
    // Independent current source reads are bounded to four subprocesses at once.
    for (let offset = 0; offset < ids.length; offset += 4) await Promise.all(ids.slice(offset, offset + 4).map(verify));
    for (const action of response.action_graph?.actions ?? []) {
      if (action.owner_id && action.owner_id !== auth.actorId) throw new RippleError('permission_denied', 'Choose the verified local reader for simulated work.');
      if (checkOwners && !action.owner_id) throw new RippleError('missing_owner', 'Choose a current owner before simulating ticket creation.');
    }
  }
  async findTicket(auth: Auth, key: string) { this.scope(auth); return this.tickets.get(key) ?? null; }
  async createTicket(auth: Auth, input: TicketInput): Promise<Ticket> {
    this.scope(auth, input.applies_to_part);
    if (input.type !== 'ticket' || input.visibility !== 1 || input.owned_by.length !== 1 || input.owned_by[0] !== auth.actorId)
      throw new RippleError('permission_denied', 'The simulator requires one verified owner and internal visibility.');
    this.creates++;
    if (this.behavior === 'reject') throw new RippleError('create_failed', 'Simulated ticket rejection.');
    if (this.behavior === 'timeout') throw new RippleError('ambiguous_write', 'Simulated timeout with no result.', 'reconcile_first');
    const ticket: Ticket = { input, native: { id: `don:core:local:devo/${auth.workspace}:ticket/preview-${this.creates}`,
      display_id: `PREVIEW-${this.creates}`, url: null } };
    this.tickets.set(input.external_ref, ticket);
    if (this.behavior === 'commit_timeout') throw new RippleError('ambiguous_write', 'Simulated timeout after creation.', 'reconcile_first');
    return ticket;
  }
}
