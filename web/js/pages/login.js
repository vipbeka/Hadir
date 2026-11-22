// Login screen: one numeric code field, no email/username.
// The code is sent once to the login Edge Function (via onSubmit) and is
// cleared from the field afterwards; it is never stored client-side.
import { h, clear } from '../core/dom.js';
import { t, setDocumentTitle } from '../core/i18n.js';
import { input, setFieldError } from '../ui/field.js';
import { button, setLoading } from '../ui/button.js';
import { brandName, logoLarge } from '../ui/brand.js';
import { langSwitcher, themeToggle } from '../ui/prefs.js';
import { toast } from '../ui/toast.js';
import { alert } from '../ui/display.js';
import { installBanner } from '../ui/install.js';

const CODE_RE = /^\d{6,12}$/;

export function renderLogin(root, { onSubmit, notice } = {}) {
  clear(root);
  document.body.classList.remove('has-bottombar');
  setDocumentTitle(t('login.title'));

  const codeField = input({
    label: t('login.codeLabel'),
    name: 'code',
    type: 'password',          // masked like a PIN; numeric keypad via inputmode
    hint: t('login.codeHint'),
    placeholder: t('login.codePlaceholder'),
    required: true,
    attrs: {
      class: 'input--code',
      inputmode: 'numeric',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      maxlength: '12',
      pattern: '[0-9]*',
    },
  });
  const codeInput = codeField.querySelector('input');
  codeInput.addEventListener('input', () => {
    // digits only; strip anything else as the user types
    const clean = codeInput.value.replace(/\D/g, '');
    if (clean !== codeInput.value) codeInput.value = clean;
    setFieldError(codeField, null);
  });

  const submit = button({ label: t('login.submit'), variant: 'primary', size: 'lg', block: true, type: 'submit' });

  const form = h('form', { class: 'stack', novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (!code) { setFieldError(codeField, t('login.errorEmpty')); codeInput.focus(); return; }
    if (!CODE_RE.test(code)) { setFieldError(codeField, t('login.errorFormat')); codeInput.focus(); return; }
    setLoading(submit, true, t('login.submitting'));
    try {
      if (onSubmit) await onSubmit(code);
      else toast({ title: t('login.title'), text: t('login.notConnected'), tone: 'info' });
    } catch (err) {
      // one generic message for any wrong code; lockout/network get their own calm text
      setFieldError(codeField, t(err?.messageKey || 'login.errorGeneric', err?.vars));
      codeInput.focus();
    } finally {
      setLoading(submit, false);
      codeInput.value = '';   // never keep the code around in the DOM
    }
  } }, codeField, submit);

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
        h('div', { class: 'card' }, h('h2', { class: 'visually-hidden' }, t('login.title')), form),
        h('p', { class: 'auth__footnote' }, t('login.footnote')),
        installBanner()),
      h('div', { class: 'auth__prefs' }, langSwitcher(), themeToggle({ compact: true })))));
  codeInput.focus({ preventScroll: true });
}
