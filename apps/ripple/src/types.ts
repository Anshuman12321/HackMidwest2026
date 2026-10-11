import type { InvestigationRequest, InvestigationResponse, NativeObjectSchema, Task, ExecutionResult, FailureSchema } from '../../../contracts/investigation.ts';
import type { z } from 'zod';
export type NativeObject = z.infer<typeof NativeObjectSchema>;
export type IssueBrief = { native: NativeObject; title: string; body: string };
export const defaultConstraints = ['Do not change production settings', 'Keep customer updates as drafts'];
export const issueOutcome = (issue: IssueBrief) => `Resolve ${issue.native.display_id}: ${issue.title}`.slice(0, 2000);
export type Failure = z.infer<typeof FailureSchema>;
export type Auth = { workspace: string; actorId: string; token: string };
export type Owner = { id: string; name: string; displayId: string };
export type TicketInput = { type: 'ticket'; title: string; body: string; applies_to_part: string; owned_by: [string]; visibility: 1; external_ref: string };
export type Ticket = { native: NativeObject; input: TicketInput };
export interface NativeGateway {
  authenticate(token: string): Promise<Auth>;
  issue(auth: Auth, id: string): Promise<NativeObject>;
  issueBrief(auth: Auth, id: string): Promise<IssueBrief>;
  owners(auth: Auth, query: string): Promise<Owner[]>;
  authorize(auth: Auth, response: InvestigationResponse, startingIssue: string, checkOwners: boolean): Promise<void>;
  findTicket(auth: Auth, key: string): Promise<Ticket | null>;
  createTicket(auth: Auth, input: TicketInput): Promise<Ticket>;
}
export interface Investigator {
  investigate(request: InvestigationRequest, auth: Auth): Promise<InvestigationResponse>;
  revalidate(response: InvestigationResponse, auth: Auth): Promise<void>;
}
export type Plan = { workspace: string; actorId: string; startingIssue: string; response: InvestigationResponse; state: 'review' | 'approved' | 'rejected'; decision: unknown | null; result: ExecutionResult | null };
export type Ledger = { workspace: string; key: string; fingerprint: string; input: TicketInput; state: 'intent' | 'uncertain' | 'done' | 'failed'; native: NativeObject | null; error: Failure | null };
export type View = { mode: 'context' | 'work'; selected: string | null; evidenceId: string | null };
export class RippleError extends Error {
  failure: Failure;
  constructor(code: Failure['code'], message: string, retry: Failure['retry'] = 'never') {
    super(message); this.failure = { code, message, retry };
  }
}
export function ticketInput(response: InvestigationResponse, action: Task): TicketInput {
  const part = response.context_bundle.entities.find(e => e.entity_id === action.part_entity_id)?.native;
  if (!part || !action.owner_id) throw new RippleError('missing_owner', 'Select a current owner for every ticket.');
  return { type: 'ticket', title: action.title, body: action.body_markdown, applies_to_part: part.id,
    owned_by: [action.owner_id], visibility: 1, external_ref: action.action_key };
}
