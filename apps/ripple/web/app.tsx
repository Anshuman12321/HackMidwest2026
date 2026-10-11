import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { Login } from './login.tsx';
import { EvidenceGraph } from './evidence-graph.tsx';
import { ReviewPane, type ReviewData } from './review-pane.tsx';
import { cleanLabel, type EvidenceGraphData } from './graph-model.ts';

type Snap = { type: string; [key: string]: any };
type Owner = { id: string; name: string; displayId?: string };
type Payload = { snaps: Snap[]; preview_graph?: EvidenceGraphData | null; preview_owners?: Owner[]; preview_evidence_controls?: Snap[]; preview_review?: ReviewData | null };
type Config = { live: boolean; mode: string; label: string; issue: { display_id: string }; issue_brief: { title: string; body: string }; owners: Owner[] };
const flat = (items: Snap[] = []): Snap[] => items.flatMap(s => [s, ...flat([...(s.elements ?? []), ...(s.element ? [s.element] : [])])]);
const title = (s: Snap) => s.title?.text ?? '';
const actionName = (s: Snap) => s.action_id?.startsWith('owner:') ? s.action_id : s.action_id?.split(':')[0];
type IssueTab = 'map' | 'investigation' | 'description';
const issueTabs: { id: IssueTab; label: string; hash: string }[] = [
  { id: 'map', label: 'Evidence map', hash: '#evidence-map' },
  { id: 'investigation', label: 'Investigation', hash: '#investigation' },
  { id: 'description', label: 'Description', hash: '#description' },
];
const tabFromHash = (hash: string): IssueTab | null => issueTabs.find(t => t.hash === hash)?.id ?? null;
const plainText = (snaps: Snap[]) => flat(snaps).filter(s => s.type === 'plain_text').map(s => s.text).filter(Boolean);

