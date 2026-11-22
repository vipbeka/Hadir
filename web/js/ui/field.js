import { h, uid } from '../core/dom.js';
import { icon } from './icons.js';

function wrapField({ id, label, hint, error, required, control }) {
  const hintId = hint ? `${id}-hint` : null;
  const errId = `${id}-error`;
  const describedBy = [hintId, error ? errId : null].filter(Boolean).join(' ') || null;
  if (describedBy) control.setAttribute('aria-describedby', describedBy);
  if (error) control.setAttribute('aria-invalid', 'true');
  const errorEl = h('p', { class: 'field__error', id: errId, hidden: !error }, error ? [icon('alertCircle', { size: 'sm' }), h('span', {}, error)] : null);
  const wrap = h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label, required ? h('span', { class: 'field__required', 'aria-hidden': 'true' }, '*') : null),
    control,
    hint ? h('p', { class: 'field__hint', id: hintId }, hint) : null,
    errorEl,
  );
  return wrap;
}

/** Show or clear a validation message on a field built with input()/select()/textarea(). */
export function setFieldError(fieldEl, message) {
  const control = fieldEl.querySelector('.input, .select, .textarea');
  const err = fieldEl.querySelector('.field__error');
  const hintId = fieldEl.querySelector('.field__hint')?.id;
  if (message) {
    err.replaceChildren(icon('alertCircle', { size: 'sm' }), h('span', {}, message));
    err.hidden = false;
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', [hintId, err.id].filter(Boolean).join(' '));
  } else {
    err.replaceChildren();
    err.hidden = true;
    control.removeAttribute('aria-invalid');
    if (hintId) control.setAttribute('aria-describedby', hintId); else control.removeAttribute('aria-describedby');
  }
}

/** input({ label, name, type, placeholder, hint, error, required, disabled, loading, attrs }) */
export function input({ label, name, type = 'text', value = '', placeholder, hint, error, required, disabled, loading, attrs = {} } = {}) {
  const id = attrs.id || uid('in');
  const control = h('input', {
    id, name, type, value, placeholder, required, disabled,
    'aria-busy': loading ? 'true' : null,
    ...attrs,
    class: ['input', attrs.class],
  });
  const f = wrapField({ id, label, hint, error, required, control });
  if (loading) {
    // wrap in place so the spinner sits at the inline end of the control
    const wrap = h('div', { class: 'input-wrap' });
    control.replaceWith(wrap);
    wrap.append(control, h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  }
  return f;
}

/** select({ label, options: [{ value, label }], value, ... }) */
export function select({ label, name, options = [], value, hint, error, required, disabled, attrs = {} } = {}) {
  const id = attrs.id || uid('sel');
  const control = h('select', { id, name, required, disabled, ...attrs, class: ['select', attrs.class] },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  return wrapField({ id, label, hint, error, required, control });
}

export function textarea({ label, name, value = '', placeholder, hint, error, required, disabled, rows = 3, attrs = {} } = {}) {
  const id = attrs.id || uid('ta');
  const control = h('textarea', { id, name, placeholder, required, disabled, rows, ...attrs, class: ['textarea', attrs.class] });
  control.value = value;
  return wrapField({ id, label, hint, error, required, control });
}

/** toggle switch backed by a real checkbox (keyboard + screen reader friendly) */
export function switchControl({ label, name, checked = false, disabled = false, onChange } = {}) {
  const inputEl = h('input', { class: 'switch__input', type: 'checkbox', role: 'switch', name, checked, disabled, onChange });
  return h('label', { class: 'switch' }, inputEl, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), h('span', {}, label));
}
