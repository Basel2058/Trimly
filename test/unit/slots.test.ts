import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  availability,
  chop,
  dayWindowsMin,
  insideWindows,
  isOffered,
  mergeIntervals,
  mergeSettings,
  nearestSlot,
  parseSettings,
  validOverride,
  workWindows,
  type Interval,
  type Override,
  type Settings,
} from '../../src/slots';
import { localParts, localToEpoch, timeOf } from '../../src/time';

const at = (date: string, time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return localToEpoch(date, h! * 60 + m!);
};
const S = (patch: Partial<Settings> = {}): Settings => ({ ...mergeSettings(DEFAULT_SETTINGS, {}, false)!, ...patch });
const none = new Map<string, Override>();
const times = (list: number[]): string[] => list.map(timeOf);
const TUE = '2026-11-10';

describe('chop', () => {
  const w: Interval[] = [[0, 7200]];
  it('cuts an empty window into equal slots', () => {
    expect(chop(w, [], 1800, 1800, 0)).toEqual([0, 1800, 3600, 5400]);
  });
  it('drops a remainder that is too short', () => {
    expect(chop([[0, 7000]], [], 1800, 1800, 0)).toEqual([0, 1800, 3600]);
  });
  it('skips busy time and continues right after it', () => {
    expect(chop(w, [[1800, 3600]], 1800, 1800, 0)).toEqual([0, 3600, 5400]);
    // an appointment with a hidden 10-minute buffer pushes the following slots
    expect(chop(w, [[0, 2400]], 1800, 1800, 0)).toEqual([2400, 4200]);
  });
  it('requires extra free time when a buffer is needed', () => {
    // 30-minute visit + 10-minute buffer does not fit right before a booked visit or the end of the day
    expect(chop(w, [[3600, 5400]], 1800, 2400, 0)).toEqual([0]);
  });
  it('never offers the past', () => {
    expect(chop(w, [], 1800, 1800, 1801)).toEqual([3600, 5400]);
  });
  it('copes with overlapping or unsorted busy intervals', () => {
    expect(chop(w, [[3000, 4000], [1000, 3500]], 1800, 1800, 0)).toEqual([4000]);
    expect(mergeIntervals([[5, 9], [1, 3], [2, 6]])).toEqual([[1, 9]]);
  });
});

describe('working hours', () => {
  const split = S({ hours: Array.from({ length: 7 }, () => [[540, 780], [960, 1260]] as [number, number][]) });
  it('uses the weekly schedule by default', () => {
    expect(dayWindowsMin(S(), undefined, TUE)).toEqual([[540, 1200]]);
  });
  it('closes a day off', () => {
    expect(dayWindowsMin(S(), { date: TUE, closed: true, open: 0, close: 0 }, TUE)).toEqual([]);
  });
  it('start late / finish early / stay longer keep the usual break', () => {
    const ov = (open: number, close: number): Override => ({ date: TUE, closed: false, open, close });
    expect(dayWindowsMin(split, ov(600, 1260), TUE)).toEqual([[600, 780], [960, 1260]]);
    expect(dayWindowsMin(split, ov(540, 1080), TUE)).toEqual([[540, 780], [960, 1080]]);
    expect(dayWindowsMin(split, ov(480, 1380), TUE)).toEqual([[480, 780], [960, 1380]]);
    expect(dayWindowsMin(split, ov(840, 1260), TUE)).toEqual([[960, 1260]]);
    expect(dayWindowsMin(split, ov(540, 720), TUE)).toEqual([[540, 720]]);
  });
  it('validates overrides', () => {
    expect(validOverride(TUE, { closed: true })).toEqual({ date: TUE, closed: true, open: 0, close: 0 });
    expect(validOverride(TUE, { open: 600, close: 1080 })).toEqual({ date: TUE, closed: false, open: 600, close: 1080 });
    expect(validOverride(TUE, { open: 1080, close: 600 })).toBeNull();
    expect(validOverride(TUE, { open: 601, close: 1080 })).toBeNull();
    expect(validOverride(TUE, { open: 600, close: 3000 })).toBeNull();
    expect(validOverride(TUE, { open: '600', close: 1080 })).toBeNull();
  });
  it('merges late-night hours that run into the next morning', () => {
    const late = S({ hours: Array.from({ length: 7 }, () => [[600, 1560]] as [number, number][]) }); // 10:00 → 02:00
    const w = workWindows(late, none, TUE, 2);
    expect(w.length).toBe(2);
    expect(timeOf(w[0]![1])).toBe('02:00');
    expect(insideWindows(w, at('2026-11-11', '01:00'), at('2026-11-11', '01:30'))).toBe(true);
    expect(insideWindows(w, at('2026-11-11', '01:45'), at('2026-11-11', '02:15'))).toBe(false);
  });
});

