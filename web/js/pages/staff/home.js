// Staff Home: welcome, today's status, month stats, points, reward progress.
import { h, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { displayName, formatTime, formatMinutes, jobTitle, formatEGP } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, stat, badge, progress, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button } from '../../ui/button.js';
import { installBanner } from '../../ui/install.js';
import { pushCard } from '../../ui/push-card.js';
import { navigate } from '../../core/router.js';

export function pointsBadges(tot) {
  return h('div', { class: 'cluster cluster--sm' },
    badge(`${tot.green} · ${t('points.green')}`, { tone: 'point-green', dot: true, size: 'lg' }),
    badge(`${tot.red} · ${t('points.red')}`, { tone: 'point-red', dot: true, size: 'lg' }),
    badge(`${tot.black} · ${t('points.black')}`, { tone: 'point-black', dot: true, size: 'lg' }));
}

export function rewardProgress(sum) {
  const g = Math.max(0, sum.period_totals.green), th = sum.threshold;
  return progress({ label: t('reward.progress'), value: Math.min(g, th), max: th, reward: true, valueText: `${g}/${th}`,
    hint: g >= th ? t('reward.reached') : t('reward.remaining', { n: th - g }) });
}

export async function renderStaffHome(main, { me }) {
  setDocumentTitle(t('nav.home'));
  add(main, pageHeader({ eyebrow: jobTitle(me) || t('role.staff'), title: t('shell.welcome', { name: displayName(me) }) }),
    installBanner(), pushCard(me));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);
  try {
    const [day, sum] = await Promise.all([api('my_day'), api('my_summary')]);
    const a = day.attendance;
    let todayText; let action = null;
    if (day.holiday) todayText = t('home.holiday', { name: getLang() === 'ar' ? day.holiday.name_ar : day.holiday.name_en });
    else if (!day.is_work_day) todayText = t('home.dayOff');
    else if (a?.checked_out_at) todayText = `${t('home.checkedInAt', { time: formatTime(a.checked_in_at) })} · ${t('home.checkedOutAt', { time: formatTime(a.checked_out_at) })}`;
    else if (a?.checked_in_at) { todayText = t('home.checkedInAt', { time: formatTime(a.checked_in_at) }); action = button({ label: t('att.checkOut'), variant: 'primary', icon: 'mapPin', onClick: () => navigate('/staff/attendance') }); }
    else { todayText = t('home.notCheckedIn'); action = day.check_in_enabled ? button({ label: t('home.goCheckIn'), variant: 'primary', icon: 'mapPin', onClick: () => navigate('/staff/attendance') }) : null; }
    fill(body, 
      card({ facet: true, title: t('home.today'), subtitle: day.business_date, body: h('p', { class: 'stat__value', style: { 'font-size': 'var(--font-size-xl)' } }, todayText), footer: action ? [action] : null }),
      sum.pending_black > 0 ? alert(t('home.pendingBlack', { n: sum.pending_black }), { tone: 'warning' }) : null,
      day.missing_checkouts > 0 ? alert(t('home.missingCheckouts', { n: day.missing_checkouts }), { tone: 'info' }) : null,
      h('div', { class: 'grid-auto' },
        card({ body: stat({ label: t('design.statDays'), value: String(sum.days_present), meta: t('design.statMeta') }) }),
        card({ body: stat({ label: t('design.statHours'), value: formatMinutes(sum.worked_minutes), meta: t('design.statMeta') }) }),
        card({ title: t('pts.period'), body: pointsBadges(sum.period_totals) })),
      card({ body: [rewardProgress(sum), h('p', { class: 'text-sm text-muted' }, formatEGP(sum.reward_amount_piastres))],
        footer: [button({ label: t('pts.title'), variant: 'secondary', iconEnd: 'arrowRight', onClick: () => navigate('/staff/points') })] }));
  } catch (err) {
    fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true }));
  }
}
