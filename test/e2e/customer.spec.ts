import { NOW, TUE, WED, apiBook, at, barberDay, barberPost, bookViaUi, clock, customerState, expect, test } from './helpers';

test.use({ extraHTTPHeaders: { 'x-test-now': String(NOW) } });

test('a new customer books in three taps and the phone remembers the appointment', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('h1')).toHaveText('صالون أحمد');
  await expect(page.locator('#hero .hero-time')).toHaveText('09:00');

  await page.click('#hero .btn'); // tap 1
  await page.fill('.sheet input[name=name]', 'أحمد خليل');
  await page.fill('.sheet input[name=tel]', '050-123 4567');
  await page.click('.sheet button[type=submit]'); // tap 2 (after typing once, ever)

  await expect(page.locator('#appt .hero-time')).toHaveText('09:00');
  await expect(page.locator('#appt')).toContainText('تم الحجز');
  await expect(page.locator('#appt')).toContainText('محفوظ لك حتى 09:10');

  // the calendar button suits the phone: Apple Calendar file on iPhone, Google Calendar on Android
  const href = await page.locator('#add-cal').getAttribute('href');
  if (info.project.name === 'android') expect(href).toContain('calendar.google.com');
  else expect(href).toMatch(/^\/api\/ics\?t=/);

  // closing and reopening the page (same link, no login) shows the appointment again
  await page.reload();
  await expect(page.locator('#appt .hero-time')).toHaveText('09:00');
  await expect(page.locator('#appt')).toContainText('موعدك');
  expect(errors).toEqual([]);
});

test('typing mistakes are explained next to the field', async ({ page }) => {
  await page.goto('/');
  await page.click('#hero .btn');
  await page.click('.sheet button[type=submit]');
  await expect(page.locator('.sheet .err').first()).toHaveText('اكتب اسمك من فضلك');
  await page.fill('.sheet input[name=name]', 'سامي');
  await page.fill('.sheet input[name=tel]', '12345');
  await page.click('.sheet button[type=submit]');
  await expect(page.locator('.sheet .field.bad .err')).toHaveText('رقم الجوال غير صحيح');
  await page.fill('.sheet input[name=tel]', '0401234567'); // looks long enough but is not a mobile number
  await page.click('.sheet button[type=submit]');
  await expect(page.locator('.sheet .field.bad .err')).toHaveText('رقم الجوال غير صحيح');
  await page.fill('.sheet input[name=tel]', '0521234567');
  await page.click('.sheet button[type=submit]');
  await expect(page.locator('#appt .hero-time')).toHaveText('09:00');
});

test('a returning customer books with a single tap', async ({ page, context }) => {
  await bookViaUi(page, '10:00');
  await clock(context, at(WED, '08:00')); // the next day
  await page.reload();
  await expect(page.locator('.hello')).toContainText('أهلاً أحمد خليل');
  await page.click('#hero .btn'); // the only tap
  await expect(page.locator('#appt .hero-time')).toHaveText('09:00');
  await expect(page.locator('.sheet')).toHaveCount(0);
});

test('"not you?" forgets the person on a shared phone', async ({ page, context }) => {
  await bookViaUi(page, '10:00');
  await clock(context, at(WED, '08:00'));
  await page.reload();
  await page.click('#not-you');
  await expect(page.locator('.hello')).toHaveCount(0);
  await page.click('#hero .btn');
  await expect(page.locator('.sheet input[name=name]')).toHaveValue('');
});

test('changing the time and cancelling', async ({ page }) => {
  await bookViaUi(page, '15:00');
  await page.click('text=تغيير الموعد');
  await expect(page.locator('.section')).toHaveText('اختر وقتاً جديداً');
  await page.locator('#days .day').nth(1).click();
  await page.locator('#chips .chip', { hasText: '11:30' }).click();
  await page.click('.sheet.show >> text=تأكيد التغيير');
  await expect(page.locator('#appt .hero-time')).toHaveText('11:30');
  await expect(page.locator('#appt .hero-day')).toContainText('غداً');
  await expect(page.locator('.toast')).toHaveText('تم تغيير الموعد');

  await page.click('text=إلغاء الموعد');
  await page.click('.sheet.show >> text=نعم، ألغِ الموعد');
  await expect(page.locator('#hero')).toBeVisible();
  await expect(page.locator('#appt')).toHaveCount(0);
  await page.locator('#days .day').nth(1).click();
  await expect(page.locator('#chips .chip', { hasText: '11:30' })).toBeVisible(); // free again
});

test('the private link opens the appointment on any device, and the address bar is cleaned', async ({ page, browser }) => {
  await bookViaUi(page, '10:00');
  const token = (await customerState(page)).appt.token as string;
  const other = await browser.newContext({ extraHTTPHeaders: { 'x-test-now': String(NOW) }, locale: 'ar' });
  const p2 = await other.newPage();
  await p2.goto('/a/' + token);
  await expect(p2.locator('#appt .hero-time')).toHaveText('10:00');
  expect(new URL(p2.url()).pathname).toBe('/');
  await p2.reload(); // remembered from now on
  await expect(p2.locator('#appt .hero-time')).toHaveText('10:00');
  // a made-up link shows the normal page and nobody's data
  const p3 = await (await browser.newContext({ extraHTTPHeaders: { 'x-test-now': String(NOW) }, locale: 'ar' })).newPage();
  await p3.goto('/a/' + token.slice(0, -3) + 'abc');
  await expect(p3.locator('#hero')).toBeVisible();
  await expect(p3.locator('body')).not.toContainText('أحمد خليل');
  await other.close();
});

