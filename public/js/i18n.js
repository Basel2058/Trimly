// Languages: Arabic, Hebrew, English. Dates are shown as weekday + day/month, times always 24h.
export const LANGS = ['ar', 'he', 'en'];
export const LANG_NAMES = { ar: 'العربية', he: 'עברית', en: 'English' };
const LOCALE = { ar: 'ar-u-nu-latn', he: 'he', en: 'en-GB' };

const D = {
  ar: {
    today: 'اليوم',
    tomorrow: 'غداً',
    whenFmt: '{day} الساعة {time}',
    offline: 'لا يوجد اتصال بالإنترنت',
    error: 'حدث خطأ، حاول مرة أخرى',
    retry: 'إعادة المحاولة',
    closedTitle: 'قريباً',
    closedText: 'الحجز غير متاح بعد.',
    nextSlot: 'أقرب موعد',
    bookAt: 'احجز {time}',
    otherTimes: 'أو اختر وقتاً آخر',
    noSlotsDay: 'لا مواعيد متاحة في هذا اليوم',
    noSlots: 'لا توجد مواعيد متاحة حالياً',
    hello: 'أهلاً {name}',
    notYou: 'ليس أنت؟',
    confirmTitle: 'تأكيد الحجز',
    name: 'الاسم',
    phone: 'رقم الجوال',
    confirm: 'تأكيد الحجز',
    badName: 'اكتب اسمك من فضلك',
    badPhone: 'رقم الجوال غير صحيح',
    booked: 'تم الحجز',
    yourAppt: 'موعدك',
    heldUntil: 'محفوظ لك حتى {time}',
    addCalendar: 'أضف إلى التقويم',
    calendarHint: 'ليذكّرك هاتفك بالموعد تلقائياً',
    googleCal: 'تقويم Google',
    calFile: 'تقويم آخر',
    change: 'تغيير الموعد',
    late: 'سأتأخر',
    cancelAppt: 'إلغاء الموعد',
    cancelQ: 'إلغاء موعدك؟',
    cancelYes: 'نعم، ألغِ الموعد',
    keep: 'رجوع',
    pickNew: 'اختر وقتاً جديداً',
    moveQ: 'نقل موعدك إلى',
    moveYes: 'تأكيد التغيير',
    movedOk: 'تم تغيير الموعد',
    cancelledOk: 'تم إلغاء الموعد',
    slotTaken: 'هذا الوقت حُجز للتو، اختر وقتاً آخر',
    hasActiveTitle: 'يوجد موعد بهذا الرقم',
    hasActive: 'لعرضه أو تغييره افتح الرابط الموجود في تقويمك، أو اطلبه من الحلاق.',
    tooMany: 'محاولات كثيرة، حاول لاحقاً',
    blockedTitle: 'الحجز عبر التطبيق متوقف مؤقتاً',
    blockedText: 'للحجز تواصل مع الحلاق مباشرة.',
    contact: 'واتساب الحلاق',
    gracePassed: 'انتهت مهلة موعدك',
    graceText: 'كان موعدك محفوظاً حتى {time}. لا تقلق، يوجد وقت آخر:',
    graceNone: 'كان موعدك محفوظاً حتى {time}. تواصل مع الحلاق.',
    moveToTime: 'انقلني إلى {time}',
    moveToDay: 'انقلني إلى {day} {time}',
    movedBanner: 'تغيّر موعدك (كان {when}). إن لم يناسبك اختر وقتاً آخر.',
    delayBanner: 'يوجد تأخير بسيط: حوالي {min} دقيقة',
    cancelledNotice: 'نعتذر، أُلغي موعدك ({when}). يمكنك اختيار وقت جديد.',
    directions: 'الموقع',
    ok: 'تم',
  },
  he: {
    today: 'היום',
    tomorrow: 'מחר',
    whenFmt: '{day} בשעה {time}',
    offline: 'אין חיבור לאינטרנט',
    error: 'משהו השתבש, נסו שוב',
    retry: 'נסו שוב',
    closedTitle: 'בקרוב',
    closedText: 'קביעת התורים עדיין לא נפתחה.',
    nextSlot: 'התור הקרוב',
    bookAt: 'קבעו תור ל־{time}',
    otherTimes: 'או בחרו שעה אחרת',
    noSlotsDay: 'אין תורים פנויים ביום הזה',
    noSlots: 'אין תורים פנויים כרגע',
    hello: 'שלום {name}',
    notYou: 'זה לא אתם?',
    confirmTitle: 'אישור התור',
    name: 'שם',
    phone: 'טלפון נייד',
    confirm: 'אישור התור',
    badName: 'נא להזין שם',
    badPhone: 'מספר הטלפון לא תקין',
    booked: 'התור נקבע',
    yourAppt: 'התור שלך',
    heldUntil: 'התור נשמר לך עד {time}',
    addCalendar: 'הוספה ליומן',
    calendarHint: 'כדי שהטלפון יזכיר לך אוטומטית',
    googleCal: 'יומן Google',
    calFile: 'יומן אחר',
    change: 'שינוי התור',
    late: 'אני מאחר/ת',
    cancelAppt: 'ביטול התור',
    cancelQ: 'לבטל את התור?',
    cancelYes: 'כן, לבטל את התור',
    keep: 'חזרה',
    pickNew: 'בחרו שעה חדשה',
    moveQ: 'להעביר את התור אל',
    moveYes: 'אישור השינוי',
    movedOk: 'התור שונה',
    cancelledOk: 'התור בוטל',
    slotTaken: 'השעה הזו נתפסה הרגע, בחרו שעה אחרת',
    hasActiveTitle: 'כבר קיים תור למספר הזה',
    hasActive: 'כדי לראות או לשנות אותו, פתחו את הקישור שביומן שלכם או בקשו אותו מהספר.',
    tooMany: 'יותר מדי ניסיונות, נסו מאוחר יותר',
    blockedTitle: 'קביעת תור באפליקציה מושהית זמנית',
    blockedText: 'לקביעת תור פנו ישירות לספר.',
    contact: 'וואטסאפ לספר',
    gracePassed: 'התור שלך כבר לא שמור',
    graceText: 'התור נשמר עד {time}. אל דאגה, יש שעה אחרת:',
    graceNone: 'התור נשמר עד {time}. פנו לספר.',
    moveToTime: 'העבירו אותי ל־{time}',
    moveToDay: 'העבירו אותי ל{day} {time}',
    movedBanner: 'התור שלך שונה (היה {when}). אם זה לא מתאים, בחרו שעה אחרת.',
    delayBanner: 'יש עיכוב קל: כ־{min} דקות',
    cancelledNotice: 'מצטערים, התור שלך ({when}) בוטל. אפשר לבחור שעה חדשה.',
    directions: 'מיקום',
    ok: 'סגירה',
  },
  en: {
    today: 'Today',
    tomorrow: 'Tomorrow',
    whenFmt: '{day} at {time}',
    offline: 'No internet connection',
    error: 'Something went wrong, please try again',
    retry: 'Try again',
    closedTitle: 'Coming soon',
    closedText: 'Booking is not open yet.',
    nextSlot: 'Next available',
    bookAt: 'Book {time}',
    otherTimes: 'Or pick another time',
    noSlotsDay: 'No free times on this day',
    noSlots: 'No free times right now',
    hello: 'Hi {name}',
    notYou: 'Not you?',
    confirmTitle: 'Confirm booking',
    name: 'Name',
    phone: 'Mobile number',
    confirm: 'Confirm booking',
    badName: 'Please enter your name',
    badPhone: 'That mobile number is not valid',
    booked: 'Booked',
    yourAppt: 'Your appointment',
    heldUntil: 'Held for you until {time}',
    addCalendar: 'Add to Calendar',
    calendarHint: 'So your phone reminds you automatically',
    googleCal: 'Google Calendar',
    calFile: 'Other calendar',
    change: 'Change time',
    late: "I'll be late",
    cancelAppt: 'Cancel appointment',
    cancelQ: 'Cancel your appointment?',
    cancelYes: 'Yes, cancel it',
    keep: 'Back',
    pickNew: 'Pick a new time',
    moveQ: 'Move your appointment to',
    moveYes: 'Confirm change',
    movedOk: 'Appointment changed',
    cancelledOk: 'Appointment cancelled',
    slotTaken: 'That time was just taken — please pick another',
    hasActiveTitle: 'This number already has an appointment',
    hasActive: 'To see or change it, open the link in your calendar or ask the barber for it.',
    tooMany: 'Too many attempts, try again later',
    blockedTitle: 'Online booking is paused for now',
    blockedText: 'Please contact the barber directly to book.',
    contact: 'WhatsApp the barber',
    gracePassed: 'Your time is no longer held',
    graceText: 'It was held until {time}. No worries, here is another time:',
    graceNone: 'It was held until {time}. Please contact the barber.',
    moveToTime: 'Move me to {time}',
    moveToDay: 'Move me to {time}, {day}',
    movedBanner: 'Your appointment was changed (it was {when}). If it does not suit you, pick another time.',
    delayBanner: 'Running a little late: about {min} minutes',
    cancelledNotice: 'Sorry, your appointment ({when}) was cancelled. You can pick a new time.',
    directions: 'Location',
    ok: 'Done',
  },
};

