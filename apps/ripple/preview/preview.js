const brief = document.getElementById('brief');
const notice = document.getElementById('notice');
const panelScroll = document.querySelector('.panel-scroll');
const graphDialog = document.getElementById('graph-dialog');
let latest;
let currentOwners = [];
let zoom = 1;
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const flatten = snaps => snaps.flatMap(s => [s, ...flatten(s.elements ?? [])]);
const actionName = s => s.action_id?.startsWith('owner:') ? s.action_id : s.action_id?.split(':')[0];
function inline(text) {
  const fragment = document.createDocumentFragment();
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (part.startsWith('**') && part.endsWith('**')) fragment.append(node('strong', part.slice(2, -2)));
    else if (part.startsWith('`') && part.endsWith('`')) fragment.append(node('code', part.slice(1, -1)));
    else fragment.append(document.createTextNode(part));
  }
  return fragment;
}
function markdown(text) {
  const el = node('div', undefined, 'markdown'); let list;
  for (const line of text.split('\n')) {
    if (/^\s*[-*–] /.test(line)) {
      if (!list) { list = node('ul'); el.append(list); }
      const item = node('li'); item.append(inline(line.replace(/^\s*[-*–] /, ''))); list.append(item);
    } else {
      list = null;
      if (!line.trim()) continue;
      const p = node(/^#{1,3} /.test(line) || /^(Background|Acceptance Criteria):$/i.test(line.trim()) ? 'h3' : 'p'); p.append(inline(line.replace(/^#{1,3} /, ''))); el.append(p);
    }
  }
  return el;
}
async function request(path, input) {
  const response = await fetch(path, { signal: AbortSignal.timeout(90000), ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
}
function lockPendingControls() {
  if (!document.body.classList.contains('busy')) return;
  for (const el of document.querySelectorAll('#brief button[data-action], #brief select, #brief form button, #graph-dialog button[data-action], #graph-dialog select, #restart, #record-run, .toolbar select')) {
    if (!el.disabled) { el.dataset.pending = 'true'; el.disabled = true; }
  }
}
async function act(snap, value = snap.value) {
  if (document.body.classList.contains('busy')) return;
  const name = actionName(snap);
  const active = { ...document.activeElement?.dataset };
  const focusScope = graphDialog.contains(document.activeElement) ? graphDialog : brief;
  document.body.classList.add('busy'); brief.setAttribute('aria-busy', 'true'); notice.classList.add('loading');
  lockPendingControls();
  notice.textContent = name === 'investigate' || name === 'intake' ? 'Investigating this issue…' : name === 'owner' || name?.startsWith('owner:') ? 'Saving owner and checking evidence…' : name === 'approve' ? 'Recording approval and creating simulated work…' : 'Updating review…';
  try {
    show(await request('/action', { action_id: snap.action_id, block_id: snap.block_id, value: value ?? null })); notice.textContent = '';
    if (name === 'investigate' || name === 'intake' || name === 'new-review') panelScroll.scrollTop = 0;
    if (name === 'evidence') (graphDialog.open ? document.getElementById('graph-inspector') : brief).querySelector('.evidence-card')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (name === 'approve' || name === 'reject' || name === 'reconcile') brief.querySelector('.result-card')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'The request took too long. Refresh to recover the current review before retrying an approval.' : error.message;
    notice.textContent = message;
    if (graphDialog.open) document.getElementById('graph-inspector').prepend(node('p', message, 'request-error'));
  }
  finally {
    for (const el of document.querySelectorAll('[data-pending]')) { el.disabled = false; delete el.dataset.pending; }
    document.body.classList.remove('busy'); notice.classList.remove('loading'); brief.setAttribute('aria-busy', 'false');
    if (active.action && (!graphDialog.open || focusScope === graphDialog)) [...focusScope.querySelectorAll('[data-action]')].find(el => el.dataset.action === active.action && el.dataset.node === active.node && el.dataset.evidence === active.evidence)?.focus({ preventScroll: true });
  }
}
function cardClass(title) {
  if (title === 'Issue context') return 'issue-card';
  if (title === 'Findings') return 'findings-card';
  if (title === 'Impact graph') return 'graph-card';
  if (title === 'Proposed ticket') return 'ticket-card';
  if (title === 'Approve this revision') return 'approval-card';
  if (title === 'Review needed' || title === 'Clarification needed') return 'error-card';
  if (title.startsWith('Evidence ·')) return 'evidence-card';
  if (['Plan rejected', 'Execution result', 'Creating approved tickets'].includes(title)) return 'result-card';
  return '';
}
function render(s, formValues, parentKey = '') {
  if (s.type === 'plain_text') return node('div', s.text, 'text');
  if (s.type === 'rich_text') return markdown(s.text);
  if (s.type === 'image') {
    const frame = node('button', undefined, 'graph-frame'), img = node('img', undefined, 'graph');
    frame.type = 'button'; frame.setAttribute('aria-label', 'Open impact graph'); frame.onclick = openGraph;
    img.src = s.image_url; img.alt = s.alt_text; frame.append(img);
    img.onerror = () => { frame.replaceChildren(node('p', 'Graph image expired. Refresh the review to load it again.', 'text')); };
    return frame;
  }
  if (s.type === 'card') {
    const title = s.title?.text ?? '', el = node(s.is_collapsible ? 'details' : 'section', undefined, `card ${cardClass(title)}`);
    const owner = flatten(s.elements).find(child => child.type === 'user_picker');
    el.dataset.cardKey = `${parentKey}/${title}/${owner?.action_id ?? ''}`;
    if (s.is_collapsible) el.open = !s.default_collapsed;
    el.append(node(s.is_collapsible ? 'summary' : 'h2', title));
    for (const child of s.elements) el.append(render(child, undefined, el.dataset.cardKey));
    if (title === 'Impact graph' && latest.preview_graph) {
      const open = node('button', 'Open full impact graph ↗', 'graph-open'); open.onclick = openGraph; el.append(open);
    }
    return el;
  }
  if (s.type === 'button') {
    const name = actionName(s), el = node('button', s.text.text, `${s.style ?? ''}${name === 'evidence' ? ' citation' : ''}`);
    el.type = 'button'; el.disabled = s.disabled === true; el.dataset.action = name;
    if (name === 'evidence') { el.title = `Inspect ${s.text.text} evidence`; el.dataset.evidence = s.value; }
    el.onclick = () => s.href ? window.open(s.href, '_blank', 'noopener,noreferrer') : act(s); return el;
  }
  if (s.type === 'static_select' || s.type === 'user_picker') {
    const el = node('select'); el.dataset.action = s.action_id;
    el.setAttribute('aria-label', s.type === 'user_picker' ? 'Current ticket owner' : s.action_id === 'mode' ? 'Graph mode' : 'Record or relationship');
    const options = s.type === 'user_picker' ? [{ value: '', text: { text: 'Choose current ticket owner' } },
      ...currentOwners.map(owner => ({ value: owner.id, text: { text: `${owner.name} · ${owner.displayId}` } }))] :
      [...(s.action_id === 'mode' ? [] : [{ value: '', text: { text: 'Inspect a record or relationship' } }]), ...s.options];
    for (const o of options) { const option = node('option', o.text.text); option.value = o.value; option.disabled = !o.value; el.append(option); }
    el.value = s.initial_selected_option?.value ?? s.initial_dev_users_selected_options?.[0] ?? '';
    el.onchange = () => { if (el.value) void act(s, s.type === 'user_picker' ? [el.value] : options.find(o => o.value === el.value)); }; return el;
  }
  if (s.type === 'form') {
    const values = {}, el = node('form', undefined, 'form');
    for (const child of s.elements) el.append(render(child, values));
    const submit = node('button', s.submit_action.text.text, 'primary'); submit.type = 'submit'; el.append(submit);
    el.onsubmit = event => { event.preventDefault(); void act(s, Object.fromEntries(Object.entries(values).map(([key, input]) => [key, { value: input.value }]))); }; return el;
  }
  if (s.type === 'input_layout') { const el = node('label', undefined, 'field'); el.append(node('span', s.label?.text ?? '')); el.append(render(s.element, formValues)); return el; }
  if (s.type === 'plain_text_input') { const el = node(s.multiline ? 'textarea' : 'input'); el.value = s.initial_value ?? ''; el.maxLength = s.max_length ?? 48000; formValues[s.action_id] = el; return el; }
  const el = node('div', undefined, s.type); for (const child of s.elements ?? []) el.append(render(child, formValues)); return el;
}
function show(payload) {
  const opened = new Map([...brief.querySelectorAll('details')].map(d => [d.dataset.cardKey, d.open]));
  const focus = document.activeElement?.dataset.action, evidence = document.activeElement?.dataset.evidence;
  const scroll = panelScroll.scrollTop;
  latest = payload; if (payload.preview_owners) currentOwners = payload.preview_owners;
  brief.replaceChildren(...payload.snaps.map(s => render(s)));
  for (const d of brief.querySelectorAll('details')) if (opened.has(d.dataset.cardKey)) d.open = opened.get(d.dataset.cardKey);
  panelScroll.scrollTop = scroll;
  if (focus && !graphDialog.open) [...brief.querySelectorAll('[data-action]')].find(el => el.dataset.action === focus && el.dataset.evidence === evidence)?.focus({ preventScroll: true });
  updateRecord();
  if (graphDialog.open) renderGraph();
  lockPendingControls();
}
function updateRecord() {
  const snaps = latest.snaps, graph = latest.preview_graph;
  const result = snaps.find(s => ['Execution result', 'Plan rejected', 'Creating approved tickets'].includes(s.title?.text));
  const findings = snaps.find(s => s.title?.text === 'Findings');
  const status = result ? result.title.text : graph ? 'Ready for review' : findings ? 'Clarification needed' : 'Ready to investigate';
  const stage = result ? 4 : graph ? 3 : 0;
  document.querySelectorAll('.steps li').forEach((el, index) => {
    el.classList.toggle('done', index < stage); if (index === stage) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    const button = el.querySelector('button');
    button.disabled = !brief.querySelector(`.${button.dataset.section}`) && !(index === 4 && brief.querySelector('.result-card'));
    button.title = button.disabled ? 'Available after investigation' : `Go to ${button.textContent.toLowerCase()}`;
  });
  const record = document.getElementById('record-investigation');
  if (!findings) { void initializeRecordSummary(); return; }
  const summary = flatten(findings?.elements ?? []).find(s => s.type === 'plain_text');
  const statusEl = node('div', undefined, 'record-status'); statusEl.append(node('i'), node('span', status));
  const stats = node('div', undefined, 'record-stats');
  for (const [count, label] of [[(graph?.nodes ?? []).filter(n => n.kind !== 'proposed').length, 'Context records'], [graph?.edges.length ?? 0, 'Connections'], [snaps.filter(s => s.title?.text === 'Proposed ticket').length, 'Proposed tickets']]) {
    const stat = node('div'); stat.append(node('strong', String(count)), node('span', label)); stats.append(stat);
  }
  record.replaceChildren(statusEl, node('p', summary?.text ?? 'Review the cited findings in Ripple.', 'record-summary'), stats,
    node('p', 'Select a source or relationship in Ripple to inspect the evidence behind it.', 'record-hint'));
  if (result) { const output = node('div', undefined, 'record-outcome'); output.append(node('div', result.title.text, 'eyebrow')); for (const s of result.elements.filter(s => s.type === 'content').flatMap(s => s.elements ?? [])) if (s.type === 'plain_text') output.append(node('p', s.text)); record.append(output); }
}
function openGraph() { zoom = 1; graphDialog.showModal(); renderGraph(); }
function renderGraph() {
  const snap = latest.snaps.find(s => s.title?.text === 'Impact graph'), data = latest.preview_graph;
  if (!snap || !data) { graphDialog.close(); return; }
  const all = flatten(snap.elements), image = all.find(s => s.type === 'image'), selection = all.find(s => s.action_id === 'selection');
  const canvas = document.getElementById('graph-canvas'), inspector = document.getElementById('graph-inspector'), stage = node('div', undefined, 'graph-stage');
  const scroll = { left: canvas.scrollLeft, top: canvas.scrollTop, inspector: inspector.scrollTop };
  const active = graphDialog.contains(document.activeElement) ? { ...document.activeElement.dataset } : {};
  const opened = new Map([...inspector.querySelectorAll('details')].map(d => [d.dataset.cardKey, d.open]));
  const padding = parseFloat(getComputedStyle(canvas).paddingLeft) * 2;
  const fit = Math.max(.05, Math.min(1, (canvas.clientWidth - padding) / data.width, (canvas.clientHeight - padding) / data.height));
  stage.style.width = `${data.width * fit * zoom}px`;
  const img = node('img'); img.src = image.image_url; img.alt = image.alt_text; stage.append(img);
  for (const n of data.nodes) {
    const hit = node('button', n.label, 'graph-hit'); hit.dataset.action = 'selection'; hit.dataset.node = n.id; hit.setAttribute('aria-label', `${n.subtitle}: ${n.label}`);
    hit.setAttribute('aria-pressed', String(selection?.initial_selected_option?.value === n.id)); hit.title = `${n.subtitle} · ${n.label}`;
    hit.style.left = `${n.x / data.width * 100}%`; hit.style.top = `${n.y / data.height * 100}%`;
    hit.style.width = `${230 / data.width * 100}%`; hit.style.height = `${80 / data.height * 100}%`;
    hit.onclick = () => act(selection, { value: n.id }); stage.append(hit);
  }
  canvas.replaceChildren(stage);
  inspector.replaceChildren(node('div', 'INSPECT THE CONNECTIONS', 'eyebrow'));
  for (const s of snap.elements) if (s.type !== 'content' || !s.elements.some(c => c.type === 'image')) inspector.append(render(s));
  const evidence = latest.snaps.find(s => s.title?.text.startsWith('Evidence ·')); if (evidence) inspector.append(render(evidence));
  const hint = node('p', 'Click a node, or choose a relationship. Open its citations to see the source.', 'subtle'); inspector.append(hint);
  for (const d of inspector.querySelectorAll('details')) if (opened.has(d.dataset.cardKey)) d.open = opened.get(d.dataset.cardKey);
  canvas.scrollLeft = scroll.left; canvas.scrollTop = scroll.top; inspector.scrollTop = scroll.inspector;
  if (active.action) [...graphDialog.querySelectorAll('[data-action]')].find(el => el.dataset.action === active.action && el.dataset.node === active.node && el.dataset.evidence === active.evidence)?.focus({ preventScroll: true });
  lockPendingControls();
}
async function settings() {
  try { await request('/settings', { multi: document.getElementById('fixture').value === 'multi', behavior: document.getElementById('behavior').value, partial: document.getElementById('behavior').value === 'partial' }); notice.textContent = 'Preview settings apply to the next investigation or write.'; }
  catch (error) { notice.textContent = error.message; }
}
document.getElementById('fixture').onchange = settings;
document.getElementById('behavior').onchange = settings;
document.getElementById('restart').onclick = async () => {
  if (!latest) return;
  const signed = flatten(latest.snaps).find(s => s.block_id)?.block_id;
  if (signed) await act({ action_id: 'new-review', block_id: signed });
};
async function initializeRecordSummary() {
  const record = document.getElementById('record-investigation');
  record.replaceChildren(node('p', 'A clear next step starts with the context.', 'record-empty'), node('p', 'Run Ripple to connect this issue to the evidence, understand what remains unknown, and review the proposed work.', 'subtle'));
  const run = node('button', 'Investigate this issue ↗', 'text-button'); run.id = 'record-run'; run.onclick = runIssue; record.append(run);
}
function runIssue() { const action = flatten(latest?.snaps ?? []).find(s => s.type === 'button' && actionName(s) === 'investigate'); if (action) void act(action); }
document.getElementById('record-run').onclick = runIssue;
document.querySelectorAll('.steps button').forEach(button => { button.onclick = () => {
  const target = button.dataset.section === 'approval-card' ? brief.querySelector('.result-card, .approval-card') : brief.querySelector(`.${button.dataset.section}`);
  if (!target) return;
  if (target.tagName === 'DETAILS') target.open = true;
  target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  target.tabIndex = -1; target.focus({ preventScroll: true });
}; });
document.querySelector('.navigation a.active').onclick = event => { event.preventDefault(); document.querySelector('.record-pane').scrollTo({ top: 0, behavior: 'smooth' }); };
document.querySelector('.ripple-link').onclick = event => { event.preventDefault(); document.querySelector('.steps button').click(); };
document.getElementById('graph-close').onclick = () => graphDialog.close();
graphDialog.addEventListener('close', () => brief.querySelector('.graph-open')?.focus({ preventScroll: true }));
graphDialog.addEventListener('click', event => { if (event.target === graphDialog) { const rect = graphDialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) graphDialog.close(); } });
document.getElementById('zoom-in').onclick = () => { zoom = Math.min(4, zoom + .3); renderGraph(); };
document.getElementById('zoom-out').onclick = () => { zoom = Math.max(.7, zoom - .3); renderGraph(); };
document.getElementById('zoom-reset').onclick = () => { zoom = 1; renderGraph(); };
window.addEventListener('resize', () => { if (graphDialog.open) renderGraph(); });
async function initialize() {
  const config = await request('/config'); currentOwners = config.owners;
  document.getElementById('mode-label').textContent = config.live ? 'LIVE READS / SIMULATED WRITES' : 'FIXTURE / SIMULATED WRITES';
  document.getElementById('issue-label').textContent = config.issue.display_id;
  document.getElementById('record-id').textContent = config.issue.display_id;
  document.getElementById('panel-subtitle').textContent = `Issue investigation · ${config.issue.display_id}`;
  document.getElementById('record-title').textContent = config.issue_brief.title.replace(/^\[Maple[^\]]*\]\s*/, '');
  const description = document.getElementById('record-description'); description.replaceChildren(markdown(config.issue_brief.body || 'No description has been provided for this issue.'));
  const reader = config.owners[0]; if (reader) { const name = document.getElementById('reader-name'); name.replaceChildren(document.createTextNode(reader.name), node('small', config.live ? 'Verified local reader' : 'Fixture reviewer')); document.getElementById('reader-initials').textContent = reader.name.split(/\s+/).map(p => p[0]).slice(0, 2).join(''); }
  if (config.live) {
    const sources = document.getElementById('fixture'); const option = node('option', 'Live DevRev · one ticket'); option.value = 'single'; sources.replaceChildren(option); sources.disabled = true;
    document.querySelector('#behavior option[value="partial"]').remove();
    document.getElementById('preview-footer').textContent = 'Live reads use the local DevRev connector. Imported March evidence is historical. Writes create simulated PREVIEW IDs; only the verified reader is offered as owner.';
  }
  show(await request('/initialize'));
}
initialize().catch(error => { notice.textContent = error.message; }).finally(() => brief.setAttribute('aria-busy', 'false'));
