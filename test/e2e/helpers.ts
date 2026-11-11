import { expect, test as base, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { randomId } from '../../src/core';
import { localToEpoch } from '../../src/time';

export const BASE = 'http://127.0.0.1:8798';
export const TUE = '2026-11-10';
export const WED = '2026-11-11';

export const at = (date: string, time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return localToEpoch(date, h! * 60 + m!);
};
export const NOW = at(TUE, '08:00');

const headers = (now: number, ip?: string): Record<string, string> => ({
  origin: BASE,
  'content-type': 'application/json',
  'x-test-now': String(now),
  ...(ip ? { 'x-test-ip': ip } : {}),
});

export async function reset(request: APIRequestContext): Promise<void> {
  expect((await request.post('/api/test/reset', { headers: headers(NOW), data: {} })).ok()).toBe(true);
}

/** Sets the app's clock for everything this browser context does. */
export async function clock(context: BrowserContext, now: number): Promise<void> {
  await context.setExtraHTTPHeaders({ 'x-test-now': String(now) });
}

/** Creates the shop through the API using the page's own cookie jar, so the page is signed in as the barber. */
export async function setupShop(page: Page, now = NOW, settings: Record<string, unknown> = {}): Promise<string> {
  const r = await page.request.post('/api/b/setup', { headers: headers(now), data: { shopName: 'صالون أحمد', phone: '0509999999', lang: 'ar' } });
  expect(r.ok()).toBe(true);
  if (Object.keys(settings).length) {
    expect((await page.request.post('/api/b/settings', { headers: headers(now), data: settings })).ok()).toBe(true);
  }
  return (await r.json()).recovery;
}

let n = 0;
/** A booking made by some other customer, straight through the API. Returns their private token. */
export async function apiBook(request: APIRequestContext, start: number, name: string, phone: string, now = NOW): Promise<string> {
  const r = await request.post('/api/book', { headers: headers(now, `10.7.0.${++n % 250}`), data: { start, id: randomId(), lang: 'ar', name, phone } });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).appt.token;
}

export async function barberPost(page: Page, path: string, data: Record<string, unknown>, now = NOW): Promise<any> {
  const r = await page.request.post('/api/b/' + path, { headers: headers(now), data });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}

/** Opens the customer page and books `time` as a brand-new customer through the real UI. */
export async function bookViaUi(page: Page, time: string, name = 'أحمد خليل', phone = '050-1234567'): Promise<void> {
  await page.goto('/');
  await page.locator('#chips .chip', { hasText: time }).first().click();
  await page.fill('.sheet input[name=name]', name);
  await page.fill('.sheet input[name=tel]', phone);
  await page.click('.sheet button[type=submit]');
  await expect(page.locator('#appt .hero-time')).toHaveText(time);
}

export async function barberDay(page: Page, date: string, now = NOW): Promise<any> {
  const r = await page.request.get(`/api/b/day?date=${date}`, { headers: { 'x-test-now': String(now) } });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}

export const customerState = async (page: Page, now = NOW): Promise<any> =>
  (await page.request.get('/api/state', { headers: { 'x-test-now': String(now) } })).json();

/**
 * Every test starts from an empty database with the shop already claimed.
 * `owner` is the barber's own browser (a separate cookie jar from the customer's `page`).
 */
export const test = base.extend<{ owner: Page }>({
  owner: [
    async ({ browser, request }, use) => {
      await reset(request);
      const ctx = await browser.newContext({ locale: 'ar', extraHTTPHeaders: { 'x-test-now': String(NOW) } });
      const page = await ctx.newPage();
      await setupShop(page);
      await use(page);
      await ctx.close();
    },
    { auto: true },
  ],
});
export { expect };
