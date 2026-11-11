// Request context, errors, cookies, body parsing.
import type { Env } from './db';
import type { Lang } from './core';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface Ctx {
  env: Env;
  db: D1Database;
  req: Request;
  url: URL;
  /** one consistent "now" (epoch seconds) for the whole request */
  now: number;
  ip: string;
  secure: boolean;
  wait: (p: Promise<unknown>) => void;
  cookiesOut: string[];
}

export const COOKIE_AGE = 400 * 86400;

export interface ApptRow {
  id: string;
  kind: 'customer' | 'manual' | 'block';
  phone: string;
  name: string;
  lang: Lang;
  start_at: number;
  end_at: number;
  dur_min: number;
  status: 'booked' | 'cancelled' | 'no_show';
  cancelled_by: string | null;
  seq: number;
  moved_by: string | null;
  prev_start: number | null;
  created_at: number;
  updated_at: number;
}

export function json(c: Ctx, data: unknown, status = 200): Response {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  for (const ck of c.cookiesOut) h.append('set-cookie', ck);
  return new Response(JSON.stringify(data), { status, headers: h });
}

const cookieName = (c: Ctx, name: string): string => (c.secure ? '__Host-tr_' : 'tr_') + name;

export function getCookie(c: Ctx, name: string): string | null {
  const header = c.req.headers.get('cookie');
  if (!header) return null;
  const want = cookieName(c, name);
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === want) return part.slice(i + 1).trim();
  }
  return null;
}

export function setCookie(c: Ctx, name: string, value: string, maxAge = COOKIE_AGE): void {
  c.cookiesOut.push(
    `${cookieName(c, name)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${c.secure ? '; Secure' : ''}`,
  );
}

export const clearCookie = (c: Ctx, name: string): void => setCookie(c, name, '', 0);

/** Parsed JSON object body (small, same-origin only — the origin check lives in the router). */
export async function body(c: Ctx): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.length > 16000) throw new ApiError(413, 'too_large');
  if (!text) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'bad_json');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'bad_json');
  return v as Record<string, unknown>;
}
