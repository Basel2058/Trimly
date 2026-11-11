// Barber API: the day view and the handful of actions the barber ever needs.
import { ID_RE, displayPhone, normalizeName, normalizePhone, randomId } from './core';
import { barberWorld } from './auth';
import { q, setMetaStmt } from './db';
import { ApiError, body, json, type ApptRow, type Ctx } from './http';
import { getVapid, notifyBarber, validEndpoint } from './push';
import {
  availability,
  dayWindowsMin,
  insideWindows,
  isOffered,
  mergeSettings,
  nearestSlot,
  validOverride,
  workWindows,
  type Interval,
} from './slots';
import { addDays, daysBetween, isDate, localParts, localToEpoch, timeOf } from './time';
import {
  LATE_LIMIT,
  NO_SHOW_LIMIT,
  STRIKE_WINDOW,
  addStrikeStmt,
  apptById,
  apptLink,
  apptToken,
  insertApptStmt,
  moveApptStmt,
  type World,
} from './world';

type Json = Record<string, unknown>;

async function apptJson(c: Ctx, w: World, a: ApptRow, strikes: Map<string, { late: number; noShow: number }>): Promise<Json> {
  const st = strikes.get(a.phone);
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    phone: a.phone,
    phoneText: a.phone ? displayPhone(a.phone) : '',
    lang: a.lang,
    start: a.start_at,
    end: a.start_at + a.dur_min * 60,
    date: localParts(a.start_at).date,
    time: timeOf(a.start_at),
    endTime: timeOf(a.start_at + a.dur_min * 60),
    status: a.status,
    latecomer: (st?.late ?? 0) >= LATE_LIMIT,
    noShows: st?.noShow ?? 0,
    blocked: (st?.noShow ?? 0) >= NO_SHOW_LIMIT,
    link: a.kind === 'block' ? '' : apptLink(c, await apptToken(w, a.id)),
  };
}

