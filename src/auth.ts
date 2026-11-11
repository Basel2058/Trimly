// Barber sign-in: claim the shop once, then devices stay signed in. New devices pair with a short code.
import { b64url, randomBytes, sha256 } from './core';
import { allow, q, setMetaStmt } from './db';
import { ApiError, body, clearCookie, getCookie, json, setCookie, COOKIE_AGE, type Ctx } from './http';
import { DEFAULT_SETTINGS, mergeSettings } from './slots';
import { normalizePhone, asLang } from './core';
import { loadWorld, type World } from './world';

type Res = D1Result<Record<string, unknown>>;

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function recoveryCode(): string {
  let s = '';
  for (const b of randomBytes(32)) {
    if (b < 248 && s.length < 16) s += RECOVERY_ALPHABET[b % 31]; // 248 = 8 * 31, no modulo bias
  }
  return s.padEnd(16, 'A').replace(/(.{4})(?=.)/g, '$1-');
}

const normRecovery = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function pairCode(): string {
  let n = 0;
  for (;;) {
    const b = randomBytes(4);
    n = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    if (n < 4294000000) break; // multiple of 1e6: unbiased
  }
  return String(n % 1000000).padStart(6, '0');
}

async function startSession(c: Ctx): Promise<void> {
  const token = b64url(randomBytes(32));
  await q(async () =>
    c.db
      .prepare(`INSERT INTO sessions (id, created_at, seen_at, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(await sha256(token), c.now, c.now, c.now + COOKIE_AGE)
      .run(),
  );
  setCookie(c, 'b', token);
}

const sessionStmt = async (c: Ctx): Promise<D1PreparedStatement> => {
  const token = getCookie(c, 'b');
  return c.db
    .prepare(`SELECT id, seen_at FROM sessions WHERE id = ? AND expires_at > ?`)
    .bind(token ? await sha256(token) : '', c.now);
};

/** Loads the world and checks the barber session in the same round trip. Throws 401 when not signed in. */
export async function barberWorld(c: Ctx, extra: D1PreparedStatement[] = []): Promise<{ world: World; extra: Res[] }> {
  const { world, extra: res } = await loadWorld(c, [await sessionStmt(c), ...extra]);
  const sess = res[0]!.results[0] as { id: string; seen_at: number } | undefined;
  if (!sess) throw new ApiError(401, world.owner ? 'login' : 'setup');
  if (c.now - sess.seen_at > 86400) {
    // rolling session: an active device never has to sign in again
    c.wait(
      q(() =>
        c.db
          .prepare(`UPDATE sessions SET seen_at = ?, expires_at = ? WHERE id = ?`)
          .bind(c.now, c.now + COOKIE_AGE, sess.id)
          .run(),
      ),
    );
    setCookie(c, 'b', getCookie(c, 'b')!);
  }
  return { world, extra: res.slice(1) };
}

export async function sessionState(c: Ctx): Promise<Response> {
  const { world, extra } = await loadWorld(c, [await sessionStmt(c)]);
  const ok = !!extra[0]!.results[0];
  return json(c, { state: ok ? 'ok' : world.owner ? 'login' : 'setup', lang: world.settings.lang, shop: world.settings.shopName });
}

/** First visit after deployment: whoever completes this owns the shop. */
export async function setup(c: Ctx): Promise<Response> {
  const b = await body(c);
  const phone = b.phone ? normalizePhone(b.phone) : '';
  if (phone === null) throw new ApiError(400, 'bad_phone');
  const settings = mergeSettings(DEFAULT_SETTINGS, { shopName: b.shopName, phone, lang: asLang(b.lang) }, true);
  if (!settings || !settings.shopName) throw new ApiError(400, 'bad_name');
  if (!(await allow(c.db, 'setup', 20, 3600, c.now))) throw new ApiError(429, 'too_many');

  const code = recoveryCode();
  const owner = JSON.stringify({ recovery: await sha256('rec:' + normRecovery(code)), at: c.now });
  const res = await q(() =>
    c.db
      .prepare(`INSERT INTO meta (k, v) SELECT 'owner', ?1 WHERE NOT EXISTS (SELECT 1 FROM meta WHERE k = 'owner')`)
      .bind(owner)
      .run(),
  );
  if (res.meta.changes !== 1) throw new ApiError(409, 'already_setup');
  await q(() => c.db.batch([setMetaStmt(c.db, 'settings', JSON.stringify(settings)), setMetaStmt(c.db, 'origin', c.url.origin)]));
  await startSession(c);
  return json(c, { ok: true, recovery: code });
}

export async function login(c: Ctx): Promise<Response> {
  const b = await body(c);
  const raw = typeof b.code === 'string' ? b.code.trim().slice(0, 64) : '';
  if (!raw) throw new ApiError(400, 'bad_code');
  const okIp = await allow(c.db, 'login:' + (await sha256('ip:' + c.ip)).slice(0, 16), 8, 900, c.now);
  const okAll = await allow(c.db, 'login:all', 60, 3600, c.now);
  if (!okIp || !okAll) throw new ApiError(429, 'too_many');

  let ok = false;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 6 && digits.length >= raw.replace(/\s/g, '').length) {
    // pairing code: single use, removed atomically
    const row = await q(async () =>
      c.db
        .prepare(`DELETE FROM pair_codes WHERE code_hash = ? AND expires_at > ? RETURNING code_hash`)
        .bind(await sha256('pair:' + digits), c.now)
        .first(),
    );
    ok = !!row;
  } else {
    const meta = await q(() => c.db.prepare(`SELECT v FROM meta WHERE k = 'owner'`).first<{ v: string }>());
    const want = meta ? (JSON.parse(meta.v) as { recovery: string }).recovery : '';
    ok = !!want && want === (await sha256('rec:' + normRecovery(raw)));
  }
  if (!ok) throw new ApiError(403, 'bad_code');
  await startSession(c);
  c.wait(q(() => setMetaStmt(c.db, 'origin', c.url.origin).run()));
  return json(c, { ok: true });
}

/** A signed-in device shows a 6-digit code; typing it on another device signs that one in. */
export async function pairNew(c: Ctx): Promise<Response> {
  await barberWorld(c);
  const code = pairCode();
  await q(async () =>
    c.db.batch([
      c.db.prepare(`DELETE FROM pair_codes WHERE expires_at <= ?`).bind(c.now),
      c.db
        .prepare(`INSERT OR REPLACE INTO pair_codes (code_hash, expires_at) VALUES (?, ?)`)
        .bind(await sha256('pair:' + code), c.now + 900),
    ]),
  );
  return json(c, { code, ttl: 900 });
}

export async function logout(c: Ctx): Promise<Response> {
  const token = getCookie(c, 'b');
  if (token) {
    await q(async () =>
      c.db
        .prepare(`DELETE FROM sessions WHERE id = ?`)
        .bind(await sha256(token))
        .run(),
    );
  }
  clearCookie(c, 'b');
  return json(c, { ok: true });
}
