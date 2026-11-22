// Language switcher + theme toggle (segmented controls).
import { h } from '../core/dom.js';
import { t, getLang, setLang } from '../core/i18n.js';
import { getThemePref, setThemePref } from '../core/theme.js';
import { icon } from './icons.js';

/** Language switcher: flips lang + dir and re-renders via onLangChange listeners. */
export function langSwitcher() {
  const current = getLang();
  const opt = (code, label) => h('button', {
    type: 'button',
    class: 'segmented__btn',
    lang: code,
    'aria-pressed': String(current === code),
    onClick: async (e) => {
      if (getLang() === code) return;
      const btn = e.currentTarget;
      btn.setAttribute('aria-busy', 'true');
      await setLang(code);
    },
  }, label);
  return h('div', { class: 'segmented', role: 'group', 'aria-label': t('lang.label') },
    icon('globe', { size: 'sm' }),
    opt('ar', t('lang.ar')), opt('en', t('lang.en')));
}

/** Theme toggle: system | light | dark (stored locally). */
export function themeToggle({ compact = false } = {}) {
  const pref = getThemePref();
  const group = h('div', { class: 'segmented', role: 'group', 'aria-label': t('theme.label') });
  const opts = [['system', 'monitor'], ['light', 'sun'], ['dark', 'moon']];
  for (const [value, ic] of opts) {
    const btn = h('button', {
      type: 'button', class: 'segmented__btn',
      'aria-pressed': String(pref === value),
      'aria-label': compact ? t(`theme.${value}`) : null,
      title: compact ? t(`theme.${value}`) : null,
      onClick: () => {
        setThemePref(value);
        group.querySelectorAll('.segmented__btn').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      },
    }, icon(ic, { size: 'sm' }), compact ? null : h('span', {}, t(`theme.${value}`)));
    group.append(btn);
  }
  return group;
}
