// Shared data loading and the guarded SQL that keeps the calendar consistent.
import { b64url, fromUtf8, hmacKey, signToken, unb64url, utf8, verifyToken } from './core';
import { q, rowsToMeta } from './db';
import type { ApptRow, Ctx } from './http';
import { parseSettings, type Interval, type Override, type Settings } from './slots';
import { addDays, localParts } from './time';

export const STRIKE_WINDOW = 180 * 86400; // strikes expire by themselves after six months
export const NO_SHOW_LIMIT = 2; // online booking pauses after two no-shows
export const LATE_LIMIT = 2; // habitual latecomers get an invisible buffer and earlier reminders
export const LATE_CHANGE_SEC = 3600; // changing/cancelling inside the last hour counts as "late"
export const FRESH_SEC = 600; // …unless the booking was only just made

export interface Delay {
  min: number;
  date: string;
  setAt: number;
}

export interface World {
  settings: Settings;
  key: CryptoKey;
  delay: Delay | null;
  /** true once the barber has claimed the shop */
  owner: boolean;
  meta: Record<string, string>;
  overrides: Map<string, Override>;
  /** occupied intervals of booked visits that end after now, sorted */
  busy: Interval[];
}

type Res = D1Result<Record<string, unknown>>;

/** One round trip: settings, overrides, occupancy, plus any extra statements the caller needs. */
export async function loadWorld(c: Ctx, extra: D1PreparedStatement[] = []): Promise<{ world: World; extra: Res[] }> {
  const today = localParts(c.now).date;
  const res = (await q(() =>
    c.db.batch([
      c.db.prepare(`SELECT k, v FROM meta WHERE k IN ('settings','secret','delay','owner','vapid')`),
      c.db.prepare(`SELECT date, closed, open_min, close_min FROM overrides WHERE date >= ?`).bind(addDays(today, -1)),
      c.db
        .prepare(`SELECT start_at, end_at FROM appointments WHERE status = 'booked' AND end_at > ? ORDER BY start_at`)
        .bind(c.now),
      ...extra,
    ]),
  )) as Res[];
  const meta = rowsToMeta(res[0]!.results as Array<{ k: string; v: string }>);
  if (!meta.secret) throw new Error('database not initialised');
  const overrides = new Map<string, Override>();
  for (const r of res[1]!.results as Array<{ date: string; closed: number; open_min: number; close_min: number }>) {
    overrides.set(r.date, { date: r.date, closed: !!r.closed, open: r.open_min, close: r.close_min });
  }
  let delay: Delay | null = null;
  try {
    const d = meta.delay ? (JSON.parse(meta.delay) as Delay) : null;
    if (d && d.min > 0 && d.date === today) delay = d;
  } catch {
    delay = null;
  }
  return {
    world: {
      settings: parseSettings(meta.settings),
      key: await hmacKey(meta.secret),
      delay,
      owner: !!meta.owner,
      meta,
      overrides,
      busy: (res[2]!.results as Array<{ start_at: number; end_at: number }>).map((r) => [r.start_at, r.end_at]),
    },
    extra: res.slice(3),
  };
}

// ---- strikes ----

export const strikesStmt = (c: Ctx, phone: string): D1PreparedStatement =>
  c.db
    .prepare(`SELECT kind, COUNT(*) AS n FROM strikes WHERE phone = ? AND at > ? GROUP BY kind`)
    .bind(phone, c.now - STRIKE_WINDOW);

export function strikeCounts(res: Res | undefined): { noShow: number; late: number } {
  const out = { noShow: 0, late: 0 };
  for (const r of (res?.results ?? []) as Array<{ kind: string; n: number }>) {
    if (r.kind === 'no_show') out.noShow = r.n;
    if (r.kind === 'late') out.late = r.n;
  }
  return out;
}

export const addStrikeStmt = (c: Ctx, phone: string, kind: 'no_show' | 'late', apptId: string): D1PreparedStatement =>
  c.db
    .prepare(`INSERT OR IGNORE INTO strikes (phone, kind, appt_id, at) VALUES (?, ?, ?, ?)`)
    .bind(phone, kind, apptId, c.now);

// ---- guarded writes: a slot can never be double-booked, whatever the timing ----

export interface NewAppt {
  id: string;
  kind: ApptRow['kind'];
  phone: string;
  name: string;
  lang: string;
  start: number;
  end: number;
  durMin: number;
}

/** Inserts only if the time is still free (and, for customers, the phone has no other upcoming visit). */
export function insertApptStmt(c: Ctx, a: NewAppt, onePerPhone: boolean): D1PreparedStatement {
  return c.db
    .prepare(
      `INSERT INTO appointments (id, kind, phone, name, lang, start_at, end_at, dur_min, status, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'booked', ?9, ?9
       WHERE NOT EXISTS (SELECT 1 FROM appointments WHERE status = 'booked' AND start_at < ?7 AND end_at > ?6)
         AND (?10 = 0 OR NOT EXISTS (
           SELECT 1 FROM appointments WHERE phone = ?3 AND status = 'booked' AND start_at + dur_min * 60 > ?9))`,
    )
    .bind(a.id, a.kind, a.phone, a.name, a.lang, a.start, a.end, a.durMin, c.now, onePerPhone ? 1 : 0);
}

/** Moves a booked visit only if it is still where we think it is and the new time is free. */
export function moveApptStmt(
  c: Ctx,
  a: ApptRow,
  start: number,
  end: number,
  durMin: number,
  by: 'customer' | 'barber',
): D1PreparedStatement {
  return c.db
    .prepare(
      `UPDATE appointments
       SET start_at = ?2, end_at = ?3, prev_start = ?4, seq = seq + 1, moved_by = ?5, updated_at = ?6, dur_min = ?7
       WHERE id = ?1 AND status = 'booked' AND start_at = ?4
         AND NOT EXISTS (
           SELECT 1 FROM appointments o
           WHERE o.id != ?1 AND o.status = 'booked' AND o.start_at < ?3 AND o.end_at > ?2)`,
    )
    .bind(a.id, start, end, a.start_at, by, c.now, durMin);
}

export const apptById = (c: Ctx, id: string): Promise<ApptRow | null> =>
  q(() => c.db.prepare(`SELECT * FROM appointments WHERE id = ?`).bind(id).first<ApptRow>());

export const isActive = (a: ApptRow | null | undefined, now: number): a is ApptRow =>
  !!a && a.status === 'booked' && a.start_at + a.dur_min * 60 > now;

// ---- capability tokens ----

export const apptToken = (w: World, id: string): Promise<string> => signToken(w.key, 'a', id);
export const apptLink = (c: Ctx, token: string): string => `${c.url.origin}/a/${token}`;

export interface Identity {
  p: string;
  n: string;
}

export function identityToken(w: World, id: Identity): Promise<string> {
  return signToken(w.key, 'd', b64url(utf8(JSON.stringify({ p: id.p, n: id.n }))));
}

function decodeIdentity(payload: string): Identity | null {
  try {
    const v = JSON.parse(fromUtf8(unb64url(payload))) as Identity;
    return typeof v.p === 'string' && typeof v.n === 'string' ? { p: v.p, n: v.n } : null;
  } catch {
    return null;
  }
}

/** The identity a cookie *claims*, before its signature is checked (only used to choose what to load). */
export function claimedIdentity(token: string | null): Identity | null {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  return i > 0 ? decodeIdentity(token.slice(0, i)) : null;
}

export async function verifiedIdentity(w: World, token: string | null): Promise<Identity | null> {
  const payload = await verifyToken(w.key, 'd', token);
  return payload ? decodeIdentity(payload) : null;
}
