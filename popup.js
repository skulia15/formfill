const $ = (id) => document.getElementById(id);
const load = async () => (await chrome.storage.local.get('profiles')).profiles || [];
const save = (profiles) => chrome.storage.local.set({ profiles });

let tab, draft = null, editingId = null;

function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  setTimeout(() => ($('toast').hidden = true), 2200);
}

/* The content script isn't in tabs that were already open when the extension
 * loaded, so inject on demand and retry once before reporting a failure. */
async function send(msg, retry = true) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    if (!retry) throw e;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return send(msg, false);
  }
}

function patternFor(mode) {
  const u = new URL(tab.url);
  if (mode === 'origin') return u.origin;
  if (mode === 'prefix') return u.origin + u.pathname;
  if (mode === 'glob') return `${u.protocol}//${wildcardHost(u.hostname)}${u.pathname}`;
  return tab.url.split('#')[0];
}

/* Preview deploys put a throwaway build id in the hostname, on either side
 * of a `--` separator:
 *   specta-test--pr7729-chore-swe-2045-neutr-gz1brwz5.web.app   (Firebase)
 *   deploy-preview-42--my-site.netlify.app                      (Netlify)
 * Wildcard whichever side carries the digits/hash and keep the stable side. */
const VOLATILE = /\d|[0-9a-f]{6,}/i;

function wildcardHost(host) {
  const [first, ...rest] = host.split('.');
  if (first.includes('--')) {
    const i = first.indexOf('--');
    const [left, right] = [first.slice(0, i), first.slice(i + 2)];
    const sub = VOLATILE.test(left) && !VOLATILE.test(right) ? `*--${right}` : `${left}--*`;
    return [sub, ...rest].join('.');
  }
  if (rest.length >= 2 && VOLATILE.test(first)) return ['*', ...rest].join('.');
  return host;
}

/* ---------- capture tab ---------- */

function renderFields() {
  $('fields').innerHTML = '';
  draft.fields.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'field';

    const on = Object.assign(document.createElement('input'), { type: 'checkbox', checked: f.enabled });
    on.onchange = () => (f.enabled = on.checked);

    const lbl = Object.assign(document.createElement('span'), { className: 'lbl', textContent: f.label, title: f.label });

    row.append(on, lbl);

    if (f.checked !== undefined) {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: f.checked });
      box.onchange = () => (f.checked = box.checked);
      row.append(box, Object.assign(document.createElement('span'), { className: 'muted', textContent: f.type }));
    } else {
      const val = Object.assign(document.createElement('input'), { type: 'text', value: f.value });
      val.oninput = () => (f.value = val.value);
      row.append(val);
    }
    if (f.sensitive) row.append(Object.assign(document.createElement('span'), { className: 'warn', textContent: '!', title: 'Password - stored unencrypted in local browser storage' }));
    $('fields').append(row);
  });
}

async function scan() {
  const res = await send({ type: 'capture' });
  if (!res || !res.fields.length) {
    $('empty').hidden = false;
    $('editor').hidden = true;
    return;
  }
  $('empty').hidden = true;
  editingId = null;
  // Passwords are captured but opt-in: storage here is plain local storage.
  draft = { fields: res.fields.map((f) => ({ ...f, enabled: !f.sensitive })) };
  const host = new URL(tab.url).hostname;
  // A preview-deploy hostname is never worth pinning exactly, so start on wildcard.
  const mode = wildcardHost(host) === host ? 'exact' : 'glob';
  $('name').value = host;
  $('pattern').value = patternFor(mode);
  document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
  $('autofill').checked = true;
  renderFields();
  $('editor').hidden = false;
}

async function commit() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  const profiles = await load();
  const entry = {
    id: editingId || crypto.randomUUID(),
    name: $('name').value.trim() || new URL(tab.url).hostname,
    mode,
    pattern: $('pattern').value.trim(),
    autofill: $('autofill').checked,
    enabled: true,
    fields: draft.fields.filter((f) => f.enabled !== false),
  };
  if (!entry.pattern) return toast('Pattern is empty');
  const i = profiles.findIndex((p) => p.id === entry.id);
  if (i >= 0) profiles[i] = entry; else profiles.push(entry);
  await save(profiles);
  $('editor').hidden = true;
  draft = null;
  toast(`Saved "${entry.name}"`);
  renderSaved();
}

/* ---------- saved tab ---------- */

async function renderSaved() {
  const profiles = await load();
  $('count').textContent = profiles.length ? `(${profiles.length})` : '';
  const box = $('saved');
  box.innerHTML = '';
  if (!profiles.length) {
    box.innerHTML = '<p class="muted">Nothing saved yet. Fill a form, then hit Capture.</p>';
    return;
  }
  const MODE = { exact: 'exact URL', prefix: 'starts with', origin: 'whole site', glob: 'wildcard' };
  for (const p of profiles) {
    const matches = formFillMatches(p, tab.url);
    const card = document.createElement('div');
    card.className = 'card' + (matches ? ' match' : '');
    card.innerHTML =
      `<h4></h4><div class="muted">${p.fields.length} field(s) · ${MODE[p.mode]}${p.autofill ? '' : ' · manual'}</div><div class="meta"></div>`;
    card.querySelector('h4').textContent = p.name;
    card.querySelector('.meta').textContent = p.pattern;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const fill = Object.assign(document.createElement('button'), { textContent: 'Fill now', disabled: !matches });
    fill.onclick = async () => {
      const r = await send({ type: 'fill', profile: p });
      toast(r.missing.length ? `Filled ${r.filled}, missed: ${r.missing.join(', ')}` : `Filled ${r.filled} field(s)`);
    };

    const auto = Object.assign(document.createElement('button'), { textContent: p.autofill ? 'Auto: on' : 'Auto: off' });
    auto.onclick = async () => {
      const all = await load();
      const t = all.find((x) => x.id === p.id);
      t.autofill = !t.autofill;
      await save(all);
      renderSaved();
    };

    const edit = Object.assign(document.createElement('button'), { textContent: 'Edit' });
    edit.onclick = () => {
      editingId = p.id;
      draft = { fields: p.fields.map((f) => ({ ...f, enabled: true })) };
      $('name').value = p.name;
      $('pattern').value = p.pattern;
      $('autofill').checked = p.autofill !== false;
      document.querySelector(`input[name=mode][value=${p.mode}]`).checked = true;
      renderFields();
      $('editor').hidden = false;
      $('empty').hidden = true;
      showTab('capture');
    };

    const del = Object.assign(document.createElement('button'), { textContent: 'Delete' });
    del.onclick = async () => {
      await save((await load()).filter((x) => x.id !== p.id));
      renderSaved();
    };

    actions.append(fill, auto, edit, del);
    card.append(actions);
    box.append(card);
  }
}

/* ---------- wiring ---------- */

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('capture').hidden = name !== 'capture';
  $('saved').hidden = name !== 'saved';
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('url').textContent = tab.url;
  $('url').title = tab.url;

  for (const t of document.querySelectorAll('.tab')) t.onclick = () => showTab(t.dataset.tab);
  for (const r of document.querySelectorAll('input[name=mode]'))
    r.onchange = () => { if (!editingId) $('pattern').value = patternFor(r.value); };

  $('scan').onclick = () => scan().catch((e) => toast(`Can't read this page: ${e.message}`));
  $('save').onclick = () => commit();
  $('cancel').onclick = () => { $('editor').hidden = true; draft = null; editingId = null; };

  renderSaved();
})();
