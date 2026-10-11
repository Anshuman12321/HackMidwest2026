import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { InvestigationResponse } from '../../../contracts/investigation.ts';
import { initialState, bindState, renderBrief } from './ui.ts';
import type { UIState } from './ui.ts';
import type { Auth, Plan, View, IssueBrief } from './types.ts';
import { RippleError, defaultConstraints, issueOutcome } from './types.ts';
import { RippleService, failure } from './service.ts';
import { graphData } from './graph.ts';
const Action = z.object({ action_id: z.string().max(200), block_id: z.string().max(6000), value: z.unknown().optional() });
export class Controller {
  service: RippleService; publicUrl: string; preview: boolean | 'live';
  constructor(service: RippleService, publicUrl: string, preview: boolean | 'live' = false) { this.service = service; this.publicUrl = publicUrl; this.preview = preview; }
  async render(auth: Auth, state: UIState, response?: InvestigationResponse, plan?: Plan, error?: string, issue?: IssueBrief) {
    if (response?.action_graph) state = bindState(state, response);
    const signedState = this.service.secrets.sign(state, 'ui');
    const imageToken = state.planId ? this.service.secrets.sign({ workspace: auth.workspace, actorId: auth.actorId,
      planId: state.planId, digest: state.digest, view: state.view, expires: Date.now() + 5 * 60_000 }, 'graph') : null;
    const imageUrl = imageToken ? new URL(`/graph/${imageToken}.png`, this.publicUrl).href : undefined;
    const owners = response ? await this.service.native.owners(auth, '') : [];
    const payload = renderBrief({ state, signedState, response, plan, imageUrl, owners, error, issue, preview: this.preview });
    return this.preview ? { ...payload, preview_owners: owners, preview_graph: response ? graphData(response, state.view) : null } : payload;
  }
  async initialize(auth: Auth, id: string) {
    const brief = await this.service.native.issueBrief(auth, id), issue = brief.native;
    // Resume the latest accessible review rather than losing the durable job on reload.
    const latest = await this.service.store.db.connection(async sql => (await sql.query(`SELECT plan_id FROM ripple_plans
      WHERE workspace=$1 AND actor_id=$2 AND starting_issue=$3 ORDER BY created_at DESC LIMIT 1`, [auth.workspace, auth.actorId, issue.id])).rows[0]);
    const state = initialState(auth.workspace, auth.actorId, issue.id);
    if (latest) { const plan = await this.service.read(auth, latest.plan_id); return this.render(auth, state, plan.response, plan, undefined, brief); }
    return this.render(auth, state, undefined, undefined, undefined, brief);
  }
  async action(auth: Auth, raw: unknown, issueId: string) {
    const action = Action.parse(raw);
    const state = this.service.secrets.verify<UIState>(action.block_id, 'ui');
    const brief = await this.service.native.issueBrief(auth, issueId), issue = brief.native;
    if (state.workspace !== auth.workspace || state.actorId !== auth.actorId || state.issue !== issue.id || state.expires < Date.now())
      throw new RippleError('permission_denied', 'The review session expired or belongs to another user or issue.');
    let plan = state.planId ? await this.service.read(auth, state.planId) : undefined;
    let response = plan?.response;
    const name = action.action_id.split(':')[0];
    try {
      if (name === 'new-review') return this.render(auth, initialState(auth.workspace, auth.actorId, issue.id), undefined, undefined, undefined, brief);
      if (name === 'intake' || name === 'investigate') {
        const fields = name === 'intake' ? z.object({ outcome: z.object({ value: z.string().max(2000) }).optional(),
          constraints: z.object({ value: z.string().max(48000) }).optional() }).parse(action.value ?? {}) : {};
        response = await this.service.investigate(auth, { schema_version: '2.0', request_id: randomUUID(),
          outcome: name === 'intake' ? fields.outcome?.value.trim() || issueOutcome(brief) : response?.outcome.statement ?? issueOutcome(brief),
          constraints: fields.constraints ? fields.constraints.value.split('\n').map(v => v.trim()).filter(Boolean) : response?.outcome.constraints ?? [...defaultConstraints],
          reference_time: null, scope_hints: { starting_object: issue, part_ids: [], account_ids: [] } });
        plan = response.action_graph ? await this.service.read(auth, response.action_graph.plan_id) : undefined;
        state.view = { mode: 'context', selected: null, evidenceId: null };
      } else if (!plan || !state.planId) throw new RippleError('invalid_request', 'Investigate the issue before reviewing a plan.');
      else if (name === 'owner') {
        const values = z.array(z.string()).length(1).parse(action.value);
        response = await this.service.revise(auth, { schema_version: '2.0', plan_id: state.planId, expected_revision: state.revision,
          owner_assignments: [{ action_id: action.action_id.slice('owner:'.length), owner_id: values[0] }] });
        plan = await this.service.read(auth, state.planId);
      } else if (name === 'content') {
        // Reviewer edit of title/body: seals a new revision exactly like an owner change; never approves.
        const field = z.union([z.string(), z.object({ value: z.string() }).transform(v => v.value)]);
        const edit = z.object({ title: field.optional(), body_markdown: field.optional() }).parse(action.value ?? {});
        response = await this.service.revise(auth, { schema_version: '2.0', plan_id: state.planId, expected_revision: state.revision,
          content_edits: [{ action_id: action.action_id.slice('content:'.length), ...edit }] });
        plan = await this.service.read(auth, state.planId);
      } else if (name === 'approve' || name === 'reject') {
        plan = await this.service.decide(auth, { schema_version: '2.0', plan_id: state.planId, expected_revision: state.revision,
          plan_digest: state.digest, decision: name === 'approve' ? 'approve' : 'reject', idempotency_key: state.decisionKey });
      } else if (name === 'reconcile') plan = await this.service.reconcile(auth, state.planId);
      else if (name === 'mode' || name === 'selection') {
        const value = typeof action.value === 'string' ? action.value : z.object({ value: z.string() }).parse(action.value).value;
        if (name === 'mode') { state.view.mode = z.enum(['context', 'work']).parse(value); state.view.selected = null; }
        else {
          const data = graphData(plan.response, state.view);
          if (![...data.nodes, ...data.edges].some(n => n.id === value)) throw new RippleError('invalid_request', 'Unknown graph selection.');
          state.view.selected = value;
        }
      } else if (name === 'evidence') {
        const id = z.string().parse(action.value);
        if (!plan.response.context_bundle.evidence.some(e => e.evidence_id === id)) throw new RippleError('invalid_request', 'Unknown citation.');
        state.view.evidenceId = id;
      } else if (name !== 'refresh') throw new RippleError('invalid_request', 'Unsupported review action.');
      return this.render(auth, state, plan?.response ?? response, plan, undefined, brief);
    } catch (error) {
      if (state.planId) plan = await this.service.read(auth, state.planId);
      return this.render(auth, state, plan?.response ?? response, plan, failure(error).message, brief);
    }
  }
  async graph(token: string): Promise<{ response: InvestigationResponse; view: View }> {
    const grant = this.service.secrets.verify<{ workspace: string; actorId: string; planId: string; digest: string; expires: number; view: View }>(token, 'graph');
    if (grant.expires < Date.now()) throw new RippleError('permission_denied', 'This graph URL expired.');
    const plan = await this.service.store.db.connection(sql => this.service.store.plan(sql, grant.workspace, grant.planId));
    if (!plan || plan.actorId !== grant.actorId || plan.response.action_graph?.plan_digest !== grant.digest)
      throw new RippleError('permission_denied', 'The graph belongs to an older review.');
    return { response: plan.response, view: grant.view };
  }
}
