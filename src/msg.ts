// The few texts the server itself writes: calendar events, push notifications, app manifest.
import type { Lang } from './core';
import { TZ, timeOf } from './time';

type Dict = Record<string, string>;

const M: Record<Lang, Dict> = {
  ar: {
    haircut: 'حلاقة',
    evTitle: '✂️ {shop} · موعدك {time}',
    evHeld: ' (محفوظ حتى {grace})',
    evDesc: 'لعرض الموعد أو تغييره أو إلغائه:',
    pNew: 'حجز جديد',
    pCancel: 'تم إلغاء موعد',
    pMove: 'تغيير موعد',
    pMorning: 'مواعيد اليوم',
    pMorningBody: '{n} مواعيد · الأول {time}',
    pTest: 'الإشعارات تعمل ✓',
    barberApp: 'لوحة الحلاق',
  },
  he: {
    haircut: 'תספורת',
    evTitle: '✂️ {shop} · התור שלך {time}',
    evHeld: ' (נשמר עד {grace})',
    evDesc: 'לצפייה, שינוי או ביטול התור:',
    pNew: 'תור חדש',
    pCancel: 'תור בוטל',
    pMove: 'תור שונה',
    pMorning: 'התורים של היום',
    pMorningBody: '{n} תורים · הראשון {time}',
    pTest: 'ההתראות פועלות ✓',
    barberApp: 'לוח הספר',
  },
  en: {
    haircut: 'Haircut',
    evTitle: '✂️ {shop} · {time}',
    evHeld: ' (held until {grace})',
    evDesc: 'View, change or cancel:',
    pNew: 'New booking',
    pCancel: 'Booking cancelled',
    pMove: 'Booking changed',
    pMorning: "Today's appointments",
    pMorningBody: '{n} appointments · first at {time}',
    pTest: 'Notifications are working ✓',
    barberApp: 'Barber',
  },
};

export function msg(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  const s = M[lang][key] ?? M.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

const LOCALE: Record<Lang, string> = { ar: 'ar-u-nu-latn', he: 'he', en: 'en-GB' };
const dayFmt = new Map<Lang, Intl.DateTimeFormat>();

/** e.g. "الثلاثاء 10/11 16:30" in the shop's time zone. */
export function dayTime(lang: Lang, epochSec: number): string {
  let f = dayFmt.get(lang);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE[lang], { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric' });
    dayFmt.set(lang, f);
  }
  return `${f.format(new Date(epochSec * 1000))} ${timeOf(epochSec)}`;
}