describe('availability', () => {
  it('offers the rest of today and the following days, never the past', () => {
    const days = availability({ settings: S(), overrides: none, busy: [], now: at(TUE, '16:40') });
    expect(days.length).toBe(14);
    expect(days[0]!.date).toBe(TUE);
    expect(times(days[0]!.slots)).toEqual(['17:00', '17:30', '18:00', '18:30', '19:00', '19:30']);
    expect(days[1]!.slots.length).toBe(22);
  });
  it('a slot that has just started is no longer offered', () => {
    const days = availability({ settings: S(), overrides: none, busy: [], now: at(TUE, '17:00') });
    expect(times(days[0]!.slots)[0]).toBe('17:30');
  });
  it('removes booked times', () => {
    const busy: Interval[] = [[at(TUE, '17:00'), at(TUE, '17:30')]];
    const days = availability({ settings: S(), overrides: none, busy, now: at(TUE, '16:40') });
    expect(times(days[0]!.slots)).toEqual(['17:30', '18:00', '18:30', '19:00', '19:30']);
  });
  it('gives a habitual latecomer only times with room behind them', () => {
    const busy: Interval[] = [[at(TUE, '18:00'), at(TUE, '18:30')]];
    const days = availability({ settings: S(), overrides: none, busy, now: at(TUE, '16:40'), bufferMin: 10 });
    // 17:30 (touches the 18:00 visit) and 19:30 (touches closing time) are quietly left out
    expect(times(days[0]!.slots)).toEqual(['17:00', '18:30', '19:00']);
  });
  it('respects days off and changed hours', () => {
    const ov = new Map<string, Override>([
      [TUE, { date: TUE, closed: false, open: 540, close: 1080 }],
      ['2026-11-11', { date: '2026-11-11', closed: true, open: 0, close: 0 }],
    ]);
    const days = availability({ settings: S(), overrides: ov, busy: [], now: at(TUE, '16:40') });
    expect(times(days[0]!.slots)).toEqual(['17:00', '17:30']);
    expect(days[1]!.slots).toEqual([]);
  });
  it('keeps a full day of slots on both daylight-saving days', () => {
    for (const d of ['2026-03-27', '2026-10-25']) {
      const days = availability({ settings: S(), overrides: none, busy: [], now: at(d, '00:10') });
      expect(days[0]!.date).toBe(d);
      expect(times(days[0]!.slots)[0]).toBe('09:00');
      expect(times(days[0]!.slots).at(-1)).toBe('19:30');
      expect(days[0]!.slots.length).toBe(22);
    }
  });
  it('files after-midnight slots under the date they really fall on', () => {
    const late = S({ hours: Array.from({ length: 7 }, () => [[600, 1500]] as [number, number][]) }); // 10:00 → 01:00
    const days = availability({ settings: late, overrides: none, busy: [], now: at(TUE, '23:50') });
    expect(days[0]!.slots).toEqual([]);
    expect(times(days[1]!.slots).slice(0, 3)).toEqual(['00:00', '00:30', '10:00']);
  });

  it('simulation: thousands of random bookings never overlap and never leave working hours', () => {
    let seed = 42;
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (const slotMin of [15, 20, 30, 45]) {
      const s = S({ slotMin, hours: Array.from({ length: 7 }, (_, i) => (i === 6 ? [] : [[540, 780], [960, 1260]])) as Settings['hours'] });
      const now = at(TUE, '08:00');
      const windows = workWindows(s, none, '2026-11-09', 20);
      const busy: Interval[] = [];
      for (let n = 0; n < 600; n++) {
        const bufferMin = rnd() < 0.25 ? 10 : 0;
        const days = availability({ settings: s, overrides: none, busy, now, bufferMin });
        const all = days.flatMap((d) => d.slots);
        if (!all.length) break;
        const start = all[Math.floor(rnd() * all.length)]!;
        const end = start + (slotMin + bufferMin) * 60;
        expect(busy.some(([a, b]) => start < b && end > a)).toBe(false);
        expect(insideWindows(windows, start, end)).toBe(true);
        expect(start).toBeGreaterThan(now);
        expect(localParts(start).date >= TUE).toBe(true);
        busy.push([start, end]);
      }
      expect(busy.length).toBeGreaterThan(100);
    }
  });
});

