import React, { useEffect, useState } from 'react';
import './review-pane.css';

export type Snap = { type: string; [key: string]: any };
type Owner = { id: string; name: string; displayId?: string };
export type ReviewData = {
  state: 'review' | 'approved' | 'rejected'; summary: string; as_of: string; replay: boolean;
  findings: { id: string; kind: 'fact' | 'inference'; statement: string; evidence_ids: string[] }[];
  questions: string[]; gaps: { question: string; next_step: string }[];
  plan: null | { plan_id: string; revision: number; digest: string; expires_at: string; expired: boolean; approvable: boolean; blocked_reason: string | null;
    tickets: { action_id: string; title: string; body: string; acceptance_checks: string[]; part: { label: string; display_id: string | null };
      owner: Owner | null; evidence_ids: string[]; context_count: number }[] };
  result: null | { pending: boolean; status: string | null; error: string | null; approval: { actor: string; recorded_at: string } | null;
    results: { action_id: string; title: string; status: string; display_id: string | null; url: string | null; error: string | null }[] };
  evidence: null | { id: string; record: string; field: string; text: string; event_at: string | null; coverage: string; path: string };
};
type Props = {
  review: ReviewData | null | undefined; snaps: Snap[]; evidenceControls: Snap[]; owners: Owner[];
  readOnly: boolean; modeLabel: string; live: boolean; busy: boolean; notice: string; loading: boolean;
  act: (s: Snap, value?: unknown) => Promise<void>;
};
const flat = (items: Snap[] = []): Snap[] => items.flatMap(s => [s, ...flat([...(s.elements ?? []), ...(s.element ? [s.element] : [])])]);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const words = (s: string) => s.replaceAll('_', ' ');


