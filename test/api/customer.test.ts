import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, Client, TUE, WED, at, barber, randomId, reset, slotTimes, who } from './helpers';

const NOW = at(TUE, '08:00');

beforeEach(reset);

describe('before the barber has set up the shop', () => {
  it('the page reports closed and nobody can book', async () => {
    const c = new Client(NOW);
    expect((await c.state()).open).toBe(false);
    const r = await c.book(at(TUE, '10:00'), who(1));
    expect(r.status).toBe(503);
    expect(r.data.error).toBe('closed');
  });
});

describe('booking', () => {
  it('a new customer books in one request and the device remembers the appointment', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    const before = await c.state();
    expect(before.open).toBe(true);
    expect(before.appt).toBeNull();
    expect(slotTimes(before, TUE)[0]).toBe('09:00');

    const r = await c.book(at(TUE, '10:00'), { name: ' أحمد  خليل ', phone: '050-123 4567' });
    expect(r.status).toBe(200);
    expect(r.data.booked).toBe(true);
    expect(r.data.appt.time).toBe('10:00');
    expect(r.data.appt.date).toBe(TUE);
    expect(r.data.appt.graceTime).toBe('10:10');
    expect(r.data.me).toEqual({ name: 'أحمد خليل', phone: '050•••••67' });

    // cookies are HttpOnly, so page scripts (and injected scripts) can never read them
    for (const sc of r.res.headers.getSetCookie()) expect(sc).toMatch(/HttpOnly; SameSite=Lax/);

    const again = await c.state();
    expect(again.appt.time).toBe('10:00');
    expect(slotTimes(again, TUE)).not.toContain('10:00');
  });

  it('the calendar file and the private link work', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    const { data } = await c.book(at(TUE, '10:00'), who(1));
    const ics = await fetch(BASE + data.appt.ics, { headers: { 'x-test-now': String(NOW) } });
    expect(ics.status).toBe(200);
    expect(ics.headers.get('content-type')).toContain('text/calendar');
    const text = await ics.text();
    expect(text).toContain('DTSTART:20261110T080000Z');
    expect(text).toContain(`/a/${data.appt.token}`);
    expect(data.appt.gcal).toContain('calendar.google.com');

    // a brand-new device opening the private link sees the appointment and then remembers it
    const phone2 = new Client(NOW);
    phone2.token = data.appt.token;
    const viaLink = await phone2.state();
    expect(viaLink.appt.time).toBe('10:00');
    phone2.token = undefined;
    expect((await phone2.state()).appt.time).toBe('10:00');
  });

  it('never reveals other customers', async () => {
    await barber(NOW);
    const a = new Client(NOW);
    await a.book(at(TUE, '10:00'), { name: 'سرّي جداً', phone: '0507654321' });
    const stranger = new Client(NOW);
    const raw = JSON.stringify(await stranger.state());
    expect(raw).not.toContain('سرّي');
    expect(raw).not.toContain('7654321');
    expect(raw).not.toContain('765');
    expect((await stranger.state()).appt).toBeNull();

    // guessing or forging a link gives nothing
    stranger.token = randomId() + '.' + randomId();
    expect((await stranger.state()).appt).toBeNull();
    const aToken = (await a.state()).appt.token as string;
    stranger.token = aToken.slice(0, -2) + 'xx';
    expect((await stranger.state()).appt).toBeNull();
    expect((await stranger.post('/api/cancel')).status).toBe(404);
    expect((await fetch(`${BASE}/api/ics?t=${stranger.token}`)).status).toBe(404);
  });

  it('knowing a phone number gives no access to that person’s appointment', async () => {
    await barber(NOW);
    const owner = new Client(NOW);
    await owner.book(at(TUE, '10:00'), who(7));
    const other = new Client(NOW);
    const r = await other.book(at(TUE, '11:00'), who(7));
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ error: 'has_active' });
    expect(other.jar.size).toBe(0);
    expect((await other.state()).appt).toBeNull();
  });

  it('twenty people racing for the same time: exactly one gets it', async () => {
    await barber(NOW);
    const start = at(TUE, '12:00');
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => new Client(NOW).book(start, who(100 + i))));
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.status === 409 && r.data.error === 'slot_taken').length).toBe(19);
  });

  it('one person tapping twenty times gets one appointment', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => c.book(at(TUE, `${10 + Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`), who(5))));
    expect(results.filter((r) => r.status === 200).length).toBe(1);
  });

  it('a retried request (lost reply) succeeds again without a duplicate', async () => {
    const b = await barber(NOW);
    const c = new Client(NOW);
    const id = randomId();
    const first = await c.book(at(TUE, '10:00'), who(1), id);
    const second = await c.book(at(TUE, '10:00'), who(1), id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.data.appt.token).toBe(first.data.appt.token);
    const day = await b.get(`/api/b/day?date=${TUE}`);
    expect(day.data.appts.length).toBe(1);
    // the same id cannot be reused by someone else for another time
    const thief = await new Client(NOW).book(at(TUE, '11:00'), who(2), id);
    expect(thief.status).toBe(409);
  });

  it('rejects invalid input', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    expect((await c.book(at(TUE, '10:00'), { name: 'x', phone: '0501234567' })).data.error).toBe('bad_name');
    expect((await c.book(at(TUE, '10:00'), { name: 'Ahmad', phone: '12345' })).data.error).toBe('bad_phone');
    expect((await c.book(at(TUE, '10:00'))).data.error).toBe('need_identity');
    expect((await c.book(at(TUE, '07:00'), who(1))).data.error).toBe('slot_taken'); // in the past
    expect((await c.book(at(TUE, '10:10'), who(1))).data.error).toBe('slot_taken'); // not a real slot
    expect((await c.book(at(TUE, '22:00'), who(1))).data.error).toBe('slot_taken'); // closed
    expect((await c.book(at('2027-01-10', '10:00'), who(1))).data.error).toBe('slot_taken'); // too far ahead
    expect((await c.post('/api/book', { start: 'abc', id: randomId(), ...who(1) })).status).toBe(400);
    expect((await c.post('/api/book', { start: at(TUE, '10:00'), id: '../x', ...who(1) })).status).toBe(400);
    expect((await c.call('POST', '/api/book', undefined, {})).status).toBe(400);
    const sqli = await c.book(at(TUE, '10:00'), { name: "Robert'); DROP TABLE appointments;--", phone: '0501234567' });
    expect(sqli.status).toBe(200);
    expect(sqli.data.me.name).toBe("Robert'); DROP TABLE appointments;--");
  });
});

