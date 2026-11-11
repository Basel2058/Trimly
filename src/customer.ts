// Customer API. No accounts: a signed cookie / private link is the only key to an appointment.
import { ID_RE, asLang, maskPhone, normalizeName, normalizePhone, sha256, verifyToken } from './core';
import { q } from './db';
import { ApiError, body, clearCookie, getCookie, json, setCookie, type ApptRow, type Ctx } from './http';
import { buildIcs, googleCalendarUrl, type CalEvent } from './ics';
import { notifyBarber } from './push';
import { availability, isOffered } from './slots';
import { localParts, timeOf } from './time';
import {
  FRESH_SEC,
  LATE_CHANGE_SEC,
  LATE_LIMIT,
  NO_SHOW_LIMIT,
  STRIKE_WINDOW,
  addStrikeStmt,
  apptById,
  apptLink,
  apptToken,
  claimedIdentity,
  identityToken,
  insertApptStmt,
  isActive,
  loadWorld,
  moveApptStmt,
  strikeCounts,
  strikesStmt,
  verifiedIdentity,
  type Identity,
  type World,
} from './world';

type Json = Record<string, unknown>;

const idOf = (token: string | null | undefined): string => {
  if (!token) return '';
  const id = token.slice(0, Math.max(0, token.lastIndexOf('.')));
  return ID_RE.test(id) ? id : '';
};

function calEvent(c: Ctx, w: World, a: ApptRow, token: string, early: boolean): CalEvent {
  return {
    id: a.id,
    seq: a.seq,
    start: a.start_at,
    end: a.start_at + a.dur_min * 60,
    graceMin: w.settings.graceMin,
    shop: w.settings.shopName,
    address: w.settings.address,
    link: apptLink(c, token),
    lang: a.lang,
    early,
    now: c.now,
  };
}

function apptView(c: Ctx, w: World, a: ApptRow, token: string, early: boolean): Json {
  const day = localParts(a.start_at).date;
  const d = w.delay;
  const grace = a.start_at + w.settings.graceMin * 60;
  return {
    token,
    start: a.start_at,
    end: a.start_at + a.dur_min * 60,
    date: day,
    time: timeOf(a.start_at),
    graceUntil: grace,
    graceTime: timeOf(grace),
    moved:
      a.moved_by === 'barber' && a.prev_start
        ? { date: localParts(a.prev_start).date, time: timeOf(a.prev_start) }
        : null,
    delayMin: d && d.date === day && a.start_at + a.dur_min * 60 > d.setAt ? d.min : 0,
    ics: `/api/ics?t=${token}`,
    gcal: googleCalendarUrl(calEvent(c, w, a, token, early)),
  };
}

/**
 * Everything the customer page needs, in one database round trip.
 * `over` lets a handler that has just issued new cookies build the state as the browser will see it next.
 */
