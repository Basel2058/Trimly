import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { b64url } from '../../src/core';
import { BASE, Client, THU, TUE, WED, at, barber, randomId, reset, slotTimes, who } from './helpers';

const ece = createRequire(import.meta.url)('http_ece') as { decrypt: (b: Buffer, o: Record<string, unknown>) => Buffer };
const NOW = at(TUE, '08:00');
const day = async (b: Client, date: string): Promise<any> => (await b.get(`/api/b/day?date=${date}`)).data;

beforeEach(reset);

describe('claiming the shop and signing in', () => {
  it('the first setup wins; nobody can claim it again', async () => {
    const b = await barber(NOW);
    expect(b.recovery).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect((await b.get('/api/b/session')).data.state).toBe('ok');
    const intruder = new Client(NOW);
    expect((await intruder.get('/api/b/session')).data.state).toBe('login');
    expect((await intruder.post('/api/b/setup', { shopName: 'Evil', lang: 'en' })).status).toBe(409);
    expect((await intruder.get('/api/b/day')).status).toBe(401);
    for (const path of ['add', 'cancel', 'move', 'noshow', 'late', 'forgive', 'hours', 'settings', 'delay', 'pair', 'push/subscribe', 'push/test']) {
      expect((await intruder.post('/api/b/' + path, { id: randomId() })).status, path).toBe(401);
    }
  });

  it('setup needs a shop name', async () => {
    const c = new Client(NOW);
    expect((await c.get('/api/b/session')).data.state).toBe('setup');
    expect((await c.post('/api/b/setup', { shopName: '', lang: 'ar' })).status).toBe(400);
    expect((await c.post('/api/b/setup', { shopName: 'Sami', phone: '123', lang: 'ar' })).status).toBe(400);
  });

  it('a second device pairs with a one-time 6-digit code', async () => {
    const b = await barber(NOW);
    const code = (await b.post('/api/b/pair')).data.code as string;
    expect(code).toMatch(/^\d{6}$/);
    const phone2 = new Client(NOW);
    expect((await phone2.post('/api/b/login', { code: '000000' === code ? '111111' : '000000' })).status).toBe(403);
    expect((await phone2.post('/api/b/login', { code: ` ${code.slice(0, 3)} ${code.slice(3)} ` })).status).toBe(200);
    expect((await phone2.get('/api/b/day')).status).toBe(200);
    // single use
    expect((await new Client(NOW).post('/api/b/login', { code })).status).toBe(403);
    // expires after 15 minutes
    const code2 = (await b.post('/api/b/pair')).data.code;
    expect((await new Client(NOW + 901).post('/api/b/login', { code: code2 })).status).toBe(403);
  });

  it('the recovery code signs in; guessing is rate limited; sign-out works', async () => {
    const b = await barber(NOW);
    const d = new Client(NOW);
    expect((await d.post('/api/b/login', { code: b.recovery.toLowerCase().replace(/-/g, ' ') })).status).toBe(200);
    expect((await d.post('/api/b/logout')).status).toBe(200);
    expect((await d.get('/api/b/day')).status).toBe(401);

    const attacker = new Client(NOW, '198.51.100.7');
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await attacker.post('/api/b/login', { code: 'AAAA-BBBB-CCCC-DDD' + i })).status);
    expect(codes.slice(0, 8).every((s) => s === 403)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
    // even the right code is refused while locked out, and works again later
    expect((await attacker.post('/api/b/login', { code: b.recovery })).status).toBe(429);
    attacker.now += 901;
    expect((await attacker.post('/api/b/login', { code: b.recovery })).status).toBe(200);
  });

  it('an idle session lasts; an expired one is refused', async () => {
    const b = await barber(NOW);
    b.now = NOW + 200 * 86400;
    expect((await b.get('/api/b/day')).status).toBe(200); // refreshed for another 400 days
    b.now = NOW + 500 * 86400;
    expect((await b.get('/api/b/day')).status).toBe(200);
    b.now = NOW + 1000 * 86400;
    expect((await b.get('/api/b/day')).status).toBe(401);
  });
});

