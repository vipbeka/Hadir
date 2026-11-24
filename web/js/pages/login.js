// Login screen: one numeric code, entered with an on-screen number pad.
// Visual design adapted from the supplied "Pocket Keypad" (code boxes +
// mini keypad); the demo autoplay and test codes are not used.
// The real <input name="code"> stays the single source of truth (typing,
// paste, password managers, tests); the boxes only mirror it. The code is
// sent once to the login Edge Function and is cleared afterwards; it is
// never stored client-side. Digits are masked unless «إظهار» is pressed.
import { h, clear } from '../core/dom.js';
import { t, setDocumentTitle } from '../core/i18n.js';
import { button, setLoading } from '../ui/button.js';
import { brandName, logoLarge } from '../ui/brand.js';
import { langSwitcher, themeToggle } from '../ui/prefs.js';
import { toast } from '../ui/toast.js';
import { alert } from '../ui/display.js';
import { icon } from '../ui/icons.js';
import { installBanner } from '../ui/install.js';

const CODE_RE = /^\d{6,12}$/;
const MIN_BOXES = 8;       // current code length; grows up to 12 as typed
const MAX = 12;
const touch = () => window.matchMedia?.('(pointer: coarse)').matches;

export function renderLogin(root, { onSubmit, notice } = {}) {
  clear(root);
  document.body.classList.remove('has-bottombar');
  setDocumentTitle(t('login.title'));

  let reveal = false; let busy = false;
  const status = h('span', { class: 'cp-status__text' }, t('login.padIdle'));
  const statusBox = h('p', { class: 'cp-status', id: 'cp-status', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'cp-dot', 'aria-hidden': 'true' }), status);
  // the real field: transparent, on top of the boxes (tap → focus; type/paste work)
  const codeInput = h('input', { class: 'cp-input', id: 'login-code', name: 'code', type: 'password', required: true,
    inputmode: touch() ? 'none' : 'numeric',  // phones: the pad below replaces the system keyboard
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: String(MAX), pattern: '[0-9]*',
    'aria-describedby': 'cp-status cp-hint' });
  const row = h('div', { class: 'cp-row', dir: 'ltr', 'aria-hidden': 'true' });
  const setStatus = (text, state) => { status.textContent = text; statusBox.className = `cp-status${state ? ` cp-status--${state}` : ''}`; };

  function paint(pop = -1) {
    const v = codeInput.value; const n = Math.min(MAX, Math.max(MIN_BOXES, v.length + (v.length >= MIN_BOXES && v.length < MAX ? 1 : 0)));
    while (row.children.length < n) row.append(h('span', { class: 'cp-box' }, h('span', { class: 'cp-box__ch' })));
    while (row.children.length > n) row.lastChild.remove();
    row.style.setProperty('--n', String(n));
    [...row.children].forEach((box, i) => {
      const ch = v[i] || '';
      box.firstChild.textContent = ch ? (reveal ? ch : '•') : '';
      box.classList.toggle('cp-box--filled', !!ch);
      box.classList.toggle('cp-box--active', document.activeElement === codeInput && i === Math.min(v.length, n - 1) && !busy);
      if (i === pop) { box.classList.remove('cp-box--pop'); void box.offsetWidth; box.classList.add('cp-box--pop'); }
    });
    submit.disabled = busy || v.length < 6;
  }
  const clean = (s) => s.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '').slice(0, MAX);
  codeInput.addEventListener('input', () => {
    const before = codeInput.dataset.len ? Number(codeInput.dataset.len) : 0;
    codeInput.value = clean(codeInput.value);
    codeInput.dataset.len = String(codeInput.value.length);
    root.querySelector('.cp')?.classList.remove('cp--shake', 'cp--ok');
    if (statusBox.classList.contains('cp-status--err')) setStatus(t('login.padIdle'), '');
    paint(codeInput.value.length > before ? codeInput.value.length - 1 : -1);
  });
  codeInput.addEventListener('focus', () => paint()); codeInput.addEventListener('blur', () => paint());
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); } });

  // on-screen pad (LTR like every phone keypad, also in Arabic)
  const press = (k, el) => {
    if (busy) return;
    if (el) { el.classList.remove('cp-key--press'); void el.offsetWidth; el.classList.add('cp-key--press'); }
    if (k === 'back') codeInput.value = codeInput.value.slice(0, -1);
    else if (codeInput.value.length < MAX) codeInput.value += k;
    codeInput.dispatchEvent(new Event('input', { bubbles: true }));
    if (!touch()) codeInput.focus({ preventScroll: true });
  };
  const key = (k, label, extra = {}) => { const b = h('button', { type: 'button', class: ['cp-key', extra.cls], 'data-k': k, 'aria-label': extra.aria || null,
    onClick: (e) => press(k, e.currentTarget) }, label); return b; };
  let holdTimer = 0;
  const back = key('back', icon('backspace'), { cls: 'cp-key--back', aria: t('login.padBack') });
  back.addEventListener('pointerdown', () => { holdTimer = setTimeout(() => { codeInput.value = ''; codeInput.dispatchEvent(new Event('input', { bubbles: true })); }, 600); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => back.addEventListener(ev, () => clearTimeout(holdTimer)));
  const eye = h('button', { type: 'button', class: 'cp-key cp-key--eye', 'aria-pressed': 'false', 'aria-label': t('login.padShow'),
    onClick: () => { reveal = !reveal; eye.setAttribute('aria-pressed', String(reveal)); eye.setAttribute('aria-label', t(reveal ? 'login.padHide' : 'login.padShow'));
      eye.replaceChildren(icon(reveal ? 'eyeOff' : 'eye')); paint(); } }, icon('eye'));
  const pad = h('div', { class: 'cp-pad', dir: 'ltr', role: 'group', 'aria-label': t('login.padLabel') },
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, d)), eye, key('0', '0'), back);

  const submit = button({ label: t('login.submit'), variant: 'primary', size: 'lg', block: true, type: 'submit' });
  const form = h('form', { class: 'cp-form', novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    if (busy) return;
    const code = codeInput.value.trim();
    const card = root.querySelector('.cp');
    if (!code) { setStatus(t('login.errorEmpty'), 'err'); card.classList.add('cp--shake'); return; }
    if (!CODE_RE.test(code)) { setStatus(t('login.errorFormat'), 'err'); card.classList.remove('cp--shake'); void card.offsetWidth; card.classList.add('cp--shake'); return; }
    busy = true; setLoading(submit, true, t('login.submitting')); setStatus(t('login.submitting'), 'busy'); paint();
    try {
      if (onSubmit) { await onSubmit(code); card.classList.add('cp--ok'); setStatus(t('login.padOk'), 'ok'); }
      else toast({ title: t('login.title'), text: t('login.notConnected'), tone: 'info' });
    } catch (err) {
      // one generic message for any wrong code; lockout/network get their own calm text
      setStatus(t(err?.messageKey || 'login.errorGeneric', err?.vars), 'err');
      card.classList.remove('cp--shake'); void card.offsetWidth; card.classList.add('cp--shake');
    } finally {
      busy = false; setLoading(submit, false);
      codeInput.value = ''; codeInput.dataset.len = '0';   // never keep the code around in the DOM
      paint();
      if (!touch() && root.contains(codeInput)) codeInput.focus({ preventScroll: true });
    }
  } },
  h('label', { class: 'cp-label', for: 'login-code' }, t('login.codeLabel')),
  h('div', { class: 'cp-field' }, row, codeInput),
  statusBox, pad, submit,
  h('p', { class: 'cp-hint', id: 'cp-hint' }, t('login.codeHint')));

  root.append(h('div', { class: 'auth' },
    h('section', { class: 'auth__hero', 'aria-hidden': 'true' },
      h('div', { class: 'auth__hero-content' },
        h('p', { class: 'auth__hero-title' }, t('login.heroTitle')),
        h('p', { class: 'auth__hero-text' }, t('login.heroText')))),
    h('main', { class: 'auth__panel', id: 'main' },
      h('div', { class: 'auth__card' },
        h('div', { class: 'auth__brand' },
          logoLarge(),
          h('h1', { class: 'auth__wordmark' }, brandName()),
          h('p', { class: 'auth__company' }, t('app.tagline'))),
        notice ? alert(notice, { tone: 'info' }) : null,
        h('div', { class: 'card cp' }, h('h2', { class: 'visually-hidden' }, t('login.title')), form),
        h('p', { class: 'auth__footnote' }, t('login.footnote')),
        installBanner()),
      h('div', { class: 'auth__prefs' }, langSwitcher(), themeToggle({ compact: true })))));
  paint();
  // desktop: ready to type; phones: no focus → no system keyboard popping up
  if (!touch()) codeInput.focus({ preventScroll: true });
}
