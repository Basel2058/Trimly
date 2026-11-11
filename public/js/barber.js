// Barber dashboard: today's line-up, and the few buttons the barber ever needs.
import './i18n-barber.js';
import { api, button, closeAllSheets, copyText, field, h, icon, randomId, registerSW, sheet, toast, waLink } from './ui.js';
import { dayFull, dayLabel, dayNum, detectLang, setLang, t, tIn, weekdayShort, when } from './i18n.js';
import { banners, openSettings, syncPush } from './barber-settings.js';

const app = document.getElementById('app');
let D = null; // the day as the server sees it
let offset = 0;
let date = null; // null = follow "today"
let auth = 'loading'; // loading | setup | recovery | login | ok | offline
let recovery = '';
let pending = { moved: [], unplaced: [] }; // customers moved by the last change of hours

const now = () => Math.floor(Date.now() / 1000) + offset;
const store = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};
const savedLang = () => store(() => localStorage.getItem('lang'));

function apply(d) {
  D = d;
  offset = d.now - Math.floor(Date.now() / 1000);
  date = d.date === d.today ? null : d.date;
  auth = 'ok';
  if (!savedLang()) setLang(d.shop.lang);
  document.title = d.shop.shopName || 'Trimly';
  store(() => localStorage.setItem('day', JSON.stringify(d)));
  render();
  if (d.moved || d.unplaced) {
    pending.moved.push(...(d.moved || []));
    pending.unplaced.push(...(d.unplaced || []));
    if (d.more) return void post('rehome', { date: d.date, after: d.cursor });
    const { moved, unplaced } = pending;
    pending = { moved: [], unplaced: [] };
    if (moved.length || unplaced.length) movedSheet(moved, unplaced);
  }
}

function onError(e, quiet) {
  if (e.status === 401) {
    auth = e.code === 'setup' ? 'setup' : 'login';
    D = null;
    closeAllSheets();
    return render();
  }
  if (!quiet) toast(t({ offline: 'offline', slot_taken: 'slotTaken', too_many: 'tooMany', bad_phone: 'badPhone' }[e.code] || 'error'));
  if (e.code === 'slot_taken' || e.code === 'no_appt') load(true);
}

async function load(quiet) {
  try {
    apply(await api('/api/b/day' + (date ? '?date=' + date : '')));
  } catch (e) {
    if (!D && e.status !== 401) {
      // No connection: show the last known day rather than an empty screen.
      const cached = store(() => JSON.parse(localStorage.getItem('day')));
      if (cached && auth !== 'login') {
        D = cached;
        auth = 'ok';
        render();
      } else if (auth === 'loading') auth = 'offline';
    }
    onError(e, quiet && !!D);
    if (auth === 'offline') render();
  }
}

/** Every action answers with the fresh day, so the screen can never drift from reality. */
async function post(path, body = {}) {
  try {
    const d = await api('/api/b/' + path, { method: 'POST', body: { date: D && D.date, ...body } });
    closeAllSheets();
    apply(d);
    return d;
  } catch (e) {
    onError(e);
    return null;
  }
}

const label = (a) => (a.kind === 'block' ? t('breakWord') : a.name || t('customer'));
const addMin = (time, min) => {
  const [hh, mm] = time.split(':').map(Number);
  const v = (hh * 60 + mm + min) % 1440;
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
};

/** A ready-to-send WhatsApp text in the customer's own language. */
function message(a, key, extra = {}) {
  const l = a.lang || D.shop.lang;
  return tIn(l, key, {
    name: a.name ? ' ' + a.name : '',
    shop: D.shop.shopName,
    when: when(a.date, a.time, D.today, l),
    link: a.link,
    ...extra,
  });
}
const waButton = (a, key, text, extra) =>
  h('a', { class: 'btn green', target: '_blank', rel: 'noopener', href: waLink(a.phone, message(a, key, extra)) }, icon('chat'), text);

// ---------- sheets ----------