async function dayView(c: Ctx, w: World, dateIn: unknown, flash: Json = {}): Promise<Json> {
  const today = localParts(c.now).date;
  const date = isDate(dateIn) ? dateIn : today;
  const from = localToEpoch(date, 0);
  const to = localToEpoch(addDays(date, 1), 0);
  const s = w.settings;
  const res = await q(() =>
    c.db.batch([
      c.db
        .prepare(`SELECT * FROM appointments WHERE status != 'cancelled' AND start_at >= ? AND start_at < ? ORDER BY start_at`)
        .bind(from, to),
      c.db
        .prepare(
          `SELECT phone, kind, COUNT(*) AS n FROM strikes
           WHERE at > ?1 AND phone IN (SELECT phone FROM appointments WHERE start_at >= ?2 AND start_at < ?3 AND phone != '')
           GROUP BY phone, kind`,
        )
        .bind(c.now - STRIKE_WINDOW, from, to),
      c.db.prepare(`SELECT start_at FROM appointments WHERE status = 'booked' AND kind != 'block' AND start_at >= ?`).bind(localToEpoch(today, 0)),
      c.db.prepare(`SELECT appt_id FROM strikes WHERE kind = 'late' AND appt_id IN (SELECT id FROM appointments WHERE start_at >= ? AND start_at < ?)`).bind(from, to),
      c.db.prepare(`SELECT COUNT(*) AS n FROM push_subs`),
    ]),
  );
  const rows = res[0]!.results as unknown as ApptRow[];
  const strikes = new Map<string, { late: number; noShow: number }>();
  for (const r of res[1]!.results as Array<{ phone: string; kind: string; n: number }>) {
    const e = strikes.get(r.phone) ?? { late: 0, noShow: 0 };
    if (r.kind === 'late') e.late = r.n;
    else e.noShow = r.n;
    strikes.set(r.phone, e);
  }
  const counts = new Map<string, number>();
  for (const r of res[2]!.results as Array<{ start_at: number }>) {
    const d = localParts(r.start_at).date;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const lateIds = new Set((res[3]!.results as Array<{ appt_id: string }>).map((r) => r.appt_id));
  const avail = availability({ settings: s, overrides: w.overrides, busy: w.busy, now: c.now });
  const ov = w.overrides.get(date);
  const appts = [];
  for (const a of rows) appts.push({ ...(await apptJson(c, w, a, strikes)), markedLate: lateIds.has(a.id) });
  const span = Math.max(s.horizonDays, daysBetween(today, date) + 1);
  return {
    now: c.now,
    today,
    date,
    shop: s,
    hours: { windows: dayWindowsMin(s, ov, date), normal: dayWindowsMin(s, undefined, date), override: ov ?? null },
    appts,
    free: (avail.find((d) => d.date === date)?.slots ?? []).map((t) => [t, timeOf(t)]),
    slots: avail.map((d) => ({ date: d.date, slots: d.slots.map((t) => [t, timeOf(t)]) })),
    days: Array.from({ length: span }, (_, i) => {
      const d = addDays(today, i);
      return { date: d, n: counts.get(d) ?? 0, closed: dayWindowsMin(s, w.overrides.get(d), d).length === 0 };
    }),
    delay: w.delay,
    push: (res[4]!.results[0] as { n: number }).n > 0,
    origin: c.url.origin,
    ...flash,
  };
}

/** After any change, answer with the fresh day so the screen is always the truth. */
async function fresh(c: Ctx, date: unknown, flash: Json = {}): Promise<Response> {
  const { world } = await barberWorld(c);
  return json(c, await dayView(c, world, date, flash));
}

export async function getDay(c: Ctx): Promise<Response> {
  const { world } = await barberWorld(c);
  return json(c, await dayView(c, world, c.url.searchParams.get('date')));
}

export async function add(c: Ctx): Promise<Response> {
  const b = await body(c);
  const { world: w } = await barberWorld(c);
  const start = b.start;
  if (typeof start !== 'number' || !Number.isInteger(start)) throw new ApiError(400, 'bad_request');
  const id = typeof b.id === 'string' && ID_RE.test(b.id) ? b.id : randomId();
  const phone = b.phone ? normalizePhone(b.phone) : '';
  if (phone === null) throw new ApiError(400, 'bad_phone');
  const name = b.name ? normalizeName(b.name) : '';
  if (name === null) throw new ApiError(400, 'bad_name');
  const s = w.settings;
  const days = availability({ settings: s, overrides: w.overrides, busy: w.busy, now: c.now });
  const existing = await apptById(c, id);
  if (!existing) {
    if (!isOffered(days, start)) throw new ApiError(409, 'slot_taken');
    const res = await q(() =>
      insertApptStmt(
        c,
        { id, kind: phone || name ? 'manual' : 'block', phone, name, lang: s.lang, start, end: start + s.slotMin * 60, durMin: s.slotMin },
        false,
      ).run(),
    );
    if (res.meta.changes !== 1 && !(await apptById(c, id))) throw new ApiError(409, 'slot_taken');
  }
  return fresh(c, localParts(start).date, { added: id });
}

async function target(c: Ctx, b: Json): Promise<{ w: World; a: ApptRow }> {
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) throw new ApiError(400, 'bad_request');
  const { world: w, extra } = await barberWorld(c, [c.db.prepare(`SELECT * FROM appointments WHERE id = ?`).bind(b.id)]);
  const a = extra[0]!.results[0] as unknown as ApptRow | undefined;
  if (!a) throw new ApiError(404, 'no_appt');
  return { w, a };
}

export async function cancelAppt(c: Ctx): Promise<Response> {
  const { a } = await target(c, await body(c));
  await q(() =>
    c.db
      .prepare(`UPDATE appointments SET status = 'cancelled', cancelled_by = 'barber', updated_at = ? WHERE id = ? AND status = 'booked'`)
      .bind(c.now, a.id)
      .run(),
  );
  return fresh(c, localParts(a.start_at).date);
}

export async function moveAppt(c: Ctx): Promise<Response> {
  const b = await body(c);
  const { w, a } = await target(c, b);
  const start = b.start;
  if (typeof start !== 'number' || !Number.isInteger(start)) throw new ApiError(400, 'bad_request');
  if (a.status !== 'booked') throw new ApiError(409, 'no_appt');
  const occupied = a.end_at - a.start_at;
  const days = availability({ settings: w.settings, overrides: w.overrides, busy: w.busy, now: c.now, needMin: occupied / 60 });
  if (!isOffered(days, start)) throw new ApiError(409, 'slot_taken');
  const stmts = [moveApptStmt(c, a, start, start + occupied, a.dur_min, 'barber')];
  // moving someone whose time has already begun means they came late
  if (a.phone && c.now > a.start_at) stmts.push(addStrikeStmt(c, a.phone, 'late', a.id));
  const res = await q(() => c.db.batch(stmts));
  if (res[0]!.meta.changes !== 1) {
    const cur = await apptById(c, a.id);
    if (!cur || cur.start_at !== start) throw new ApiError(409, 'slot_taken');
  }
  return fresh(c, localParts(start).date, { movedId: a.id });
}

