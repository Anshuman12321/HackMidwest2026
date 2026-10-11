import { InvestigationResponseSchema } from '../../../contracts/investigation.ts';
import type { InvestigationRequest, InvestigationResponse } from '../../../contracts/investigation.ts';
import { RippleError } from './types.ts';
import type { Auth, Investigator, NativeGateway, Owner, Ticket, TicketInput } from './types.ts';

type Policy = { workspace: string; actors: Set<string>; owners: Set<string> };
// works.create takes the numeric visibility uenum {1: internal, 2: external}; reads may return
// {id, label}. Normalise every representation to the numeric ID Ripple fingerprints.
const VISIBILITY_NAMES: Record<string, number> = { internal: 1, external: 2 };
const visibilityId = (value: any): 1 => {
  const v = value && typeof value === 'object' ? (value.id ?? value.label) : value;
  return (typeof v === 'string' ? VISIBILITY_NAMES[v] ?? v : v) as 1;
};
type OwnerSearch = (auth: Auth, query: string) => Promise<string[]>;
export class DevRevGateway implements NativeGateway {
  policy: Policy; base: string; search?: OwnerSearch;
  constructor(policy: Policy, search?: OwnerSearch, base = 'https://api.devrev.ai/') {
    this.policy = policy; this.search = search; this.base = base;
  }
  async call(auth: Pick<Auth, 'token'>, endpoint: string, body: unknown): Promise<any> {
    let response: Response;
    try { response = await fetch(new URL(endpoint, this.base), { method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }); }
    catch { throw new RippleError('ambiguous_write', 'DevRev did not return a definitive response.', 'reconcile_first'); }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new RippleError('permission_denied', 'Current DevRev permissions do not allow this operation.');
      if (response.status === 429) throw new RippleError('rate_limited', `DevRev rate limit reached. Retry after ${response.headers.get('Retry-After') ?? 'the server delay'}.`, 'safe');
      if (response.status >= 500 || response.status === 409) throw new RippleError('ambiguous_write', 'The DevRev write needs reconciliation.', 'reconcile_first');
      throw new RippleError('create_failed', 'DevRev rejected the request. Review the destination fields.');
    }
    try { return await response.json(); }
    catch { throw new RippleError('ambiguous_write', 'DevRev returned an unreadable response.', 'reconcile_first'); }
  }
  async authenticate(token: string): Promise<Auth> {
    const { dev_user: user } = await this.call({ token }, 'dev-users.self', {});
    if (!user || user.state !== 'active' || !user.id?.includes(`:devo/${this.policy.workspace}:devu/`) || !this.policy.actors.has(user.id))
      throw new RippleError('permission_denied', 'This user is not enabled for Ripple in this workspace.');
    return { token, workspace: this.policy.workspace, actorId: user.id };
  }
  async verifyMember(token: string): Promise<Auth> {
    const { dev_user: user } = await this.call({ token }, 'dev-users.self', {});
    if (!user || user.state !== 'active' || !user.id?.includes(`:devo/${this.policy.workspace}:devu/`))
      throw new RippleError('permission_denied', 'This user is not an active member of this workspace.');
    return { token, workspace: this.policy.workspace, actorId: user.id };
  }
  async issue(auth: Auth, id: string) {
    return (await this.issueBrief(auth, id)).native;
  }
  async issueBrief(auth: Auth, id: string) {
    const { work } = await this.call(auth, 'works.get', { id });
    if (!work || work.type !== 'issue' || !work.id?.includes(`:devo/${auth.workspace}:issue/`)) throw new RippleError('permission_denied', 'Start from an accessible issue in this workspace.');
    if (typeof work.title !== 'string' || !work.title.trim()) throw new RippleError('invalid_response', 'The issue needs a title before Ripple can investigate it.');
    return { native: { id: work.id, display_id: work.display_id, url: null }, title: work.title, body: typeof work.body === 'string' ? work.body : '' };
  }
  async owners(auth: Auth, query: string): Promise<Owner[]> {
    // An actor-scoped MCP connection can supply hybrid_search results. Native roster is
    // the explicit fallback, not a claim that MCP search enumerates all members.
    const ids = this.search ? await this.search(auth, query) : [...this.policy.owners];
    const result: Owner[] = [];
    for (const id of new Set([auth.actorId, ...ids])) {
      if (!this.policy.owners.has(id)) continue;
      const { dev_user: user } = await this.call(auth, 'dev-users.get', { id });
      if (user?.state === 'active' && (!query || `${user.full_name} ${user.display_name}`.toLowerCase().includes(query.toLowerCase())))
        result.push({ id: user.id, name: user.full_name || user.display_name, displayId: user.display_id });
    }
    return result;
  }
  async authorize(auth: Auth, response: InvestigationResponse, startingIssue: string, checkOwners: boolean): Promise<void> {
    if (auth.workspace !== this.policy.workspace || !this.policy.actors.has(auth.actorId)) throw new RippleError('permission_denied', 'Workspace access changed.');
    const ids = new Set([startingIssue, ...response.context_bundle.entities.flatMap(e => e.native ? [e.native.id] : [])]);
    for (const id of ids) {
      if (!id.includes(`:devo/${auth.workspace}:`)) throw new RippleError('permission_denied', 'A destination or source belongs to another workspace.');
      let endpoint: string;
      if (/:issue\/|:ticket\/|:opportunity\//.test(id)) endpoint = 'works.get';
      else if (/:product\/|:capability\/|:feature\/|:enhancement\//.test(id)) endpoint = 'parts.get';
      else if (/:account\//.test(id)) endpoint = 'accounts.get';
      else if (/:article\//.test(id)) endpoint = 'articles.get';
      else if (/:devu\//.test(id)) endpoint = 'dev-users.get';
      else throw new RippleError('permission_denied', 'Unsupported source object.');
      const value = await this.call(auth, endpoint, { id });
      if (!value || !Object.values(value).some((o: any) => o && o.id === id)) throw new RippleError('permission_denied', 'A source object could not be verified.');
    }
    for (const action of response.action_graph?.actions ?? []) {
      if (!action.owner_id) { if (checkOwners) throw new RippleError('missing_owner', 'Select a current owner for every ticket.'); continue; }
      if (!this.policy.owners.has(action.owner_id)) throw new RippleError('permission_denied', 'The selected user is not an enabled ticket owner.');
      const { dev_user: user } = await this.call(auth, 'dev-users.get', { id: action.owner_id });
      if (user?.state !== 'active' || user.id !== action.owner_id) throw new RippleError('permission_denied', 'The selected owner is no longer active.');
    }
  }
  parseTicket(work: any): Ticket {
    if (!work || work.type !== 'ticket' || !/:ticket\/[^/]+$/.test(work.id) || !/^TKT-/.test(work.display_id ?? '') || !work.external_ref)
      throw new RippleError('ambiguous_write', 'The returned ticket could not be verified.', 'reconcile_first');
    return { native: { id: work.id, display_id: work.display_id, url: null }, input: {
      type: 'ticket', title: work.title, body: work.body, external_ref: work.external_ref,
      applies_to_part: work.applies_to_part?.id, owned_by: work.owned_by?.map((u: any) => u.id),
      visibility: visibilityId(work.visibility),
    } };
  }
  async findTicket(auth: Auth, key: string): Promise<Ticket | null> {
    const { works } = await this.call(auth, 'works.list', { type: ['ticket'], external_ref: [key], limit: 2 });
    if (!Array.isArray(works)) throw new RippleError('invalid_response', 'DevRev ticket lookup returned an invalid response.');
    if (works.length > 1) throw new RippleError('action_conflict', 'Multiple tickets use this action reference.');
    return works.length ? this.parseTicket(works[0]) : null;
  }
  async createTicket(auth: Auth, input: TicketInput): Promise<Ticket> {
    // Ripple only creates internal tickets: works-create-request-ticket.visibility is int64 uenum 1.
    const { work } = await this.call(auth, 'works.create', input);
    // Read back the object rather than assuming the create response contains all fields.
    if (!work?.id) throw new RippleError('ambiguous_write', 'Ticket creation returned no ID.', 'reconcile_first');
    const fetched = await this.call(auth, 'works.get', { id: work.id });
    return this.parseTicket(fetched.work);
  }
}

export class AgentClient implements Investigator {
  url: string; secret: string;
  constructor(url: string, secret: string) {
    if (!url.startsWith('https://') && !url.startsWith('http://127.0.0.1:')) throw new Error('AGENT_URL must use HTTPS.');
    this.url = url.endsWith('/') ? url : url + '/'; this.secret = secret;
  }
  async call(operation: string, payload: unknown, auth: Auth): Promise<any> {
    const response = await fetch(new URL(operation, this.url), { method: 'POST', headers: {
      Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ payload, context: { workspace: auth.workspace, actor_id: auth.actorId, actor_session_token: auth.token } }),
      signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new RippleError('blocked', 'The investigation service is unavailable or denied access.');
    return response.json();
  }
  async investigate(request: InvestigationRequest, auth: Auth): Promise<InvestigationResponse> {
    const parsed = InvestigationResponseSchema.safeParse(await this.call('investigate', request, auth));
    if (!parsed.success || parsed.data.request_id !== request.request_id) throw new RippleError('invalid_response', 'The investigation output did not match the v2 request.');
    return parsed.data;
  }
  async revalidate(response: InvestigationResponse, auth: Auth): Promise<void> {
    const result = await this.call('revalidate', response, auth);
    if (result?.valid !== true || result?.investigation_id !== response.investigation_id || result?.plan_digest !== (response.action_graph?.plan_digest ?? null))
      throw new RippleError(result?.code === 'permission_denied' ? 'permission_denied' : 'evidence_changed', 'Evidence or its access changed. Generate a fresh investigation.');
  }
}
