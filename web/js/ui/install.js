// "Install the app" UI: a button where the browser supports the install
// prompt, step-by-step instructions on iPhone/iPad (Safari has no
// prompt), nothing when already installed. Also the update banner.
import { h, add, fill } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { store } from '../core/storage.js';
import { state, promptInstall, onPwaChange, applyUpdate } from '../core/pwa.js';
import { button } from './button.js';
import { modal } from './modal.js';
import { icon } from './icons.js';
import { toast } from './toast.js';

function iosSteps() {
  const m = modal({
    title: t('pwa.iosTitle'), size: 'sm',
    body: h('ol', { class: 'install-steps' },
      h('li', {}, icon('share'), h('span', {}, t('pwa.iosStep1'))),
      h('li', {}, icon('plusSquare'), h('span', {}, t('pwa.iosStep2'))),
      h('li', {}, icon('check'), h('span', {}, t('pwa.iosStep3')))),
    actions: [button({ label: t('common.close'), variant: 'primary', onClick: () => m.close() })],
  });
  m.open();
}

/** Inline install button (renders nothing if install isn't possible). */
export function installButton({ variant = 'secondary', block = false, size = 'md' } = {}) {
  const host = h('div', { class: 'install-slot' });
  const render = (s) => {
    fill(host, );
    if (s.installed || (!s.canPrompt && !s.iosManual)) return;
    add(host, button({ label: t('pwa.install'), variant, block, size, icon: 'download', onClick: async () => {
      if (s.canPrompt) {
        const outcome = await promptInstall();
        if (outcome === 'accepted') toast({ title: t('pwa.installed'), tone: 'success' });
      } else iosSteps();
    } }));
  };
  render(state());
  onPwaChange(render);
  return host;
}

// Dismissal is remembered per device under a namespaced key (never touches
// the auth storage). It is read BEFORE the card is built, so a dismissed
// card never flashes. If storage is blocked, the dismissal still holds for
// this page session (in memory) and nothing throws.
const DISMISS_KEY = 'hadir.pwa.installBannerDismissed';
let dismissedThisSession = false;
const isDismissed = () => dismissedThisSession || store.get(DISMISS_KEY) === '1' || store.get('zh.installDismissed') === '1';
const dismiss = () => { dismissedThisSession = true; store.set(DISMISS_KEY, '1'); };

/** Dismissible install card (shown until dismissed). */
export function installBanner() {
  const host = h('div', { class: 'install-slot' });
  const render = (s) => {
    fill(host, );
    if (s.installed || isDismissed() || (!s.canPrompt && !s.iosManual)) return;
    add(host, h('section', { class: 'install-card', 'aria-labelledby': 'install-title' },
      h('img', { src: new URL('../../assets/icons/icon-192.png', import.meta.url).href, alt: '', width: '48', height: '48', class: 'install-card__icon' }),
      h('div', { class: 'install-card__text' },
        h('p', { class: 'install-card__title', id: 'install-title' }, t('pwa.bannerTitle', { app: `\u2066${t('app.name')}\u2069` })),
        h('p', { class: 'text-sm text-muted' }, t(s.canPrompt ? 'pwa.bannerText' : 'pwa.bannerTextIos'))),
      h('div', { class: 'install-card__actions' },
        installButton({ variant: 'primary', size: 'sm' }),
        button({ label: t('pwa.notNow'), variant: 'ghost', size: 'sm', onClick: () => { dismiss(); render(state()); } }))));
  };
  render(state());
  onPwaChange(render);
  return host;
}

/** Show a one-time "new version" toast with an Update action. */
export function watchUpdates() {
  let shown = false;
  onPwaChange((s) => {
    if (!s.updateReady || shown) return;
    shown = true;
    const dismiss = toast({ title: t('pwa.updateTitle'), text: t('pwa.updateText'), tone: 'info', duration: 0 });
    const region = document.querySelector('.toast-region .toast:last-child .toast__body');
    region?.append(button({ label: t('pwa.updateNow'), variant: 'primary', size: 'sm', onClick: () => { dismiss(); applyUpdate(); } }));
  });
}
