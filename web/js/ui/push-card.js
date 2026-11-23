// Calm opt-in card for shift reminders (never auto-prompts).
import { h, add, fill } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { store } from '../core/storage.js';
import { pushStatus, enablePush } from '../core/push.js';
import { button, setLoading } from './button.js';
import { alert } from './display.js';
import { toast } from './toast.js';
import { icon } from './icons.js';
import { errorMessage } from '../core/errors.js';

/**
 * pushCard(me, { dismissible, compact })
 *  - standalone (Home): title + explanation + Enable button (dismissible)
 *  - compact (My account, where the card already explains): status/button only
 * Rendering is generation-guarded: overlapping async renders (initial +
 * after enabling) can never append two copies.
 */
export function pushCard(me, { dismissible = true, compact = false } = {}) {
  const host = h('div', { class: 'install-slot' });
  let generation = 0;
  const render = async () => {
    const gen = ++generation;
    const st = await pushStatus();
    if (gen !== generation) return;          // a newer render superseded this one
    fill(host);
    if (st === 'enabled') { if (!dismissible) add(host, alert(t('push.enabled'), { tone: 'success' })); return; }
    if (dismissible && store.get('zh.pushDismissed') === '1') return;
    if (st === 'unsupported') { if (!dismissible) add(host, alert(t('push.unsupported'), { tone: 'info' })); return; }
    if (st === 'denied') { add(host, alert(t('push.denied'), { tone: 'warning' })); return; }
    const btn = button({ label: t('push.enable'), variant: 'primary', size: 'sm', icon: 'bell', onClick: async () => {
      setLoading(btn, true);
      try {
        const r = await enablePush(me.id);
        toast({ title: r === 'enabled' ? t('push.enabled') : t('push.denied'), tone: r === 'enabled' ? 'success' : 'warning' });
      } catch (e) { toast({ title: t('error.title'), text: errorMessage(e), tone: 'danger' }); }
      finally { setLoading(btn, false); render(); }
    } });
    if (compact) { add(host, h('div', {}, btn)); return; }
    add(host, h('section', { class: 'install-card' },
      h('span', { class: 'empty__icon install-card__badge' }, icon('bell')),
      h('div', { class: 'install-card__text' }, h('p', { class: 'install-card__title' }, t('push.title')), h('p', { class: 'text-sm text-muted' }, t('push.text'))),
      h('div', { class: 'install-card__actions' }, btn,
        dismissible ? button({ label: t('push.dismiss'), variant: 'ghost', size: 'sm', onClick: () => { store.set('zh.pushDismissed', '1'); render(); } }) : null)));
  };
  render();
  return host;
}
