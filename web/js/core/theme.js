// Theme: follows the device (prefers-color-scheme) by default, with a
// manual override (light | dark) stored locally. Always resolves to a
// concrete data-theme on <html>; tokens.css does the rest.
import { store } from './storage.js';

const KEY = 'zh.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

export const getThemePref = () => {
  const v = store.get(KEY, 'system');
  return ['system', 'light', 'dark'].includes(v) ? v : 'system';
};

export const resolvedTheme = () => document.documentElement.getAttribute('data-theme') || 'light';

function apply() {
  const pref = getThemePref();
  const theme = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  // browser chrome color follows the surface token of the active theme
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim();
  listeners.forEach((fn) => fn(theme, pref));
}

export function setThemePref(pref) {
  store.set(KEY, pref);
  apply();
}

export function initTheme() {
  media.addEventListener('change', () => { if (getThemePref() === 'system') apply(); });
  apply();
}

export const onThemeChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
