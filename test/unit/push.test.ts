import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { b64url, unb64url } from '../../src/core';
import { encryptPayload, generateVapid, vapidJwt } from '../../src/push';

// http_ece is the reference implementation of the push encryption standard: an independent check.
const ece = createRequire(import.meta.url)('http_ece') as { decrypt: (b: Buffer, o: Record<string, unknown>) => Buffer };

describe('web push', () => {
  it('encrypts so that a standard browser-side implementation can decrypt', async () => {
    for (const text of ['{"title":"حجز جديد","body":"أحمد · الثلاثاء 16:30"}', 'x', 'ע'.repeat(900)]) {
      const browser = createECDH('prime256v1');
      browser.generateKeys();
      const auth = randomBytes(16);
      const body = await encryptPayload(new TextEncoder().encode(text), b64url(browser.getPublicKey()), b64url(auth));
      const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: browser, authSecret: auth });
      expect(plain.toString('utf8')).toBe(text);
    }
  });
  it('uses a fresh key and salt every time', async () => {
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const args = [new TextEncoder().encode('same'), b64url(browser.getPublicKey()), b64url(randomBytes(16))] as const;
    expect(b64url(await encryptPayload(...args))).not.toBe(b64url(await encryptPayload(...args)));
  });
  it('rejects malformed subscription keys', async () => {
    await expect(encryptPayload(new Uint8Array(1), 'AAAA', 'AAAA')).rejects.toThrow();
  });
  it('signs a VAPID token that verifies with the public key', async () => {
    const v = await generateVapid();
    const jwt = await vapidJwt(v, 'https://fcm.googleapis.com', 'https://shop.example', 1000);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(unb64url(h)).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(unb64url(p)).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1000 + 43200, sub: 'https://shop.example' });
    const raw = unb64url(v.publicKey);
    expect(raw.length).toBe(65);
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(unb64url(s)))).toBe(true);
  });
});