async function buildState(c: Ctx, over: { a?: string; d?: string } = {}, flash: Json = {}): Promise<Json> {
  const hdr = over.a ?? c.req.headers.get('x-appt-token');
  const aCk = getCookie(c, 'a');
  const dCk = over.d ?? getCookie(c, 'd');
  const hid = idOf(hdr);
  const cid = idOf(aCk);
  const claimed = claimedIdentity(dCk);

  const { world: w, extra } = await loadWorld(c, [
    c.db.prepare(`SELECT * FROM appointments WHERE id IN (?, ?)`).bind(hid, cid),
    c.db
      .prepare(
        `SELECT phone, kind, COUNT(*) AS n FROM strikes
         WHERE at > ?1 AND phone != '' AND phone IN (?2,
           (SELECT phone FROM appointments WHERE id = ?3), (SELECT phone FROM appointments WHERE id = ?4))
         GROUP BY phone, kind`,
      )
      .bind(c.now - STRIKE_WINDOW, claimed?.p ?? '', hid, cid),
  ]);
  const rows = extra[0]!.results as unknown as ApptRow[];
  const strikeRows = extra[1]!.results as Array<{ phone: string; kind: string; n: number }>;

  // Only appointments whose token signature checks out are visible.
  const candidates: Array<{ row: ApptRow; token: string }> = [];
  for (const [id, token] of [
    [hid, hdr],
    [cid, aCk],
  ] as const) {
    if (!id || !token || (await verifyToken(w.key, 'a', token)) !== id) continue;
    const row = rows.find((r) => r.id === id);
    if (row && !candidates.some((x) => x.row.id === id)) candidates.push({ row, token });
  }
  const current = candidates.find((x) => isActive(x.row, c.now)) ?? null;
  if (current && current.token !== aCk) setCookie(c, 'a', current.token);
  if (!current && aCk && !candidates.some((x) => x.token === aCk)) clearCookie(c, 'a');

  let me: Identity | null = await verifiedIdentity(w, dCk);
  if (!me && current && current.row.phone && current.row.name) {
    me = { p: current.row.phone, n: current.row.name };
    setCookie(c, 'd', await identityToken(w, me));
  } else if (me && dCk && !over.d) {
    setCookie(c, 'd', dCk); // rolling expiry
  }

  const phone = current?.row.phone || me?.p || '';
  const count = (kind: string): number => strikeRows.find((r) => r.phone === phone && r.kind === kind)?.n ?? 0;
  const latecomer = !!phone && count('late') >= LATE_LIMIT;
  const blocked = !current && !!phone && count('no_show') >= NO_SHOW_LIMIT;

  // A visit the barber had to cancel is announced until its time has passed or a new one is booked.
  const gone = current
    ? null
    : candidates.find((x) => x.row.status === 'cancelled' && x.row.cancelled_by === 'barber' && x.row.start_at > c.now);

  const s = w.settings;
  const days = blocked
    ? []
    : availability({
        settings: s,
        overrides: w.overrides,
        busy: w.busy,
        now: c.now,
        bufferMin: latecomer ? s.graceMin : 0,
      });

  return {
    now: c.now,
    today: localParts(c.now).date,
    open: w.owner,
    shop: { name: s.shopName, address: s.address, phone: s.phone, slotMin: s.slotMin, graceMin: s.graceMin, lang: s.lang },
    me: me ? { name: me.n, phone: maskPhone(me.p) } : null,
    appt: current ? apptView(c, w, current.row, current.token, latecomer) : null,
    notice: gone ? { kind: 'cancelled', date: localParts(gone.row.start_at).date, time: timeOf(gone.row.start_at) } : null,
    blocked,
    days: days.map((d) => ({ date: d.date, slots: d.slots.map((t) => [t, timeOf(t)]) })),
    ...flash,
  };
}

export async function getState(c: Ctx): Promise<Response> {
  return json(c, await buildState(c));
}

async function limitBookings(c: Ctx): Promise<void> {
  const ip = (await sha256('ip:' + c.ip)).slice(0, 16);
  const rules: Array<[string, number, number]> = [
    [`bk:h:${ip}`, 6, 3600],
    [`bk:d:${ip}`, 15, 86400],
    ['bk:all', 60, 3600], // circuit breaker against a distributed flood
  ];
  const res = await q(() =>
    c.db.batch(
      rules.map(([k, , win]) =>
        c.db
          .prepare(
            `INSERT INTO rate (k, n, reset_at) VALUES (?1, 1, ?2)
             ON CONFLICT (k) DO UPDATE SET
               n = CASE WHEN rate.reset_at <= ?3 THEN 1 ELSE rate.n + 1 END,
               reset_at = CASE WHEN rate.reset_at <= ?3 THEN ?2 ELSE rate.reset_at END
             RETURNING n`,
          )
          .bind(k, c.now + win, c.now),
      ),
    ),
  );
  res.forEach((r, i) => {
    const n = (r.results[0] as { n: number } | undefined)?.n ?? 1;
    if (n > rules[i]![1]) throw new ApiError(429, 'too_many');
  });
}