function apptSheet(a) {
  const n = now();
  const live = a.status === 'booked';
  const started = a.start <= n;
  const over = a.end <= n;
  const person = a.kind !== 'block';
  sheet(() => [
    h('h2', { text: label(a) }),
    h('p', { class: 'sub', text: `${dayLabel(a.date, D.today)} · ${a.time}–${a.endTime}${a.phoneText ? ' · \u2066' + a.phoneText + '\u2069' : ''}` }),
    person && a.phone && !over && live && waButton(a, 'waLink', t('waSend')),
    person && a.phone && h('a', { class: 'btn gray', href: 'tel:' + a.phone }, icon('phone'), t('call')),
    live && !over && button(t('moveAppt'), () => moveSheet(a), 'gray'),
    live && started && person && button(t('noShow'), () => post('noshow', { id: a.id }), 'gray danger'),
    a.status === 'no_show' && button(t('undoNoShow'), () => post('noshow', { id: a.id, value: false }), 'gray'),
    live && started && a.phone && button(t(a.markedLate ? 'undoLate' : 'arrivedLate'), () => post('late', { id: a.id, value: !a.markedLate }), 'gray'),
    a.blocked && button(t('allowAgain'), () => post('forgive', { phone: a.phone }), 'gray'),
    live && !over && button(t(person ? 'cancelAppt' : 'removeBreak'), () => (person ? cancelSheet(a) : post('cancel', { id: a.id })), 'plain danger'),
  ]);
}

function cancelSheet(a) {
  closeAllSheets();
  sheet((close) => [
    h('h2', { text: t('cancelQ') }),
    h('p', { class: 'sub', text: `${label(a)} · ${when(a.date, a.time, D.today)}` }),
    button(
      t('cancelYes'),
      async () => {
        if ((await post('cancel', { id: a.id })) && a.phone) {
          sheet((done) => [
            h('h2', { text: t('cancelledOk') }),
            h('p', { class: 'sub', text: label(a) }),
            waButton({ ...a, link: D.origin }, 'waCancelled', t('contact')),
            button(t('ok'), done, 'gray'),
          ]);
        }
      },
      'gray danger',
    ),
    button(t('keep'), close, 'plain'),
  ]);
}

