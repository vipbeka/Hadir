// Locale-aware formatting. Digits stay Western (latn) in both languages
// so codes, money and times read consistently.
import { getLang, t } from './i18n.js';

const locale = () => (getLang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
const TZ = 'Africa/Cairo'; // display timezone; the server remains the authority

// ---------------------------------------------------------------------
// TIME DISPLAY — the ONE place times are formatted for people.
// Always Cairo (Africa/Cairo, DST handled by Intl — never a fixed offset),
// always 12-hour: Arabic "4:44 م", English "4:44 PM". Western digits.
// Stored timestamps are untouched; this is display only.
// ---------------------------------------------------------------------
const timeLocale = (lang) => (lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US');
const timeFmtCache = new Map();
function timeFmt(lang, seconds) {
  const key = `${lang}|${seconds}`;
  if (!timeFmtCache.has(key)) {
    timeFmtCache.set(key, new Intl.DateTimeFormat(timeLocale(lang), {
      hour: 'numeric', minute: '2-digit', second: seconds ? '2-digit' : undefined, hour12: true, timeZone: TZ }));
  }
  return timeFmtCache.get(key);
}
// Some engines insert a narrow no-break space before AM/PM; normalise to a plain space.
const tidy = (s) => s.replace(/[\u202f\u00a0]/g, ' ');

/** Timestamp (ISO / Date) → "4:44 م" / "4:44 PM" in Cairo time. */
export function formatTime(iso, lang = getLang(), { seconds = false } = {}) {
  if (iso === null || iso === undefined || iso === '') return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return tidy(timeFmt(lang, seconds).format(d));
}

/**
 * Schedule time-of-day value ("09:00", "17:00:00") → "9:00 ص" / "5:00 PM".
 * These are local wall-clock values, NOT timestamps: they are never fed to
 * a Date parser (which would assume a date and a timezone).
 */
export function formatClock(hms, lang = getLang()) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hms ?? ''));
  if (!m) return '';
  const h = Number(m[1]); const min = m[2];
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const pm = h >= 12;
  return lang === 'ar' ? `${h12}:${min} ${pm ? 'م' : 'ص'}` : `${h12}:${min} ${pm ? 'PM' : 'AM'}`;
}

export function formatDate(iso, lang = getLang()) {
  if (!iso) return '';
  // a bare "YYYY-MM-DD" work date is a calendar day: format it as such
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeZone: TZ }).format(d);
}
/** "23 نوفمبر 2026" / "23 November 2026" (Cairo calendar day) */
export function formatLongDate(iso, lang = getLang()) {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(d);
}
export function formatDateTime(iso, lang = getLang()) {
  if (!iso) return '';
  return `${formatDate(iso, lang)}، ${formatTime(iso, lang)}`.replace('، ', lang === 'ar' ? '، ' : ', ');
}
/** piastres (integer) → "1,050 EGP" / "1,050 ج.م" */
export function formatEGP(piastres) {
  if (piastres === null || piastres === undefined) return '';
  const egp = Number(piastres) / 100;
  const n = new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(egp);
  return getLang() === 'ar' ? `${n} ج.م` : `${n} EGP`;
}
/** Display name in the current language, falling back to the other. */
export const displayName = (p) => (getLang() === 'ar' ? p.full_name_ar || p.full_name_en : p.full_name_en || p.full_name_ar);

/** "HH:MM:SS" → "HH:MM" — ONLY for <input type="time"> values, never for display. */
export const hhmm = (s) => (s ? String(s).slice(0, 5) : '');
/** minutes → "7h 30m" / "7 س 30 د" */
export function formatMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return t('common.hoursShort', { h: Math.floor(m / 60), m: m % 60 });
}
export function monthLabel(isoDate) {
  return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${String(isoDate).slice(0, 7)}-01T00:00:00Z`));
}
export const jobTitle = (p) => (getLang() === 'ar' ? p.job_title_ar || p.job_title_en : p.job_title_en || p.job_title_ar) || '';
