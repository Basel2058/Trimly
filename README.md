# Trimly ✂️

حجز مواعيد لحلاق واحد: الزبون يحجز بضغطة، والحلاق يضبط دوامه مرة واحدة، والبرنامج يتولى الباقي.
تطبيق ويب يُضاف إلى الشاشة الرئيسية على iPhone وAndroid، بثلاث لغات (العربية، العبرية، الإنجليزية)، وبتكلفة تشغيل صفر.

A booking app for a single barber. Customers book in one tap, the barber sets hours once, the software does the rest.
Installable web app (iPhone and Android), Arabic / Hebrew / English, runs on Cloudflare's free plan.

---

## النشر (مرة واحدة، حوالي 5 دقائق)

تحتاج حساب [Cloudflare](https://dash.cloudflare.com/sign-up) مجاني و Node.js 20 أو أحدث.

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

الأمر الأخير ينشئ قاعدة البيانات تلقائياً ويطبع رابط التطبيق، مثل `https://trimly.اسمك.workers.dev`.

**مهم:** بعد أول نشر يكتب `wrangler` رقم قاعدة البيانات (`database_id`) داخل `wrangler.toml`. احفظ هذا التغيير في Git حتى تستعمل النشرات القادمة القاعدة نفسها.

إذا لم تُنشأ القاعدة تلقائياً، أنشئها يدوياً ثم أضف السطر `database_id = "..."` تحت `[[d1_databases]]` وأعد النشر:

```bash
npx wrangler d1 create trimly
```

### بعد النشر

1. افتح `رابط-التطبيق/barber` **من هاتف الحلاق**، واكتب اسم الصالون ورقم الواتساب. أول من يكمل هذه الخطوة يصبح مالك الصالون، فافعلها مباشرة بعد النشر.
2. احفظ **رمز الاسترجاع** الذي يظهر (يظهر مرة واحدة فقط).
3. من زر الإعدادات ⚙️ اضبط ساعات العمل ومدة الموعد والعنوان.
4. أضف التطبيق إلى الشاشة الرئيسية وفعّل الإشعارات.
   - **Android:** يظهر زر «تثبيت».
   - **iPhone:** زر المشاركة ← «إضافة إلى الشاشة الرئيسية»، ثم افتح التطبيق وأدخل **رمز الربط** (من الإعدادات ← «ربط جهاز آخر» في المتصفح).
5. أعطِ الزبائن الرابط الرئيسي (واتساب، إنستغرام، أو QR على باب المحل).

### إذا فقد الحلاق هاتفه

- عنده رمز الاسترجاع: يفتح `/barber` على الهاتف الجديد ويدخله.
- لا يملك الرمز: نفّذ الأمر التالي، ثم افتح `/barber` وأعد الإعداد. المواعيد والإعدادات تبقى كما هي.

```bash
npx wrangler d1 execute trimly --remote --command "DELETE FROM meta WHERE k='owner'; DELETE FROM sessions;"
```

---

## How it works

### Customer (no account, no app to install)

- Opens the link and sees the next free time with one button: **Book 16:30**.
- First time only: types name and mobile number. After that the phone remembers them and booking is a single tap.
- Opening the same link again shows their appointment with **Change**, **Cancel** and **Add to Calendar**.
  The calendar entry reminds them (a day before and an hour before) and contains a private link to the appointment.
- Nobody can see anyone else's name, number or appointment.

### Barber

- Sets working hours once. Every day after that: open the app and read the list.
- Tap a free time to add a walk-in or a break. Tap an appointment to send it on WhatsApp, move it, cancel it or mark a no-show.
- **Today's hours** (start late, finish early, stay longer, day off): affected customers are moved automatically to the nearest free time, and a ready WhatsApp message is prepared for each.
- **I'm running late**: customers see it on their page, plus a ready WhatsApp message for each waiting customer.
- New bookings, changes and cancellations arrive as push notifications; a summary arrives each morning.

### Problems the software handles by itself

| Problem | What happens |
| --- | --- |
| Two people want the same time | The database accepts exactly one, whatever the timing |
| Customer forgets the appointment | Phone calendar reminders; the same link always shows the appointment |
| Customer arrives late | The time is held for a grace period (10 min by default). After it, the customer's page offers the next free time; the barber's screen says whether there is still enough time and moves the customer with one tap |
| Habitual latecomers | After two late changes they quietly get earlier reminders and a hidden buffer after their visit |
| No-shows | The barber taps **No-show**. After two in six months, online booking pauses for that number and resumes by itself later |
| Prank or bulk bookings | One upcoming appointment per number, limits per connection, a global circuit breaker |
| Weak connection | Requests retry automatically and can never create a duplicate. If the reply to a booking is lost, the phone recovers the appointment by itself next time. The barber's list stays readable offline |
| Old data | Deleted automatically after 90 days |

---

## Security

- Customers have no passwords. An appointment is reachable only through a signed, unguessable link or the HttpOnly cookie on the device that made it. Knowing a phone number gives no access.
- The barber signs in once per device; new devices pair with a 6-digit one-time code. Sign-in attempts are rate limited.
- Same-origin JSON only (CSRF-safe), strict Content-Security-Policy, HTTPS enforced, all SQL parameterised, user text is never inserted as HTML.
- No third-party scripts, fonts or trackers.

Because there is no SMS verification (it would cost money per message), a phone number is not proven to belong to the person who typed it. The limits above keep abuse small, and the barber can undo a wrongly counted no-show from the appointment sheet.

## Cost and limits

Runs on Cloudflare's free plan: static files are unmetered, and the API uses a few requests per visit out of 100,000 per day. No SMS, no paid services.

Current scope, on purpose:

- One barber, one service length.
- One upcoming online appointment per phone number (the barber can add more by hand, for example a father and son).
- Working hours can run past midnight (up to 06:00), with at most one break per day.
- Time zone is `Asia/Jerusalem` (`src/time.ts`).
- Payments are not included.

## Development

```bash
npm run dev
```

```bash
npm test
```

`npm test` runs type checking, unit tests, API tests against the real Worker with a local database, and browser tests on iPhone-sized and Android-sized screens (`npx playwright install chromium` is needed once).

| Path | Contents |
| --- | --- |
| `src/slots.ts`, `src/time.ts` | Scheduling and time-zone logic (pure functions) |
| `src/customer.ts`, `src/barber.ts`, `src/auth.ts` | API handlers |
| `src/world.ts`, `src/db.ts` | Guarded SQL, self-creating schema, automatic retries |
| `src/push.ts`, `src/ics.ts` | Web Push and calendar export |
| `public/` | The web app: plain HTML, CSS and JavaScript modules, no build step |
| `test/` | Unit, API and browser tests |

Logs: `npx wrangler tail`. The Worker never needs a manual migration: tables are created and upgraded on first use.