describe('cancel and change', () => {
  it('cancelling frees the time for others', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    await c.book(at(WED, '10:00'), who(1));
    const r = await c.post('/api/cancel');
    expect(r.status).toBe(200);
    expect(r.data.appt).toBeNull();
    expect(r.data.me.name).toBe('زبون 1');
    expect(slotTimes(r.data, WED)).toContain('10:00');
    expect((await c.post('/api/cancel')).status).toBe(404);
    expect((await new Client(NOW).book(at(WED, '10:00'), who(2))).status).toBe(200);
  });

  it('changing the time is atomic and keeps the same private link', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    const booked = await c.book(at(WED, '10:00'), who(1));
    const other = new Client(NOW);
    await other.book(at(WED, '11:00'), who(2));

    expect((await c.post('/api/move', { start: at(WED, '11:00') })).data.error).toBe('slot_taken');
    expect((await c.state()).appt.time).toBe('10:00'); // nothing lost on failure

    const moved = await c.post('/api/move', { start: at(WED, '15:30') });
    expect(moved.status).toBe(200);
    expect(moved.data.appt.time).toBe('15:30');
    expect(moved.data.appt.token).toBe(booked.data.appt.token);
    const st = await other.state();
    expect(slotTimes(st, WED)).toContain('10:00');
    expect(slotTimes(st, WED)).not.toContain('15:30');
    const ics = await (await fetch(BASE + moved.data.appt.ics, { headers: { 'x-test-now': String(NOW) } })).text();
    expect(ics).toContain('SEQUENCE:1');
    expect(ics).toContain('DTSTART:20261111T133000Z');
  });

  it('two customers swapping into the same free time: only one wins', async () => {
    await barber(NOW);
    const a = new Client(NOW);
    const b = new Client(NOW);
    await a.book(at(WED, '10:00'), who(1));
    await b.book(at(WED, '11:00'), who(2));
    const [ra, rb] = await Promise.all([a.post('/api/move', { start: at(WED, '12:00') }), b.post('/api/move', { start: at(WED, '12:00') })]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
  });

  it('a returning customer books with one tap, and can be forgotten', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    await c.book(at(TUE, '10:00'), who(1));
    c.now = at(WED, '08:00'); // the visit is over
    const st = await c.state();
    expect(st.appt).toBeNull();
    expect(st.me.name).toBe('زبون 1');
    const r = await c.book(at(WED, '10:00')); // no name, no phone
    expect(r.status).toBe(200);
    expect(r.data.appt.time).toBe('10:00');

    await c.post('/api/cancel');
    const f = await c.post('/api/forget');
    expect(f.data.me).toBeNull();
    expect(c.jar.size).toBe(0);
    expect((await c.book(at(WED, '10:00'))).data.error).toBe('need_identity');
  });

  it('a forged identity cookie is ignored', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    await c.book(at(TUE, '10:00'), who(1));
    c.now = at(WED, '08:00');
    const name = [...c.jar.keys()].find((k) => k.endsWith('tr_d'))!;
    const forged = Buffer.from(JSON.stringify({ p: '+972500000000', n: 'Evil' })).toString('base64url');
    c.jar.set(name, forged + '.' + c.jar.get(name)!.split('.')[1]);
    expect((await c.state()).me).toBeNull();
    expect((await c.book(at(WED, '10:00'))).data.error).toBe('need_identity');
  });
});

