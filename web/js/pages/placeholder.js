// Step-1 shell preview pages (illustrative content; replaced by real
// screens in later steps).
import { h } from '../core/dom.js';
import { t, setDocumentTitle } from '../core/i18n.js';
import { pageHeader } from '../shell/shell.js';
import { card, stat, badge, progress, emptyState, alert } from '../ui/display.js';
import { installBanner } from '../ui/install.js';

export function renderPlaceholder(main, { item, user, isHome }) {
  setDocumentTitle(t(item.labelKey));
  main.append(pageHeader({
    eyebrow: isHome ? t('shell.welcome', { name: user.name }) : t(user.roleKey),
    title: t(item.labelKey),
    subtitle: t('shell.previewNotice'),
  }));
  if (isHome) {
    main.append(
      installBanner(),
      alert(t('shell.previewNotice'), { tone: 'info' }),
      h('div', { class: 'grid-auto' },
        card({ body: stat({ label: t('design.statDays'), value: '14', meta: t('design.statMeta') }) }),
        card({ body: stat({ label: t('design.statHours'), value: '112.5', meta: t('design.statMeta') }) }),
        card({ facet: true, body: [
          progress({ label: t('reward.progress'), value: 7, max: 30, reward: true, hint: t('reward.remaining', { n: 23 }) }),
          h('div', { class: 'cluster cluster--sm' },
            badge(`7 · ${t('points.green')}`, { tone: 'point-green', dot: true }),
            badge(`1 · ${t('points.red')}`, { tone: 'point-red', dot: true }),
            badge(`0 · ${t('points.black')}`, { tone: 'point-black', dot: true })),
        ] })));
  } else {
    main.append(emptyState({ iconName: item.icon, title: t(item.labelKey), text: t('common.comingSoon') }));
  }
}