export async function book(c: Ctx): Promise<Response> {
  const b = await body(c);
  const start = b.start;
  const id = b.id;
  if (typeof start !== 'number' || !Number.isInteger(start) || typeof id !== 'string' || !ID_RE.test(id)) {
    throw new ApiError(400, 'bad_request');
  }
  const lang = asLang(b.lang);
  const dCk = getCookie(c, 'd');
  const typed = b.name !== undefined || b.phone !== undefined;
  let who: Identity | null = null;
  if (typed) {
    const n = normalizeName(b.name);
    const p = normalizePhone(b.phone);
    if (!n) throw new ApiError(400, 'bad_name');
    if (!p) throw new ApiError(400, 'bad_phone');
    who = { p, n };
  }
  const claimed = who ?? claimedIdentity(dCk);
  if (!claimed) throw new ApiError(401, 'need_identity');

  await limitBookings(c);

  const { world: w, extra } = await loadWorld(c, [
    c.db.prepare(`SELECT * FROM appointments WHERE id = ?`).bind(id),
    strikesStmt(c, claimed.p),
    c.db
      .prepare(`SELECT id FROM appointments WHERE phone = ? AND status = 'booked' AND start_at + dur_min * 60 > ? LIMIT 1`)
      .bind(claimed.p, c.now),
  ]);
  if (!w.owner) throw new ApiError(503, 'closed');
  who = who ?? (await verifiedIdentity(w, dCk));
  if (!who) throw new ApiError(401, 'need_identity');

  const done = async (): Promise<Response> => {
    const a = await apptToken(w, id);
    const d = await identityToken(w, who!);
    setCookie(c, 'a', a);
    setCookie(c, 'd', d);
    return json(c, await buildState(c, { a, d }, { booked: true }));
  };

  // A retry of a request that already succeeded (lost response) simply succeeds again.
  const same = (r: ApptRow | null | undefined): boolean =>
    !!r && r.phone === who!.p && r.start_at === start && r.status === 'booked';
  const existing = extra[0]!.results[0] as unknown as ApptRow | undefined;
  if (existing) {
    if (same(existing)) return done();
    throw new ApiError(409, 'slot_taken');
  }

  const strikes = strikeCounts(extra[1]);
  if (strikes.noShow >= NO_SHOW_LIMIT) throw new ApiError(403, 'blocked');
  if (extra[2]!.results.length) throw new ApiError(409, 'has_active');

  const s = w.settings;
  const bufferMin = strikes.late >= LATE_LIMIT ? s.graceMin : 0;
  const days = availability({ settings: s, overrides: w.overrides, busy: w.busy, now: c.now, bufferMin });
  if (!isOffered(days, start)) throw new ApiError(409, 'slot_taken');

  const res = await q(() =>
    insertApptStmt(
      c,
      {
        id,
        kind: 'customer',
        phone: who!.p,
        name: who!.n,
        lang,
        start,
        end: start + (s.slotMin + bufferMin) * 60,
        durMin: s.slotMin,
      },
      true,
    ).run(),
  );
  if (res.meta.changes !== 1 && !same(await apptById(c, id))) throw new ApiError(409, 'slot_taken');

  c.wait(notifyBarber(c, w, 'new', { name: who.n, start }));
  return done();
}

/** The appointment the caller is allowed to act on (private-link header first, then cookie). */
async function authAppt(c: Ctx): Promise<{ w: World; row: ApptRow; token: string; late: number }> {
  const hdr = c.req.headers.get('x-appt-token');
  const aCk = getCookie(c, 'a');
  const hid = idOf(hdr);
  const cid = idOf(aCk);
  const { world: w, extra } = await loadWorld(c, [
    c.db.prepare(`SELECT * FROM appointments WHERE id IN (?, ?)`).bind(hid, cid),
    c.db
      .prepare(
        `SELECT s.phone, COUNT(*) AS n FROM strikes s
         WHERE s.kind = 'late' AND s.at > ?1 AND s.phone IN (SELECT phone FROM appointments WHERE id IN (?2, ?3))
         GROUP BY s.phone`,
      )
      .bind(c.now - STRIKE_WINDOW, hid, cid),
  ]);
  const rows = extra[0]!.results as unknown as ApptRow[];
  for (const [id, token] of [
    [hid, hdr],
    [cid, aCk],
  ] as const) {
    if (!id || !token || (await verifyToken(w.key, 'a', token)) !== id) continue;
    const row = rows.find((r) => r.id === id);
    if (isActive(row, c.now)) {
      const late = (extra[1]!.results as Array<{ phone: string; n: number }>).find((r) => r.phone === row.phone)?.n ?? 0;
      return { w, row, token, late };
    }
  }
  throw new ApiError(404, 'no_appt');
}

