import { h } from '../core/dom.js';
import { icon } from './icons.js';

/**
 * button({ label, variant: 'primary'|'secondary'|'ghost'|'danger'|'reward',
 *          size: 'sm'|'md'|'lg', icon, iconEnd, block, iconOnly, type, onClick, disabled })
 * Icon-only buttons must pass `label`; it becomes the aria-label.
 */
export function button({
  label, variant = 'secondary', size = 'md', icon: iconName, iconEnd, block = false,
  iconOnly = false, type = 'button', onClick, disabled = false, attrs = {},
} = {}) {
  const el = h('button', {
    type,
    class: ['btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, block && 'btn--block', iconOnly && 'btn--icon', attrs.class],
    disabled,
    'aria-label': iconOnly ? label : null,
    title: iconOnly ? label : null,
    onClick,
    ...Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'class')),
  });
  if (iconName) el.append(icon(iconName, { size: size === 'sm' ? 'sm' : 'md', flip: ['arrowRight', 'chevronRight'].includes(iconName) }));
  if (!iconOnly && label) el.append(h('span', { class: 'btn__label' }, label));
  if (iconEnd) el.append(icon(iconEnd, { size: size === 'sm' ? 'sm' : 'md', flip: ['arrowRight', 'chevronRight'].includes(iconEnd) }));
  return el;
}

/**
 * Put a button into (or out of) the loading state. Keeps its width,
 * announces busy to assistive tech, blocks repeated clicks.
 */
export function setLoading(btn, loading, loadingLabel) {
  if (loading) {
    if (btn.getAttribute('aria-busy') === 'true') return;
    btn.setAttribute('aria-busy', 'true');
    btn.dataset.wasDisabled = btn.disabled ? '1' : '';
    btn.disabled = true;
    btn.classList.add('is-loading');
    const sp = h('span', { class: 'spinner', role: 'status', 'aria-label': loadingLabel || '' });
    btn.append(sp);
  } else {
    btn.removeAttribute('aria-busy');
    btn.disabled = btn.dataset.wasDisabled === '1';
    btn.classList.remove('is-loading');
    btn.querySelector(':scope > .spinner')?.remove();
  }
}
