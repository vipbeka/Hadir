// Brand wordmark: logo mark + the product name «حاضر».
// The name comes from the single `app.name` message (never hard-coded),
// so it renders the same in RTL and LTR layouts and never reorders the
// surrounding text.
import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';

const MARK_SRC = new URL('../../assets/brand/logo-mark.png', import.meta.url).href;

export function brandName(attrs = {}) {
  return h('span', { ...attrs }, t('app.name'));
}

/** wordmark({ href, size }) — header/sidebar lockup */
export function wordmark({ href = null, tag } = {}) {
  return h(href ? 'a' : tag || 'span', { class: 'wordmark', href },
    h('img', { class: 'wordmark__mark', src: MARK_SRC, alt: '', width: '36', height: '35', decoding: 'async' }),
    brandName({ class: 'wordmark__text' }));
}

/** Large logo for the login screen; meaningful alt text (company name). */
export function logoLarge() {
  return h('img', { class: 'auth__logo', src: MARK_SRC, alt: t('app.name'), width: '88', height: '85' });
}

export { MARK_SRC };
