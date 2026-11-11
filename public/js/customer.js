// Customer page: see the next free time, tap, done. No account, no app to install.
import { api, button, closeAllSheets, field, h, icon, platform, randomId, registerSW, sheet, toast, waLink } from './ui.js';
import { LANGS, LANG_NAMES, dayFull, dayLabel, dayNum, detectLang, getLang, setLang, t, weekdayShort, when } from './i18n.js';

const app = document.getElementById('app');
let S = null; // latest state from the server (the single source of truth)
let offset = 0; // server clock − device clock, so a wrong phone clock never matters
let token = null; // private-link token
let mode = 'home'; // 'home' | 'change'
let picked = null;
let fresh = false; // just booked → show the success tick once
let failed = false;
let phase = '';

const now = () => Math.floor(Date.now() / 1000) + offset;
const store = (fn) => {
  try {
    return fn();
  } catch {
    return null; // storage can be unavailable in private mode
  }
};

// A private link looks like /a/<token>. Keep the token for this tab only and clean the address bar,
// so copying the page address to a friend never shares the appointment itself.
const m = /^\/a\/([\w.-]{20,120})$/.exec(location.pathname);
if (m) {
  token = m[1];
  store(() => sessionStorage.setItem('t', token));
} else {
  token = store(() => sessionStorage.getItem('t'));
}
if (location.pathname !== '/') history.replaceState(null, '', '/');

setLang(detectLang());

function apply(st) {
  S = st;
  offset = st.now - Math.floor(Date.now() / 1000);
  failed = false;
  if (!store(() => localStorage.getItem('lang'))) setLang(detectLang(st.shop.lang));
  document.title = st.shop.name || 'Trimly';
  fresh = !!st.booked;
  if (!st.appt || st.moved) mode = 'home'; // after a change, go back to the appointment card
  if (!st.days.some((d) => d.date === picked && d.slots.length)) picked = null;
  if (st.moved) toast(t('movedOk'));
  if (st.cancelled) toast(t('cancelledOk'));
  render();
}

async function load() {
  try {
    apply(await api('/api/state', { token }));
  } catch (e) {
    failed = true;
    if (S) toast(t(e.code === 'offline' ? 'offline' : 'error'));
    else render();
  }
}

function fail(e) {
  if (e.code === 'has_active') {
    closeAllSheets();
    sheet((close) => [
      h('h2', { text: t('hasActiveTitle') }),
      h('p', { class: 'sub', text: t('hasActive') }),
      S.shop.phone && h('a', { class: 'btn green', href: waLink(S.shop.phone, ''), target: '_blank', rel: 'noopener', text: t('contact') }),
      button(t('ok'), close, 'gray'),
    ]);
    return;
  }
  toast(t({ slot_taken: 'slotTaken', too_many: 'tooMany', offline: 'offline' }[e.code] || 'error'));
  if (['slot_taken', 'no_appt', 'blocked', 'need_identity', 'closed'].includes(e.code)) {
    closeAllSheets();
    load(); // show the truth
  }
}

async function act(path, body) {
  try {
    const st = await api(path, { method: 'POST', body, token });
    closeAllSheets();
    apply(st);
  } catch (e) {
    fail(e);
  }
}

const allSlots = () => S.days.flatMap((d) => d.slots.map(([start, time]) => ({ start, time, date: d.date })));
const firstSlot = () => allSlots()[0] || null;

// ---------- pieces ----------

function langButton() {
  const b = h('button', { class: 'pill', type: 'button', 'aria-label': 'Language' }, icon('globe'), LANG_NAMES[getLang()]);
  b.addEventListener('click', () =>
    sheet((close) =>
      LANGS.map((l) =>
        button(
          LANG_NAMES[l],
          () => {
            setLang(l, true);
            close();
            render();
          },
          l === getLang() ? '' : 'gray',
        ),
      ),
    ),
  );
  return b;
}

const banner = (kind, text) => h('div', { class: 'banner ' + kind, role: 'status' }, h('div', { class: 'grow', text }));

function tick() {
  const el = h('div', { class: 'tick' });
  el.append(icon('check', ''));
  return el;
}

function calendarButtons(a) {
  const ics = { href: a.ics, ...(platform.ios ? {} : { download: 'appointment.ics' }) };
  const gcal = { href: a.gcal, target: '_blank', rel: 'noopener' };
  const [main, other, otherLabel] = platform.android ? [gcal, ics, 'calFile'] : [ics, gcal, 'googleCal'];
  return [
    h('a', { class: 'btn', id: 'add-cal', ...main }, icon('cal'), t('addCalendar')),
    h('p', { class: 'small', text: t('calendarHint') }),
    h('a', { class: 'small', ...other, text: t(otherLabel) }),
  ];
}

