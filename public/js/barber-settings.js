// Barber: one-time settings, notifications, installing the app, pairing another device.
import { api, button, closeAllSheets, h, icon, platform, sheet, toast } from './ui.js';
import { LANGS, LANG_NAMES, setLang, t, weekdayLong } from './i18n.js';

const store = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

// ---------- push notifications ----------

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function subscribe() {
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('/api/b/push/key');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key can never deliver: replace it.
  if (sub && sub.options.applicationServerKey && b64(sub.options.applicationServerKey) !== key) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  const j = sub.toJSON();
  await api('/api/b/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
}

/** Runs on every start: if notifications were allowed, make sure the server still has a working subscription. */
export function syncPush() {
  if (pushSupported() && Notification.permission === 'granted') subscribe().catch(() => {});
}

async function enablePush(load) {
  try {
    if ((await Notification.requestPermission()) !== 'granted') return toast(t('notifsDenied'));
    await subscribe();
    toast(t('notifsOn'));
    load(true);
  } catch {
    toast(t('error'));
  }
}

// ---------- install + pairing ----------

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
});

export function pairSheet() {
  return api('/api/b/pair', { method: 'POST' }).then(
    (r) =>
      sheet((close) => [
        h('h2', { text: t('pairDevice') }),
        h('p', { class: 'sub', text: t('pairText') }),
        h('div', { class: 'code', id: 'pair-code', text: r.code.slice(0, 3) + ' ' + r.code.slice(3) }),
        button(t('ok'), close, 'gray mt'),
      ]),
    () => toast(t('error')),
  );
}

/** Gentle one-time hints at the top of the dashboard. */
export function banners({ D, load }) {
  const out = [];
  const dismissed = (k) => store(() => localStorage.getItem(k)) === '1';
  const closer = (k, el) => {
    const x = h('button', { type: 'button', 'aria-label': 'close' }, icon('x'));
    x.addEventListener('click', () => {
      store(() => localStorage.setItem(k, '1'));
      el.remove();
    });
    return x;
  };
  if (!platform.standalone && !dismissed('hideInstall') && (platform.ios || installEvent)) {
    const el = h('div', { class: 'banner info', id: 'install' });
    const act = h('button', { type: 'button', text: t(platform.ios ? 'showCode' : 'installBtn') });
    act.addEventListener('click', () => (platform.ios ? pairSheet() : installEvent.prompt()));
    el.append(h('div', { class: 'grow' }, h('b', { text: t('installTitle') }), platform.ios && h('div', { class: 'small', text: t('installIos') })), act, closer('hideInstall', el));
    out.push(el);
  }
  if (pushSupported() && Notification.permission === 'default' && !dismissed('hidePush')) {
    const el = h('div', { class: 'banner', id: 'push-hint' });
    const act = h('button', { type: 'button', text: t('enableNotifs') });
    act.addEventListener('click', () => enablePush(load).then(() => el.remove()));
    el.append(icon('bell'), h('div', { class: 'grow small', text: t('notifsHint') }), act, closer('hidePush', el));
    out.push(el);
  }
  return out;
}

// ---------- settings ----------

