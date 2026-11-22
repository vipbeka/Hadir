import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { button } from './button.js';

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

  function open() {
    document.body.append(el);
    el.showModal();
    return new Promise((res) => { resolver = res; });
  }
  function close(reason = 'close') {
    if (!el.open) return;
    el.classList.add('is-closing');
    const done = () => {
      el.classList.remove('is-closing');
      el.close();
      el.remove();
      onClose?.(reason);
      resolver?.(reason);
    };
    const dur = parseFloat(getComputedStyle(el).animationDuration) || 0;
    if (dur > 0) el.addEventListener('animationend', done, { once: true }); else done();
  }
  return { el, open, close };
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