function apptView() {
  const a = S.appt;
  const n = now();
  const out = [];
  if (a.moved) out.push(banner('info', t('movedBanner', { when: when(a.moved.date, a.moved.time, S.today) })));
  if (a.delayMin > 0) out.push(banner('warn', t('delayBanner', { min: a.delayMin })));

  const late = n > a.graceUntil;
  const c = h('div', { class: 'card center fade', id: 'appt' });
  if (fresh) c.append(tick());
  c.append(
    h('div', { class: 'label', text: t(late ? 'gracePassed' : fresh ? 'booked' : 'yourAppt') }),
    h('div', { class: 'hero-day', text: dayFull(a.date, S.today) }),
    h('div', { class: 'hero-time', text: a.time }),
  );
  if (late) {
    // The customer is late: no blame, just the next free time, one tap away.
    const next = firstSlot();
    c.append(h('p', { class: 'sub', text: t(next ? 'graceText' : 'graceNone', { time: a.graceTime }) }));
    if (next) {
      c.append(button(t('moveTo', { when: when(next.date, next.time, S.today) }), () => act('/api/move', { start: next.start })));
    }
  } else {
    if (S.shop.graceMin > 0) c.append(h('p', { class: 'sub', text: t('heldUntil', { time: a.graceTime }) }));
    c.append(...calendarButtons(a));
  }
  out.push(c);

  const soon = !late && n > a.start - 7200;
  out.push(
    h(
      'div',
      { class: 'stack actions' },
      button(
        t(soon ? 'late' : 'change'),
        () => {
          mode = 'change';
          picked = null;
          render();
          window.scrollTo(0, 0);
        },
        'gray',
      ),
      button(t('cancelAppt'), cancelSheet, 'plain danger'),
    ),
  );
  return out;
}

function cancelSheet() {
  const a = S.appt;
  sheet((close) => [
    h('h2', { text: t('cancelQ') }),
    h('p', { class: 'sub', text: when(a.date, a.time, S.today) }),
    button(t('cancelYes'), () => act('/api/cancel'), 'danger gray'),
    button(t('keep'), close, 'plain'),
  ]);
}

function choose(slot, direct) {
  const whenText = when(slot.date, slot.time, S.today);
  if (mode === 'change') {
    sheet((close) => [
      h('h2', { text: t('moveQ') }),
      h('p', { class: 'sub', text: whenText }),
      button(t('moveYes'), () => act('/api/move', { start: slot.start })),
      button(t('keep'), close, 'plain'),
    ]);
    return;
  }
  const id = randomId(); // one id per attempt: a retry can never create a second booking
  if (S.me) {
    const go = () => act('/api/book', { start: slot.start, id, lang: getLang() });
    if (direct) return go();
    sheet((close) => [
      h('h2', { text: t('confirmTitle') }),
      h('p', { class: 'sub', text: whenText }),
      button(t('confirm'), go),
      button(t('keep'), close, 'plain'),
    ]);
    return;
  }
  sheet(() => {
    const name = field(t('name'), { type: 'text', name: 'name', autocomplete: 'name', maxlength: '40', enterkeyhint: 'next' });
    const phone = field(t('phone'), {
      type: 'tel',
      name: 'tel',
      autocomplete: 'tel',
      inputmode: 'tel',
      maxlength: '20',
      placeholder: '050-1234567',
      enterkeyhint: 'done',
    });
    const go = button(t('confirm'), async () => {
      name.setError('');
      phone.setError('');
      const n = name.input.value.trim();
      const p = phone.input.value.trim();
      if (n.length < 2) return name.setError(t('badName'));
      if (p.replace(/\D/g, '').length < 9) return phone.setError(t('badPhone'));
      try {
        const st = await api('/api/book', { method: 'POST', body: { start: slot.start, id, lang: getLang(), name: n, phone: p } });
        closeAllSheets();
        apply(st);
      } catch (e) {
        if (e.code === 'bad_name') name.setError(t('badName'));
        else if (e.code === 'bad_phone') phone.setError(t('badPhone'));
        else fail(e);
      }
    });
    const form = h('form', { novalidate: true }, name.wrap, phone.wrap, go);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      go.click();
    });
    go.type = 'submit';
    setTimeout(() => name.input.focus(), 420);
    return [h('h2', { text: t('confirmTitle') }), h('p', { class: 'sub', text: whenText }), form];
  });
}

