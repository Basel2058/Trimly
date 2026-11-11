// Time helpers. Everything is stored as UTC epoch seconds and shown in the shop's time zone.
export const TZ = 'Asia/Jerusalem';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  /** YYYY-MM-DD in the shop's time zone */
  date: string;
  /** minutes since local midnight */
  mins: number;
}

const pad = (n: number): string => (n < 10 ? '0' + n : '' + n);

export function dateKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function wallParts(epochSec: number): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const o: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(epochSec * 1000))) {
    if (p.type !== 'literal') o[p.type] = Number(p.value);
  }
  return { y: o.year!, m: o.month!, d: o.day!, h: o.hour! % 24, min: o.minute!, s: o.second! };
}

export function localParts(epochSec: number): LocalParts {
  const p = wallParts(epochSec);
  return { y: p.y, m: p.m, d: p.d, h: p.h, min: p.min, date: dateKey(p.y, p.m, p.d), mins: p.h * 60 + p.min };
}

/** Offset of the shop's zone from UTC (seconds) at the given instant. */
export function offsetSec(epochSec: number): number {
  const p = wallParts(epochSec);
  return Math.round(Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) / 1000) - Math.floor(epochSec);
}

export function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('bad date');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parseDate(s);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2020 && y <= 2100;
}

/**
 * Local wall time (date + minutes from midnight; minutes may exceed 1440 for "after midnight")
 * to UTC epoch seconds. Daylight-saving safe: a non-existent time maps forward.
 */
export function localToEpoch(date: string, mins: number): number {
  const [y, m, d] = parseDate(date);
  const wall = Date.UTC(y, m - 1, d, 0, mins) / 1000;
  const guess = wall - offsetSec(wall);
  return wall - offsetSec(guess);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dateKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Day of week, 0 = Sunday. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parseDate(a);
  const [by, bm, bd] = parseDate(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function hhmm(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "HH:MM" local time of an instant. */
export function timeOf(epochSec: number): string {
  return hhmm(localParts(epochSec).mins);
}