function slotPicker(onPick) {
  let picked = (D.slots.find((d) => d.date === D.date && d.slots.length) || D.slots.find((d) => d.slots.length) || {}).date;
  const strip = h('div', { class: 'days' });
  const chips = h('div', { class: 'chips' });
  const fill = () => {
    const day = D.slots.find((d) => d.date === picked);
    chips.replaceChildren(
      ...(day && day.slots.length
        ? day.slots.map(([start, time]) => h('button', { class: 'chip', type: 'button', text: time, onclick: () => onPick(start) }))
        : [h('div', { class: 'empty-note', text: t('noSlotsDay') })]),
    );
    chips.classList.toggle('one', !(day && day.slots.length));
    for (const b of strip.children) b.classList.toggle('on', b.dataset.date === picked);
  };
  for (const d of D.slots) {
    const b = h(
      'button',
      { class: 'day' + (d.slots.length ? '' : ' empty'), type: 'button', 'data-date': d.date },
      h('span', { class: 'wd', text: d.date === D.today ? t('today') : weekdayShort(d.date) }),
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

function moveSheet(a) {
  closeAllSheets();
  sheet(
    () => [
      h('h2', { text: t('moveAppt') }),
      h('p', { class: 'sub', text: `${label(a)} · ${when(a.date, a.time, D.today)}` }),
      ...slotPicker(async (start) => {
        const d = await post('move', { id: a.id, start });
        const moved = d && d.appts.find((x) => x.id === a.id);
        if (moved && moved.phone) told(moved, 'waMoved', t('movedOk'));
      }),
    ],
    { gray: true },
  );
}

/** After a change that affects one customer: offer the ready WhatsApp message. */
function told(a, key, title) {
  sheet((close) => [
    h('h2', { text: title }),
    h('p', { class: 'sub', text: `${label(a)} · ${when(a.date, a.time, D.today)}` }),
    waButton(a, key, t('waSend')),
    button(t('ok'), close, 'gray'),
  ]);
}

function addSheet(start, time) {
  const id = randomId();
  sheet(() => {
    const name = field(t('nameOpt'), { type: 'text', name: 'name', maxlength: '40', autocomplete: 'off', enterkeyhint: 'next' });
    const phone = field(t('phoneOpt'), { type: 'tel', name: 'tel', inputmode: 'tel', maxlength: '20', autocomplete: 'off', placeholder: '050-1234567' });
    const go = button(t('save'), async () => {
      phone.setError('');
      const p = phone.input.value.trim();
      if (p && p.replace(/\D/g, '').length < 9) return phone.setError(t('badPhone'));
      const d = await post('add', { start, id, name: name.input.value.trim(), phone: p });
      const made = d && d.appts.find((x) => x.id === id);
      if (made && made.phone) told(made, 'waLink', t('addedSend'));
    });
    go.type = 'submit';
    const form = h('form', { novalidate: true }, name.wrap, phone.wrap, go);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      go.click();
    });
    return [
      h('h2', { text: `${t('newAppt')} · ${time}` }),
      h('p', { class: 'sub', text: `${dayLabel(D.date, D.today)} — ${t('newApptHint')}` }),
      form,
    ];
  });
}

const toMin = (v) => {
  const [hh, mm] = v.split(':').map(Number);
  return hh * 60 + mm;
};
const toTime = (m) => addMin('00:00', m);

function hoursSheet() {
  const w = D.hours.windows.length ? D.hours.windows : D.hours.normal;
  const from = h('input', { type: 'time', step: '300', value: toTime(w.length ? w[0][0] : 540) });
  const to = h('input', { type: 'time', step: '300', value: toTime(w.length ? w[w.length - 1][1] : 1200) });
  sheet(() => [
    h('h2', { text: t('dayHours') }),
    h('p', { class: 'sub', text: `${dayFull(D.date, D.today)} — ${t('hoursNote')}` }),
    h('div', { class: 'row-btns times-row' }, h('label', { class: 'field' }, h('span', { text: t('from') }), from), h('label', { class: 'field' }, h('span', { text: t('to') }), to)),
    button(t('save'), () => {
      const open = Math.round(toMin(from.value) / 5) * 5;
      let close = Math.round(toMin(to.value) / 5) * 5;
      if (close <= open) close += 1440; // past midnight
      return post('hours', { date: D.date, open, close });
    }),
    button(t('dayOff'), () => post('hours', { date: D.date, closed: true }), 'gray danger'),
    D.hours.override && button(t('backToNormal'), () => post('hours', { date: D.date, reset: true }), 'plain'),
  ]);
}

function movedSheet(moved = [], unplaced = []) {
  const row = (a, text, key) =>
    h(
      'div',
      { class: 'item' },
      h('div', { class: 'who' }, h('b', { text: label(a) }), h('small', { text })),
      a.phone && h('a', { class: 'pill', target: '_blank', rel: 'noopener', href: waLink(a.phone, message(a, key)) }, icon('chat')),
    );
  sheet(
    (close) => [
      moved.length > 0 && h('h2', { text: t('movedTitle', { n: moved.length }) }),
      moved.length > 0 && h('p', { class: 'sub', text: t('movedText') }),
      moved.length > 0 && h('div', { class: 'list plain', id: 'moved' }, moved.map((a) => row(a, `${a.fromTime} → ${when(a.date, a.time, D.today)}`, 'waMoved'))),
      unplaced.length > 0 && h('h2', { class: 'mt', text: t('unplacedTitle') }),
      unplaced.length > 0 && h('p', { class: 'sub', text: t('unplacedText') }),
      unplaced.length > 0 && h('div', { class: 'list plain' }, unplaced.map((a) => row(a, when(a.date, a.time, D.today), 'waLink'))),
      button(t('ok'), close, 'gray mt'),
    ],
    { gray: true },
  );
}

function delaySheet() {
  sheet(() => [
    h('h2', { text: t('delayTitle') }),
    h(
      'div',
      { class: 'chips delay-chips' },
      [10, 15, 20, 30, 45].map((min) =>
        h('button', {
          class: 'chip',
          type: 'button',
          text: String(min),
          onclick: async () => {
            if (!(await post('delay', { min }))) return;
            const n = now();
            const next = D.appts.filter((a) => a.status === 'booked' && a.kind !== 'block' && a.phone && a.end > n);
            sheet(
              (close) => [
                h('h2', { text: t('delayOn', { min }) }),
                h('p', { class: 'sub', text: t(next.length ? 'delaySend' : 'nobodyToTell') }),
                next.length > 0 &&
                  h(
                    'div',
                    { class: 'list plain' },
                    next.map((a) =>
                      h(
                        'div',
                        { class: 'item' },
                        h('div', { class: 'time', text: a.time }),
                        h('div', { class: 'who' }, h('b', { text: label(a) })),
                        h('a', { class: 'pill', target: '_blank', rel: 'noopener', href: waLink(a.phone, message(a, 'waDelay', { min, time: a.time, newTime: addMin(a.time, min) })) }, icon('chat')),
                      ),
                    ),
                  ),
                button(t('ok'), close, 'gray mt'),
              ],
              { gray: true },
            );
          },
        }),
      ),
    ),
    D.delay && button(t('delayClear'), () => post('delay', { min: 0 }), 'gray mt'),
  ]);
}

// ---------- main screen ----------

function nowCard() {
  const n = now();
  const live = D.appts.filter((a) => a.status === 'booked' && a.kind !== 'block');
  const cur = live.find((a) => a.start <= n && n < a.end);
  const next = live.find((a) => a.start > n);
  const c = h('div', { class: 'card', id: 'now' });
  if (cur) {
    c.append(h('div', { class: 'label', text: t('nowCard') }), h('div', { class: 'now-name', text: label(cur) }), h('div', { class: 'sub', text: `${cur.time}–${cur.endTime}` }));
    if (n > cur.start + D.shop.graceMin * 60) {
      // Would a haircut that starts this minute run into the next visit or closing time?
      const span = D.hours.spans.find(([a, b]) => cur.start >= a && cur.start < b);
      const limit = Math.min(span ? span[1] : Infinity, ...D.appts.filter((a) => a.status === 'booked' && a.start > cur.start).map((a) => a.start));
      const enough = n + (cur.end - cur.start) <= limit;
      const alt = D.free[0];
      c.append(h('p', { class: 'verdict' }, t('ifArrives') + ' ', h('span', { class: 'tag ' + (enough ? 'green' : 'orange'), id: 'verdict', text: t(enough ? 'enough' : 'notEnough') })));
      if (!enough && alt) c.append(button(t('moveHimTo', { time: alt[1] }), () => post('move', { id: cur.id, start: alt[0] }), 'orange'));
      c.append(button(t('noShow'), () => post('noshow', { id: cur.id }), 'gray danger'));
    }
  } else if (next) {
    c.append(
      h('div', { class: 'label', text: t('nextCard') }),
      h('div', { class: 'now-name', text: label(next) }),
      h('div', { class: 'sub', text: `${next.time} · ${t('inMin', { n: Math.max(1, Math.round((next.start - n) / 60)) })}` }),
    );
  } else {
    c.append(h('div', { class: 'sub center', text: t('noMore') }));
  }
  return c;
}

function timeline() {
  const n = now();
  const rows = [
    ...D.appts.map((a) => ({ at: a.start, a })),
    ...D.free.map(([start, time]) => ({ at: start, start, time })),
  ].sort((x, y) => x.at - y.at);
  if (!rows.length) return h('div', { class: 'empty-note', text: t(D.hours.windows.length ? 'noSlotsDay' : 'closedDay') });
  return h(
    'div',
    { class: 'list', id: 'timeline' },
    rows.map((r) => {
      if (!r.a) {
        return h('button', { class: 'item free', type: 'button', onclick: () => addSheet(r.start, r.time) }, h('div', { class: 'time', text: r.time }), h('div', { class: 'who', text: t('free') }), icon('plus', 'ic chev'));
      }
      const a = r.a;
      const cls = a.end <= n ? ' past' : a.start <= n && a.status === 'booked' ? ' now' : '';
      const name = h('b', { text: label(a) });
      if (a.status === 'no_show') name.append(h('span', { class: 'tag red', text: t('noShow') }));
      else if (a.markedLate) name.append(h('span', { class: 'tag orange', text: t('arrivedLate') }));
      else if (a.blocked) name.append(h('span', { class: 'tag red', text: t('paused') }));
      else if (a.latecomer) name.append(h('span', { class: 'tag orange', text: t('latecomer') }));
      return h(
        'button',
        { class: 'item' + cls, type: 'button', 'data-id': a.id, onclick: () => apptSheet(a) },
        h('div', { class: 'time', text: a.time }),
        h('div', { class: 'who' }, name, a.phoneText && h('small', { class: 'ltr', text: a.phoneText })),
        icon('chev', 'ic chev'),
      );
    }),
  );
}

function dayStrip() {
  const strip = h('div', { class: 'days', id: 'days' });
  for (const d of D.days) {
    const b = h(
      'button',
      { class: 'day' + (d.date === D.date ? ' on' : '') + (d.closed ? ' empty' : ''), type: 'button', 'data-date': d.date },
      h('span', { class: 'wd', text: d.date === D.today ? t('today') : weekdayShort(d.date) }),
      h('span', { class: 'num', text: dayNum(d.date) }),
      d.n > 0 && h('span', { class: 'dot', text: String(d.n) }),
    );
    b.addEventListener('click', () => {
      date = d.date === D.today ? null : d.date;
      load();
    });
    strip.append(b);
  }
  return strip;
}

function main() {
  const isToday = D.date === D.today;
  const w = D.hours.windows;
  const hoursText = w.length ? `${toTime(w[0][0])}–${toTime(w[w.length - 1][1])}` : t('closedDay');
  const gear = h('button', { class: 'icon-btn', type: 'button', id: 'settings', 'aria-label': t('settings') }, icon('gear'));
  gear.addEventListener('click', () => openSettings({ D, post, load, setAuth }));
  const hours = h('button', { class: 'pill', type: 'button', id: 'hours' }, icon('clock'), h('span', { text: hoursText }));
  hours.addEventListener('click', hoursSheet);
  const late = h('button', { class: 'pill' + (D.delay ? ' warn' : ''), type: 'button', id: 'late' }, D.delay ? t('delayOn', { min: D.delay.min }) : t('runningLate'));
  late.addEventListener('click', delaySheet);
  return [
    h('div', { class: 'top' }, h('span', { class: 'sub', text: D.shop.shopName }), gear),
    h('h1', { class: 'title', text: isToday ? t('today') : dayLabel(D.date, D.today) }),
    ...banners({ D, load }),
    isToday && nowCard(),
    dayStrip(),
    h('div', { class: 'pills' }, hours, isToday && late),
    timeline(),
  ];
}

// ---------- sign-in ----------

function setAuth(state) {
  auth = state;
  D = null;
  render();
}

function authView() {
  if (auth === 'offline') {
    return [h('div', { class: 'card center' }, h('p', { class: 'sub', text: t('offline') }), button(t('retry'), boot, 'gray'))];
  }
  if (auth === 'recovery') {
    return [
      h('h1', { class: 'title', text: t('recTitle') }),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'sub', text: t('recText') }),
        h('div', { class: 'code long', id: 'recovery', text: recovery }),
        button(t('copy'), () => copyText(recovery).then(() => toast(t('copied'))), 'gray'),
        button(t('savedIt'), load),
      ),
    ];
  }
  const isSetup = auth === 'setup';
  const a = isSetup ? field(t('shopName'), { type: 'text', name: 'shop', maxlength: '40', autocomplete: 'organization' }) : field(t('code'), { type: 'text', name: 'code', maxlength: '40', autocomplete: 'one-time-code', autocapitalize: 'characters', class: 'ltr' });
  const b = isSetup && field(t('waPhone'), { type: 'tel', name: 'tel', inputmode: 'tel', maxlength: '20', autocomplete: 'tel', placeholder: '050-1234567' });
  const go = button(t(isSetup ? 'start' : 'signIn'), async () => {
    a.setError('');
    if (b) b.setError('');
    const v = a.input.value.trim();
    if (!v) return a.setError(t(isSetup ? 'shopName' : 'badCode'));
    try {
      if (isSetup) {
        const r = await api('/api/b/setup', { method: 'POST', body: { shopName: v, phone: b.input.value.trim(), lang: detectLang() } });
        recovery = r.recovery;
        auth = 'recovery';
        render();
      } else {
        await api('/api/b/login', { method: 'POST', body: { code: v } });
        await load();
      }
    } catch (e) {
      if (e.code === 'bad_phone') b.setError(t('badPhone'));
      else if (e.code === 'bad_code') a.setError(t('badCode'));
      else if (e.code === 'already_setup') boot();
      else toast(t({ too_many: 'tooMany', offline: 'offline' }[e.code] || 'error'));
    }
  });
  go.type = 'submit';
  const form = h('form', { class: 'card', novalidate: true }, h('p', { class: 'sub', text: t(isSetup ? 'setupText' : 'loginText') }), a.wrap, b && b.wrap, go);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go.click();
  });
  return [h('h1', { class: 'title', text: t(isSetup ? 'setupTitle' : 'loginTitle') }), form];
}