function picker() {
  const first = S.days.find((d) => d.slots.length);
  picked = picked || (first && first.date);
  const chips = h('div', { class: 'chips', id: 'chips' });
  const strip = h('div', { class: 'days', id: 'days' });
  const fill = () => {
    const day = S.days.find((d) => d.date === picked);
    const slots = day ? day.slots : [];
    chips.replaceChildren(
      ...(slots.length
        ? slots.map(([start, time]) =>
            h('button', { class: 'chip', type: 'button', text: time, onclick: () => choose({ start, time, date: picked }, false) }),
          )
        : [h('div', { class: 'empty-note', text: t('noSlotsDay') })]),
    );
    chips.classList.toggle('one', !slots.length);
    for (const b of strip.children) {
      const on = b.dataset.date === picked;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  for (const d of S.days) {
    const b = h(
      'button',
      { class: 'day' + (d.slots.length ? '' : ' empty'), type: 'button', 'data-date': d.date, 'aria-label': dayLabel(d.date, S.today) },
      h('span', { class: 'wd', text: d.date === S.today ? t('today') : weekdayShort(d.date) }),
      h('span', { class: 'num', text: dayNum(d.date) }),
    );
    b.addEventListener('click', () => {
      picked = d.date;
      fill();
    });
    strip.append(b);
  }
  fill();
  return [strip, chips];
}

function bookingView() {
  const out = [];
  if (mode === 'change') {
    const back = h('button', { class: 'pill', type: 'button', text: t('keep') });
    back.addEventListener('click', () => {
      mode = 'home';
      render();
    });
    out.push(h('div', { class: 'top' }, back));
  } else {
    if (S.notice) out.push(banner('bad', t('cancelledNotice', { when: when(S.notice.date, S.notice.time, S.today) })));
    if (S.me) {
      const forget = h('button', { class: 'pill', type: 'button', id: 'not-you', text: t('notYou') });
      forget.addEventListener('click', () => act('/api/forget'));
      out.push(h('div', { class: 'top hello' }, h('span', { class: 'sub', text: t('hello', { name: S.me.name }) }), forget));
    }
  }
  const first = firstSlot();
  if (!first) {
    out.push(h('div', { class: 'card center' }, h('p', { class: 'sub', text: t('noSlots') })));
    return out;
  }
  if (mode !== 'change') {
    out.push(
      h(
        'div',
        { class: 'card center fade', id: 'hero' },
        h('div', { class: 'label', text: t('nextSlot') }),
        h('div', { class: 'hero-day', text: dayLabel(first.date, S.today) }),
        h('div', { class: 'hero-time', text: first.time }),
        button(t('bookAt', { time: first.time }), () => choose(first, true)),
      ),
    );
  }
  out.push(h('div', { class: 'section', text: t(mode === 'change' ? 'pickNew' : 'otherTimes') }), ...picker());
  return out;
}

function footer() {
  const s = S.shop;
  const links = [];
  if (s.address) {
    links.push(
      h(
        'a',
        { class: 'pill', target: '_blank', rel: 'noopener', href: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(s.address) },
        icon('pin'),
        t('directions'),
      ),
    );
  }
  if (s.phone) links.push(h('a', { class: 'pill', target: '_blank', rel: 'noopener', href: waLink(s.phone, '') }, icon('chat'), t('contact')));
  return h('div', { class: 'foot' }, links);
}

function phaseKey() {
  if (!S || !S.appt) return '';
  const n = now();
  const a = S.appt;
  return [a.token, n > a.start - 7200, n > a.graceUntil, n >= a.end].join();
}

function render() {
  const kids = [h('div', { class: 'top' }, h('div', { class: 'spacer' }), langButton())];
  if (!S) {
    if (failed) {
      kids.push(h('div', { class: 'card center' }, h('p', { class: 'sub', text: t('offline') }), button(t('retry'), load, 'gray')));
    } else {
      kids.push(h('div', { class: 'skel sk-title' }), h('div', { class: 'skel sk-hero' }), h('div', { class: 'skel sk-row' }));
    }
  } else {
    kids.push(h('h1', { class: 'title', text: S.shop.name }));
    if (!S.open) {
      kids.push(h('div', { class: 'card center' }, h('h2', { text: t('closedTitle') }), h('p', { class: 'sub', text: t('closedText') })));
    } else {
      if (S.appt && mode === 'home') kids.push(...apptView());
      else if (S.blocked) {
        kids.push(h('div', { class: 'card center', id: 'blocked' }, h('h2', { text: t('blockedTitle') }), h('p', { class: 'sub', text: t('blockedText') })));
      } else kids.push(...bookingView());
      kids.push(footer());
    }
  }
  app.replaceChildren(...kids);
  phase = phaseKey();
}

// Keep the screen honest without asking the user to refresh.
setInterval(() => {
  if (!S) return void (failed && load());
  if (phaseKey() === phase) return;
  if (S.appt && now() >= S.appt.end) load();
  else render();
}, 15000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());
window.addEventListener('online', load);
window.addEventListener('pageshow', (e) => e.persisted && load());

render();
load();
registerSW();