describe('the day view', () => {
  it('shows who is coming, with a private link the barber can send', async () => {
    const b = await barber(NOW);
    const c = new Client(NOW);
    const booked = await c.book(at(TUE, '10:00'), { name: 'أحمد خليل', phone: '0501234567' });
    const d = await day(b, TUE);
    expect(d.today).toBe(TUE);
    expect(d.appts.length).toBe(1);
    expect(d.appts[0]).toMatchObject({ name: 'أحمد خليل', phone: '+972501234567', phoneText: '050-1234567', time: '10:00', endTime: '10:30', status: 'booked', kind: 'customer' });
    expect(d.appts[0].link).toBe(`${BASE}/a/${booked.data.appt.token}`);
    expect(d.free.map((s: any) => s[1])).not.toContain('10:00');
    expect(d.days[0]).toMatchObject({ date: TUE, n: 1, closed: false });
    expect(d.days.length).toBe(14);
  });

  it('the barber adds walk-ins, phone bookings and breaks', async () => {
    const b = await barber(NOW);
    const id = randomId();
    const r1 = await b.post('/api/b/add', { start: at(TUE, '11:00'), name: 'أبو سامي', phone: '052-7654321', id });
    expect(r1.status).toBe(200);
    expect((await b.post('/api/b/add', { start: at(TUE, '11:00'), name: 'أبو سامي', phone: '052-7654321', id })).status).toBe(200); // retry-safe
    expect((await b.post('/api/b/add', { start: at(TUE, '11:30') })).status).toBe(200); // a break
    expect((await b.post('/api/b/add', { start: at(TUE, '11:00'), name: 'Other' })).status).toBe(409);
    expect((await b.post('/api/b/add', { start: at(TUE, '12:00'), phone: 'nope' })).status).toBe(400);
    const d = await day(b, TUE);
    expect(d.appts.map((a: any) => [a.time, a.kind])).toEqual([['11:00', 'manual'], ['11:30', 'block']]);
    expect(d.appts[1].link).toBe('');
    expect(slotTimes(await new Client(NOW).state(), TUE)).not.toContain('11:30');

    // the customer opens the link the barber sent and sees the appointment
    const c = new Client(NOW);
    c.token = d.appts[0].link.split('/a/')[1];
    const st = await c.state();
    expect(st.appt.time).toBe('11:00');
    expect(st.me.name).toBe('أبو سامي');
    // the barber may book a second visit for the same phone (father and son)
    expect((await b.post('/api/b/add', { start: at(TUE, '12:00'), name: 'ابن أبو سامي', phone: '0527654321' })).status).toBe(200);
  });

  it('cancelling tells the customer on their page', async () => {
    const b = await barber(NOW);
    const c = new Client(NOW);
    await c.book(at(WED, '10:00'), who(1));
    const id = (await day(b, WED)).appts[0].id;
    expect((await b.post('/api/b/cancel', { id })).data.appts.length).toBe(0);
    const st = await c.state();
    expect(st.appt).toBeNull();
    expect(st.notice).toEqual({ kind: 'cancelled', date: WED, time: '10:00' });
    expect((await fetch(`${BASE}/api/ics?t=${[...c.jar.values()][0]}`)).status).toBe(404);
    // booking again clears the notice
    const again = await c.book(at(WED, '12:00'));
    expect(again.data.notice).toBeNull();
    expect(again.data.appt.time).toBe('12:00');
  });

  it('no-show can only be marked once the time has come, and can be undone', async () => {
    const b = await barber(NOW);
    await new Client(NOW).book(at(TUE, '10:00'), who(1));
    const id = (await day(b, TUE)).appts[0].id;
    expect((await b.post('/api/b/noshow', { id })).data.error).toBe('too_early');
    b.now = at(TUE, '10:20');
    let d = (await b.post('/api/b/noshow', { id })).data;
    expect(d.appts[0]).toMatchObject({ status: 'no_show', noShows: 1, blocked: false });
    d = (await b.post('/api/b/noshow', { id, value: false })).data;
    expect(d.appts[0]).toMatchObject({ status: 'booked', noShows: 0 });
    expect((await b.post('/api/b/noshow', { id: randomId() })).status).toBe(404);
  });

  it('forgiving a customer lets them book online again', async () => {
    const b = await barber(NOW);
    const c = new Client(NOW);
    for (const d of [TUE, WED]) {
      c.now = at(d, '08:00');
      await c.book(at(d, '10:00'), who(1));
      b.now = at(d, '10:40');
      await b.post('/api/b/noshow', { id: (await day(b, d)).appts[0].id });
    }
    c.now = at(THU, '08:00');
    expect((await c.state()).blocked).toBe(true);
    expect((await day(b, WED)).appts[0].blocked).toBe(true);
    expect((await b.post('/api/b/forgive', { phone: who(1).phone, date: WED })).status).toBe(200);
    expect((await c.state()).blocked).toBe(false);
  });
});

