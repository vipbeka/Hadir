import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { icon } from './icons.js';
import { button } from './button.js';

const ICONS = { info: 'info', success: 'checkCircle', warning: 'alertTriangle', danger: 'alertCircle', reward: 'gift' };
let region;

function ensureRegion() {
  if (region && document.body.contains(region)) return region;
  region = h('div', { class: 'toast-region', role: 'region', 'aria-label': 'Notifications' });
  // polite for info/success; danger toasts use role=alert on the toast itself
  region.setAttribute('aria-live', 'polite');
  document.body.append(region);
  return region;
}

/** Build a toast element (also used statically by the design preview). */
export function toastEl({ title, text, tone = 'info', onDismiss, isStatic = false }) {
  return h('div', { class: ['toast', `toast--${tone}`, isStatic && 'toast--static'], role: tone === 'danger' ? 'alert' : 'status' },
    h('span', { class: 'toast__icon' }, icon(ICONS[tone] || 'info')),
    h('div', { class: 'toast__body' }, title ? h('p', { class: 'toast__title' }, title) : null, text ? h('p', { class: 'toast__text' }, text) : null),
    button({ label: t('common.close'), variant: 'ghost', size: 'sm', icon: 'x', iconOnly: true, onClick: onDismiss }),
  );
}

/** toast({ title, text, tone: 'info'|'success'|'warning'|'danger'|'reward', duration }) */
export function toast({ title, text, tone = 'info', duration = 5000 } = {}) {
  const r = ensureRegion();
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    const dur = parseFloat(getComputedStyle(el).animationDuration) || 0;
    if (dur > 0) el.addEventListener('animationend', () => el.remove(), { once: true }); else el.remove();
  };
  const el = toastEl({ title, text, tone, onDismiss: dismiss });
  r.append(el);
  // Danger toasts stay until dismissed so they can't be missed.
  if (tone !== 'danger' && duration > 0) {
    timer = setTimeout(dismiss, duration);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('focusin', () => clearTimeout(timer));
  }
  return dismiss;
}
