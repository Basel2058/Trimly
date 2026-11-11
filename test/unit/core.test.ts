import { describe, expect, it } from 'vitest';
import { b64url, displayPhone, hmacKey, isLocalHost, maskPhone, normalizeName, normalizePhone, randomBytes, randomId, signToken, unb64url, verifyToken, ID_RE } from '../../src/core';
import { buildIcs, fold, googleCalendarUrl, type CalEvent } from '../../src/ics';
import { localToEpoch } from '../../src/time';

describe('phone numbers', () => {
  it('accepts every common way of writing an Israeli mobile', () => {
    for (const p of ['0501234567', '050-1234567', '050 123 4567', '+972501234567', '972501234567', '00972501234567', '+972 50-123-4567', '+9720501234567', '٠٥٠١٢٣٤٥٦٧', '(050) 123.4567']) {
      expect(normalizePhone(p), p).toBe('+972501234567');
    }
  });
  it('accepts full international numbers', () => {
    expect(normalizePhone('+970599123456')).toBe('+970599123456');
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
  });
  it('rejects junk', () => {
    for (const p of ['', '050123456', '05012345678', '0401234567', 'abc', '123', '+972401234567', null, 5, '0501234567' + ' '.repeat(40), "0501234567'; DROP TABLE"]) {
      expect(normalizePhone(p as string), String(p)).toBeNull();
    }
  });
  it('formats for display and masks for privacy', () => {
    expect(displayPhone('+972501234567')).toBe('050-1234567');
    expect(displayPhone('+14155552671')).toBe('+14155552671');
    expect(maskPhone('+972501234567')).toBe('050•••••67');
  });
});

describe('https enforcement', () => {
  it('allows plain http only on a local machine or home network', () => {
    for (const h of ['localhost', '127.0.0.1', '192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.254']) expect(isLocalHost(h), h).toBe(true);
    for (const h of ['trimly.example.workers.dev', 'example.com', '8.8.8.8', '172.32.0.1', '192.169.1.1', 'localhost.evil.com', '127.evil.com', '10.evil.com']) {
      expect(isLocalHost(h), h).toBe(false);
    }
  });
});

describe('names', () => {
  it('trims and collapses whitespace, in any script', () => {
    expect(normalizeName('  أحمد   خليل ')).toBe('أحمد خليل');
    expect(normalizeName('דני\nכהן')).toBe('דני כהן');
  });
  it('rejects empty, too short, too long, wrong type', () => {
    expect(normalizeName(' a ')).toBeNull();
    expect(normalizeName('x'.repeat(41))).toBeNull();
    expect(normalizeName(42)).toBeNull();
    expect(normalizeName('‏‏')).toBeNull();
  });
});

describe('signed tokens', () => {
  it('round-trips and rejects any tampering', async () => {
    const key = await hmacKey(b64url(randomBytes(32)));
    const id = randomId();
    expect(ID_RE.test(id)).toBe(true);
    const token = await signToken(key, 'a', id);
    expect(await verifyToken(key, 'a', token)).toBe(id);
    expect(await verifyToken(key, 'd', token)).toBeNull(); // wrong purpose
    expect(await verifyToken(key, 'a', token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(await verifyToken(key, 'a', randomId() + token.slice(22))).toBeNull(); // someone else's id
    expect(await verifyToken(key, 'a', id)).toBeNull();
    expect(await verifyToken(key, 'a', null)).toBeNull();
    const other = await hmacKey(b64url(randomBytes(32)));
    expect(await verifyToken(other, 'a', token)).toBeNull();
  });
  it('base64url is reversible', () => {
    const bytes = randomBytes(40);
    expect([...unb64url(b64url(bytes))]).toEqual([...bytes]);
  });
});

describe('calendar file', () => {
  const start = localToEpoch('2026-11-10', 16 * 60 + 30);
  const ev: CalEvent = {
    id: 'abcdefghijklmnopqrstuv', seq: 2, start, end: start + 1800, graceMin: 10, shop: 'صالون أحمد, الناصرة; فرع 1',
    address: 'شارع بولس السادس 12, الناصرة', link: 'https://example.com/a/abcdefghijklmnopqrstuv.MACMACMACMACMACMACMACM', lang: 'ar', early: false, now: start - 86400,
  };
  it('is a valid event in UTC with reminders', () => {
    const ics = buildIcs(ev);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20261110T143000Z');
    expect(ics).toContain('DTEND:20261110T150000Z');
    expect(ics).toContain('UID:abcdefghijklmnopqrstuv@trimly');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics.match(/BEGIN:VALARM/g)!.length).toBe(2);
    expect(ics).toContain('TRIGGER:-P1D');
    expect(ics).toContain('TRIGGER:-PT1H');
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:✂️ صالون أحمد\\, الناصرة\\; فرع 1 · موعدك 16:30 (محفوظ حتى 16:40)');
    expect(unfolded).toContain('LOCATION:شارع بولس السادس 12\\, الناصرة');
    expect(unfolded).toContain('\\n' + ev.link);
  });
  it('folds long lines at 75 bytes without breaking characters', () => {
    const enc = new TextEncoder();
    for (const line of buildIcs(ev).split('\r\n')) expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    const long = 'SUMMARY:' + 'ع✂️x'.repeat(60);
    expect(fold(long).replace(/\r\n /g, '')).toBe(long);
  });
  it('gives habitual latecomers earlier reminders', () => {
    const ics = buildIcs({ ...ev, early: true });
    expect(ics.match(/BEGIN:VALARM/g)!.length).toBe(3);
    expect(ics).toContain('TRIGGER:-PT2H');
  });
  it('builds a Google Calendar link (Android)', () => {
    const u = new URL(googleCalendarUrl({ ...ev, lang: 'he', shop: 'דני' }));
    expect(u.searchParams.get('dates')).toBe('20261110T143000Z/20261110T150000Z');
    expect(u.searchParams.get('text')).toBe('✂️ דני · התור שלך 16:30 (נשמר עד 16:40)');
    expect(u.searchParams.get('details')).toContain(ev.link);
  });
});
