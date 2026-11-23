// Staff Home: greeting hero, today's status (with the real check-in
// closing time), month stats and this month's point counters.
import { h, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { sb } from '../../core/supabase.js';
import { errorMessage } from '../../core/errors.js';
import { displayName, formatTime, formatClock, formatMinutes, formatLongDate, formatDateTime, jobTitle } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, chip, statCard, progress, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button } from '../../ui/button.js';
import { icon } from '../../ui/icons.js';
import { installBanner } from '../../ui/install.js';
import { pushCard } from '../../ui/push-card.js';
import { navigate } from '../../core/router.js';

/** Three counters (green / red / black) used on Home and Points. */
export function pointCounters(tot) {
  const c = (cls, n, label) => h('div', { class: `counter counter--${cls}` },
    h('span', { class: 'counter__value num' }, String(n ?? 0)),
    h('span', { class: 'counter__label' }, h('span', { class: 'chip__dot', 'aria-hidden': 'true' }), label));
  return h('div', { class: 'counter-row' },
    c('green', tot.green, t('points.green')), c('red', tot.red, t('points.red')), c('black', tot.black, t('points.black')));
}
// kept for other pages that import it
export const pointsBadges = pointCounters;

export function rewardProgress(sum) {
  const g = Math.max(0, sum.period_totals.green), th = sum.threshold;
  return progress({ label: t('reward.progress'), value: Math.min(g, th), max: th, reward: true, valueText: `${g}/${th}`,
    hint: g >= th ? t('reward.reached') : t('reward.remaining', { n: th - g }) });
}

function cairoHour(iso) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Africa/Cairo' }).format(iso ? new Date(iso) : new Date()));
}

export async function renderStaffHome(main, { me }) {
  setDocumentTitle(t('nav.home'));
  const greetHost = h('div', { class: 'hero-greet' }, icon('hand'), t(cairoHour() < 12 ? 'home.greetMorning' : 'home.greetEvening'));
  add(main, pageHeader({
    chips: [chip(t('role.staff'), { dot: true }), jobTitle(me) ? chip(jobTitle(me), { tone: 'neutral' }) : null],
    title: t('shell.welcome', { name: displayName(me) }), subtitle: t('home.tagline'), aside: greetHost }),
  installBanner(), pushCard(me));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);
  try {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const [day, sum, ann] = await Promise.all([api('my_day'), api('my_summary'),
      // latest owner announcement (last 7 days); a failure here never blocks Home
      sb.from('announcements').select('body,created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(1)
        .then((r) => (r.error ? null : r.data?.[0] || null), () => null)]);
    fill(greetHost, icon('hand'), t(cairoHour(day.server_now) < 12 ? 'home.greetMorning' : 'home.greetEvening'));
    const a = day.attendance;
    const goBtn = (label) => button({ label, variant: 'primary', size: 'lg', block: true, iconEnd: 'arrowRight', onClick: () => navigate('/staff/attendance') });
    // one status decision for the "today" card
    let st; let title; let sub = null; let ico; let action = null;
    if (day.holiday) { st = chip(t('home.stHoliday'), { tone: 'accent' }); ico = 'calendar'; title = t('home.holiday', { name: getLang() === 'ar' ? day.holiday.name_ar : day.holiday.name_en }); }
    else if (!day.is_work_day) { st = chip(t('home.stOff'), { tone: 'neutral' }); ico = 'calendar'; title = t('home.dayOff'); }
    else if (a?.checked_out_at) {
      st = chip(t('home.stOut'), { tone: 'success', dot: true }); ico = 'checkCircle'; title = t('home.outTitle');
      sub = `${t('home.checkedInAt', { time: formatTime(a.checked_in_at) })} · ${t('home.checkedOutAt', { time: formatTime(a.checked_out_at) })}`;
    } else if (a?.checked_in_at) {
      st = chip(t('home.stIn'), { tone: 'success', dot: true }); ico = 'clock'; title = t('home.checkedInAt', { time: formatTime(a.checked_in_at) });
      sub = t('home.inSub', { time: formatClock(day.expected_end_time) }); action = goBtn(t('att.checkOut'));
    } else if (day.check_in_closed) {
      st = chip(t('home.stClosed'), { tone: 'warning', dot: true }); ico = 'clockOff'; title = t('home.notCheckedIn');
      sub = t('home.closedSub', { time: formatClock(day.check_in_closes_at) });
    } else {
      st = chip(t('home.stPending'), { dot: true }); ico = 'clockOff'; title = t('home.notCheckedIn');
      sub = day.check_in_closes_at ? t('home.availableUntil', { time: formatClock(day.check_in_closes_at) }) : null;
      action = day.check_in_enabled ? goBtn(t('home.goCheckIn')) : null;
    }
    fill(body,
      ann ? h('section', { class: 'card announce', role: 'status' },
        h('span', { class: 'card__icon', 'aria-hidden': 'true' }, icon('bell')),
        h('div', { class: 'announce__text' }, h('p', { class: 'announce__title' }, t('home.announcement')),
          h('p', { class: 'announce__body' }, ann.body), h('p', { class: 'text-xs text-muted' }, formatDateTime(ann.created_at)))) : null,
      card({ iconName: 'calendarCheck', title: t('home.todayDate', { date: formatLongDate(day.business_date) }), actions: st, className: 'today-card',
        body: [h('div', { class: 'today-box' },
          h('span', { class: 'today-box__icon', 'aria-hidden': 'true' }, icon(ico)),
          h('div', { class: 'today-box__text' }, h('p', { class: 'today-box__title' }, title), sub ? h('p', { class: 'today-box__sub' }, sub) : null)),
        action] }),
      sum.pending_black > 0 ? alert(t('home.pendingBlack', { n: sum.pending_black }), { tone: 'warning' }) : null,
      day.missing_checkouts > 0 ? alert(t('home.missingCheckouts', { n: day.missing_checkouts }), { tone: 'info' }) : null,
      h('div', { class: 'stat-pair' },
        statCard({ label: t('design.statDays'), iconName: 'calendarCheck', value: String(sum.days_present), unit: t('home.daysUnit'), meta: t('design.statMeta'), metaIcon: 'checkCircle' }),
        statCard({ label: t('home.hoursTitle'), iconName: 'clock', value: formatMinutes(sum.worked_minutes), meta: t('design.statMeta'), metaIcon: 'activity' })),
      card({ iconName: 'trophy', title: t('home.pointsLog'), actions: chip(t('home.live'), { tone: 'neutral' }),
        body: [pointCounters(sum.period_totals),
          h('a', { class: 'tip-row', href: '#/staff/points' }, icon('bulb'), h('span', { class: 'tip-row__text' }, t('home.tip')), icon('chevronRight', { flip: true }))] }));
  } catch (err) {
    fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true }));
  }
}
