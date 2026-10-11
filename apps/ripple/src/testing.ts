import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sealPlan } from '../../../contracts/review.server.ts';
import { InvestigationResponseSchema } from '../../../contracts/investigation.ts';
import type { InvestigationRequest, InvestigationResponse } from '../../../contracts/investigation.ts';
import type { Database, SQL } from './store.ts';
import type { Auth, NativeGateway, Investigator, TicketInput, Ticket } from './types.ts';
import { RippleError } from './types.ts';
export class TestDatabase implements Database {
  pg: PGlite; tail: Promise<void> = Promise.resolve();
  constructor(pg: PGlite) { this.pg = pg; }
  static async create(path?: string) {
    const db = new TestDatabase(new PGlite(path));
    await db.pg.exec(readFileSync(new URL('../migrations/001_ripple.sql', import.meta.url), 'utf8')); return db;
  }
  async connection<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
    const prior = this.tail; let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await fn({ query: async (text, values) => this.pg.query(text, values) }); }
    finally { release(); }
  }
}
export const fixture = (multi = false) => InvestigationResponseSchema.parse(JSON.parse(readFileSync(
  new URL(`../../../contracts/examples/${multi ? 'multi-' : ''}investigation-response.json`, import.meta.url), 'utf8')));
export const actor = 'don:identity:dvrv-us-1:devo/1mWckJhGyy:devu/6';
export const auth: Auth = { workspace: '1mWckJhGyy', actorId: actor, token: 'local-fixture-token' };
export class FakeNative implements NativeGateway {
  tickets = new Map<string, Ticket>(); creates = 0; deny = false; invalidOwner = false;
  behavior: 'ok' | 'commit_timeout' | 'timeout' | 'reject' = 'ok'; failKey: string | null = null;
  async authenticate(token: string) { if (token !== auth.token || this.deny) throw new RippleError('permission_denied', 'Unauthorized actor.'); return auth; }
  async issue(_auth: Auth, id: string) {
    const native = fixture().context_bundle.entities.find(e => e.kind === 'issue')!.native!;
    if (id !== native.id && id !== native.display_id) throw new RippleError('permission_denied', 'Unknown issue.'); return native;
  }
  async issueBrief(a: Auth, id: string) {
    const native = await this.issue(a, id);
    const entity = fixture().context_bundle.entities.find(e => e.native?.id === native.id)!;
    const evidence = fixture().context_bundle.evidence.find(e => e.entity_id === entity.entity_id && e.excerpt.field_path.endsWith('description'));
    return { native, title: entity.label, body: evidence?.excerpt.text ?? '' };
  }
  async owners() { return [{ id: actor, name: 'Maanav', displayId: 'DEVU-6' }]; }
  async authorize(a: Auth, response: InvestigationResponse, _issue: string, checkOwners: boolean) {
    if (this.deny || a.workspace !== auth.workspace) throw new RippleError('permission_denied', 'Source access revoked.');
    if (this.invalidOwner || response.action_graph?.actions.some(t => t.owner_id && t.owner_id !== actor)) throw new RippleError('permission_denied', 'Owner is not assignable.');
    if (checkOwners && response.action_graph?.actions.some(t => !t.owner_id)) throw new RippleError('missing_owner', 'Select a current owner.');
  }
  async findTicket(_auth: Auth, key: string) { return this.tickets.get(key) ?? null; }
  async createTicket(_auth: Auth, input: TicketInput) {
    this.creates++;
    if (this.behavior === 'reject' || input.external_ref === this.failKey) throw new RippleError('create_failed', 'Ticket rejected.');
    if (this.behavior === 'timeout') throw new RippleError('ambiguous_write', 'Timeout.', 'reconcile_first');
    const ticket: Ticket = { input, native: { id: `don:core:test:devo/test:ticket/preview-${this.creates}`, display_id: `PREVIEW-${this.creates}`, url: null } };
    this.tickets.set(input.external_ref, ticket);
    if (this.behavior === 'commit_timeout') throw new RippleError('ambiguous_write', 'Timeout after commit.', 'reconcile_first');
    return ticket;
  }
}
export class FixtureAgent implements Investigator {
  multi = false; changed = false;
  async investigate(request: InvestigationRequest) {
    const response = fixture(this.multi); response.request_id = request.request_id; response.investigation_id = randomUUID();
    response.outcome.statement = request.outcome; response.outcome.constraints = request.constraints;
    response.outcome.reference_time = request.reference_time ?? response.outcome.reference_time;
    response.generated_at = new Date().toISOString(); response.action_graph!.expires_at = new Date(Date.now() + 30 * 60_000).toISOString();
    return sealPlan(response);
  }
  async revalidate() { if (this.changed) throw new RippleError('evidence_changed', 'Evidence changed.'); }
}
