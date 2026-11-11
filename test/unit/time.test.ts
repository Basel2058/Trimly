import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, daysBetween, hhmm, isDate, localParts, localToEpoch, offsetSec, timeOf } from '../../src/time';

const utc = (s: string): number => Date.parse(s) / 1000;

describe('time zone conversion (Asia/Jerusalem)', () => {
  it('uses +2 in winter and +3 in summer', () => {
    expect(offsetSec(utc('2026-01-15T12:00:00Z'))).toBe(7200);
    expect(offsetSec(utc('2026-07-15T12:00:00Z'))).toBe(10800);
  });

  it('converts wall time to the right instant in both seasons', () => {
    expect(localToEpoch('2026-11-10', 16 * 60 + 30)).toBe(utc('2026-11-10T14:30:00Z'));
    expect(localToEpoch('2026-07-10', 9 * 60)).toBe(utc('2026-07-10T06:00:00Z'));
  });

  it('round-trips every half hour across a whole year, including both DST changes', () => {
    let bad = 0;
    for (let t = utc('2026-01-01T00:00:00Z'); t < utc('2027-01-01T00:00:00Z'); t += 1800) {
      const p = localParts(t);
      const back = localToEpoch(p.date, p.mins);
      // the repeated hour when clocks go back maps to one of its two instants
      if (back !== t && Math.abs(back - t) !== 3600) bad++;
      if (localParts(back).mins !== p.mins || localParts(back).date !== p.date) bad++;
    }
    expect(bad).toBe(0);
  });

  it('handles the spring-forward gap (27 Mar 2026, 02:00 → 03:00)', () => {
    expect(timeOf(localToEpoch('2026-03-27', 1 * 60 + 30))).toBe('01:30');
    expect(timeOf(localToEpoch('2026-03-27', 3 * 60 + 30))).toBe('03:30');
    // 02:30 does not exist that night: it moves forward instead of crashing
    expect(timeOf(localToEpoch('2026-03-27', 2 * 60 + 30))).toBe('03:30');
    // a 09:00–20:00 working day is still exactly 11 hours long
    expect(localToEpoch('2026-03-27', 20 * 60) - localToEpoch('2026-03-27', 9 * 60)).toBe(11 * 3600);
  });

  it('handles the autumn change (25 Oct 2026)', () => {
    expect(localToEpoch('2026-10-25', 20 * 60) - localToEpoch('2026-10-25', 9 * 60)).toBe(11 * 3600);
    expect(timeOf(localToEpoch('2026-10-25', 9 * 60))).toBe('09:00');
    expect(localToEpoch('2026-10-26', 0) - localToEpoch('2026-10-25', 0)).toBe(25 * 3600);
  });

  it('supports minutes past midnight for late-night hours', () => {
    const t = localToEpoch('2026-11-10', 25 * 60);
    expect(localParts(t).date).toBe('2026-11-11');
    expect(timeOf(t)).toBe('01:00');
  });
});

describe('calendar helpers', () => {
  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-11-10', '2026-11-24')).toBe(14);
  });
  it('knows weekdays', () => {
    expect(dayOfWeek('2026-11-10')).toBe(2); // Tuesday
    expect(dayOfWeek('2026-11-15')).toBe(0); // Sunday
  });
  it('validates dates', () => {
    expect(isDate('2026-11-10')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-13-01')).toBe(false);
    expect(isDate('10/11/2026')).toBe(false);
    expect(isDate(null)).toBe(false);
  });
  it('formats minutes', () => {
    expect(hhmm(0)).toBe('00:00');
    expect(hhmm(16 * 60 + 5)).toBe('16:05');
    expect(hhmm(25 * 60)).toBe('01:00');
  });
});
