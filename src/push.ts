// Web Push (RFC 8291 / 8188 / 8292) with WebCrypto only — free notifications to the barber's phone.
import { b64url, randomBytes, unb64url, utf8 } from './core';
import { q } from './db';
import type { Ctx } from './http';
import { dayTime, msg } from './msg';
import { localParts, timeOf } from './time';
import type { World } from './world';

export interface Vapid {
  publicKey: string; // raw P-256 point, base64url
  privateJwk: JsonWebKey;
}

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/** Encrypts a push message body (aes128gcm content encoding). */
export async function encryptPayload(plain: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = unb64url(p256dh);
  const authSecret = unb64url(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, ecdh, false, []);
  const local = (await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256),
  );
  const salt = randomBytes(16);
  const ikm = await hkdf(authSecret, shared, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plain, new Uint8Array([2]))));
  const head = new Uint8Array(86);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = 65;
  head.set(asPublic, 21);
  return concat(head, cipher);
}

export async function generateVapid(): Promise<Vapid> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    publicKey: b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    privateJwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey,
  };
}

export async function vapidJwt(v: Vapid, audience: string, subject: string, now: number): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (o: unknown): string => b64url(utf8(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: now + 12 * 3600, sub: subject })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

/** The server's push identity; created on first use and kept in the database. */
export async function getVapid(c: Ctx, stored?: string): Promise<Vapid> {
  if (stored) return JSON.parse(stored) as Vapid;
  const fresh = JSON.stringify(await generateVapid());
  const res = await q(() =>
    c.db.batch([
      c.db.prepare(`INSERT OR IGNORE INTO meta (k, v) VALUES ('vapid', ?)`).bind(fresh),
      c.db.prepare(`SELECT v FROM meta WHERE k = 'vapid'`),
    ]),
  );
  return JSON.parse((res[1]!.results[0] as { v: string }).v) as Vapid;
}

export function validEndpoint(c: Ctx, endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' || (c.env.TEST_MODE === '1' && u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

export async function sendPush(c: Ctx, v: Vapid, sub: PushSub, payload: unknown): Promise<number> {
  const subject = c.url.protocol === 'https:' ? c.url.origin : 'mailto:admin@example.com';
  const jwt = await vapidJwt(v, new URL(sub.endpoint).origin, subject, c.now);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '43200',
      urgency: 'high',
      authorization: `vapid t=${jwt}, k=${v.publicKey}`,
    },
    body: await encryptPayload(utf8(JSON.stringify(payload)), sub.p256dh, sub.auth),
    signal: AbortSignal.timeout(8000),
  });
  return res.status;
}

export type PushKind = 'new' | 'cancel' | 'move' | 'test' | 'morning';

/** Tells the barber's devices about a change. Never throws: a push problem must not break a booking. */
export async function notifyBarber(
  c: Ctx,
  w: World,
  kind: PushKind,
  a: { name?: string; start?: number; prevStart?: number; n?: number } = {},
): Promise<number> {
  try {
    const subs = (await q(() => c.db.prepare(`SELECT endpoint, p256dh, auth FROM push_subs`).all<PushSub>())).results;
    if (!subs.length) return 0;
    const v = await getVapid(c, w.meta.vapid);
    const lang = w.settings.lang;
    const when = a.start ? dayTime(lang, a.start) : '';
    const who = a.name || msg(lang, 'haircut');
    let title = msg(lang, 'pTest');
    let text = '';
    if (kind === 'new') [title, text] = [msg(lang, 'pNew'), `${who} · ${when}`];
    if (kind === 'cancel') [title, text] = [msg(lang, 'pCancel'), `${who} · ${when}`];
    if (kind === 'move') [title, text] = [msg(lang, 'pMove'), `${who} · ${a.prevStart ? timeOf(a.prevStart) + ' → ' : ''}${when}`];
    if (kind === 'morning') {
      [title, text] = [msg(lang, 'pMorning'), msg(lang, 'pMorningBody', { n: a.n ?? 0, time: a.start ? timeOf(a.start) : '' })];
    }
    const payload = {
      title,
      body: text,
      tag: `${kind}:${a.start ?? ''}`,
      url: '/barber' + (a.start ? `?d=${localParts(a.start).date}` : ''),
    };
    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        const status = await sendPush(c, v, s, payload).catch(() => 0);
        if (status >= 200 && status < 300) sent++;
        // the push service says this subscription is gone: forget it
        if (status === 404 || status === 410) {
          await q(() => c.db.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).bind(s.endpoint).run());
        }
      }),
    );
    return sent;
  } catch (e) {
    console.error('push failed', (e as Error)?.message);
    return 0;
  }
}
