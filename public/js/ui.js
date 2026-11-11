// Tiny UI toolkit: safe DOM building (never innerHTML with user text), sheets, toasts, resilient API calls.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const ICONS = {
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.500 5.600 12 3z',
  gear: 'M12 15.2a3.200 3.200 0 100-6.400 3.200 3.200 0 000 6.400zM19.400 13.500l1.600 1.200-1.800 3.200-1.900-.8a7.600 7.600 0 01-2.300 1.300L14.700 21h-3.600l-.3-2.600a7.600 7.600 0 01-2.300-1.300l-1.900.8-1.800-3.200 1.600-1.200a7.800 7.800 0 010-2.600L4.800 9.700l1.800-3.200 1.900.8a7.600 7.600 0 012.300-1.300L11.100 3h3.600l.3 2.600a7.600 7.600 0 012.300 1.300l1.900-.8 1.800 3.200-1.600 1.200c.15.85.15 1.750 0 2.600z',
  chev: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.500l4.500 4.500L19 7.500',
  cal: 'M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2z',
  clock: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  chat: 'M20 11.500a8 8 0 01-11.800 7L4 20l1.500-4.200A8 8 0 1120 11.500z',
  phone: 'M6.500 3h3l1.500 4-2 1.500a11 11 0 006.500 6.500l1.500-2 4 1.500v3a2 2 0 01-2 2A16 16 0 014.500 5a2 2 0 012-2z',
  pin: 'M12 21s7-6.200 7-11.500A7 7 0 005 9.500C5 14.800 12 21 12 21zM12 12a2.500 2.500 0 100-5 2.500 2.500 0 000 5z',
  bell: 'M6 9a6 6 0 1112 0c0 5 2 6.500 2 6.500H4S6 14 6 9zM10 19a2 2 0 004 0',
  x: 'M6 6l12 12M18 6L6 18',
};

export function icon(name, cls = 'ic') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls the API. Network failures and server hiccups are retried automatically with backoff —
 * every request is designed to be safe to repeat — so a weak signal never costs the user a booking.
 */
export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers['x-appt-token'] = token;
  if (method !== 'GET') headers['content-type'] = 'application/json';
  const payload = method === 'GET' ? undefined : JSON.stringify(body || {});
  for (let attempt = 0; ; attempt++) {
    let err;
    try {
      const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (res.ok && data) return data;
      err = Object.assign(new Error((data && data.error) || 'server'), { code: (data && data.error) || 'server', status: res.status });
    } catch {
      err = Object.assign(new Error('offline'), { code: 'offline', status: 0 });
    }
    const transient = err.status === 0 || err.status >= 500;
    if (!transient || attempt >= 3) throw err;
    await sleep(350 * 2 ** attempt);
  }
}

let toastEl = null;
let toastTimer = 0;
export function toast(text) {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

const openSheets = [];

/** Bottom sheet. `build(close)` returns the content nodes. Returns a close function. */
export function sheet(build, { gray = false } = {}) {
  const back = h('div', { class: 'backdrop' });
  const box = h('div', { class: 'sheet' + (gray ? ' gray' : ''), role: 'dialog', 'aria-modal': 'true' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.classList.remove('show');
    box.classList.remove('show');
    openSheets.splice(openSheets.indexOf(close), 1);
    setTimeout(() => {
      back.remove();
      box.remove();
    }, 400);
  };
  box.append(h('div', { class: 'grabber' }), ...[build(close)].flat(Infinity).filter(Boolean));
  back.addEventListener('click', close);
  document.body.append(back, box);
  openSheets.push(close);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      back.classList.add('show');
      box.classList.add('show');
    }),
  );
  return close;
}

export function closeAllSheets() {
  for (const c of [...openSheets]) c();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openSheets.length) openSheets[openSheets.length - 1]();
});

/** Runs an async action from a button: shows a spinner and ignores double taps. */
export async function busy(btn, fn) {
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    btn.classList.remove('busy');
    btn.removeAttribute('aria-busy');
  }
}

export function button(label, onclick, cls = '') {
  const b = h('button', { class: 'btn ' + cls, type: 'button', text: label });
  b.addEventListener('click', () => busy(b, () => onclick(b)));
  return b;
}

export function field(label, attrs) {
  const input = h('input', attrs);
  const err = h('div', { class: 'small err', hidden: true });
  const wrap = h('label', { class: 'field' }, h('span', { text: label }), input, err);
  return {
    wrap,
    input,
    setError(text) {
      wrap.classList.toggle('bad', !!text);
      err.hidden = !text;
      err.textContent = text || '';
      if (text) input.focus();
    },
  };
}

export function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const waLink = (phone, text) => `https://wa.me/${String(phone).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

export const platform = (() => {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return {
    ios,
    android: /Android/i.test(ua),
    standalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  };
})();

/** Registers the service worker (offline shell + push). Failure is harmless. */
export function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}