let lang = 'ar';
export const getLang = () => lang;
export const isRtl = (l = lang) => l !== 'en';

export function addStrings(extra) {
  for (const l of LANGS) Object.assign(D[l], extra[l]);
}

function stored() {
  try {
    return localStorage.getItem('lang');
  } catch {
    return null;
  }
}

/** Saved choice → device language → fallback. */
export function detectLang(fallback = 'ar') {
  const s = stored();
  if (LANGS.includes(s)) return s;
  for (const n of navigator.languages || [navigator.language || '']) {
    const p = String(n).toLowerCase().slice(0, 2);
    if (p === 'iw') return 'he';
    if (LANGS.includes(p)) return p;
  }
  return fallback;
}

export function setLang(l, remember = false) {
  lang = LANGS.includes(l) ? l : 'ar';
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
  if (remember) {
    try {
      localStorage.setItem('lang', lang);
    } catch {
      /* private mode */
    }
  }
}

export function tIn(l, key, vars = {}) {
  const s = (D[l] && D[l][key]) ?? D.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}
export const t = (key, vars) => tIn(lang, key, vars);

const fmts = {};
function weekday(l, date, style) {
  const k = l + style;
  fmts[k] = fmts[k] || new Intl.DateTimeFormat(LOCALE[l], { weekday: style, timeZone: 'UTC' });
  const [y, m, d] = date.split('-').map(Number);
  return fmts[k].format(new Date(Date.UTC(y, m - 1, d, 12)));
}
const dm = (date) => `${Number(date.slice(8))}/${Number(date.slice(5, 7))}`;

function addDay(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const weekdayShort = (date) => weekday(lang, date, 'short');
export const weekdayLong = (date, l = lang) => weekday(l, date, 'long');
export const dayNum = (date) => String(Number(date.slice(8)));

/** "اليوم" / "غداً" / "الثلاثاء 10/11" */
export function dayLabel(date, today, l = lang) {
  if (date === today) return tIn(l, 'today');
  if (date === addDay(today, 1)) return tIn(l, 'tomorrow');
  return `${weekday(l, date, 'long')} ${dm(date)}`;
}

/** "اليوم · الثلاثاء 10/11" */
export function dayFull(date, today, l = lang) {
  const base = `${weekday(l, date, 'long')} ${dm(date)}`;
  if (date === today) return `${tIn(l, 'today')} · ${base}`;
  if (date === addDay(today, 1)) return `${tIn(l, 'tomorrow')} · ${base}`;
  return base;
}

export const when = (date, time, today, l = lang) => tIn(l, 'whenFmt', { day: dayLabel(date, today, l), time });
