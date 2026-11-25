import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { icon } from './icons.js';
import { button } from './button.js';

const ICONS = { info: 'info', success: 'checkCircle', warning: 'alertTriangle', danger: 'alertCircle', reward: 'gift' };
let region;

const POPOVER = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

function ensureRegion() {
  if (!(region && document.body.contains(region))) {
    region = h('div', { class: 'toast-region', role: 'region', 'aria-label': 'Notifications' });
    // polite for info/success; danger toasts use role=alert on the toast itself
    region.setAttribute('aria-live', 'polite');
    // An open <dialog> lives in the browser's top layer, above any z-index.
    // As a manual popover the region joins the top layer too, so a toast is
    // never hidden behind an open dialog (it never takes focus or closes it).
    if (POPOVER) region.setAttribute('popover', 'manual');
    document.body.append(region);
  }
  raise();
  return region;
}

/** Put the toasts above everything currently open (dialogs, drawer). */
function raise() {
  if (POPOVER) {
    try {
      // re-showing moves it to the top of the top layer (after any newer dialog)
      if (region.matches(':popover-open')) region.hidePopover();
      region.showPopover();
    } catch { /* not connected yet */ }
    return;
  }
  // older browsers: inside the topmost open dialog (part of the top layer)
  const top = [...document.querySelectorAll('dialog[open]')].pop();
  const host = top || document.body;
  if (region.parentElement !== host) host.append(region);
}

/** Build a toast element (also used statically by the design preview). */
export function toastEl({ title, text, tone = 'info', onDismiss, isStatic = false, onOpen }) {
  const content = [title ? h('p', { class: 'toast__title' }, title) : null, text ? h('p', { class: 'toast__text' }, text) : null];
  return h('div', { class: ['toast', `toast--${tone}`, isStatic && 'toast--static'], role: tone === 'danger' ? 'alert' : 'status' },
    h('span', { class: 'toast__icon' }, icon(ICONS[tone] || 'info')),
    onOpen ? h('button', { type: 'button', class: 'toast__body toast__body--action', onClick: () => { onDismiss?.(); onOpen(); } }, ...content)
      : h('div', { class: 'toast__body' }, ...content),
    button({ label: t('common.close'), variant: 'ghost', size: 'sm', icon: 'x', iconOnly: true, onClick: onDismiss }),
  );
}

/** toast({ title, text, tone: 'info'|'success'|'warning'|'danger'|'reward', duration }) */
export function toast({ title, text, tone = 'info', duration = 5000, onOpen } = {}) {
  const r = ensureRegion();
  let timer; let keepOnTop;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    const dur = parseFloat(getComputedStyle(el).animationDuration) || 0;
    const gone = () => { el.remove(); keepOnTop?.disconnect(); };
    if (dur > 0) el.addEventListener('animationend', gone, { once: true }); else gone();
  };
  const el = toastEl({ title, text, tone, onDismiss: dismiss, onOpen });
  r.append(el);
  // a dialog opened after this toast would cover it: keep it on top
  keepOnTop = new MutationObserver(() => { if (el.isConnected) raise(); else keepOnTop.disconnect(); });
  keepOnTop.observe(document.body, { subtree: true, attributeFilter: ['open'] });
  el.addEventListener('animationend', () => { if (!el.isConnected) keepOnTop.disconnect(); });
  // Danger toasts stay until dismissed so they can't be missed.
  if (tone !== 'danger' && duration > 0) {
    timer = setTimeout(dismiss, duration);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('focusin', () => clearTimeout(timer));
  }
  return dismiss;
}
