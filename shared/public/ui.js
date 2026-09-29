// Small shared front-end helpers. DOM is built with textContent only (no innerHTML)
// so server data can never inject markup.

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function inr(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n || 0);
}

export function dt(iso) {
  return iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

const STATUS_TONE = {
  ACTIVE: 'ok', COMPLETED: 'ok', AUTHORIZED: 'ok', SUCCESS: 'ok',
  PENDING: 'warn', PENDING_AUTHORIZATION: 'warn', PENDING_APPROVAL: 'warn', PENDING_BANK_APPROVAL: 'warn',
  REJECTED: 'bad', FAILED: 'bad', INACTIVE: 'bad',
};

export function badge(status) {
  return h('span', { class: `badge ${STATUS_TONE[status] || ''}` }, String(status).replaceAll('_', ' '));
}

export function toast(message, isError = false) {
  let el = $('#toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = isError ? 'bad' : '';
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

export function table(headers, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return h('p', { class: 'muted' }, empty);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, headers.map((x) => h('th', { class: x.num ? 'num' : '' }, x.label ?? x)))),
      h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((c, i) => h('td', { class: headers[i]?.num ? 'num' : '' }, c))))),
    ),
  );
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export function tabs(container, names, onChange) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const buttons = {};
  for (const [key, label] of Object.entries(names)) {
    buttons[key] = h('button', { type: 'button', role: 'tab', onclick: () => select(key) }, label);
    bar.append(buttons[key]);
  }
  function select(key) {
    for (const [k, b] of Object.entries(buttons)) b.classList.toggle('active', k === key);
    onChange(key);
  }
  container.replaceChildren(bar);
  return { select, buttons };
}

// Wraps an async submit handler with busy state + error toast.
export function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      await handler(formData(form), form);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}