describe('nearestSlot', () => {
  const day = (date: string, ...t: string[]) => ({ date, slots: t.map((x) => at(date, x)) });
  it('prefers the same day, closest time, later on a tie', () => {
    const days = [day(TUE, '15:00', '17:00', '18:30'), day('2026-11-11', '18:00')];
    expect(timeOf(nearestSlot(days, at(TUE, '18:00'))!)).toBe('18:30');
    expect(timeOf(nearestSlot(days, at(TUE, '16:00'))!)).toBe('17:00');
  });
  it('falls back to the nearest day at the closest time of day', () => {
    const days = [day(TUE), day('2026-11-11', '09:00', '18:30'), day('2026-11-12', '18:00')];
    const t = nearestSlot(days, at(TUE, '18:00'))!;
    expect(localParts(t).date).toBe('2026-11-11');
    expect(timeOf(t)).toBe('18:30');
    expect(nearestSlot([day(TUE)], at(TUE, '18:00'))).toBeNull();
  });
  it('keeps the time of day rather than grabbing a far-off hour on a nearer day', () => {
    const days = [day(TUE, '09:00'), day('2026-11-11', '09:30'), day('2026-11-12', '18:00')];
    const t = nearestSlot(days, at(TUE, '18:00'))!;
    expect([localParts(t).date, timeOf(t)]).toEqual(['2026-11-12', '18:00']);
  });
  it('never moves a visit to an earlier day', () => {
    const days = [day(TUE, '14:00'), day('2026-11-11'), day('2026-11-12', '09:00')];
    const t = nearestSlot(days, at('2026-11-11', '14:00'))!;
    expect(localParts(t).date).toBe('2026-11-12');
    expect(nearestSlot([day(TUE, '14:00')], at('2026-11-11', '14:00'))).toBeNull();
  });
  it('gives the customer notice when it can', () => {
    const days = [day(TUE, '17:00', '17:30'), day('2026-11-11', '18:00')];
    const soon = at(TUE, '17:20');
    expect(timeOf(nearestSlot(days, at(TUE, '18:00'), soon)!)).toBe('17:30');
    expect(timeOf(nearestSlot(days, at(TUE, '18:00'), at(TUE, '19:00'))!)).toBe('18:00');
    // nothing else at all: better a short-notice time than none
    expect(timeOf(nearestSlot([day(TUE, '17:00')], at(TUE, '18:00'), at(TUE, '19:00'))!)).toBe('17:00');
  });
  it('isOffered checks exact starts', () => {
    const days = [day(TUE, '15:00')];
    expect(isOffered(days, at(TUE, '15:00'))).toBe(true);
    expect(isOffered(days, at(TUE, '15:00') + 60)).toBe(false);
  });
});

describe('settings', () => {
  it('rejects invalid input on write', () => {
    const base = S();
    expect(mergeSettings(base, { slotMin: 7 }, true)).toBeNull();
    expect(mergeSettings(base, { hours: [[[540, 1200]]] }, true)).toBeNull();
    expect(mergeSettings(base, { hours: Array(7).fill([[600, 540]]) }, true)).toBeNull();
    expect(mergeSettings(base, { hours: Array(7).fill([[540, 800], [700, 900]]) }, true)).toBeNull();
    expect(mergeSettings(base, { phone: '0501234567' }, true)).toBeNull();
    expect(mergeSettings(base, { lang: 'fr' }, true)).toBeNull();
    expect(mergeSettings(base, { shopName: 5 }, true)).toBeNull();
  });
  it('accepts a valid patch and leaves the rest untouched', () => {
    const next = mergeSettings(S(), { slotMin: 20, shopName: '  صالون   أحمد ', phone: '+972501234567' }, true)!;
    expect(next.slotMin).toBe(20);
    expect(next.shopName).toBe('صالون أحمد');
    expect(next.graceMin).toBe(10);
    expect(next.hours.length).toBe(7);
  });
  it('a damaged stored value falls back to safe defaults instead of crashing', () => {
    expect(parseSettings('{not json').slotMin).toBe(30);
    expect(parseSettings(null).hours.length).toBe(7);
    const s = parseSettings(JSON.stringify({ slotMin: -1, hours: 'x', shopName: 'Sami' }));
    expect(s.slotMin).toBe(30);
    expect(s.hours.length).toBe(7);
    expect(s.shopName).toBe('Sami');
  });
});