describe('a customer arrives late', () => {
  it('the barber moves them with one tap; it is remembered quietly', async () => {
    const b = await barber(NOW);
    const late = new Client(NOW);
    await late.book(at(TUE, '10:00'), who(1));
    await new Client(NOW).book(at(TUE, '10:30'), who(2));
    b.now = at(TUE, '10:20');
    const d = await day(b, TUE);
    const appt = d.appts[0];
    const next = d.free[0];
    expect(next[1]).toBe('11:00');
    const moved = (await b.post('/api/b/move', { id: appt.id, start: next[0] })).data;
    expect(moved.appts.map((a: any) => a.time)).toEqual(['10:30', '11:00']);
    expect(moved.appts[1].markedLate).toBe(true);
    late.now = b.now;
    const st = await late.state();
    expect(st.appt.time).toBe('11:00');
    expect(st.appt.moved).toEqual({ date: TUE, time: '10:00' });
    // moving onto a taken time is refused
    expect((await b.post('/api/b/move', { id: appt.id, start: at(TUE, '10:30') })).status).toBe(409);
  });

  it('“arrived late” can be marked and unmarked', async () => {
    const b = await barber(NOW);
    await new Client(NOW).book(at(TUE, '10:00'), who(1));
    b.now = at(TUE, '10:20');
    const id = (await day(b, TUE)).appts[0].id;
    expect((await b.post('/api/b/late', { id })).data.appts[0].markedLate).toBe(true);
    expect((await b.post('/api/b/late', { id, value: false })).data.appts[0].markedLate).toBe(false);
  });
});