// The snap-in launcher opens /?issue=<DON or display id>; without it the server uses its default issue.
const issueParam = new URLSearchParams(window.location.search).get('issue') ?? undefined;
async function api(path: string, body?: unknown) {
  const url = issueParam && body === undefined ? `${path}?issue=${encodeURIComponent(issueParam)}` : path;
  const payload = issueParam && body && typeof body === 'object' ? { ...body, issue: issueParam } : body;
  const response = await fetch(url, { signal: AbortSignal.timeout(90000), ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) });
  if (response.status === 401) { window.dispatchEvent(new Event('ripple:login-required')); throw new Error('Sign in to continue.'); }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  return value;
}

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [goal, setGoal] = useState('');
  const [constraints, setConstraints] = useState('');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [selectedGraphItem, setSelectedGraphItem] = useState<string | null>(null);
  const [inspectedEvidenceId, setInspectedEvidenceId] = useState<string | null>(null);
  // null follows the default: Description until a graph exists, then Evidence map.
  const [chosenTab, setChosenTab] = useState<IssueTab | null>(() => tabFromHash(window.location.hash));
  const graphDialog = useRef<HTMLDivElement>(null);
  const graphClose = useRef<HTMLButtonElement>(null);
  const graphTrigger = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const pollInFlight = useRef(false);
  const actionEpoch = useRef(0);
  const graph = payload?.preview_graph;
  const activeTab: IssueTab = chosenTab ?? (graph ? 'map' : 'description');
  function selectTab(id: IssueTab, focus = false) {
    const hash = issueTabs.find(t => t.id === id)!.hash;
    setChosenTab(id);
    if (window.location.hash !== hash) window.location.hash = hash;
    if (focus) requestAnimationFrame(() => document.getElementById(`tab-${id}`)?.focus());
  }
  function onTabKey(e: React.KeyboardEvent, index: number) {
    const last = issueTabs.length - 1;
    const next = e.key === 'ArrowRight' ? (index + 1) % issueTabs.length : e.key === 'ArrowLeft' ? (index + last) % issueTabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(issueTabs[next]!.id, true);
  }
  const snaps = payload?.snaps ?? [];
  const owners = payload?.preview_owners ?? config?.owners ?? [];
  const readOnly = config === null || config.mode === 'read-only';
  const allCards = snaps.filter(s => s.type === 'card');
  const cards = readOnly ? allCards.filter(s => !['Approve this revision', 'Plan rejected', 'Execution result', 'Creating approved tickets'].includes(title(s))) : allCards;
  const hasFindings = cards.some(s => title(s) === 'Findings');
  const result = readOnly ? undefined : cards.find(s => ['Execution result', 'Plan rejected', 'Creating approved tickets'].includes(title(s)));
  const hasPlan = cards.some(s => ['Proposed ticket', 'Approve this revision', 'Plan rejected', 'Execution result', 'Creating approved tickets'].includes(title(s)));
  const intakeSnap = flat(snaps).find(s => s.type === 'form' && s.action_id === 'intake');
  const intakeOutcome = intakeSnap && flat([intakeSnap]).find(s => s.type === 'plain_text_input' && s.action_id === 'outcome')?.initial_value;
  const intakeConstraints = intakeSnap && flat([intakeSnap]).find(s => s.type === 'plain_text_input' && s.action_id === 'constraints')?.initial_value;
  const approved = Boolean(result && ['Execution result', 'Creating approved tickets'].includes(title(result)));
  const awaitingWorker = Boolean(result && title(result) === 'Creating approved tickets');
  const fullSteps = [
    { label: 'Intake', enabled: !hasFindings || Boolean(intakeSnap), complete: hasFindings, target: 'intake' },
    { label: 'Context', enabled: hasFindings, complete: hasFindings, target: 'context' },
    { label: 'Proposed work', enabled: cards.some(s => title(s) === 'Proposed ticket'), complete: false, target: 'work' },
    { label: 'Approval', enabled: cards.some(s => title(s) === 'Approve this revision') || Boolean(result), complete: approved, target: 'approval' },
    { label: 'Results', enabled: Boolean(result), complete: Boolean(result && title(result) === 'Execution result'), target: 'results' },
  ];
  const steps = readOnly ? fullSteps.slice(0, 3) : fullSteps;
  const findingSummary = useMemo(() => {
    const finding = cards.find(s => title(s) === 'Findings');
    return finding ? plainText(finding.elements ?? []).slice(0, 2).join(' ') : '';
  }, [payload]);

  useEffect(() => { (async () => {
    try {
      const c = await api('/config'); setConfig(c);
      setConstraints('Avoid production setting changes. Keep customer updates as drafts.');
      setPayload(await api('/initialize'));
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not load Ripple.'); }
  })(); }, []);

  useEffect(() => {
    // Back/forward and manual hash edits switch tabs; unknown hashes (e.g. #issue) restore the default.
    const sync = () => setChosenTab(tabFromHash(window.location.hash));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    if (!graphOpen) return;
    graphTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => graphClose.current?.focus());
    return () => graphTrigger.current?.focus({ preventScroll: true });
  }, [graphOpen]);

  useEffect(() => {
    if (graphOpen && !busy && graphDialog.current && !graphDialog.current.contains(document.activeElement)) graphClose.current?.focus();
  }, [busy, graphOpen]);

  useEffect(() => {
    if (!awaitingWorker) return;
    let stopped = false;
    const refresh = async () => {
      if (stopped || pollInFlight.current || busyRef.current) return;
      pollInFlight.current = true;
      const epoch = actionEpoch.current;
      try {
        const latest = await api('/initialize');
        if (!stopped && !busyRef.current && actionEpoch.current === epoch) setPayload(latest);
      } catch { /* Keep the approved review visible; the next poll can recover transient failures. */ }
      finally { pollInFlight.current = false; }
    };
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [awaitingWorker]);

  async function act(s: Snap, value: unknown = s.value) {
    if (busy || busyRef.current) return;
    const name = actionName(s) ?? '';
    const progress = name === 'approve' ? 'Recording approval for this revision…'
      : name === 'intake' || name === 'investigate' ? 'Investigating the issue and validating cited sources…'
      : name.startsWith('owner:') || name === 'owner' ? 'Saving the owner and checking the proposed revision…'
      : name === 'evidence' ? 'Loading the cited source excerpt…'
      : name === 'reject' ? 'Recording your rejection…'
      : name === 'reconcile' ? 'Checking the approved write results…'
      : name === 'new-review' ? 'Starting a fresh review…'
      : 'Updating the review…';
    busyRef.current = true;
    actionEpoch.current += 1;
    setBusy(true); setNotice(progress);
    try { const next = await api('/action', { action_id: s.action_id, block_id: s.block_id, value: value ?? null }); setPayload(next); setNotice(''); if (['intake', 'investigate', 'new-review'].includes(name)) { setIntakeOpen(false); setSelectedGraphItem(null); setInspectedEvidenceId(null); if (next.preview_graph) selectTab('map'); } }
    catch (e) {
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      setNotice(timeout && name === 'approve' ? 'Approval timed out. Reload to recover the stored review before taking another action.' : e instanceof Error ? e.message : 'The request failed.');
    }
    finally { busyRef.current = false; setBusy(false); }
  }

  function findAction(name: string) { return flat(snaps).find(s => s.type === 'button' && actionName(s) === name); }
  async function investigate(refined: boolean) {
    const intake = intakeSnap;
    const trigger = refined && intake ? intake : findAction('investigate');
    if (!trigger) return;
    if (refined && intake) {
      await act(intake, { outcome: { value: goal }, constraints: { value: constraints } });
    } else await act(trigger);
  }

  function editIntake() {
    if (!intakeSnap) return;
    if (intakeOpen) { setIntakeOpen(false); return; }
    setGoal(intakeOutcome ?? '');
    setConstraints(intakeConstraints ?? '');
    setIntakeOpen(true);
    selectTab('investigation');
  }

  const modeSelect = flat(snaps).find(s => s.type === 'static_select' && s.action_id === 'mode');
  const graphMode = modeSelect?.initial_selected_option?.value ?? 'context';
  const status = result ? title(result) : hasPlan ? 'Ready for review' : hasFindings ? 'Investigation complete' : config ? 'Ready to investigate' : 'Connecting';
  const evidenceCards = cards.filter(s => title(s).startsWith('Evidence ·'));
  function jumpToStep(step: typeof steps[number]) {
    if (step.target === 'intake') {
      if (intakeSnap) { if (!intakeOpen) editIntake(); else selectTab('investigation'); }
      else { setIntakeOpen(true); selectTab('investigation'); }
      return;
    }
    if (step.target === 'context' || step.target === 'work') {
      // Main-pane steps open the evidence map in the matching view; never scroll a long page.
      selectTab(graph ? 'map' : 'investigation');
      const mode = step.target === 'work' ? 'work' : 'context';
      if (graph && modeSelect && graphMode !== mode) { setSelectedGraphItem(null); setInspectedEvidenceId(null); void act(modeSelect, modeSelect.options.find((o: any) => o.value === mode)); }
      return;
    }
    // Approval and results live in the review pane beside the tabs.
    const selectors: Record<string, string> = { approval: '.approve-this-revision', results: '.execution-result, .plan-rejected, .creating-approved-tickets' };
    (document.querySelector<HTMLElement>(selectors[step.target] ?? '#review') ?? document.querySelector<HTMLElement>('#review'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const openGraphFromReview = () => { graphTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setGraphOpen(true); };
  const sourceIssueId = config?.issue_brief.title.match(/^\[Maple (ISS-\d+)\]/)?.[1];
  const evidenceControls = payload?.preview_evidence_controls ?? flat(snaps).filter(s => s.type === 'button' && actionName(s) === 'evidence');
  const selectedEvidenceIds = graph?.nodes.find(n => n.id === selectedGraphItem)?.evidenceIds ?? graph?.edges.find(e => e.id === selectedGraphItem)?.evidenceIds ?? [];
  const explorerProps = graph ? {
    graph, mode: graphMode, busy, selected: selectedGraphItem,
    onSelect: (id: string | null) => { setSelectedGraphItem(id); setInspectedEvidenceId(null); },
    onMode: (mode: string) => { if (modeSelect) { setSelectedGraphItem(null); setInspectedEvidenceId(null); void act(modeSelect, modeSelect.options.find((o: any) => o.value === mode)); } },
    renderEvidence: (ids: string[]) => <div className="explorer-citations">{ids.map(id => {
      const control = evidenceControls.find(s => s.value === id);
      return control ? <button className="citation" key={id} disabled={busy} onClick={() => { setInspectedEvidenceId(id); void act(control); }}>{control.text?.text ?? 'Open source excerpt'} ↗</button> : null;
    })}</div>,
    evidence: inspectedEvidenceId && selectedEvidenceIds.includes(inspectedEvidenceId) ? busy ? <p role="status"><span className="spinner" /> Loading source excerpt…</p> : <>{notice && <p role="status">{notice}</p>}{!notice && evidenceCards.map((card, i) => <SnapCard key={i} snap={card} busy={busy} owners={owners} act={act} setGraphOpen={setGraphOpen} compact />)}</> : null,
  } : null;

  return <div className="app-shell">
    <aside className="rail" inert={graphOpen}>
      <div className="brand"><span className="brand-mark">r</span><span>ripple</span><span className="brand-tag">WORKSPACE</span></div>
      <div className="workspace"><span className="workspace-icon">↗</span><div><b>Current workspace</b><small>Issue investigation</small></div></div>
      <div className="nav-group">CURRENT ITEM</div>
      <nav className="nav-links"><a className="selected" href="#issue"><span>◈</span> Issue review</a></nav>
      <div className="rail-bottom"><div className="avatar">R</div><div><b>Ripple</b><small>Issue review</small></div></div>
    </aside>

    <main className="issue-pane" id="issue" inert={graphOpen}>
      <header className="topbar"><div className="breadcrumbs"><span>Issue</span><b>/</b><strong>{config?.issue.display_id ?? '…'}</strong></div><div className="top-actions"><span className={`live-pill ${config?.live ? 'is-live' : ''}`}><i />{config?.label ?? 'Connecting'}</span></div></header>
      <div className="issue-scroll">
        <section className="issue-head"><div className="issue-kicker"><span className="issue-id">{config?.issue.display_id ?? 'ISSUE'}</span>{sourceIssueId && <span className="source-id-chip">Imported source · {sourceIssueId}</span>}</div><h1>{config ? cleanLabel(config.issue_brief.title) : 'Loading issue context…'}</h1><div className="metadata"><span><small>DEVREV ISSUE</small><b>{config?.issue.display_id ?? '…'}</b></span>{sourceIssueId && <span><small>IMPORTED SOURCE ID</small><b>{sourceIssueId}</b></span>}<span><small>INVESTIGATION</small><b>Outcome-led review</b></span></div></section>
        <div className="issue-tabs" role="tablist" aria-label="Issue sections">{issueTabs.map((t, i) => <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={activeTab === t.id} aria-controls={`panel-${t.id}`} tabIndex={activeTab === t.id ? 0 : -1} className={activeTab === t.id ? 'active' : ''} onClick={() => selectTab(t.id)} onKeyDown={e => onTabKey(e, i)}>{t.label}</button>)}</div>
        {activeTab === 'map' && (explorerProps ? <section className="tab-panel workspace-graph" role="tabpanel" id="panel-map" aria-labelledby="tab-map"><div className="workspace-graph-heading"><div><span className="eyebrow">ISSUE {config?.issue.display_id} · EVIDENCE MAP</span><h2>Explore the investigation</h2></div><span className="map-status"><i />{graphMode === 'work' ? 'Proposed scope' : 'Cited context'}</span></div><EvidenceGraph {...explorerProps} onExpand={openGraphFromReview} /></section>
          : <section className="tab-panel empty-panel" role="tabpanel" id="panel-map" aria-labelledby="tab-map"><div className="section-label">EVIDENCE MAP</div><h2>No evidence map yet</h2><p>Run an investigation to map this issue to cited product context.</p><button className="primary-button" onClick={() => selectTab('investigation')}>Go to investigation <b>↗</b></button></section>)}
        {activeTab === 'description' && <section className="tab-panel description" role="tabpanel" id="panel-description" aria-labelledby="tab-description"><div className="section-label">DESCRIPTION</div><IssueBody text={config?.issue_brief.body ?? 'The issue description will appear here.'} /><div className="issue-note"><span>↗</span><span>Ripple uses the issue description and acceptance criteria as the investigation starting point.</span></div></section>}
        {activeTab === 'investigation' && <div className="tab-panel investigation-panel" role="tabpanel" id="panel-investigation" aria-labelledby="tab-investigation">
        <section className="record-card"><div className="record-top"><div><div className="section-label">RIPPLE INVESTIGATION</div><h2>{hasFindings ? 'Evidence and next steps' : 'Understand the issue before acting'}</h2></div><span className={`status-dot ${hasFindings ? 'done' : ''}`}>{status}</span></div>
          {!hasFindings && <><p className="record-copy">Connect this issue to product context and source evidence, then review the proposed work.</p><div className="intake-actions"><button className="primary-button" disabled={busy || !payload} onClick={() => void investigate(false)}><span>✦</span> Investigate issue <b>↗</b></button><button className="quiet-button" onClick={() => setIntakeOpen(v => !v)} aria-expanded={intakeOpen}>{intakeOpen ? 'Hide refinements' : 'Refine goal or add constraints'} <span>{intakeOpen ? '−' : '+'}</span></button></div>
            {intakeOpen && <div className="refine-panel"><p>Optional. Leave the goal blank to use the issue title and description.</p><label>REFINED GOAL<input value={goal} onChange={e => setGoal(e.target.value)} placeholder="What outcome should this work achieve?" /></label><label>CONSTRAINTS<textarea value={constraints} onChange={e => setConstraints(e.target.value)} rows={3} /></label><button className="primary-button" disabled={busy || !payload} onClick={() => void investigate(true)}>Investigate with refinements <b>↗</b></button></div>}</>}
          {hasFindings && <><div className="status-line"><span>Evidence tied to {graph?.nodes?.filter(n => n.kind !== 'proposed').length ?? '—'} context records</span></div><p className="record-copy">{findingSummary}</p><div className="stats"><div><b>{graph?.nodes?.filter(n => n.kind !== 'proposed').length ?? 0}</b><small>CONTEXT RECORDS</small></div><div><b>{graph?.edges?.length ?? 0}</b><small>CONNECTIONS</small></div><div><b>{cards.filter(s => title(s) === 'Proposed ticket').length}</b><small>PROPOSED TICKETS</small></div></div><p className="hint">Select a source citation in the Ripple review to inspect its excerpt and provenance.</p>
            {intakeSnap && <div className="edit-intake"><button className="quiet-button" onClick={editIntake} aria-expanded={intakeOpen}>{intakeOpen ? 'Close goal & scope' : 'Edit goal & scope'} <span>{intakeOpen ? '−' : '↗'}</span></button>
              {intakeOpen && <div className="refine-panel"><p>Update the investigation inputs. Submitting starts a new investigation review for this issue.</p><label>REFINED GOAL<input value={goal} onChange={e => setGoal(e.target.value)} maxLength={2000} placeholder="Blank uses the issue goal" /></label><label>CONSTRAINTS<textarea value={constraints} onChange={e => setConstraints(e.target.value)} maxLength={48000} rows={4} /></label><button className="primary-button" disabled={busy} onClick={() => void act(intakeSnap, { outcome: { value: goal }, constraints: { value: constraints } })}>Re-investigate with these changes <b>↗</b></button></div>}
            </div>}
          </>}
        </section>
        <section className="steps-card"><div className="section-label">REVIEW PATH</div><div className="step-list">{steps.map((step, i) => <button className={`step-row ${step.enabled ? 'available' : ''} ${step.complete ? 'complete' : ''}`} key={step.label} disabled={!step.enabled} onClick={() => jumpToStep(step)}><span className="step-num">{step.complete ? '✓' : String(i + 1).padStart(2, '0')}</span><span>{step.label}</span><i /></button>)}</div></section>
        </div>}
        <footer className="issue-foot">ISSUE WORKSPACE <span>·</span> POWERED BY RIPPLE</footer>
      </div>
    </main>

    <div inert={graphOpen} className="review-slot"><ReviewPane review={payload?.preview_review} snaps={snaps} evidenceControls={evidenceControls} owners={owners} readOnly={readOnly} modeLabel={config?.label ?? 'Connecting'} live={Boolean(config?.live)} busy={busy} notice={notice} loading={!payload && !notice} act={act} /></div>

    {graphOpen && explorerProps && <div className="graph-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setGraphOpen(false); }}>
      <div className="graph-modal" ref={graphDialog} role="dialog" aria-modal="true" aria-label="Impact graph" tabIndex={-1} onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); setGraphOpen(false); }
        if (e.key === 'Tab' && graphDialog.current) {
          const items = [...graphDialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input, a[href], [tabindex="0"]')];
          const first = items[0], last = items.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}><header className="graph-head"><div><span className="eyebrow">{config?.issue.display_id} · EVIDENCE MAP</span><h2>Explore the investigation</h2></div><button ref={graphClose} className="icon-button" aria-label="Close graph" onClick={() => setGraphOpen(false)}>×</button></header><EvidenceGraph {...explorerProps} /></div>
    </div>}
  </div>;
}

function readOnlyPresentation(snap: Snap): Snap | null {
  if (snap.type === 'user_picker') return null;
  if (snap.type === 'button' && ['approve', 'reject', 'reconcile'].includes(actionName(snap) ?? '')) return null;
  if (snap.type === 'plain_text' && /^Owner:\s*(Choose an owner|Choose a current owner)\s*$/i.test(snap.text?.trim() ?? '')) return null;
  const name = title(snap);
  const elements: Snap[] | undefined = snap.elements?.map((child: Snap) => readOnlyPresentation(child)).filter((item: Snap | null): item is Snap => item !== null);
  const element = snap.element ? readOnlyPresentation(snap.element) : undefined;
  if (snap.type === 'input_layout' && !element) return null;
  const nextTitle = snap.type === 'card' && name === 'Proposed ticket'
    ? { ...snap.title, text: 'Proposed work' }
    : snap.type === 'card' && name === 'Ticket details & acceptance checks'
      ? { ...snap.title, text: 'Work scope & acceptance checks' }
      : snap.type === 'card' && name === 'Ticket evidence'
        ? { ...snap.title, text: 'Work evidence' }
    : snap.title;
  return {
    ...snap,
    ...(elements ? { elements } : {}),
    ...(snap.element ? { element } : {}),
    ...(nextTitle ? { title: nextTitle } : {}),
  };
}

function IssueBody({ text }: { text: string }) {
  const marker = '\n---\nSynthetic Enterprise-Bench source:';
  const appendixAt = text.indexOf(marker);
  if (appendixAt < 0) return <p>{text}</p>;
  return <>
    <p>{text.slice(0, appendixAt)}</p>
    <details className="imported-record"><summary>Imported source record</summary><pre>{text.slice(appendixAt)}</pre></details>
  </>;
}

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return <>{parts.map((p, i) => p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p)}</>;
}

function SnapCard({ snap, busy, owners, act, setGraphOpen, compact = false }: { snap: Snap; busy: boolean; owners: Owner[]; act: (s: Snap, value?: unknown) => Promise<void>; setGraphOpen: (v: boolean) => void; compact?: boolean }) {
  const [open, setOpen] = useState(!snap.default_collapsed);
  const name = title(snap);
  const nested = snap.elements ?? [];
  if (snap.is_collapsible) return <section className={`snap-card collapsible ${compact ? 'compact' : ''}`}><button className="card-heading" onClick={() => setOpen(v => !v)} aria-expanded={open}><span>{name}</span><i>{open ? '−' : '+'}</i></button>{open && <div className="card-body">{nested.map((s: Snap, i: number) => <SnapBlock key={i} snap={s} busy={busy} owners={owners} act={act} setGraphOpen={setGraphOpen} />)}</div>}</section>;
  return <section className={`snap-card ${name.toLowerCase().replace(/[^a-z]+/g, '-')} ${compact ? 'compact' : ''}`}><div className="card-heading static-heading"><span>{name}</span></div><div className="card-body">{nested.map((s: Snap, i: number) => <SnapBlock key={i} snap={s} busy={busy} owners={owners} act={act} setGraphOpen={setGraphOpen} />)}</div></section>;
}

function SnapBlock({ snap, busy, owners, act, setGraphOpen }: { snap: Snap; busy: boolean; owners: Owner[]; act: (s: Snap, value?: unknown) => Promise<void>; setGraphOpen: (v: boolean) => void }) {
  if (snap.type === 'content' || snap.type === 'actions') return <div className={snap.type === 'actions' ? 'snap-actions' : 'snap-content'}>{(snap.elements ?? []).map((s: Snap, i: number) => <SnapBlock key={i} snap={s} busy={busy} owners={owners} act={act} setGraphOpen={setGraphOpen} />)}</div>;
  if (snap.type === 'plain_text') return <p className="snap-text">{snap.text}</p>;
  if (snap.type === 'rich_text') return <p className="snap-text"><InlineText text={snap.text} /></p>;
  if (snap.type === 'image') return <button className="graph-preview" onClick={() => setGraphOpen(true)} aria-label="Open impact graph"><img src={snap.image_url} alt={snap.alt_text} /><span>Explore evidence map ↗</span></button>;
  if (snap.type === 'button') {
    const kind = actionName(snap);
    if (kind === 'evidence') return <button className="citation" disabled={busy || snap.disabled} onClick={() => void act(snap)}><span>↗</span>{snap.text?.text ?? 'Source'}</button>;
    return <button className={`snap-button ${snap.style === 'primary' ? 'primary-button' : ''} ${kind === 'reject' ? 'reject-button' : ''}`} disabled={busy || snap.disabled} onClick={() => snap.href ? window.open(snap.href, '_blank', 'noopener,noreferrer') : void act(snap)}>{snap.text?.text}</button>;
  }
  if (snap.type === 'static_select' || snap.type === 'user_picker') {
    const opts = snap.type === 'user_picker' ? [{ value: '', text: { text: 'Choose current owner' } }, ...owners.map(o => ({ value: o.id, text: { text: `${o.name}${o.displayId ? ` · ${o.displayId}` : ''}` } }))] : snap.options ?? [];
    const current = snap.initial_selected_option?.value ?? snap.initial_dev_users_selected_options?.[0] ?? '';
    return <label className="snap-select"><span>{snap.type === 'user_picker' ? 'TICKET OWNER' : snap.action_id === 'mode' ? 'VIEW' : 'INSPECT'}</span><select disabled={busy} value={current} onChange={e => { const option = opts.find((o: any) => o.value === e.target.value); if (option) void act(snap, snap.type === 'user_picker' ? [option.value] : option); }}><option value="">{snap.type === 'user_picker' ? 'Choose current owner' : 'Select…'}</option>{opts.filter((o: any) => o.value).map((o: any) => <option key={o.value} value={o.value}>{o.text?.text}</option>)}</select></label>;
  }
  if (snap.type === 'card') return <SnapCard snap={snap} busy={busy} owners={owners} act={act} setGraphOpen={setGraphOpen} />;
  if (snap.type === 'form') return <div className="snap-form">{(snap.elements ?? []).map((s: Snap, i: number) => <SnapBlock key={i} snap={s} busy={busy} owners={owners} act={act} setGraphOpen={setGraphOpen} />)}<button className="snap-button" disabled={busy} onClick={() => void act(snap, {})}>{snap.submit_action?.text?.text ?? 'Submit'}</button></div>;
  if (snap.type === 'input_layout') return <label className="snap-select"><span>{snap.label?.text}</span><SnapBlock snap={snap.element} busy={busy} owners={owners} act={act} setGraphOpen={setGraphOpen} /></label>;
  if (snap.type === 'plain_text_input') return <textarea defaultValue={snap.initial_value ?? ''} maxLength={snap.max_length} readOnly aria-label={snap.action_id} />;
  return null;
}

function Root() {
  const [needsLogin, setNeedsLogin] = useState(false);
  const [session, setSession] = useState(0);
  useEffect(() => { const on = () => setNeedsLogin(true); window.addEventListener('ripple:login-required', on); return () => window.removeEventListener('ripple:login-required', on); }, []);
  return needsLogin ? <Login onSuccess={() => { setNeedsLogin(false); setSession(n => n + 1); }} /> : <App key={session} />;
}
createRoot(document.getElementById('root')!).render(<Root />);
