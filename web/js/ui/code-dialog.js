// Shows a freshly generated login code exactly once.
// The code lives only in this dialog's DOM while it is open: it is not
// logged, stored, put in the URL or in local/session storage, and the
// element + variable are cleared when the dialog closes.
import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { modal } from './modal.js';
import { button } from './button.js';
import { alert } from './display.js';
import { toast } from './toast.js';

export function showCodeOnce({ name, code }) {
  let secret = code;
  const codeEl = h('output', { class: 'code-reveal', dir: 'ltr', 'aria-label': t('login.codeLabel') }, secret.replace(/(\d{4})(?=\d)/g, '$1 '));
  const copy = button({ label: t('common.copy'), variant: 'secondary', icon: 'copy', onClick: async () => {
    try {
      await navigator.clipboard.writeText(secret);
      copy.querySelector('.btn__label').textContent = t('common.copied');
      toast({ title: t('common.copied'), tone: 'success', duration: 2000 });
    } catch {
      // clipboard blocked: select the text so the owner can copy manually
      const r = document.createRange(); r.selectNodeContents(codeEl);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }
  } });
  const m = modal({
    title: t('emp.codeDialogTitle', { name }),
    size: 'sm',
    dismissible: true,
    body: [alert(t('emp.codeWarning'), { tone: 'warning' }), h('div', { class: 'code-reveal__wrap' }, codeEl, copy)],
    actions: [button({ label: t('emp.codeDone'), variant: 'primary', onClick: () => m.close('done') })],
    onClose: () => {
      secret = null;
      codeEl.textContent = '';
      try { getSelection().removeAllRanges(); } catch { /* ignore */ }
    },
  });
  return m.open();
}
