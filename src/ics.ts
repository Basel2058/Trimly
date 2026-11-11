// Calendar export: the customer's free, built-in reminder channel.
import type { Lang } from './core';
import { msg } from './msg';
import { timeOf } from './time';

export interface CalEvent {
  id: string;
  seq: number;
  start: number;
  end: number;
  graceMin: number;
  shop: string;
  address: string;
  link: string;
  lang: Lang;
  /** habitual latecomers get earlier reminders */
  early: boolean;
  now: number;
}

const stamp = (epochSec: number): string =>
  new Date(epochSec * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

const esc = (s: string): string =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/** RFC 5545 line folding: at most 75 octets per line, never splitting a UTF-8 character. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function eventTitle(e: CalEvent): string {
  const shop = e.shop || msg(e.lang, 'haircut');
  let t = msg(e.lang, 'evTitle', { shop, time: timeOf(e.start) });
  if (e.graceMin > 0) t += msg(e.lang, 'evHeld', { grace: timeOf(e.start + e.graceMin * 60) });
  return t;
}

export function buildIcs(e: CalEvent): string {
  const title = eventTitle(e);
  const alarms = e.early ? ['-P1D', '-PT2H', '-PT45M'] : ['-P1D', '-PT1H'];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Trimly//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.id}@trimly`,
    `DTSTAMP:${stamp(e.now)}`,
    `SEQUENCE:${e.seq}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(e.end)}`,
    `SUMMARY:${esc(title)}`,
    ...(e.address ? [`LOCATION:${esc(e.address)}`] : []),
    `DESCRIPTION:${esc(msg(e.lang, 'evDesc') + '\n' + e.link)}`,
    `URL:${e.link}`,
    'STATUS:CONFIRMED',
    ...alarms.flatMap((trigger) => [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(title)}`,
      `TRIGGER:${trigger}`,
      'END:VALARM',
    ]),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(e: CalEvent): string {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: eventTitle(e),
    dates: `${stamp(e.start)}/${stamp(e.end)}`,
    details: msg(e.lang, 'evDesc') + '\n' + e.link,
  });
  if (e.address) p.set('location', e.address);
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}