const toTime = (m) => String(Math.floor((m % 1440) / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const toMin = (v) => {
  const [hh, mm] = (v || '0:0').split(':').map(Number);
  return Math.round((hh * 60 + mm) / 5) * 5;
};
const SUNDAY = '2026-11-15'; // any Sunday, to print weekday names

function hoursEditor(hours) {
  const rows = [];
  const box = h('div', { class: 'list', id: 'week' });
  hours.forEach((wins, i) => {
    const first = wins[0];
    const last = wins[wins.length - 1];
    const time = (v) => h('input', { type: 'time', step: '300', value: toTime(v) });
    const on = h('input', { type: 'checkbox', class: 'switch', 'aria-label': weekdayLong(addDays(i)) });
    on.checked = wins.length > 0;
    const brk = h('input', { type: 'checkbox', class: 'switch' });
    brk.checked = wins.length > 1;
    const a = time(first ? first[0] : 540);
    const b = time(last ? last[1] : 1200);
    const x = time(wins.length > 1 ? first[1] : 780);
    const y = time(wins.length > 1 ? last[0] : 960);
    const breakTimes = h('span', { class: 'break-times' }, x, '–', y);
    const times = h('div', { class: 'times' }, a, '–', b, h('label', { class: 'brk small' }, brk, t('withBreak')), breakTimes);
    const sync = () => {
      times.hidden = !on.checked;
      breakTimes.hidden = !brk.checked;
    };
    on.addEventListener('change', sync);
    brk.addEventListener('change', sync);
    sync();
    box.append(h('div', { class: 'hours-row' }, h('b', { text: weekdayLong(addDays(i)) }), on, times));
    rows.push(() => {
      if (!on.checked) return [];
      const open = toMin(a.value);
      let close = toMin(b.value);
      if (close <= open) close += 1440;
      return brk.checked ? [[open, toMin(x.value)], [toMin(y.value), close]] : [[open, close]];
    });
  });
  return { box, read: () => rows.map((r) => r()) };
}

function addDays(i) {
  const d = new Date(SUNDAY + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

function selectField(label, value, options) {
  const sel = h('select', {}, options.map(([v, text]) => h('option', { value: String(v), text, selected: v === value })));
  return { wrap: h('label', { class: 'field' }, h('span', { text: label }), sel), get: () => sel.value };
}

function textField(label, value, attrs = {}) {
  const input = h('input', { type: 'text', value: value || '', ...attrs });
  return { wrap: h('label', { class: 'field' }, h('span', { text: label }), input), get: () => input.value.trim() };
}

export function openSettings({ D, post, load, setAuth }) {
  const s = D.shop;
  const name = textField(t('shopName'), s.shopName, { maxlength: '40', name: 'shop' });
  const address = textField(t('address'), s.address, { maxlength: '120', name: 'address' });
  const phone = textField(t('waPhone'), s.phone ? '0' + s.phone.replace(/^\+972/, '') : '', { type: 'tel', inputmode: 'tel', maxlength: '20', name: 'tel' });
  if (s.phone && !s.phone.startsWith('+972')) phone.wrap.querySelector('input').value = s.phone;
  const slot = selectField(t('slotLen'), s.slotMin, [10, 15, 20, 25, 30, 40, 45, 60, 90].map((n) => [n, t('minN', { n })]));
  const grace = selectField(t('grace'), s.graceMin, [0, 5, 10, 15, 20].map((n) => [n, t('minN', { n })]));
  const horizon = selectField(t('horizon'), s.horizonDays, [7, 14, 21, 30].map((n) => [n, t('daysN', { n })]));
  const lang = selectField(t('language'), s.lang, LANGS.map((l) => [l, LANG_NAMES[l]]));
  const week = hoursEditor(s.hours);
  const link = D.origin + '/';

  sheet(
    () => [
      h('h2', { text: t('settings') }),
      h('div', { class: 'gap' }),
      name.wrap,
      phone.wrap,
      address.wrap,
      h('div', { class: 'row-btns' }, slot.wrap, grace.wrap),
      h('div', { class: 'row-btns' }, horizon.wrap, lang.wrap),
      h('div', { class: 'section', text: t('weekHours') }),
      week.box,
      button(
        t('save'),
        async () => {
          const d = await post('settings', {
            shopName: name.get(),
            address: address.get(),
            phone: phone.get(),
            slotMin: Number(slot.get()),
            graceMin: Number(grace.get()),
            horizonDays: Number(horizon.get()),
            lang: lang.get(),
            hours: week.read(),
          });
          if (d) {
            setLang(lang.get(), true);
            load(true);
            toast(t('savedOk'));
          }
        },
        'mt',
      ),

      h('div', { class: 'section', text: t('bookingLink') }),
      h('div', { class: 'code long ltr', id: 'book-link', text: link }),
      h(
        'div',
        { class: 'row-btns mt' },
        button(t('copy'), () => navigator.clipboard.writeText(link).then(() => toast(t('copied')), () => {}), 'gray'),
        navigator.share && button(t('share'), () => navigator.share({ title: s.shopName, url: link }).catch(() => {}), 'gray'),
      ),

      h('div', { class: 'section', text: t('notifs') }),
      pushSupported()
        ? Notification.permission === 'granted'
          ? button(t('testNotif'), () => api('/api/b/push/test', { method: 'POST' }).then((r) => toast(t(r.sent ? 'sent' : 'error')), () => toast(t('error'))), 'gray')
          : Notification.permission === 'denied'
            ? h('p', { class: 'sub', text: t('notifsDenied') })
            : button(t('enableNotifs'), () => enablePush(load).then(closeAllSheets), 'gray')
        : h('p', { class: 'sub', text: t(platform.ios ? 'notifsIos' : 'notifsDenied') }),

      h('div', { class: 'section', text: t('pairDevice') }),
      button(t('showCode'), pairSheet, 'gray'),
      button(
        t('signOut'),
        async () => {
          await api('/api/b/logout', { method: 'POST' }).catch(() => {});
          store(() => localStorage.removeItem('day'));
          closeAllSheets();
          setAuth('login');
        },
        'plain danger mt',
      ),
    ],
    { gray: true },
  );
}
