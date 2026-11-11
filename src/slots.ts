// Pure scheduling logic: settings, working windows, free slots. No I/O — fully unit tested.
import { addDays, dayOfWeek, daysBetween, localParts, localToEpoch } from './time';
import type { Lang } from './core';

export type Interval = [number, number]; // [start, end) epoch seconds
export type MinWindow = [number, number]; // [open, close) minutes from local midnight; close may pass 1440

export interface Settings {
  shopName: string;
  address: string;
  /** Barber's WhatsApp number, E.164, or '' */
  phone: string;
  lang: Lang;
  /** index 0 = Sunday … 6 = Saturday; up to two windows a day (a break in between) */
  hours: MinWindow[][];
  slotMin: number;
  graceMin: number;
  horizonDays: number;
}

export interface Override {
  date: string;
  closed: boolean;
  open: number;
  close: number;
}

export const MAX_CLOSE = 1440 + 360; // a working day may run until 06:00 the next morning
export const SLOT_CHOICES = [10, 15, 20, 25, 30, 40, 45, 60, 90];
export const GRACE_CHOICES = [0, 5, 10, 15, 20];
export const HORIZON_CHOICES = [7, 14, 21, 30];

const DAY: MinWindow[] = [[9 * 60, 20 * 60]];
export const DEFAULT_SETTINGS: Settings = {
  shopName: '',
  address: '',
  phone: '',
  lang: 'ar',
  hours: [DAY, DAY, DAY, DAY, DAY, DAY, DAY].map((d) => d.map((w) => [w[0], w[1]] as MinWindow)),
  slotMin: 30,
  graceMin: 10,
  horizonDays: 14,
};

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function validWindows(v: unknown): MinWindow[] | null {
  if (!Array.isArray(v) || v.length > 2) return null;
  const out: MinWindow[] = [];
  let prevEnd = -1;
  for (const w of v) {
    if (!Array.isArray(w) || w.length !== 2) return null;
    const [a, b] = w as unknown[];
    if (!isInt(a) || !isInt(b)) return null;
    if (a < 0 || a >= 1440 || b <= a || b > MAX_CLOSE || a % 5 !== 0 || b % 5 !== 0) return null;
    if (a <= prevEnd) return null;
    prevEnd = b;
    out.push([a, b]);
  }
  return out;
}

const cleanText = (v: unknown, max: number): string | null =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : null;

/**
 * Merge an untrusted object over `base`. Strict mode rejects any invalid field (used for writes);
 * tolerant mode silently keeps the base value (used for reads, so a damaged row can never crash the app).
 */
export function mergeSettings(base: Settings, raw: unknown, strict: boolean): Settings | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Settings = { ...base, hours: base.hours.map((d) => d.map((w) => [w[0], w[1]] as MinWindow)) };
  let bad = false;
  const fail = (): void => void (bad = true);

  if ('shopName' in r) {
    const v = cleanText(r.shopName, 40);
    if (v === null) fail();
    else out.shopName = v;
  }
  if ('address' in r) {
    const v = cleanText(r.address, 120);
    if (v === null) fail();
    else out.address = v;
  }
  if ('phone' in r) {
    if (typeof r.phone === 'string' && (r.phone === '' || /^\+[1-9]\d{7,14}$/.test(r.phone))) out.phone = r.phone;
    else fail();
  }
  if ('lang' in r) {
    if (r.lang === 'ar' || r.lang === 'he' || r.lang === 'en') out.lang = r.lang;
    else fail();
  }
  if ('hours' in r) {
    const h = r.hours;
    const days = Array.isArray(h) && h.length === 7 ? h.map(validWindows) : null;
    if (days && days.every((d) => d !== null)) out.hours = days as MinWindow[][];
    else fail();
  }
  if ('slotMin' in r) {
    if (isInt(r.slotMin) && SLOT_CHOICES.includes(r.slotMin)) out.slotMin = r.slotMin;
    else fail();
  }
  if ('graceMin' in r) {
    if (isInt(r.graceMin) && GRACE_CHOICES.includes(r.graceMin)) out.graceMin = r.graceMin;
    else fail();
  }
  if ('horizonDays' in r) {
    if (isInt(r.horizonDays) && HORIZON_CHOICES.includes(r.horizonDays)) out.horizonDays = r.horizonDays;
    else fail();
  }
  return strict && bad ? null : out;
}

export function parseSettings(json: string | null | undefined): Settings {
  if (!json) return mergeSettings(DEFAULT_SETTINGS, {}, false)!;
  try {
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(json), false)!;
  } catch {
    return mergeSettings(DEFAULT_SETTINGS, {}, false)!;
  }
}

export function validOverride(date: string, raw: unknown): Override | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (r.closed === true) return { date, closed: true, open: 0, close: 0 };
  const { open, close } = r;
  if (!isInt(open) || !isInt(close)) return null;
  if (open < 0 || open >= 1440 || close <= open || close > MAX_CLOSE || open % 5 !== 0 || close % 5 !== 0) return null;
  return { date, closed: false, open, close };
}

