// Display components: card, stat, badge, alert, table, progress,
// empty state, skeleton. Pure builders — no global state.
import { h, append } from '../core/dom.js';
import { icon } from './icons.js';

/** card({ title, subtitle, body, footer, actions, facet, interactive, onClick }) */
export function card({ title, subtitle, body, footer, actions, facet = false, interactive = false, onClick, tag, iconName, className } = {}) {
  const el = h(tag || (interactive ? 'button' : 'section'), {
    class: ['card', facet && 'card--facet', interactive && 'card--interactive', className],
    type: interactive ? 'button' : null,
    onClick,
  });
  if (title || actions) {
    const text = h('div', { style: { 'min-inline-size': '0' } }, title ? h(interactive ? 'span' : 'h3', { class: 'card__title' }, title) : null,
      subtitle ? h('p', { class: 'card__subtitle' }, subtitle) : null);
    el.append(h('div', { class: 'card__header' },
      iconName ? h('div', { class: 'card__head' }, h('span', { class: 'card__icon', 'aria-hidden': 'true' }, icon(iconName)), text) : text,
      actions || null));
  }
  if (body) append(el, [body]);
  if (footer) el.append(h('div', { class: 'card__footer' }, footer));
  return el;
}

/** stat({ label, value, meta, iconName }) — big-number card content */
export function stat({ label, value, meta }) {
  return h('div', { class: 'stat' },
    h('span', { class: 'stat__label' }, label),
    h('span', { class: 'stat__value num' }, value),
    meta ? h('span', { class: 'stat__meta' }, meta) : null);
}

/**
 * badge(text, { tone: 'neutral'|'info'|'success'|'warning'|'danger'|'accent'|'reward'
 *                     |'point-green'|'point-red'|'point-black', dot, size })
 */
export function badge(text, { tone = 'neutral', dot = false, size = 'md', iconName } = {}) {
  return h('span', { class: ['badge', tone !== 'neutral' && `badge--${tone}`, size === 'lg' && 'badge--lg'] },
    dot ? h('span', { class: 'badge__dot', 'aria-hidden': 'true' }) : null,
    iconName ? icon(iconName, { size: 'sm' }) : null,
    text);
}

/** alert(text, { tone, title }) — inline, non-dismissible status message */
export function alert(text, { tone = 'info', title } = {}) {
  const icons = { info: 'info', success: 'checkCircle', warning: 'alertTriangle', danger: 'alertCircle' };
  return h('div', { class: ['alert', tone !== 'info' && `alert--${tone}`], role: tone === 'danger' ? 'alert' : 'status' },
    icon(icons[tone]),
    h('div', {}, title ? h('strong', {}, title, ' ') : null, text));
}

/**
 * table({ caption, columns: [{ key, label, numeric, render }], rows, stack })
 * `stack` collapses rows into labeled blocks on phones.
 */
export function table({ caption, columns, rows, stack = true, captionHidden = false }) {
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': caption },
    h('table', { class: ['table', stack && 'table--stack'] },
      caption ? h('caption', { class: captionHidden ? 'visually-hidden' : null }, caption) : null,
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { scope: 'col', class: c.numeric ? 'is-num' : null }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', { class: r._class },
        columns.map((c) => h('td', { 'data-label': c.label, class: c.numeric ? 'is-num' : null },
          c.render ? c.render(r) : r[c.key])))))));
}

/**
 * progress({ label, value, max, valueText, reward, indeterminate })
 * Uses role=progressbar with aria values; `reward` adds the gold
 * threshold marker and turns gold when complete.
 */
export function progress({ label, value = 0, max = 100, valueText, reward = false, indeterminate = false, hint }) {
  const v = Number(value); const m = Number(max);
  const pct = Number.isFinite(v) && Number.isFinite(m) && m > 0 ? Math.max(0, Math.min(100, (v / m) * 100)) : 0;
  const complete = reward && m > 0 && v >= m;
  return h('div', { class: ['progress', reward && 'progress--reward', complete && 'progress--complete', indeterminate && 'progress--indeterminate'] },
    h('div', { class: 'progress__head' },
      h('span', { class: 'progress__label' }, label),
      indeterminate ? null : h('span', { class: 'progress__value num' }, valueText ?? `${value}/${max}`)),
    h('div', {
      class: 'progress__track', role: 'progressbar', 'aria-label': label,
      'aria-valuemin': indeterminate ? null : '0', 'aria-valuemax': indeterminate ? null : String(max),
      'aria-valuenow': indeterminate ? null : String(value), 'aria-valuetext': valueText || null,
      style: { '--progress': `${pct}%` },
    }, h('div', { class: 'progress__fill' })),
    hint ? h('p', { class: 'text-sm text-muted' }, hint) : null);
}

/** emptyState({ iconName, title, text, action, error }) */
export function emptyState({ iconName = 'inbox', title, text, action, error = false }) {
  return h('div', { class: ['empty', error && 'empty--error'], role: error ? 'alert' : null },
    h('div', { class: 'empty__icon', 'aria-hidden': 'true' }, icon(iconName, { size: 'lg' })),
    h('p', { class: 'empty__title' }, title),
    text ? h('p', { class: 'empty__text' }, text) : null,
    action || null);
}

/** skeleton('text'|'title'|'block'|'circle', { width }) */
export function skeleton(kind = 'text', { width } = {}) {
  return h('span', { class: ['skeleton', `skeleton--${kind}`], 'aria-hidden': 'true', style: width ? { 'inline-size': width } : null });
}

/** A labelled group of skeletons announced as loading once. */
export function skeletonCard(label) {
  return h('div', { class: 'card', 'aria-busy': 'true', 'aria-label': label, role: 'status' },
    skeleton('title'), skeleton('text'), skeleton('text', { width: '80%' }), skeleton('block'));
}

/** chip(text, { tone, iconName, dot }) — small pill label */
export function chip(text, { tone, iconName, dot = false } = {}) {
  return h('span', { class: ['chip', tone && `chip--${tone}`] },
    dot ? h('span', { class: 'chip__dot', 'aria-hidden': 'true' }) : null,
    iconName ? icon(iconName) : null, text);
}

/** statCard({ label, iconName, value, unit, meta, metaIcon }) */
export function statCard({ label, iconName, value, unit, meta, metaIcon }) {
  return h('section', { class: 'card stat-card' },
    h('div', { class: 'stat-card__top' }, h('span', {}, label), iconName ? h('span', { class: 'stat-card__icon', 'aria-hidden': 'true' }, icon(iconName)) : null),
    h('div', {}, h('span', { class: 'stat-card__value num' }, value), unit ? h('span', { class: 'stat-card__unit' }, unit) : null),
    meta ? h('span', { class: 'stat-card__meta' }, metaIcon ? icon(metaIcon) : null, meta) : null);
}
