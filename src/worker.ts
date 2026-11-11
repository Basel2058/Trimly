// Entry point: routing, safety checks, error handling, housekeeping.
import * as auth from './auth';
import * as barber from './barber';
import * as customer from './customer';
import { ensureSchema, getMeta, q, resetSchemaCache, setMetaStmt, type Env } from './db';
import { ApiError, json, type Ctx } from './http';
import { msg } from './msg';
import { notifyBarber } from './push';
import { parseSettings } from './slots';
import { addDays, localParts, localToEpoch } from './time';
import { STRIKE_WINDOW, loadWorld } from './world';

type Handler = (c: Ctx) => Promise<Response>;

const ROUTES: Record<string, Handler> = {
  'GET /api/state': customer.getState,
  'POST /api/book': customer.book,
  'POST /api/cancel': customer.cancel,
  'POST /api/move': customer.move,
  'POST /api/forget': customer.forget,
  'GET /api/ics': customer.ics,
  'GET /api/b/session': auth.sessionState,
  'POST /api/b/setup': auth.setup,
  'POST /api/b/login': auth.login,
  'POST /api/b/logout': auth.logout,
  'POST /api/b/pair': auth.pairNew,
  'GET /api/b/day': barber.getDay,
  'POST /api/b/add': barber.add,
  'POST /api/b/cancel': barber.cancelAppt,
  'POST /api/b/move': barber.moveAppt,
  'POST /api/b/noshow': barber.noShow,
  'POST /api/b/late': barber.markLate,
  'POST /api/b/forgive': barber.forgive,
  'POST /api/b/hours': barber.setHours,
  'POST /api/b/settings': barber.saveSettings,
  'POST /api/b/delay': barber.setDelay,
  'GET /api/b/push/key': barber.pushKey,
  'POST /api/b/push/subscribe': barber.pushSubscribe,
  'POST /api/b/push/unsubscribe': barber.pushUnsubscribe,
  'POST /api/b/push/test': barber.pushTest,
  'GET /api/health': health,
  'GET /manifest.webmanifest': manifest,
  'GET /barber.webmanifest': manifest,
};

const TABLES = ['appointments', 'strikes', 'overrides', 'sessions', 'pair_codes', 'push_subs', 'rate'];

function makeCtx(req: Request, env: Env, wait: (p: Promise<unknown>) => void): Ctx {
  const url = new URL(req.url);
  const test = env.TEST_MODE === '1';
  const testNow = test ? Number(req.headers.get('x-test-now')) : 0;
  return {
    env,
    db: env.DB,
    req,
    url,
    now: testNow > 0 ? Math.floor(testNow) : Math.floor(Date.now() / 1000),
    ip: (test && req.headers.get('x-test-ip')) || req.headers.get('cf-connecting-ip') || 'unknown',
    secure: url.protocol === 'https:',
    wait,
    cookiesOut: [],
  };
}

async function health(c: Ctx): Promise<Response> {
  const row = await q(() => c.db.prepare(`SELECT COUNT(*) AS n FROM meta`).first<{ n: number }>());
  return json(c, { ok: true, db: (row?.n ?? 0) > 0, now: c.now });
}