/** The single routine action: mark a customer who never came (tap again to undo). */
export async function noShow(c: Ctx): Promise<Response> {
  const b = await body(c);
  const { a } = await target(c, b);
  const on = b.value !== false;
  if (on) {
    if (a.status === 'booked' && a.start_at > c.now) throw new ApiError(409, 'too_early');
    const stmts = [
      c.db.prepare(`UPDATE appointments SET status = 'no_show', updated_at = ? WHERE id = ? AND status = 'booked'`).bind(c.now, a.id),
    ];
    if (a.phone) stmts.push(addStrikeStmt(c, a.phone, 'no_show', a.id));
    await q(() => c.db.batch(stmts));
  } else {
    await q(() =>
      c.db.batch([
        c.db
          .prepare(
            `UPDATE appointments SET status = 'booked', updated_at = ?1 WHERE id = ?2 AND status = 'no_show'
             AND NOT EXISTS (SELECT 1 FROM appointments o WHERE o.id != ?2 AND o.status = 'booked' AND o.start_at < ?4 AND o.end_at > ?3)`,
          )
          .bind(c.now, a.id, a.start_at, a.end_at),
        c.db.prepare(`DELETE FROM strikes WHERE appt_id = ? AND kind = 'no_show'`).bind(a.id),
      ]),
    );
  }
  return fresh(c, localParts(a.start_at).date);
}

export async function markLate(c: Ctx): Promise<Response> {
  const b = await body(c);
  const { a } = await target(c, b);
  if (a.phone) {
    await q(() =>
      b.value === false
        ? c.db.prepare(`DELETE FROM strikes WHERE appt_id = ? AND kind = 'late'`).bind(a.id).run()
        : addStrikeStmt(c, a.phone, 'late', a.id).run(),
    );
  }
  return fresh(c, localParts(a.start_at).date);
}

export async function forgive(c: Ctx): Promise<Response> {
  const b = await body(c);
  await barberWorld(c);
  const phone = normalizePhone(b.phone);
  if (!phone) throw new ApiError(400, 'bad_phone');
  await q(() => c.db.prepare(`DELETE FROM strikes WHERE phone = ?`).bind(phone).run());
  return fresh(c, b.date);
}

/**
 * Finds upcoming visits that no longer fit the working hours and gives each the nearest free time.
 * Runs after the barber changes a day or the weekly hours; the barber gets a ready WhatsApp message per customer.
 */
async function rehome(c: Ctx, w: World): Promise<{ moved: Json[]; unplaced: Json[] }> {
  const s = w.settings;
  const today = localParts(c.now).date;
  const rows = (
    await q(() =>
      c.db.prepare(`SELECT * FROM appointments WHERE status = 'booked' AND start_at > ? ORDER BY start_at`).bind(c.now).all<ApptRow>(),
    )
  ).results;
  const last = rows[rows.length - 1];
  const span = Math.max(s.horizonDays, last ? daysBetween(today, localParts(last.start_at).date) + 1 : 0) + 2;
  const windows = workWindows(s, w.overrides, addDays(today, -1), span);
  const out = rows.filter((a) => !insideWindows(windows, a.start_at, a.start_at + a.dur_min * 60));
  if (!out.length) return { moved: [], unplaced: [] };

  const outIds = new Set(out.map((a) => a.id));
  const outStarts = new Set(out.map((a) => a.start_at));
  const busy: Interval[] = w.busy.filter(([st]) => !outStarts.has(st));
  for (const a of rows) if (!outIds.has(a.id) && !busy.some(([st]) => st === a.start_at)) busy.push([a.start_at, a.end_at]);

  const stmts: D1PreparedStatement[] = [];
  const plan: Array<{ a: ApptRow; to: number | null }> = [];
  for (const a of out.slice(0, 40)) {
    if (a.kind === 'block') {
      stmts.push(
        c.db.prepare(`UPDATE appointments SET status = 'cancelled', cancelled_by = 'barber', updated_at = ? WHERE id = ?`).bind(c.now, a.id),
      );
      continue;
    }
    const occupied = a.end_at - a.start_at;
    const days = availability({ settings: s, overrides: w.overrides, busy, now: c.now, needMin: occupied / 60 });
    const to = nearestSlot(days, a.start_at);
    plan.push({ a, to });
    if (to === null) continue;
    busy.push([to, to + occupied]);
    stmts.push(moveApptStmt(c, a, to, to + occupied, a.dur_min, 'barber'));
  }
  const res = stmts.length ? await q(() => c.db.batch(stmts)) : [];
  const moved: Json[] = [];
  const unplaced: Json[] = [];
  const none = new Map<string, { late: number; noShow: number }>();
  let i = 0;
  for (const a of out.slice(0, 40)) {
    if (a.kind === 'block') {
      i++;
      continue;
    }
    const p = plan.find((x) => x.a.id === a.id)!;
    const ok = p.to !== null && res[i++]?.meta.changes === 1;
    const view = await apptJson(c, w, ok ? { ...a, start_at: p.to! } : a, none);
    if (ok) moved.push({ ...view, fromDate: localParts(a.start_at).date, fromTime: timeOf(a.start_at) });
    else unplaced.push(view);
  }
  return { moved, unplaced };
}