describe('the barber changes working hours — the software moves everyone', () => {
  it('finishing early re-homes the affected customers to the nearest free times', async () => {
    const b = await barber(NOW);
    const cs = [new Client(NOW), new Client(NOW), new Client(NOW)];
    await cs[0]!.book(at(TUE, '17:30'), who(1));
    await cs[1]!.book(at(TUE, '18:00'), who(2));
    await cs[2]!.book(at(TUE, '19:00'), who(3));
    await b.post('/api/b/add', { start: at(TUE, '19:30') }); // a break that no longer makes sense
    const r = await b.post('/api/b/hours', { date: TUE, open: 540, close: 1080 }); // 09:00–18:00
    expect(r.status).toBe(200);
    expect(r.data.unplaced).toEqual([]);
    expect(r.data.moved.map((m: any) => [m.name, m.fromTime, m.time, m.date])).toEqual([
      ['زبون 2', '18:00', '17:00', TUE],
      ['زبون 3', '19:00', '16:30', TUE],
    ]);
    expect(r.data.moved[0].link).toContain('/a/');
    expect(r.data.appts.map((a: any) => a.time)).toEqual(['16:30', '17:00', '17:30']);
    expect(r.data.hours.windows).toEqual([[540, 1080]]);
    // customers see the change on their own page
    const st = await cs[2]!.state();
    expect(st.appt.time).toBe('16:30');
    expect(st.appt.moved).toEqual({ date: TUE, time: '19:00' });
    expect(slotTimes(await new Client(NOW).state(), TUE).at(-1)).toBe('16:00');
    // nobody can book into the removed hours
    expect((await new Client(NOW).book(at(TUE, '18:30'), who(9))).status).toBe(409);
  });

  it('a day off moves customers to the next working day at the same time of day', async () => {
    const b = await barber(NOW);
    const c = new Client(NOW);
    await c.book(at(WED, '14:00'), who(1));
    await new Client(NOW).book(at(THU, '14:00'), who(2));
    const r = await b.post('/api/b/hours', { date: WED, closed: true });
    expect(r.data.moved.map((m: any) => [m.date, m.time])).toEqual([[THU, '14:30']]);
    expect(r.data.days.find((d: any) => d.date === WED).closed).toBe(true);
    expect((await c.state()).appt).toMatchObject({ date: THU, time: '14:30' });
    // undoing the day off opens it again (nobody is moved back automatically)
    const undo = await b.post('/api/b/hours', { date: WED, reset: true });
    expect(undo.data.moved).toEqual([]);
    expect(slotTimes(await c.state(), WED)).toContain('14:00');
  });

  it('starting late and staying longer both work', async () => {
    const b = await barber(NOW);
    await new Client(NOW).book(at(WED, '09:00'), who(1));
    const r = await b.post('/api/b/hours', { date: WED, open: 660, close: 1320 }); // 11:00–22:00
    expect(r.data.moved.map((m: any) => m.time)).toEqual(['11:00']);
    const t = slotTimes(await new Client(NOW).state(), WED);
    expect(t[0]).toBe('11:30');
    expect(t.at(-1)).toBe('21:30');
  });

  it('rejects nonsense hours', async () => {
    const b = await barber(NOW);
    expect((await b.post('/api/b/hours', { date: WED, open: 1200, close: 600 })).status).toBe(400);
    expect((await b.post('/api/b/hours', { date: 'tomorrow', closed: true })).status).toBe(400);
    expect((await b.post('/api/b/hours', { date: '2026-11-01', closed: true })).status).toBe(400); // the past
  });

  it('changing the weekly schedule and slot length applies immediately', async () => {
    const b = await barber(NOW);
    const c = new Client(NOW);
    await c.book(at(WED, '10:00'), who(1));
    const hours = Array.from({ length: 7 }, (_, i) => (i === 3 ? [] : [[600, 780], [960, 1140]])); // Wednesdays off, split day
    const r = await b.post('/api/b/settings', { hours, slotMin: 20, graceMin: 5, address: 'شارع 1', date: THU });
    expect(r.status).toBe(200);
    expect(r.data.moved.map((m: any) => [m.date, m.time])).toEqual([[THU, '10:00']]);
    const st = await c.state();
    expect(st.shop).toMatchObject({ slotMin: 20, graceMin: 5, address: 'شارع 1' });
    expect(slotTimes(st, WED)).toEqual([]);
    // the moved visit keeps its 30 minutes; new 20-minute slots continue right after it
    expect(slotTimes(st, THU).slice(0, 3)).toEqual(['10:30', '10:50', '11:10']);
    expect(slotTimes(st, THU)).not.toContain('13:00');
    expect(slotTimes(st, THU)).toContain('16:00');
    expect((await b.post('/api/b/settings', { slotMin: 7 })).status).toBe(400);
    expect((await b.post('/api/b/settings', { shopName: '' })).status).toBe(400);
    expect((await b.post('/api/b/settings', { phone: 'abc' })).status).toBe(400);
  });

  it('“running late” shows on today’s customers only', async () => {
    const b = await barber(NOW);
    const today = new Client(NOW);
    const tomorrow = new Client(NOW);
    await today.book(at(TUE, '12:00'), who(1));
    await tomorrow.book(at(WED, '12:00'), who(2));
    b.now = at(TUE, '11:00');
    expect((await b.post('/api/b/delay', { min: 15 })).data.delay.min).toBe(15);
    today.now = tomorrow.now = b.now;
    expect((await today.state()).appt.delayMin).toBe(15);
    expect((await tomorrow.state()).appt.delayMin).toBe(0);
    await b.post('/api/b/delay', { min: 0 });
    expect((await today.state()).appt.delayMin).toBe(0);
    await b.post('/api/b/delay', { min: 20 });
    tomorrow.now = at(WED, '08:00'); // a new day starts clean
    expect((await tomorrow.state()).appt.delayMin).toBe(0);
    expect((await b.post('/api/b/delay', { min: 999 })).status).toBe(400);
  });
});

