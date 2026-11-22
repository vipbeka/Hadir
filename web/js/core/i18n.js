// Internationalisation: one messages file per language (web/i18n/*.json).
// Arabic (RTL) is the default; English (LTR) is the alternative.
// The product name "Zintra حاضر" is the single key `app.name` in each file.
import { store } from './storage.js';

const SUPPORTED = ['ar', 'en'];
const DEFAULT_LANG = 'ar';
const BASE = new URL('../../i18n/', import.meta.url);

let lang = DEFAULT_LANG;
let messages = {};
const listeners = new Set();

/** Load the stored language (or default) before rendering. */
export async function initI18n() {
  const stored = store.get('zh.lang');
  await setLang(SUPPORTED.includes(stored) ? stored : DEFAULT_LANG, { silent: true });
}

export async function setLang(next, { silent = false } = {}) {
  if (!SUPPORTED.includes(next)) next = DEFAULT_LANG;
  const res = await fetch(new URL(`${next}.json`, BASE), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Missing messages file for ${next}`);
  messages = await res.json();
  lang = next;
  store.set('zh.lang', next);
  const root = document.documentElement;
  root.lang = next;
  root.dir = dir();
  if (!silent) listeners.forEach((fn) => fn(next));
}

export const getLang = () => lang;
export const dir = () => (lang === 'ar' ? 'rtl' : 'ltr');
export const onLangChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** t('reward.remaining', { n: 23 }) — missing keys fall back to the key itself. */
export function t(key, vars) {
  let msg = messages[key];
  if (msg === undefined) {
    console.warn(`[i18n] missing key "${key}" for ${lang}`);
    msg = key;
  }
  if (vars) msg = msg.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  return msg;
}

/** Locale-aware number formatting; digits stay Western for codes and money columns. */
export function formatNumber(n, opts = {}) {
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', opts).format(n);
}

/**
 * Set document.title as "<page> · Zintra حاضر".
 * The product name is wrapped in Unicode isolates (LRI … PDI) so the
 * mixed Latin/Arabic name keeps its visual order inside RTL titles.
 */
export function setDocumentTitle(pageTitle) {
  const name = `⁦${t('app.name')}⁩`;
  document.title = pageTitle ? `${pageTitle} · ${name}` : name;
}

/** Translate static markup: data-i18n, data-i18n-placeholder, data-i18n-aria-label, data-i18n-title. */
export function translateDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}