/** Giving up a slot at the last minute is remembered (quietly) — unless the booking was only just made. */
const isLateChange = (c: Ctx, a: ApptRow): boolean =>
  !!a.phone && c.now > a.start_at - LATE_CHANGE_SEC && c.now - a.created_at > FRESH_SEC;

export async function cancel(c: Ctx): Promise<Response> {
  const { w, row } = await authAppt(c);
  const stmts = [
    c.db
      .prepare(
        `UPDATE appointments SET status = 'cancelled', cancelled_by = 'customer', updated_at = ?
         WHERE id = ? AND status = 'booked'`,
      )
      .bind(c.now, row.id),
  ];
  if (isLateChange(c, row)) stmts.push(addStrikeStmt(c, row.phone, 'late', row.id));
  await q(() => c.db.batch(stmts));
  clearCookie(c, 'a');
  c.wait(notifyBarber(c, w, 'cancel', { name: row.name, start: row.start_at }));
  return json(c, await buildState(c, { a: '' }, { cancelled: true }));
}

export async function move(c: Ctx): Promise<Response> {
  const b = await body(c);
  const start = b.start;
  if (typeof start !== 'number' || !Number.isInteger(start)) throw new ApiError(400, 'bad_request');
  const { w, row, token, late } = await authAppt(c);
  if (start === row.start_at) return json(c, await buildState(c, { a: token }));

  const s = w.settings;
  const bufferMin = late >= LATE_LIMIT ? s.graceMin : 0;
  const days = availability({ settings: s, overrides: w.overrides, busy: w.busy, now: c.now, bufferMin });
  if (!isOffered(days, start)) throw new ApiError(409, 'slot_taken');

  const end = start + (s.slotMin + bufferMin) * 60;
  const res = await q(() => c.db.batch([moveApptStmt(c, row, start, end, s.slotMin, 'customer')]));
  if (res[0]!.meta.changes !== 1) {
    const cur = await apptById(c, row.id);
    if (!cur || cur.status !== 'booked' || cur.start_at !== start) throw new ApiError(409, 'slot_taken');
  } else if (isLateChange(c, row)) {
    await q(() => addStrikeStmt(c, row.phone, 'late', row.id).run());
  }
  c.wait(notifyBarber(c, w, 'move', { name: row.name, start, prevStart: row.start_at }));
  return json(c, await buildState(c, { a: token }, { moved: true }));
}

export async function forget(c: Ctx): Promise<Response> {
  clearCookie(c, 'a');
  clearCookie(c, 'd');
  return json(c, await buildState(c, { a: '', d: '' }));
}

export async function ics(c: Ctx): Promise<Response> {
  const token = c.url.searchParams.get('t');
  const id = idOf(token);
  if (!id) throw new ApiError(404, 'not_found');
  const { world: w, extra } = await loadWorld(c, [
    c.db.prepare(`SELECT * FROM appointments WHERE id = ?`).bind(id),
    c.db
      .prepare(
        `SELECT COUNT(*) AS n FROM strikes
         WHERE kind = 'late' AND at > ? AND phone != '' AND phone = (SELECT phone FROM appointments WHERE id = ?)`,
      )
      .bind(c.now - STRIKE_WINDOW, id),
  ]);
  const row = extra[0]!.results[0] as unknown as ApptRow | undefined;
  if (!row || row.status !== 'booked' || (await verifyToken(w.key, 'a', token)) !== id) throw new ApiError(404, 'not_found');
  const early = ((extra[1]!.results[0] as { n: number } | undefined)?.n ?? 0) >= LATE_LIMIT;
  return new Response(buildIcs(calEvent(c, w, row, token!, early)), {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="appointment.ics"',
      'cache-control': 'no-store',
    },
  });
}