describe('notifications and housekeeping', () => {
  let server: Server;
  let port = 0;
  let status = 201;
  const received: Array<{ headers: Record<string, any>; body: Buffer }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => void server.close());
  beforeEach(() => {
    received.length = 0;
    status = 201;
  });

  const subscribe = async (b: Client) => {
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const auth = randomBytes(16);
    const r = await b.post('/api/b/push/subscribe', { endpoint: `http://127.0.0.1:${port}/push/${randomId()}`, keys: { p256dh: b64url(browser.getPublicKey()), auth: b64url(auth) } });
    expect(r.status).toBe(200);
    return (i: number): any => JSON.parse(ece.decrypt(received[i]!.body, { version: 'aes128gcm', privateKey: browser, authSecret: auth }).toString('utf8'));
  };
  const waitFor = async (n: number): Promise<void> => {
    for (let i = 0; i < 100 && received.length < n; i++) await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(n);
  };

  it('a booking, a change and a cancellation each reach the barber’s phone, encrypted', async () => {
    const b = await barber(NOW);
    expect((await b.get('/api/b/push/key')).data.key).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const read = await subscribe(b);
    const c = new Client(NOW);
    await c.book(at(TUE, '10:00'), { name: 'أحمد', phone: '0501234567' });
    await waitFor(1);
    expect(received[0]!.headers['content-encoding']).toBe('aes128gcm');
    expect(received[0]!.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    expect(read(0)).toMatchObject({ title: 'حجز جديد', url: `/barber?d=${TUE}` });
    expect(read(0).body).toContain('أحمد');
    expect(read(0).body).toContain('10:00');
    await c.post('/api/move', { start: at(TUE, '11:00') });
    await waitFor(2);
    expect(read(1).title).toBe('تغيير موعد');
    await c.post('/api/cancel');
    await waitFor(3);
    expect(read(2).title).toBe('تم إلغاء موعد');
    expect((await b.post('/api/b/push/test')).data.sent).toBe(1);
    expect((await day(b, TUE)).push).toBe(true);
  });

  it('a dead subscription is forgotten automatically and never blocks a booking', async () => {
    const b = await barber(NOW);
    await subscribe(b);
    status = 410;
    expect((await new Client(NOW).book(at(TUE, '10:00'), who(1))).status).toBe(200);
    await waitFor(1);
    for (let i = 0; i < 40 && (await day(b, TUE)).push; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await day(b, TUE)).push).toBe(false);
    expect((await b.post('/api/b/push/subscribe', { endpoint: 'javascript:alert(1)', keys: { p256dh: 'x', auth: 'y' } })).status).toBe(400);
  });

  it('housekeeping sends one morning summary and deletes old data by itself', async () => {
    const b = await barber(NOW);
    const read = await subscribe(b);
    await new Client(NOW).book(at(TUE, '10:00'), who(1));
    await new Client(NOW).book(at(TUE, '12:00'), who(2));
    await waitFor(2);
    const cron = (now: number) => new Client(now).post('/api/test/cron');
    expect((await cron(at(TUE, '07:00'))).status).toBe(200); // too early
    expect(received.length).toBe(2);
    await cron(at(TUE, '07:40'));
    await waitFor(3);
    expect(read(2)).toMatchObject({ title: 'مواعيد اليوم', body: '2 مواعيد · الأول 10:00' });
    await cron(at(TUE, '08:10')); // only once a day
    expect(received.length).toBe(3);

    // four months later the old visits are gone, and the calendar is intact
    b.now = at('2027-03-20', '09:00');
    await cron(b.now);
    expect((await day(b, TUE)).appts).toEqual([]);
    expect((await new Client(b.now).get('/api/health')).data).toMatchObject({ ok: true, db: true });
  });
});
