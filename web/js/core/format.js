// Locale-aware formatting. Digits stay Western (latn) in both languages
// so codes, money and times read consistently.
import { getLang, t } from './i18n.js';

const locale = () => (getLang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
const TZ = 'Africa/Cairo'; // display timezone; the server remains the authority

export function formatDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(new Date(iso));
}
export function formatDate(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeZone: TZ }).format(new Date(iso));
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

/** 'HH:MM' (24h) in the business timezone from an ISO timestamp */
export function formatTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }).format(new Date(iso));
}
/** "HH:MM:SS" string from the server → "HH:MM" */
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