function render() {
  let kids;
  if (auth === 'loading') kids = [h('div', { class: 'skel sk-title' }), h('div', { class: 'skel sk-hero' }), h('div', { class: 'skel sk-row' })];
  else if (auth === 'ok' && D) kids = main();
  else kids = authView();
  app.replaceChildren(...kids.filter(Boolean));
}

async function boot() {
  try {
    const s = await api('/api/b/session');
    setLang(savedLang() || (s.state === 'setup' ? detectLang() : s.lang));
    if (s.state === 'ok') {
      await load();
      syncPush();
    } else setAuth(s.state);
  } catch {
    await load(); // falls back to the cached day when offline
  }
}

const d0 = new URLSearchParams(location.search).get('d');
if (d0 && /^\d{4}-\d{2}-\d{2}$/.test(d0)) date = d0;
if (location.search) history.replaceState(null, '', '/barber');
setLang(savedLang() || detectLang());
render();
boot();
registerSW();

// Stay current without a refresh button.
setInterval(() => auth === 'ok' && document.visibilityState === 'visible' && load(true), 60000);
document.addEventListener('visibilitychange', () => auth === 'ok' && document.visibilityState === 'visible' && load(true));
window.addEventListener('online', () => auth === 'ok' && load(true));
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', () => auth === 'ok' && load(true));