async function manifest(c: Ctx): Promise<Response> {
  const s = parseSettings((await getMeta(c.db, ['settings'])).settings);
  const forBarber = c.url.pathname === '/barber.webmanifest';
  const name = forBarber ? `${msg(s.lang, 'barberApp')}${s.shopName ? ' · ' + s.shopName : ''}` : s.shopName || 'Trimly';
  const data = {
    id: forBarber ? '/barber' : '/',
    name,
    short_name: forBarber ? msg(s.lang, 'barberApp') : name.slice(0, 12),
    start_url: forBarber ? '/barber' : '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: s.lang,
    dir: s.lang === 'en' ? 'ltr' : 'rtl',
    background_color: '#f2f2f7',
    theme_color: '#f2f2f7',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

async function testReset(c: Ctx): Promise<Response> {
  await c.db.batch([
    ...TABLES.map((t) => c.db.prepare(`DELETE FROM ${t}`)),
    c.db.prepare(`DELETE FROM meta WHERE k NOT IN ('secret', 'schema_v')`),
  ]);
  resetSchemaCache();
  return json(c, { ok: true });
}

function finish(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'no-referrer');
  out.headers.set('x-frame-options', 'DENY');
  return out;
}

export async function handle(req: Request, env: Env, wait: (p: Promise<unknown>) => void): Promise<Response> {
  const c = makeCtx(req, env, wait);
  try {
    const key = `${req.method} ${c.url.pathname}`;
    const route = ROUTES[key];
    if (!route) {
      if (env.TEST_MODE === '1' && key === 'POST /api/test/reset') return finish(await testReset(c));
      if (env.TEST_MODE === '1' && key === 'POST /api/test/cron') {
        await housekeeping(env, c.now, wait);
        return finish(json(c, { ok: true }));
      }
      if (c.url.pathname.startsWith('/api/')) throw new ApiError(404, 'not_found');
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    }
    if (req.method !== 'GET') {
      // Same-origin JSON only: a forged cross-site request can never change anything.
      if (req.headers.get('origin') !== c.url.origin) throw new ApiError(403, 'bad_origin');
      if (!(req.headers.get('content-type') ?? '').includes('application/json')) throw new ApiError(415, 'bad_type');
    }
    await ensureSchema(env);
    return finish(await route(c));
  } catch (e) {
    if (e instanceof ApiError) return finish(json(c, { error: e.code, ...e.extra }, e.status));
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[${ref}] ${req.method} ${c.url.pathname}`, (e as Error)?.stack ?? e);
    return finish(json(c, { error: 'server', ref }, 500));
  }
}

/** Runs every few minutes: tidies up by itself and sends the barber a morning summary. */
export async function housekeeping(env: Env, now: number, wait: (p: Promise<unknown>) => void): Promise<void> {
  await ensureSchema(env);
  const db = env.DB;
  const today = localParts(now).date;
  await q(() =>
    db.batch([
      db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now),
      db.prepare(`DELETE FROM pair_codes WHERE expires_at <= ?`).bind(now),
      db.prepare(`DELETE FROM rate WHERE reset_at <= ?`).bind(now),
      db.prepare(`DELETE FROM strikes WHERE at <= ?`).bind(now - STRIKE_WINDOW),
      // personal data is not kept longer than it is useful
      db.prepare(`DELETE FROM appointments WHERE end_at <= ?`).bind(now - 90 * 86400),
      db.prepare(`DELETE FROM overrides WHERE date < ?`).bind(addDays(today, -7)),
    ]),
  );

  // An overlap must be impossible; if one ever appears, make it loud in the logs.
  const clash = await q(() =>
    db
      .prepare(
        `SELECT a.id AS a, b.id AS b FROM appointments a JOIN appointments b
           ON a.id < b.id AND a.start_at < b.end_at AND b.start_at < a.end_at
         WHERE a.status = 'booked' AND b.status = 'booked' AND a.end_at > ?1 AND b.end_at > ?1 LIMIT 1`,
      )
      .bind(now)
      .first(),
  );
  if (clash) console.error('INTEGRITY: overlapping appointments', JSON.stringify(clash));

  const meta = await getMeta(db, ['summary_date', 'origin']);
  if (localParts(now).mins >= 7 * 60 + 30 && meta.summary_date !== today) {
    const first = await q(() =>
      db
        .prepare(
          `SELECT COUNT(*) AS n, MIN(start_at) AS first FROM appointments
           WHERE status = 'booked' AND kind != 'block' AND start_at > ? AND start_at < ?`,
        )
        .bind(now, localToEpoch(addDays(today, 1), 0))
        .first<{ n: number; first: number | null }>(),
    );
    await q(() => setMetaStmt(db, 'summary_date', today).run());
    if (first && first.n > 0 && first.first) {
      const c = makeCtx(new Request((meta.origin || 'https://trimly.invalid') + '/cron'), env, wait);
      c.now = now;
      const { world } = await loadWorld(c);
      await notifyBarber(c, world, 'morning', { n: first.n, start: first.first });
    }
  }
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(req, env, (p) => ctx.waitUntil(p));
  },
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await housekeeping(env, Math.floor(Date.now() / 1000), (p) => ctx.waitUntil(p));
    } catch (e) {
      console.error('housekeeping failed', (e as Error)?.stack ?? e); // the next run will try again
    }
  },
} satisfies ExportedHandler<Env>;