/** "Start late", "finish early", "stay longer", "day off" — one small form, the software does the rest. */
export async function setHours(c: Ctx): Promise<Response> {
  const b = await body(c);
  const { world: w } = await barberWorld(c);
  const date = b.date;
  if (!isDate(date) || daysBetween(localParts(c.now).date, date) < -1) throw new ApiError(400, 'bad_date');
  if (b.reset === true) {
    await q(() => c.db.prepare(`DELETE FROM overrides WHERE date = ?`).bind(date).run());
    w.overrides.delete(date);
  } else {
    const ov = validOverride(date, b);
    if (!ov) throw new ApiError(400, 'bad_hours');
    await q(() =>
      c.db
        .prepare(
          `INSERT INTO overrides (date, closed, open_min, close_min, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (date) DO UPDATE SET closed = excluded.closed, open_min = excluded.open_min,
             close_min = excluded.close_min, updated_at = excluded.updated_at`,
        )
        .bind(date, ov.closed ? 1 : 0, ov.open, ov.close, c.now)
        .run(),
    );
    w.overrides.set(date, ov);
  }
  return fresh(c, date, await rehome(c, w));
}

export async function saveSettings(c: Ctx): Promise<Response> {
  const b = await body(c);
  const { world: w } = await barberWorld(c);
  const patch = { ...b };
  if (typeof patch.phone === 'string' && patch.phone !== '') {
    const p = normalizePhone(patch.phone);
    if (!p) throw new ApiError(400, 'bad_phone');
    patch.phone = p;
  }
  const next = mergeSettings(w.settings, patch, true);
  if (!next || !next.shopName) throw new ApiError(400, 'bad_settings');
  await q(() => setMetaStmt(c.db, 'settings', JSON.stringify(next)).run());
  w.settings = next;
  return fresh(c, b.date, await rehome(c, w));
}

/** "I'm running late": customers see it on their page; the barber gets one-tap WhatsApp messages. */
export async function setDelay(c: Ctx): Promise<Response> {
  const b = await body(c);
  await barberWorld(c);
  const min = b.min;
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 0 || min > 180) throw new ApiError(400, 'bad_request');
  const today = localParts(c.now).date;
  await q(() => setMetaStmt(c.db, 'delay', JSON.stringify({ min, date: today, setAt: c.now })).run());
  return fresh(c, today);
}

export async function pushKey(c: Ctx): Promise<Response> {
  const { world: w } = await barberWorld(c);
  return json(c, { key: (await getVapid(c, w.meta.vapid)).publicKey });
}

export async function pushSubscribe(c: Ctx): Promise<Response> {
  const b = await body(c);
  await barberWorld(c);
  const keys = (b.keys ?? {}) as Record<string, unknown>;
  if (!validEndpoint(c, b.endpoint) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    throw new ApiError(400, 'bad_request');
  }
  if (keys.p256dh.length > 200 || keys.auth.length > 100) throw new ApiError(400, 'bad_request');
  await q(() =>
    c.db.batch([
      c.db
        .prepare(`INSERT OR REPLACE INTO push_subs (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)`)
        .bind(b.endpoint, keys.p256dh, keys.auth, c.now),
      // keep only the ten newest devices
      c.db.prepare(
        `DELETE FROM push_subs WHERE endpoint NOT IN (SELECT endpoint FROM push_subs ORDER BY created_at DESC LIMIT 10)`,
      ),
    ]),
  );
  return json(c, { ok: true });
}

export async function pushUnsubscribe(c: Ctx): Promise<Response> {
  const b = await body(c);
  await barberWorld(c);
  await q(() => c.db.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).bind(String(b.endpoint ?? '')).run());
  return json(c, { ok: true });
}

export async function pushTest(c: Ctx): Promise<Response> {
  const { world: w } = await barberWorld(c);
  return json(c, { sent: await notifyBarber(c, w, 'test') });
}