describe('lateness and no-shows (handled by the software, not by the barber)', () => {
  it('“I will be late”: the customer moves to the next free time by themselves', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    await c.book(at(TUE, '10:00'), who(1));
    await new Client(NOW).book(at(TUE, '10:30'), who(2));
    c.now = at(TUE, '10:15'); // grace period (10:10) has passed
    const st = await c.state();
    expect(st.appt.time).toBe('10:00');
    expect(st.now).toBeGreaterThan(st.appt.graceUntil);
    expect(slotTimes(st, TUE)[0]).toBe('11:00');
    const r = await c.post('/api/move', { start: at(TUE, '11:00') });
    expect(r.data.appt.time).toBe('11:00');
  });

  it('habitual latecomers quietly get a buffer; everyone else is unaffected', async () => {
    const b = await barber(NOW);
    const c = new Client(NOW);
    // two last-minute changes on two different days
    for (const [day, next] of [[TUE, WED], [WED, '2026-11-12']] as const) {
      await c.book(at(day, '10:00'), who(1));
      c.now = at(day, '09:40');
      await c.post('/api/cancel');
      c.now = at(next, '08:00');
    }
    const st = await c.state();
    // 19:30 would run into closing time once the 10-minute buffer is added
    expect(slotTimes(st, '2026-11-12').at(-1)).toBe('19:00');
    expect(slotTimes(await new Client(c.now).state(), '2026-11-12').at(-1)).toBe('19:30');

    await new Client(c.now).book(at('2026-11-12', '11:00'), who(2));
    expect(slotTimes(await c.state(), '2026-11-12')).not.toContain('10:30'); // no room behind it
    const r = await c.book(at('2026-11-12', '12:00'));
    expect(r.status).toBe(200);
    // the next customer is offered 12:40 instead of 12:30 — nobody is told why
    const after = slotTimes(await new Client(c.now).state(), '2026-11-12');
    expect(after).not.toContain('12:30');
    expect(after).toContain('12:40');
    const ics = await (await fetch(BASE + r.data.appt.ics, { headers: { 'x-test-now': String(c.now) } })).text();
    expect(ics).toContain('TRIGGER:-PT2H'); // earlier reminders
    b.now = c.now;
    const day = await b.get('/api/b/day?date=2026-11-12');
    expect(day.data.appts.find((a: any) => a.time === '12:00').latecomer).toBe(true);
  });

  it('a booking cancelled right after it was made is not held against the customer', async () => {
    await barber(NOW);
    const c = new Client(at(TUE, '09:40'));
    for (const t of ['10:00', '10:30', '11:00']) {
      await c.book(at(TUE, t), who(1));
      c.now += 60;
      await c.post('/api/cancel');
    }
    expect(slotTimes(await c.state(), TUE).at(-1)).toBe('19:30');
  });

  it('two no-shows pause online booking; it comes back by itself after six months', async () => {
    const b = await barber(NOW);
    const c = new Client(NOW);
    for (const day of [TUE, WED]) {
      c.now = at(day, '08:00');
      const r = await c.book(at(day, '10:00'), who(1));
      expect(r.status).toBe(200);
      b.now = at(day, '10:40');
      const id = (await b.get(`/api/b/day?date=${day}`)).data.appts[0].id;
      expect((await b.post('/api/b/noshow', { id })).status).toBe(200);
    }
    c.now = at('2026-11-12', '08:00');
    const st = await c.state();
    expect(st.blocked).toBe(true);
    expect(st.days).toEqual([]);
    expect((await c.book(at('2026-11-12', '10:00'))).data.error).toBe('blocked');
    // the same phone from a fresh device is paused too
    expect((await new Client(c.now).book(at('2026-11-12', '10:00'), who(1))).data.error).toBe('blocked');

    c.now = at('2027-05-20', '08:00');
    expect((await c.state()).blocked).toBe(false);
    expect((await c.book(at('2027-05-20', '10:00'))).status).toBe(200);
  });
});

describe('abuse protection', () => {
  it('limits bookings per connection', async () => {
    await barber(NOW);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await new Client(NOW, '203.0.113.9').book(at(WED, `${10 + i}:00`), who(50 + i))).status);
    expect(codes.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(codes.slice(6)).toEqual([429, 429]);
    // other people are not affected, and the limit clears with time
    expect((await new Client(NOW).book(at(WED, '18:00'), who(70))).status).toBe(200);
    expect((await new Client(NOW + 3700, '203.0.113.9').book(at(WED, '18:30'), who(71))).status).toBe(200);
  });

  it('refuses cross-site and non-JSON requests', async () => {
    await barber(NOW);
    const c = new Client(NOW);
    const body = { start: at(TUE, '10:00'), id: randomId(), ...who(1) };
    expect((await c.call('POST', '/api/book', body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.call('POST', '/api/book', body, { origin: '' })).status).toBe(403);
    expect((await c.call('POST', '/api/book', body, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await c.call('POST', '/api/b/noshow', { id: randomId() })).status).toBe(401);
    expect((await c.get('/api/nope')).status).toBe(404);
    expect((await c.call('POST', '/api/book', { x: 'y'.repeat(20000) })).status).toBe(413);
  });

  it('sends hardening headers', async () => {
    const r = await new Client(NOW).get('/api/state');
    expect(r.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.res.headers.get('cache-control')).toBe('no-store');
  });
});
