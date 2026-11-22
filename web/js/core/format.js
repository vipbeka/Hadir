// Locale-aware formatting. Digits stay Western (latn) in both languages
// so codes, money and times read consistently.
import { getLang } from './i18n.js';

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
