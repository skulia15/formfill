/* FormFill content script.
 * Two jobs:
 *   1. capture  - snapshot the currently-filled fields, with several fallback locators each
 *   2. fill     - find those fields again on a later visit and set them the way a user would
 */

const FILLABLE =
  'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=file]), textarea, select';

/* ---------- locators ---------- */

// Ranked, so a brittle structural path is only ever the last resort.
function locatorsFor(el) {
  const out = [];
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

  if (el.id && !looksGenerated(el.id)) out.push({ k: 'id', v: `#${esc(el.id)}` });
  if (el.name) out.push({ k: 'name', v: `${el.tagName.toLowerCase()}[name="${el.name}"]` });

  const aria = el.getAttribute('aria-label');
  if (aria) out.push({ k: 'aria', v: `${el.tagName.toLowerCase()}[aria-label="${aria}"]` });

  if (el.placeholder) out.push({ k: 'placeholder', v: el.placeholder });

  const lbl = labelFor(el);
  if (lbl) out.push({ k: 'label', v: lbl });

  if (el.type && el.type !== 'text') {
    out.push({ k: 'type', v: el.type, name: el.name || null, value: el.value || null });
  }

  out.push({ k: 'path', v: cssPath(el) });
  return out;
}

// Build-tool ids like `:r3:` or `input-8f2a91` change every render; don't trust them.
function looksGenerated(id) {
  return /^:r|^[a-z]*[0-9a-f]{6,}$|^mui-\d+$|^radix-/i.test(id);
}

function labelFor(el) {
  if (el.id) {
    const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) return norm(l.textContent);
  }
  const wrap = el.closest('label');
  if (wrap) return norm(wrap.textContent);
  const labelled = el.getAttribute('aria-labelledby');
  if (labelled) {
    const n = document.getElementById(labelled);
    if (n) return norm(n.textContent);
  }
  return '';
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 8) {
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (node.id && !looksGenerated(node.id)) {
      parts[0] = `#${CSS.escape(node.id)}`;
      break;
    }
    node = parent;
  }
  return parts.join(' > ');
}

function resolve(locators) {
  for (const loc of locators || []) {
    let el = null;
    try {
      if (loc.k === 'placeholder') {
        el = [...document.querySelectorAll(FILLABLE)].find((n) => n.placeholder === loc.v);
      } else if (loc.k === 'label') {
        el = [...document.querySelectorAll(FILLABLE)].find((n) => labelFor(n) === loc.v);
      } else if (loc.k === 'type') {
        const sel = loc.name
          ? `input[type="${loc.v}"][name="${loc.name}"]`
          : `input[type="${loc.v}"]`;
        const cands = [...document.querySelectorAll(sel)];
        el = loc.value ? cands.find((n) => n.value === loc.value) || cands[0] : cands[0];
      } else {
        el = document.querySelector(loc.v);
      }
    } catch {
      /* a stored selector can be invalid after a site rewrite - just try the next one */
    }
    if (el && el.matches(FILLABLE)) return el;
  }
  return null;
}

/* ---------- setting values ---------- */

// React/Vue/Svelte track the value on the node itself, so assigning `.value`
// updates the DOM but leaves framework state stale. Go through the native
// prototype setter, then fire the events the framework is actually listening for.
function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
}

function fillField(el, field) {
  if (el.type === 'checkbox' || el.type === 'radio') {
    const want = field.checked === true;
    if (el.checked !== want) el.click();
    return true;
  }
  if (el.tagName === 'SELECT') {
    const opt = [...el.options].find((o) => o.value === field.value || o.text === field.value);
    if (!opt) return false;
    setNativeValue(el, opt.value);
  } else {
    setNativeValue(el, field.value);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/* ---------- capture ---------- */

function capture() {
  const fields = [];
  for (const el of document.querySelectorAll(FILLABLE)) {
    if (el.disabled || el.readOnly) continue;
    if (el.offsetParent === null && el.type !== 'hidden') continue; // invisible

    const isToggle = el.type === 'checkbox' || el.type === 'radio';
    const value = isToggle ? '' : el.value;
    if (isToggle ? !el.checked : !value) continue; // nothing the user set

    fields.push({
      label: labelFor(el) || el.placeholder || el.name || el.id || el.type,
      type: el.type || el.tagName.toLowerCase(),
      sensitive: el.type === 'password',
      value,
      checked: isToggle ? el.checked : undefined,
      locators: locatorsFor(el),
    });
  }
  return { url: location.href, origin: location.origin, fields };
}

/* ---------- fill ---------- */

function applyProfile(profile) {
  let filled = 0;
  const missing = [];
  for (const f of profile.fields) {
    if (f.enabled === false) continue;
    const el = resolve(f.locators);
    if (el && fillField(el, f)) filled++;
    else missing.push(f.label);
  }
  return { filled, missing };
}

async function autoFill() {
  const { profiles = [] } = await chrome.storage.local.get('profiles');
  const hits = profiles.filter((p) => p.autofill !== false && formFillMatches(p, location.href));
  if (!hits.length) return;
  // Most specific pattern wins when several profiles overlap.
  hits.sort((a, b) => formFillSpecificity(b) - formFillSpecificity(a));
  const r = applyProfile(hits[0]);
  if (r.filled) console.log(`[FormFill] filled ${r.filled} field(s) from "${hits[0].name}"`);
}

/* SPAs swap the form in long after load, so retry a few times before giving up. */
let tries = 0;
const tick = () => {
  autoFill();
  if (++tries < 5) setTimeout(tick, 600);
};
tick();

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'capture') respond(capture());
  else if (msg.type === 'fill') respond(applyProfile(msg.profile));
  return true;
});