test('a late customer is offered the next free time — no awkward conversation', async ({ page, context, request }) => {
  await bookViaUi(page, '10:00');
  await apiBook(request, at(TUE, '10:30'), 'التالي', '0507000001');
  await clock(context, at(TUE, '09:30'));
  await page.reload();
  await expect(page.locator('.actions .btn').first()).toHaveText('سأتأخر'); // close to the time, "change" becomes "I'll be late"

  await clock(context, at(TUE, '10:15')); // the 10-minute grace period has passed
  await page.reload();
  await expect(page.locator('#appt')).toContainText('انتهت مهلة موعدك');
  await expect(page.locator('#appt')).toContainText('كان موعدك محفوظاً حتى 10:10');
  await page.click('#appt .btn');
  await expect(page.locator('#appt .hero-time')).toHaveText('11:00');
  await expect(page.locator('#appt')).toContainText('محفوظ لك حتى 11:10');
});

test('someone else takes the time first: a clear message and fresh times', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('#chips .chip', { hasText: '10:00' })).toBeVisible();
  await apiBook(request, at(TUE, '10:00'), 'أسرع', '0507000002'); // booked while our page is open
  await page.locator('#chips .chip', { hasText: '10:00' }).click();
  await page.fill('.sheet input[name=name]', 'أحمد');
  await page.fill('.sheet input[name=tel]', '0501234567');
  await page.click('.sheet button[type=submit]');
  await expect(page.locator('.toast')).toHaveText('هذا الوقت حُجز للتو، اختر وقتاً آخر');
  await expect(page.locator('#chips .chip', { hasText: '10:00' })).toHaveCount(0);
  await expect(page.locator('#chips .chip', { hasText: '10:30' })).toBeVisible();
});

test('a phone number that already has an appointment gets guidance, not someone else’s details', async ({ page, request }) => {
  await apiBook(request, at(TUE, '12:00'), 'صاحب الرقم', '0501234567');
  await page.goto('/');
  await page.click('#hero .btn');
  await page.fill('.sheet input[name=name]', 'شخص آخر');
  await page.fill('.sheet input[name=tel]', '0501234567');
  await page.click('.sheet button[type=submit]');
  await expect(page.locator('.sheet.show h2')).toHaveText('يوجد موعد بهذا الرقم');
  await expect(page.locator('.sheet.show')).not.toContainText('12:00');
  await expect(page.locator('body')).not.toContainText('صاحب الرقم');
  await expect(page.locator('.sheet.show a.btn')).toHaveAttribute('href', /^https:\/\/wa\.me\/972509999999/);
});

test('three languages, each in the right direction, remembered next time', async ({ page }) => {
  await page.goto('/');
  await page.click('.top .pill');
  await page.click('.sheet.show >> text=English');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#hero .label')).toHaveText('Next available');
  await expect(page.locator('#hero .btn')).toHaveText('Book 09:00');
  await page.click('.top .pill');
  await page.click('.sheet.show >> text=עברית');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.locator('#hero .label')).toHaveText('התור הקרוב');
  await page.reload();
  await expect(page.locator('#hero .label')).toHaveText('התור הקרוב');
  await expect(page.locator('#days .day').nth(1)).toContainText('יום ד׳');
});

test('the barber’s changes reach the customer’s page: delay, move, cancel', async ({ page, owner }) => {
  await bookViaUi(page, '12:00');
  const id = (await barberDay(owner, TUE)).appts[0].id as string;

  await barberPost(owner, 'delay', { min: 20 });
  await page.reload();
  await expect(page.locator('.banner.warn')).toHaveText('يوجد تأخير بسيط: حوالي 20 دقيقة');

  await barberPost(owner, 'move', { id, start: at(TUE, '14:00') });
  await page.reload();
  await expect(page.locator('#appt .hero-time')).toHaveText('14:00');
  await expect(page.locator('.banner.info')).toContainText('تغيّر موعدك (كان اليوم الساعة 12:00)');

  await barberPost(owner, 'cancel', { id });
  await page.reload();
  await expect(page.locator('.banner.bad')).toContainText('نعتذر، أُلغي موعدك (اليوم الساعة 14:00)');
  await expect(page.locator('#hero')).toBeVisible();
});

test('two no-shows: the page politely points to the barber instead of offering times', async ({ page, context, owner }) => {
  for (const d of [TUE, WED]) {
    await clock(context, at(d, '08:00'));
    await context.clearCookies();
    await bookViaUi(page, '10:00');
    const day = await barberDay(owner, d, at(d, '11:00'));
    await barberPost(owner, 'noshow', { id: day.appts[0].id }, at(d, '11:00'));
  }
  await clock(context, at('2026-11-12', '08:00'));
  await page.reload();
  await expect(page.locator('#blocked')).toContainText('الحجز عبر التطبيق متوقف مؤقتاً');
  await expect(page.locator('#hero')).toHaveCount(0);
  await expect(page.locator('.foot a').last()).toHaveAttribute('href', /wa\.me\/972509999999/);
});

test('the app still opens without a connection and recovers by itself', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#hero')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise((r) => setTimeout(r, 800))));
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.card')).toContainText('لا يوجد اتصال بالإنترنت', { timeout: 20000 });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#hero')).toBeVisible({ timeout: 20000 });
});

test('the page works on a small, old phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expect(page.locator('#hero')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.click('#hero .btn');
  await expect(page.locator('.sheet button[type=submit]')).toBeInViewport();
});
