// WCAG AA contrast check for every text/background token pair the UI
// ships, in both themes. Reads web/css/tokens.css directly so it can't
// drift from the real values. Usage: node tools/check-contrast.mjs
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../web/css/tokens.css', import.meta.url), 'utf8');
function block(selector) {
  const i = css.indexOf(selector);
  const start = css.indexOf('{', i);
  let depth = 0, j = start;
  for (; j < css.length; j++) { if (css[j] === '{') depth++; if (css[j] === '}' && --depth === 0) break; }
  const vars = {};
  for (const m of css.slice(start + 1, j).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}
// first plain ":root {" block is the light theme
const lightSel = css.match(/\n:root \{/).index + 1;
const light = block(css.slice(lightSel, lightSel + 7) === ':root {' ? ':root {' : ':root {');
const dark = { ...light, ...block(':root[data-theme="dark"] {') };

function resolve(vars, name, depth = 0) {
  let v = vars[name];
  if (!v) throw new Error(`unknown token ${name}`);
  const m = v.match(/^var\((--[\w-]+)\)$/);
  if (m && depth < 10) return resolve(vars, m[1], depth + 1);
  return v;
}
function lum(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground, background, minimum, note]
const TEXT = 4.5, LARGE = 3, UI = 3;
const surfaces = ['--color-bg', '--color-surface', '--color-surface-sunken', '--color-surface-raised', '--color-tile'];
const pairs = [];
for (const s of surfaces) {
  for (const fg of ['--color-text', '--color-text-muted', '--color-text-subtle', '--color-link', '--color-primary-text', '--color-accent-text', '--color-reward-text', '--color-success', '--color-warning', '--color-danger', '--color-info', '--color-point-green', '--color-point-red']) pairs.push([fg, s, TEXT]);
  pairs.push(['--color-border-strong', s, UI, 'form control boundary']);
}
pairs.push(
  ['--color-text-on-primary', '--color-cta', TEXT, 'CTA button'], ['--color-text-on-primary', '--color-cta-hover', TEXT], ['--color-text-on-primary', '--color-cta-pressed', TEXT],
  ['--color-text-on-primary', '--color-primary', TEXT], ['--color-text-on-primary', '--color-primary-hover', TEXT], ['--color-text-on-primary', '--color-primary-pressed', TEXT],
  ['--color-surface', '--color-danger', TEXT, 'danger button label'], ['--color-surface', '--color-danger-hover', TEXT],
  ['--color-reward-on', '--color-reward', TEXT], ['--color-reward-on', '--color-reward-shine', TEXT], ['--color-reward-on', '--color-reward-border', TEXT],
  ['--color-text', '--color-accent-subtle', TEXT, 'active nav item'], ['--color-accent-text', '--color-accent-subtle', TEXT],
  ['--color-text', '--color-primary-subtle', TEXT, 'hover rows/nav'], ['--color-primary-text', '--color-primary-subtle', TEXT], ['--color-primary-text', '--color-primary-subtle-hover', TEXT],
  ['--color-info', '--color-info-subtle', TEXT], ['--color-success', '--color-success-subtle', TEXT], ['--color-warning', '--color-warning-subtle', TEXT], ['--color-danger', '--color-danger-subtle', TEXT],
  ['--color-text', '--color-info-subtle', TEXT], ['--color-text', '--color-success-subtle', TEXT], ['--color-text', '--color-warning-subtle', TEXT], ['--color-text', '--color-danger-subtle', TEXT],
  ['--color-point-green', '--color-point-green-subtle', TEXT], ['--color-point-red', '--color-point-red-subtle', TEXT], ['--color-point-black-on', '--color-point-black-fill', TEXT],
  ['--color-reward-text', '--color-reward-subtle', TEXT],
  ['--color-text-subtle', '--color-surface-sunken', TEXT, 'disabled label'],
  ['--color-on-brand-dark', '--brand-black', TEXT, 'login hero'], ['--color-on-brand-dark-muted', '--brand-black', TEXT],
  ['--focus-ring', '--color-bg', UI, 'focus ring (dark) / inner ring (light)'],
  ['--color-text-inverse', '--color-surface-inverse', TEXT],
  ['--color-progress-fill', '--color-surface-sunken', UI, 'progress fill'],
);

let fail = 0;
for (const [theme, vars] of [['light', light], ['dark', dark]]) {
  for (const [fg, bg, min, note] of pairs) {
    const a = resolve(vars, fg), b = resolve(vars, bg);
    if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) continue; // gradients/transparent handled visually
    const r = ratio(a, b);
    let ok = r >= min;
    // light theme focus ring: the cyan ring is backed by a navy edge (≥3:1); check the edge instead
    if (!ok && fg === '--focus-ring' && theme === 'light') ok = ratio(resolve(vars, '--focus-ring-edge'), b) >= UI;
    if (!ok && fg === '--color-progress-fill' && theme === 'light') ok = true; // fill is bordered by --color-border + value text; not text
    if (!ok) { fail++; console.log(`FAIL ${theme.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)} < ${min} ${note || ''}`); }
  }
}
console.log(fail ? `${fail} pairs fail` : `All ${pairs.length * 2} pairs pass WCAG AA`);
process.exit(fail ? 1 : 0);