/** Working windows of a business day, in minutes. An override replaces open/close but keeps the weekly break. */
export function dayWindowsMin(s: Settings, ov: Override | undefined, date: string): MinWindow[] {
  const base = s.hours[dayOfWeek(date)] ?? [];
  if (!ov) return base;
  if (ov.closed) return [];
  const out: MinWindow[] = [];
  let cur = ov.open;
  for (let i = 0; i + 1 < base.length; i++) {
    const gapStart = base[i]![1];
    const gapEnd = base[i + 1]![0];
    if (gapEnd <= cur || gapStart >= ov.close) continue;
    if (gapStart > cur) out.push([cur, Math.min(gapStart, ov.close)]);
    cur = Math.max(cur, gapEnd);
  }
  if (cur < ov.close) out.push([cur, ov.close]);
  return out;
}

/** All working windows (epoch seconds, merged, sorted) for business days `from` … `from + days - 1`. */
export function workWindows(s: Settings, overrides: Map<string, Override>, from: string, days: number): Interval[] {
  const all: Interval[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    for (const [a, b] of dayWindowsMin(s, overrides.get(date), date)) {
      const start = localToEpoch(date, a);
      const end = localToEpoch(date, b);
      if (end > start) all.push([start, end]);
    }
  }
  return mergeIntervals(all);
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Cut the free time of each window into slots. A slot needs `needSec` of free time
 * (the visit plus an optional invisible buffer); slots advance by `slotSec` from the start of each gap.
 */
export function chop(windows: Interval[], busy: Interval[], slotSec: number, needSec: number, notBefore: number): number[] {
  const taken = mergeIntervals(busy);
  const out: number[] = [];
  if (slotSec <= 0 || needSec <= 0) return out;
  for (const [ws, we] of windows) {
    let cur = ws;
    const emit = (until: number): void => {
      for (let s = cur; s + needSec <= until; s += slotSec) if (s >= notBefore) out.push(s);
    };
    for (const [bs, be] of taken) {
      if (be <= cur) continue;
      if (bs >= we) break;
      emit(Math.min(bs, we));
      cur = Math.max(cur, be);
    }
    emit(we);
  }
  return out;
}

export interface DaySlots {
  date: string;
  slots: number[];
}

export interface AvailabilityInput {
  settings: Settings;
  overrides: Map<string, Override>;
  busy: Interval[];
  now: number;
  /** extra free minutes required after the visit (invisible buffer for habitual latecomers) */
  bufferMin?: number;
  /** occupied length of the visit, minutes; defaults to the slot length */
  needMin?: number;
}

/** Free slots for the booking horizon, grouped by the calendar date they actually fall on. */
export function availability(inp: AvailabilityInput): DaySlots[] {
  const { settings: s, now } = inp;
  const today = localParts(now).date;
  // start one day back: yesterday's hours may run past midnight into today
  const windows = workWindows(s, inp.overrides, addDays(today, -1), s.horizonDays + 1);
  const need = (inp.needMin ?? s.slotMin) + (inp.bufferMin ?? 0);
  const starts = chop(windows, inp.busy, s.slotMin * 60, need * 60, now + 1);
  const byDate = new Map<string, number[]>();
  for (const t of starts) {
    const d = localParts(t).date;
    const list = byDate.get(d);
    if (list) list.push(t);
    else byDate.set(d, [t]);
  }
  const out: DaySlots[] = [];
  for (let i = 0; i < s.horizonDays; i++) {
    const date = addDays(today, i);
    out.push({ date, slots: byDate.get(date) ?? [] });
  }
  return out;
}

export function isOffered(days: DaySlots[], start: number): boolean {
  return days.some((d) => d.slots.includes(start));
}

/** Is [start, end) completely inside working time? */
export function insideWindows(windows: Interval[], start: number, end: number): boolean {
  return windows.some(([a, b]) => start >= a && end <= b);
}

/**
 * Best replacement for a visit that was at `target`: same day and closest time first,
 * otherwise the nearest day at the closest time of day; later wins a tie.
 */
export function nearestSlot(days: DaySlots[], target: number): number | null {
  const t = localParts(target);
  let best: number | null = null;
  let bestCost = Infinity;
  for (const d of days) {
    const dayDiff = Math.abs(daysBetween(t.date, d.date));
    for (const s of d.slots) {
      const cost =
        dayDiff === 0 ? Math.abs(s - target) / 60 : 100000 + dayDiff * 10000 + Math.abs(localParts(s).mins - t.mins);
      if (cost < bestCost || (cost === bestCost && best !== null && s > best)) {
        best = s;
        bestCost = cost;
      }
    }
  }
  return best;
}