/** Minimal, safe markdown preview (React nodes only; no HTML injection). Covers headings, lists, bold, code. */
function inlineMd(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : part);
}
function MarkdownPreview({ text }: { text: string }) {
  const out: React.ReactNode[] = []; let list: string[] = [];
  const flush = () => { if (list.length) { const items = list; out.push(<ul key={out.length}>{items.map((l, i) => <li key={i}>{inlineMd(l)}</li>)}</ul>); list = []; } };
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line), heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (bullet) { list.push(bullet[1]!); continue; }
    flush();
    if (heading) out.push(<h4 key={out.length}>{inlineMd(heading[2]!)}</h4>);
    else if (line.trim()) out.push(<p key={out.length}>{inlineMd(line)}</p>);
  }
  flush();
  return <div className="rp-md">{out.length ? out : <em>Nothing to preview.</em>}</div>;
}
function TicketEditor({ ticket, form, busy, onSave, onCancel }: { ticket: { title: string; body: string }; form: Snap; busy: boolean;
  onSave: (value: { title: string; body_markdown: string }) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(ticket.title), [body, setBody] = useState(ticket.body), [preview, setPreview] = useState(false);
  const changed = title.trim() !== ticket.title || body.trim() !== ticket.body;
  const valid = title.trim().length > 0 && title.trim().length <= 200 && body.trim().length > 0 && body.trim().length <= 4000;
  return <form className="rp-edit" aria-label="Edit ticket content" data-action={form.action_id} onSubmit={e => { e.preventDefault(); if (changed && valid) onSave({ title: title.trim(), body_markdown: body.trim() }); }}>
    <label><span>TITLE</span><input value={title} maxLength={200} disabled={busy} onChange={e => setTitle(e.target.value)} /></label>
    <div className="rp-edit-head"><span>BODY (MARKDOWN)</span>
      <button type="button" className="rp-link" aria-pressed={preview} onClick={() => setPreview(v => !v)}>{preview ? 'Edit text' : 'Preview'}</button></div>
    {preview ? <MarkdownPreview text={body} /> : <textarea value={body} rows={9} maxLength={4000} disabled={busy} onChange={e => setBody(e.target.value)} />}
    <p className="rp-meta">{body.trim().length}/4000 · Saving seals a new revision with a new digest. Approval then covers exactly this text.</p>
    <div className="rp-actions">
      <button type="submit" className="rp-secondary rp-save" disabled={busy || !changed || !valid}>Save as new revision</button>
      <button type="button" className="rp-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

export function ReviewPane({ review, snaps, evidenceControls, owners, readOnly, modeLabel, live, busy, notice, loading, act }: Props) {
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<{ actionId: string; revision: number } | null>(null);
  const buttons = flat(snaps).filter(s => s.type === 'button');
  const byPrefix = (prefix: string) => buttons.find(s => s.action_id?.startsWith(prefix));
  const approve = byPrefix('approve:'), reject = byPrefix('reject:'), reconcile = byPrefix('reconcile:'), fresh = byPrefix('new-review');
  const reinvestigate = buttons.find(s => s.action_id === 'investigate' || s.action_id?.startsWith('investigate:'));
  // The server reports a failed action as a "Review needed" card; surface its message here.
  const problem = snaps.filter(s => (s.title as { text?: string } | undefined)?.text === 'Review needed')
    .flatMap(s => flat([s]).filter(e => e.type === 'plain_text').map(e => String(e.text ?? ''))).find(t => t && t !== 'Review needed');
  const pickers = flat(snaps).filter(s => s.type === 'user_picker' && s.action_id?.startsWith('owner:'));
  const plan = review?.plan, result = review?.result;
  const contentForms = flat(snaps).filter(s => s.type === 'form' && s.action_id?.startsWith('content:'));
  const expired = Boolean(plan?.expired);
  const canEdit = !readOnly && review?.state === 'review' && !expired;
  // A save succeeded when the sealed revision moved past the one we saved from; the editor then closes.
  const savedRev = pendingSave && plan && plan.revision > pendingSave.revision ? pendingSave : null;
  useEffect(() => { if (savedRev) setEditing(null); }, [savedRev?.revision, plan?.revision]);
  useEffect(() => { if (!canEdit) setEditing(null); }, [canEdit]);
  const deciding = review?.state === 'review' && !readOnly && !expired;
  const shortDigest = plan ? plan.digest.slice(0, 8) : '';
  const evidenceCount = plan ? new Set(plan.tickets.flatMap(t => t.evidence_ids)).size : 0;

  const status = !review ? { tone: 'idle', head: loading ? 'Loading review' : 'No investigation yet', sub: loading ? 'Fetching secure issue context…' : 'Investigate the issue to get cited findings and a proposed ticket.' }
    : review.state === 'rejected' ? { tone: 'bad', head: 'Rejected', sub: 'No tickets were created.' }
    : review.state === 'approved' ? (result?.pending ? { tone: 'wait', head: 'Approved · creating tickets', sub: 'The durable worker is processing this revision.' }
      : result?.status === 'completed' ? { tone: 'ok', head: 'Tickets created', sub: result.approval ? `Approved by ${result.approval.actor}.` : '' }
      : { tone: 'warn', head: `Write ${words(result?.status ?? 'unknown')}`, sub: 'Check the write status before taking another action.' })
    : !plan ? { tone: 'idle', head: 'Investigation complete', sub: 'No ticket is proposed yet.' }
    : expired && review.state === 'review' ? { tone: 'warn', head: 'Review expired', sub: 'Revisions expire 30 minutes after the investigation. Investigate again to get a fresh revision you can approve.' }
    : readOnly ? { tone: 'idle', head: 'Review ready', sub: 'Read-only: approval is disabled in this mode.' }
    : plan.approvable ? { tone: 'go', head: 'Awaiting your decision', sub: `${plural(plan.tickets.length, 'ticket')} ready to approve.` }
    : { tone: 'warn', head: 'Not ready to approve', sub: plan.blocked_reason ?? '' };

  const openEvidence = (id: string) => { const c = evidenceControls.find(s => s.value === id); if (c) { setOpened(id); void act(c); } };
  const inline = review?.evidence && review.evidence.id === opened ? review.evidence : null;
  const chip = (id: string) => {
    const c = evidenceControls.find(s => s.value === id);
    return c ? <button key={id} className={`rp-chip ${opened === id ? 'on' : ''}`} disabled={busy} aria-pressed={opened === id} onClick={() => openEvidence(id)}>{c.text?.text ?? id} <span aria-hidden>↗</span></button> : null;
  };

  return <aside className="review-pane rp" id="review" aria-busy={busy} aria-label="Decision rail">
    {notice && <div className={`notice ${busy ? 'pending' : 'error'}`} role="status">{busy && <span className="spinner" />}{notice}</div>}

    <section className={`rp-sec rp-status rp-${status.tone}`} aria-label="Status">
      <div className="rp-row"><span className="rp-label">STATUS</span><span className={`rp-mode ${live ? 'is-live' : ''}`}><i />{modeLabel}</span></div>
      <h2>{status.head}</h2>{status.sub && <p>{status.sub}</p>}
      {expired && review?.state === 'review' && !readOnly && reinvestigate && <div className="rp-actions"><button className="rp-approve" disabled={busy} onClick={() => void act(reinvestigate)}>Investigate again<span aria-hidden> →</span></button></div>}
      {problem && !busy && !(expired && /expired/i.test(problem)) && <p className="rp-blocked" role="alert">{problem}</p>}
      {review && <p className="rp-meta">{review.replay ? 'Historical replay' : 'Evidence'} as of {new Date(review.as_of).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })}</p>}
    </section>

    {review && review.findings.length > 0 && <section className="rp-sec" aria-label="Key findings">
      <div className="rp-label">KEY FINDINGS</div>
      <ol className="rp-findings">{review.findings.map(f => <li key={f.id}>
        <p><b>{f.kind === 'fact' ? 'Source fact' : 'Inference'}</b> {f.statement}</p>
        <div className="rp-chips">{f.evidence_ids.map(chip)}</div>
      </li>)}</ol>
      {busy && opened && !inline && <p className="rp-meta" role="status"><span className="spinner" /> Loading source excerpt…</p>}
      {inline && <figure className="rp-excerpt"><figcaption>{inline.record} · {inline.field} · {inline.event_at ? new Date(inline.event_at).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }) : 'date unknown'} · {inline.coverage}</figcaption><blockquote>{inline.text}</blockquote><button className="rp-link" onClick={() => setOpened(null)}>Hide excerpt</button></figure>}
      {(review.questions.length > 0 || review.gaps.length > 0) && <details className="rp-open"><summary>{plural(review.questions.length + review.gaps.length, 'open question')}</summary>
        <ul>{review.questions.map((q, i) => <li key={'q' + i}>{q}</li>)}{review.gaps.map((g, i) => <li key={'g' + i}>{g.question}<small>{g.next_step}</small></li>)}</ul></details>}
    </section>}

    {plan && <section className="rp-sec" aria-label="Proposed ticket">
      <div className="rp-label">PROPOSED {plan.tickets.length > 1 ? `TICKETS (${plan.tickets.length})` : 'TICKET'}</div>
      {plan.tickets.map(t => {
        const picker = pickers.find(p => p.action_id === `owner:${t.action_id}`);
        const form = contentForms.find(f => f.action_id === `content:${t.action_id}`);
        return <article className="rp-ticket" key={t.action_id}>
          <h3>{t.title}</h3>
          <dl>
            <dt>Product part</dt><dd>{t.part.label}{t.part.display_id && <small> {t.part.display_id}</small>}</dd>
            <dt>Owner</dt><dd>{t.owner?.name ?? <em>Not chosen</em>}</dd>
            <dt>Evidence</dt><dd>{plural(t.evidence_ids.length, 'cited excerpt')}</dd>
          </dl>
          {canEdit && picker && <label className="rp-owner"><span>{t.owner ? 'CHANGE OWNER' : 'CHOOSE OWNER'}</span>
            <select disabled={busy} value={t.owner?.id ?? ''} onChange={e => { if (e.target.value) void act(picker, [e.target.value]); }}>
              <option value="">Choose current owner</option>
              {owners.map(o => <option key={o.id} value={o.id}>{o.name}{o.displayId ? ` · ${o.displayId}` : ''}</option>)}
            </select></label>}
          {canEdit && form && editing !== t.action_id && <button className="rp-secondary rp-editbtn" disabled={busy} onClick={() => { setPendingSave(null); setEditing(t.action_id); }}>Edit content</button>}
          {canEdit && form && editing === t.action_id && <TicketEditor key={`${t.action_id}:${plan.revision}`} ticket={{ title: t.title, body: t.body }} form={form} busy={busy}
            onCancel={() => setEditing(null)} onSave={value => { setPendingSave({ actionId: t.action_id, revision: plan.revision }); void act(form, value); }} />}
          {savedRev?.actionId === t.action_id && <p className="rp-saved" role="status">Saved as <b>rev {plan.revision} · digest {shortDigest}</b>. Approval now covers the edited text; the earlier revision can no longer be approved.</p>}
          <details className="rp-body"><summary>Ticket body &amp; acceptance checks</summary>
            <div className="rp-text">{t.body}</div>
            <ul>{t.acceptance_checks.map((c, i) => <li key={i}>{c}</li>)}</ul></details>
        </article>;
      })}
      <p className="rp-meta rp-rev">Reviewed revision {plan.revision} · digest <code>{shortDigest}</code> · {plural(evidenceCount, 'distinct source')}</p>
    </section>}

    {plan && deciding && <section className="rp-sec rp-approval" aria-label="Approval">
      <div className="rp-label">APPROVAL</div>
      <p className="rp-auth">Approving authorizes exactly this revision: <b>rev {plan.revision} · digest {shortDigest}</b>. Any change requires a new review.</p>
      {!plan.approvable && plan.blocked_reason && <p className="rp-blocked" role="status">{plan.blocked_reason}</p>}
      <div className="rp-actions">
        <button className="rp-approve" disabled={busy || !plan.approvable || !approve || approve.disabled} onClick={() => approve && void act(approve)}>{approve?.text?.text ?? 'Approve'}<span aria-hidden> →</span></button>
        {reject && <button className="rp-reject" disabled={busy} onClick={() => void act(reject)}>Reject</button>}
      </div>
    </section>}

    {result && <section className="rp-sec" aria-label="Results">
      <div className="rp-label">RESULTS</div>
      {result.status === 'rejected' && <p>Rejected. No tickets were created.</p>}
      {result.pending && <p>Approval recorded. Waiting for the worker to create tickets…</p>}
      {result.error && <p className="rp-blocked">{result.error}</p>}
      <ul className="rp-results">{result.results.map(r => <li key={r.action_id}>
        <b className={`rp-pill ${r.status}`}>{words(r.status)}</b>
        <span>{r.title}</span>
        {r.display_id && (r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.display_id} ↗</a> : <code>{r.display_id}</code>)}
        {r.error && <small>{r.error}</small>}
      </li>)}</ul>
      <div className="rp-actions">
        {!readOnly && reconcile && review?.state === 'approved' && (result.pending || result.status !== 'completed' || result.results.some(r => r.status === 'uncertain')) && <button className="rp-secondary" disabled={busy} onClick={() => void act(reconcile)}>Check write status</button>}
        {!readOnly && fresh && <button className="rp-secondary" disabled={busy} onClick={() => void act(fresh)}>Start a fresh review</button>}
      </div>
    </section>}
  </aside>;
}
