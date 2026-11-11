import { randomId } from '../../src/core';
import { localToEpoch } from '../../src/time';
import { BASE } from '../server';

export { BASE, randomId };

/** Local shop time → epoch seconds. */
export const at = (date: string, time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return localToEpoch(date, h! * 60 + m!);
};

export const TUE = '2026-11-10';
export const WED = '2026-11-11';
export const THU = '2026-11-12';

export interface Reply {
  status: number;
  data: any;
  res: Response;
}

let ipCounter = 0;

/** A browser-like client: keeps cookies, sends same-origin headers, and controls the test clock. */
export class Client {
  jar = new Map<string, string>();
  token?: string;
  ip: string;
  constructor(public now: number, ip?: string) {
    this.ip = ip ?? `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  }
  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'x-test-now': String(this.now), 'x-test-ip': this.ip };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.token) headers['x-appt-token'] = this.token;
    if (method !== 'GET') {
      headers.origin = BASE;
      headers['content-type'] = 'application/json';
    }
    Object.assign(headers, extra);
    for (const k of Object.keys(headers)) if (headers[k] === '') delete headers[k];
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (/Max-Age=0/i.test(sc) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, data, res };
  }
  get = (path: string): Promise<Reply> => this.call('GET', path);
  post = (path: string, body: unknown = {}): Promise<Reply> => this.call('POST', path, body);
  state = async (): Promise<any> => (await this.get('/api/state')).data;
  book = (start: number, who?: { name: string; phone: string }, id = randomId()): Promise<Reply> =>
    this.post('/api/book', { start, id, lang: 'ar', ...(who ?? {}) });
}

export async function reset(): Promise<void> {
  const r = await fetch(BASE + '/api/test/reset', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error('reset failed ' + r.status);
}

/** A signed-in barber with the shop already set up. */
export async function barber(now: number, patch: Record<string, unknown> = {}): Promise<Client & { recovery: string }> {
  const b = new Client(now) as Client & { recovery: string };
  const r = await b.post('/api/b/setup', { shopName: 'صالون أحمد', phone: '0509999999', lang: 'ar' });
  if (r.status !== 200) throw new Error('setup failed ' + JSON.stringify(r.data));
  b.recovery = r.data.recovery;
  if (Object.keys(patch).length) {
    const s = await b.post('/api/b/settings', patch);
    if (s.status !== 200) throw new Error('settings failed ' + JSON.stringify(s.data));
  }
  return b;
}

export const who = (n: number): { name: string; phone: string } => ({ name: `زبون ${n}`, phone: '05' + String(10000000 + n) });
export const slotTimes = (state: any, date: string): string[] =>
  (state.days.find((d: any) => d.date === date)?.slots ?? []).map((s: [number, string]) => s[1]);
