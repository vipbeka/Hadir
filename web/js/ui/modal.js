import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { button } from './button.js';

// Every open dialog, so route changes can close them (a dialog must not
// follow the user to another page).
const OPEN = new Set();
export function closeAllModals() { [...OPEN].forEach((m) => m.close('navigate')); }

/**
 * Modal built on the native <dialog> element: focus is trapped and
 * restored by the browser, Escape closes it, the backdrop is themed.
 *
 * const m = modal({ title, body: Node|Node[], actions: [buttonEl...], size: 'sm'|'md', dismissible: true })
 * m.open(); m.close(); m.el
 * Returns a promise from m.open() that resolves with the close reason.
 */
export function modal({ title, body, actions = [], size = 'md', dismissible = true, onClose } = {}) {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = dismissible
    ? button({ label: t('common.close'), variant: 'ghost', icon: 'x', iconOnly: true, size: 'sm', onClick: () => close('dismiss') })
    : null;
  const el = h('dialog', { class: ['modal', size === 'sm' && 'modal--sm'], 'aria-labelledby': titleId },
    h('header', { class: 'modal__header' }, h('h2', { class: 'modal__title', id: titleId }, title), closeBtn),
    h('div', { class: 'modal__body' }, body),
    actions.length ? h('footer', { class: 'modal__footer' }, actions) : null,
  );
  let resolver;
  el.addEventListener('cancel', (e) => { e.preventDefault(); if (dismissible) close('dismiss'); });
  el.addEventListener('click', (e) => { if (dismissible && e.target === el) close('dismiss'); });

  let opener = null; let closing = false;
  function open() {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.append(el);
    el.showModal();
    OPEN.add(api);
    return new Promise((res) => { resolver = res; });
  }
  function close(reason = 'close') {
    if (!el.open || closing) return;
    closing = true;
    el.classList.add('is-closing');
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      el.classList.remove('is-closing');
      if (el.open) el.close();
      el.remove();
      OPEN.delete(api);
      closing = false;
      // give focus back to the control that opened the dialog (if still on the page)
      if (opener && opener.isConnected && reason !== 'navigate') { try { opener.focus({ preventScroll: true }); } catch { /* ignore */ } }
      onClose?.(reason);
      resolver?.(reason);
    };
    const dur = (parseFloat(getComputedStyle(el).animationDuration) || 0) * 1000;
    if (dur > 0) {
      el.addEventListener('animationend', done, { once: true });
      // animationend never fires when animations are suppressed (hidden tab,
      // OS "remove animations", element detached): never leave the dialog hanging
      setTimeout(done, dur + 120);
    } else done();
  }
  const api = { el, open, close };
  return api;
}

/** confirmDialog({ title, text, confirmLabel, variant }) → Promise<boolean> */
export async function confirmDialog({ title, text, confirmLabel, variant = 'primary' }) {
  let confirmed = false;
  const m = modal({
    title, size: 'sm',
    body: h('p', {}, text),
    actions: [
      button({ label: t('common.cancel'), variant: 'secondary', onClick: () => m.close('cancel') }),
      button({ label: confirmLabel || t('common.confirm'), variant, onClick: () => { confirmed = true; m.close('confirm'); } }),
    ],
  });
  await m.open();
  return confirmed;
}
