import type { Page } from '@playwright/test';
import { NOW, TUE, WED, apiBook, at, barberDay, clock, customerState, expect, reset, test } from './helpers';

test.use({ extraHTTPHeaders: { 'x-test-now': String(NOW) } });

/** The decoded text of a ready-made WhatsApp link. */
const waText = async (page: Page, selector: string): Promise<{ to: string; text: string }> => {
  const href = (await page.locator(selector).first().getAttribute('href'))!;
  const u = new URL(href);
  expect(u.origin).toBe('https://wa.me');
  return { to: u.pathname.slice(1), text: u.searchParams.get('text')! };
};

test('first visit: set up the shop once, keep the recovery code, land on today', async ({ page, request }) => {
  await reset(request); // start unclaimed
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/barber');
  await expect(page.locator('h1')).toHaveText('إعداد الصالون');
  await page.click('button[type=submit]');
  await expect(page.locator('.field.bad')).toHaveCount(1); // a name is required
  await page.fill('input[name=shop]', 'صالون سامي');
  await page.fill('input[name=tel]', '052-1234567');
  await page.click('button[type=submit]');
  const code = (await page.locator('#recovery').innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  await page.click('text=حفظته');
  await expect(page.locator('h1')).toHaveText('اليوم');
  await expect(page.locator('#timeline .item.free')).toHaveCount(22);
  await expect(page.locator('#hours')).toContainText('09:00');

  // the device simply stays signed in
  await page.reload();
  await expect(page.locator('#timeline')).toBeVisible();

  // a stranger gets the sign-in screen, and a wrong code is refused
  const other = await page.context().browser()!.newContext({ locale: 'ar', extraHTTPHeaders: { 'x-test-now': String(NOW) } });
  const p2 = await other.newPage();
  await p2.goto('/barber');
  await expect(p2.locator('h1')).toHaveText('دخول الحلاق');
  await p2.fill('input[name=code]', '123456');
  await p2.click('button[type=submit]');
  await expect(p2.locator('.field.bad .err')).toHaveText('الرمز غير صحيح');
  // the recovery code works
  await p2.fill('input[name=code]', code);
  await p2.click('button[type=submit]');
  await expect(p2.locator('#timeline')).toBeVisible();
  await other.close();
  expect(errors).toEqual([]);
});

test('a second device pairs with the 6-digit code from settings', async ({ owner, browser }) => {
  await owner.goto('/barber');
  await owner.click('#settings');
  await owner.click('.sheet.show >> text=رمز الربط');
  const code = (await owner.locator('#pair-code').innerText()).replace(/\D/g, '');
  expect(code).toMatch(/^\d{6}$/);
  const ctx = await browser.newContext({ locale: 'ar', extraHTTPHeaders: { 'x-test-now': String(NOW) } });
  const p2 = await ctx.newPage();
  await p2.goto('/barber');
  await p2.fill('input[name=code]', code);
  await p2.click('button[type=submit]');
  await expect(p2.locator('#timeline')).toBeVisible();
  await ctx.close();
});

test('the day at a glance: bookings appear, a walk-in is added, the link goes out on WhatsApp', async ({ owner, request }) => {
  await apiBook(request, at(TUE, '10:00'), 'أحمد خليل', '0501234567');
  await owner.goto('/barber');
  await expect(owner.locator('#now')).toContainText('التالي');
  await expect(owner.locator('#now')).toContainText('أحمد خليل');
  await expect(owner.locator('#now')).toContainText('10:00');
  await expect(owner.locator('#days .day.on .dot')).toHaveText('1');
  const row = owner.locator('#timeline .item[data-id]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('050-1234567');

  // tap a free time → name + phone → saved
  await owner.locator('#timeline .item.free', { hasText: '11:00' }).click();
  await owner.fill('.sheet.show input[name=name]', 'أبو سامي');
  await owner.fill('.sheet.show input[name=tel]', '0527654321');
  await owner.click('.sheet.show button[type=submit]');
  await expect(owner.locator('.sheet.show h2')).toHaveText('تم الحجز. أرسل له الموعد؟');
  const wa = await waText(owner, '.sheet.show a.btn.green');
  expect(wa.to).toBe('972527654321');
  expect(wa.text).toContain('مرحباً أبو سامي، موعدك عند صالون أحمد: اليوم الساعة 11:00.');
  const link = wa.text.match(/https?:\/\/\S+\/a\/\S+/)![0];
  await owner.click('.sheet.show button:text-is("تم")');
  await expect(owner.locator('#timeline .item[data-id]')).toHaveCount(2);

  // the link really opens that appointment for the customer
  const visitor = await owner.context().browser()!.newContext({ locale: 'ar', extraHTTPHeaders: { 'x-test-now': String(NOW) } });
  const vp = await visitor.newPage();
  await vp.goto(new URL(link).pathname);
  await expect(vp.locator('#appt .hero-time')).toHaveText('11:00');
  await visitor.close();

  // an empty form blocks a break
  await owner.locator('#timeline .item.free', { hasText: '13:00' }).click();
  await owner.click('.sheet.show button[type=submit]');
  await expect(owner.locator('#timeline .item[data-id]', { hasText: 'استراحة' })).toHaveCount(1);
});

test('names are always shown as plain text (no script injection)', async ({ owner, request }) => {
  await apiBook(request, at(TUE, '10:00'), '<img src=x onerror=window.__xss=1>', '0501234567');
  await owner.goto('/barber');
  await expect(owner.locator('#timeline .item[data-id] b')).toHaveText('<img src=x onerror=window.__xss=1>');
  await owner.locator('#timeline .item[data-id]').click();
  await expect(owner.locator('.sheet.show h2')).toHaveText('<img src=x onerror=window.__xss=1>');
  expect(await owner.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(await owner.locator('#app img, .sheet img').count()).toBe(0);
});

test('a customer who never came: one tap marks it, another undoes it', async ({ owner, request }) => {
  await apiBook(request, at(TUE, '10:00'), 'أحمد خليل', '0501234567');
  await clock(owner.context(), at(TUE, '10:45'));
  await owner.goto('/barber');
  await owner.locator('#timeline .item[data-id]').click();
  await owner.click('.sheet.show >> text=لم يحضر');
  await expect(owner.locator('#timeline .item[data-id] .tag.red')).toHaveText('لم يحضر');
  await owner.locator('#timeline .item[data-id]').click();
  await owner.click('.sheet.show >> text=تراجع: حضر');
  await expect(owner.locator('#timeline .item[data-id] .tag')).toHaveCount(0);
});

test('a customer arrives late: the screen gives the verdict and moves them with one tap', async ({ owner, request, browser }) => {
  const lateToken = await apiBook(request, at(TUE, '10:00'), 'المتأخر', '0501111111');
  await apiBook(request, at(TUE, '10:30'), 'في وقته', '0502222222');

  // within the grace period nothing special is shown
  await clock(owner.context(), at(TUE, '10:05'));
  await owner.goto('/barber');
  await expect(owner.locator('#now')).toContainText('المتأخر');
  await expect(owner.locator('#verdict')).toHaveCount(0);

  // after it: starting now would run into the 10:30 customer
  await clock(owner.context(), at(TUE, '10:15'));
  await owner.reload();
  await expect(owner.locator('#verdict')).toHaveText('الوقت لا يكفي');
  await owner.click('#now >> text=انقله إلى 11:00');
  await expect(owner.locator('#timeline .item[data-id]', { hasText: 'المتأخر' })).toContainText('11:00');
  await expect(owner.locator('#timeline .item[data-id]', { hasText: 'المتأخر' }).locator('.tag.orange')).toHaveText('وصل متأخراً');
  await expect(owner.locator('#now')).toContainText('في وقته'); // the next customer is not delayed

  // the late customer's own page already shows the new time
  const ctx = await browser.newContext({ locale: 'ar', extraHTTPHeaders: { 'x-test-now': String(at(TUE, '10:16')) } });
  const cp = await ctx.newPage();
  await cp.goto('/a/' + lateToken);
  await expect(cp.locator('#appt .hero-time')).toHaveText('11:00');
  await ctx.close();
});

test('when the next slot is free, a late arrival is simply fine', async ({ owner, request }) => {
  await apiBook(request, at(TUE, '10:00'), 'المتأخر', '0501111111');
  await clock(owner.context(), at(TUE, '10:20'));
  await owner.goto('/barber');
  await expect(owner.locator('#verdict')).toHaveText('الوقت يكفي');
  await expect(owner.locator('#now >> text=انقله')).toHaveCount(0);
});

test('finishing early: affected customers are moved and each gets a ready message', async ({ owner, request, page }) => {
  await apiBook(request, at(TUE, '17:30'), 'يبقى', '0501111111');
  const movedToken = await apiBook(request, at(TUE, '18:30'), 'ينتقل', '0502222222');
  await owner.goto('/barber');
  await owner.click('#hours');
  await owner.locator('.sheet.show input[type=time]').nth(1).fill('18:00');
  await owner.click('.sheet.show >> text=حفظ');
  await expect(owner.locator('.sheet.show h2').first()).toHaveText('مواعيد تم نقلها: 1');
  await expect(owner.locator('#moved .item')).toContainText('ينتقل');
  await expect(owner.locator('#moved .item')).toContainText('18:30');
  const wa = await waText(owner, '#moved a');
  expect(wa.to).toBe('972502222222');
  expect(wa.text).toContain('تغيّر موعدك عند صالون أحمد إلى اليوم الساعة 17:00');
  expect(wa.text).toContain('/a/' + movedToken);
  await owner.click('.sheet.show button:text-is("تم")');
  await expect(owner.locator('#hours')).toContainText('18:00');
  await expect(owner.locator('#timeline .item[data-id]')).toHaveCount(2);

  // customers can no longer see the removed hours
  await page.goto('/');
  await expect(page.locator('#chips .chip').last()).toHaveText('16:30');

  // back to normal hours
  await owner.click('#hours');
  await owner.click('.sheet.show >> text=العودة للدوام المعتاد');
  await expect(owner.locator('#hours')).toContainText('20:00');
});

test('a day off: everyone is moved to another day automatically', async ({ owner, request }) => {
  const token = await apiBook(request, at(WED, '12:00'), 'زبون الأربعاء', '0501111111');
  await owner.goto('/barber');
  await owner.locator('#days .day').nth(1).click();
  await expect(owner.locator('h1')).toHaveText('غداً');
  await owner.click('#hours');
  await owner.click('.sheet.show >> text=يوم عطلة');
  await expect(owner.locator('#moved .item')).toContainText('زبون الأربعاء');
  await owner.click('.sheet.show button:text-is("تم")');
  await expect(owner.locator('#hours')).toContainText('عطلة');
  await expect(owner.locator('#timeline')).toHaveCount(0);
  const st = await (await owner.request.get('/api/state', { headers: { 'x-test-now': String(NOW), 'x-appt-token': token } })).json();
  expect(st.appt).toMatchObject({ date: '2026-11-12', time: '12:00' });
});

test('"I am running late": one tap, then a message per waiting customer', async ({ owner, request, page }) => {
  const token = await apiBook(request, at(TUE, '10:00'), 'أحمد', '0501111111');
  await apiBook(request, at(WED, '10:00'), 'غداً', '0502222222');
  await clock(owner.context(), at(TUE, '09:30'));
  await owner.goto('/barber');
  await owner.click('#late');
  await owner.locator('.sheet.show .chip', { hasText: '15' }).click();
  await expect(owner.locator('.sheet.show h2')).toHaveText('متأخر 15 د');
  await expect(owner.locator('.sheet.show .item')).toHaveCount(1); // only today's customers
  const wa = await waText(owner, '.sheet.show .item a');
  expect(wa.text).toContain('يوجد تأخير حوالي 15 دقيقة. موعدك (10:00) سيبدأ تقريباً 10:15');
  await owner.click('.sheet.show button:text-is("تم")');
  await expect(owner.locator('#late')).toHaveText('متأخر 15 د');

  await clock(page.context(), at(TUE, '09:31'));
  await page.goto('/a/' + token);
  await expect(page.locator('.banner.warn')).toContainText('15');
});

test('settings: hours and slot length are set once and apply to customers immediately', async ({ owner, page }) => {
  await owner.goto('/barber');
  await owner.click('#settings');
  const sheet = owner.locator('.sheet.show');
  await sheet.locator('input[name=address]').fill('شارع بولس السادس 12، الناصرة');
  await sheet.locator('select').first().selectOption('20'); // appointment length
  // close on Wednesdays (4th row: Sunday is first)
  await sheet.locator('#week .hours-row').nth(3).locator('input.switch').first().uncheck();
  // Tuesdays 10:00–14:00
  const tue = sheet.locator('#week .hours-row').nth(2);
  await tue.locator('input[type=time]').nth(0).fill('10:00');
  await tue.locator('input[type=time]').nth(1).fill('14:00');
  await sheet.locator('text=حفظ').first().click();
  await expect(owner.locator('.toast')).toHaveText('تم الحفظ');
  await expect(owner.locator('#hours')).toContainText('10:00');
  await expect(owner.locator('#timeline .item.free')).toHaveCount(12);

  await page.goto('/');
  await expect(page.locator('#hero .hero-time')).toHaveText('10:00');
  await expect(page.locator('#chips .chip').nth(1)).toHaveText('10:20');
  await expect(page.locator('#days .day').nth(1)).toHaveClass(/empty/); // Wednesday is closed
  await expect(page.locator('.foot a').first()).toHaveAttribute('href', /maps/);
  const st = await customerState(page);
  expect(st.shop.address).toBe('شارع بولس السادس 12، الناصرة');
});

test('the barber cancels: the customer gets a ready message with the booking link', async ({ owner, request }) => {
  await apiBook(request, at(TUE, '15:00'), 'أحمد خليل', '0501234567');
  await owner.goto('/barber');
  await owner.locator('#timeline .item[data-id]').click();
  await owner.click('.sheet.show >> text=إلغاء الموعد');
  await owner.click('.sheet.show >> text=نعم، ألغِ الموعد');
  await expect(owner.locator('.sheet.show h2')).toHaveText('تم إلغاء الموعد');
  const wa = await waText(owner, '.sheet.show a.btn.green');
  expect(wa.text).toContain('نعتذر، أُلغي موعدك (اليوم الساعة 15:00) عند صالون أحمد');
  expect(wa.text).toContain('http://127.0.0.1:8798');
  expect(wa.text).not.toContain('/a/');
  expect((await barberDay(owner, TUE)).appts).toEqual([]);
});

test('the dashboard keeps showing the last known day with no connection', async ({ owner, request }) => {
  await apiBook(request, at(TUE, '10:00'), 'أحمد خليل', '0501234567');
  await owner.goto('/barber');
  await expect(owner.locator('#timeline .item[data-id]')).toHaveCount(1);
  await owner.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise((r) => setTimeout(r, 800))));
  await owner.context().setOffline(true);
  await owner.reload();
  await expect(owner.locator('#timeline .item[data-id]')).toContainText('أحمد خليل', { timeout: 25000 });
  await owner.context().setOffline(false);
});

test('signing out really signs out', async ({ owner }) => {
  await owner.goto('/barber');
  await owner.click('#settings');
  await owner.click('.sheet.show >> text=تسجيل الخروج');
  await expect(owner.locator('h1')).toHaveText('دخول الحلاق');
  await owner.reload();
  await expect(owner.locator('h1')).toHaveText('دخول الحلاق');
  expect((await owner.request.get('/api/b/day')).status()).toBe(401);
});
