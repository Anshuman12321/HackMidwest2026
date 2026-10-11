const brief = document.getElementById('brief');
const notice = document.getElementById('notice');
let latest;
let currentOwners = [];
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
async function request(path, input) {
  const response = await fetch(path, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
}
async function act(snap, value = snap.value) {
  if (document.body.classList.contains('busy')) return;
  document.body.classList.add('busy'); brief.setAttribute('aria-busy', 'true'); notice.textContent = '';
  try { show(await request('/action', { action_id: snap.action_id, block_id: snap.block_id, value })); }
  catch (error) { notice.textContent = error.message; }
  finally { document.body.classList.remove('busy'); brief.setAttribute('aria-busy', 'false'); }
}
function render(s, formValues) {
  if (s.type === 'plain_text') return node('div', s.text, 'text');
  if (s.type === 'rich_text') {
    const el = node('div', undefined, 'markdown');
    for (const line of s.text.split('\n')) {
      if (line.startsWith('## ')) el.append(node('h3', line.slice(3)));
      else if (line.startsWith('- ')) el.append(node('div', '• ' + line.slice(2), 'text'));
      else if (line) el.append(node('p', line));
    }
    return el;
  }
  if (s.type === 'image') { const img = node('img', undefined, 'graph'); img.src = s.image_url; img.alt = s.alt_text; return img; }
  if (s.type === 'card') {
    const el = node(s.is_collapsible ? 'details' : 'section', undefined, 'card');
    el.append(node(s.is_collapsible ? 'summary' : 'h2', s.title?.text));
    for (const child of s.elements) el.append(render(child)); return el;
  }
  if (s.type === 'button') {
    const el = node('button', s.text.text, s.style); el.disabled = s.disabled === true;
    el.onclick = () => s.href ? window.open(s.href, '_blank', 'noopener,noreferrer') : act(s); return el;
  }
  if (s.type === 'static_select' || s.type === 'user_picker') {
    const el = node('select'); el.setAttribute('aria-label', s.type === 'user_picker' ? 'Current ticket owner' : s.action_id === 'mode' ? 'Graph mode' : 'Record or relationship');
    const options = s.type === 'user_picker' ? [{ value: '', text: { text: 'Select current ticket owner' } },
      ...currentOwners.map(owner => ({ value: owner.id, text: { text: `${owner.name} · ${owner.displayId}` } }))] : [{ value: '', text: { text: 'Select a record or relationship' } }, ...s.options];
    for (const o of options) { const option = node('option', o.text.text); option.value = o.value; el.append(option); }
    el.value = s.initial_selected_option?.value ?? s.initial_dev_users_selected_options?.[0] ?? '';
    el.onchange = () => { if (el.value) void act(s, s.type === 'user_picker' ? [el.value] : options.find(o => o.value === el.value)); }; return el;
  }
  if (s.type === 'form') {
    const values = {}, el = node('form');
    for (const child of s.elements) el.append(render(child, values));
    const submit = node('button', s.submit_action.text.text, 'primary'); submit.type = 'submit'; el.append(submit);
    el.onsubmit = event => { event.preventDefault(); void act(s, Object.fromEntries(Object.entries(values).map(([key, input]) => [key, { value: input.value }]))); }; return el;
  }
  if (s.type === 'input_layout') { const el = node('label', undefined, 'field'); el.append(node('span', s.label?.text ?? '')); el.append(render(s.element, formValues)); return el; }
  if (s.type === 'plain_text_input') { const el = node(s.multiline ? 'textarea' : 'input'); el.value = s.initial_value ?? ''; el.maxLength = s.max_length ?? 48000; formValues[s.action_id] = el; return el; }
  const el = node('div', undefined, s.type); for (const child of s.elements ?? []) el.append(render(child, formValues)); return el;
}
function show(payload) { latest = payload; if (payload.preview_owners?.length) currentOwners = payload.preview_owners; brief.replaceChildren(...payload.snaps.map(s => render(s))); }
async function settings() {
  await request('/settings', { multi: document.getElementById('fixture').value === 'multi', behavior: document.getElementById('behavior').value, partial: document.getElementById('behavior').value === 'partial' });
  notice.textContent = 'Demo settings apply to the next investigation or write.';
}
document.getElementById('fixture').onchange = settings;
document.getElementById('behavior').onchange = settings;
document.getElementById('restart').onclick = async () => {
  const snaps = latest.snaps.flatMap(s => s.elements ?? []).flatMap(s => s.elements ?? []);
  const action = snaps.find(s => s.action_id?.startsWith('new-review:'));
  if (action) return act(action);
  // A fresh intake is a presentation reset; previous decisions remain stored.
  const signed = snaps.find(s => s.block_id)?.block_id ?? latest.snaps.flatMap(s => s.elements ?? []).find(s => s.block_id)?.block_id;
  if (signed) await act({ action_id: 'new-review', block_id: signed });
};
async function initialize() {
  const config = await request('/config');
  currentOwners = config.owners;
  document.getElementById('mode-label').textContent = config.label;
  document.getElementById('issue-label').textContent = `BUILD / ${config.issue.display_id}`;
  if (config.live) {
    const sources = document.getElementById('fixture');
    sources.replaceChildren(); const option = node('option', 'Live DevRev · one ticket'); option.value = 'single'; sources.append(option); sources.disabled = true;
    document.querySelector('#behavior option[value="partial"]').remove();
    document.getElementById('preview-footer').textContent = 'Live source reads use the local DevRev connector. Imported March records are historical; archive-only documentation is labelled in citations. Ticket creation is simulated with PREVIEW IDs. Only the verified current reader is offered as a simulated owner.';
  }
  show(await request('/initialize'));
}
initialize().catch(error => { notice.textContent = error.message; }).finally(() => brief.setAttribute('aria-busy', 'false'));
