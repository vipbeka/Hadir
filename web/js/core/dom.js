// Tiny DOM helpers. `h` builds elements without innerHTML so user data
// can never be interpreted as markup.

/**
 * h('button', { class: 'btn', onClick: fn, 'aria-label': 'x' }, child, ...)
 * - attrs starting with "on" + Capital become event listeners
 * - `class` may be a string or an array (falsy entries skipped)
 * - `dataset`/`style` objects are merged
 * - boolean true → empty attribute, false/null/undefined → omitted
 * - children: strings, numbers, Nodes, arrays, null (skipped)
 */
export function h(tag, attrs = {}, ...children) {
  const el = tag instanceof Element ? tag : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') {
      el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [p, v] of Object.entries(value)) el.style.setProperty(p, v);
    } else if (/^on[A-Z]/.test(key) && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') {
      el.textContent = value;
    } else if (key in el && typeof value !== 'string' && key !== 'list') {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let idCounter = 0;
export const uid = (prefix = 'zh') => `${prefix}-${++idCounter}`;

/** Append children, skipping null/undefined/false (native append would print "null"). */
export function add(el, ...children) { return append(el, children); }
/** Replace all children with the given ones (null-safe). */
export function fill(el, ...children) { clear(el); return append(el, children); }
