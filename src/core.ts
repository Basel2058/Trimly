// Small shared primitives: ids, encoding, signed tokens, input normalisation.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (u: Uint8Array): string => dec.decode(u);

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** 128-bit random id, URL safe (22 chars). */
export function randomId(): string {
  return b64url(randomBytes(16));
}

export const ID_RE = /^[A-Za-z0-9_-]{22}$/;

export async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', utf8(s)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- signed tokens (HMAC). Nothing secret is stored in the database rows themselves. ----

let cachedKey: { secret: string; key: CryptoKey } | null = null;

export async function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = await crypto.subtle.importKey('raw', unb64url(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  cachedKey = { secret, key };
  return key;
}

async function mac(key: CryptoKey, purpose: string, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, utf8(purpose + ':' + payload));
  return b64url(new Uint8Array(sig).subarray(0, 16));
}

/** `payload.mac` — payload must not contain a dot. */
export async function signToken(key: CryptoKey, purpose: string, payload: string): Promise<string> {
  return payload + '.' + (await mac(key, purpose, payload));
}

/** Returns the payload when the signature is valid, otherwise null. */
export async function verifyToken(key: CryptoKey, purpose: string, token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || token.length > 600) return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = token.slice(0, i);
  return safeEqual(token.slice(i + 1), await mac(key, purpose, payload)) ? payload : null;
}

// ---- input normalisation ----

/** Accepts Israeli mobiles (05X…) in any common spelling, or a full international number. Returns E.164. */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  let s = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[\s\-().‎‏‪-‮]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^05\d{8}$/.test(s)) return '+972' + s.slice(1);
  if (/^\+?9725\d{8}$/.test(s)) return '+' + s.replace('+', '');
  if (/^\+?97205\d{8}$/.test(s)) return '+972' + s.replace('+', '').slice(4);
  if (/^\+[1-9]\d{7,14}$/.test(s) && !s.startsWith('+972')) return s;
  return null;
}

/** 05X-XXXXXXX for Israeli numbers, E.164 otherwise. */
export function displayPhone(e164: string): string {
  const m = /^\+972(5\d)(\d{7})$/.exec(e164);
  return m ? `0${m[1]}-${m[2]}` : e164;
}

export function maskPhone(e164: string): string {
  const d = displayPhone(e164);
  return d.slice(0, 3) + '•••••' + d.slice(-2);
}

/** Human name: trimmed, single spaces, no control characters, 2–40 chars. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 2 || s.length > 40) return null;
  return s;
}

export type Lang = 'ar' | 'he' | 'en';
export const asLang = (v: unknown, fallback: Lang = 'ar'): Lang => (v === 'ar' || v === 'he' || v === 'en' ? v : fallback);
