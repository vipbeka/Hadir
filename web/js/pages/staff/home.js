// Staff Home (reference design): greeting + avatar, gradient hero with the
// shared watch (live Cairo time, or the current announcement), today's attendance status (real window / closing times),
// month stats and this month's points with the reward progress.
import { h, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { displayName, formatTime, formatClock, formatMinutes, jobTitle } from '../../core/format.js';
import { chip, progress, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button } from '../../ui/button.js';
import { icon } from '../../ui/icons.js';
import { installBanner } from '../../ui/install.js';
import { pushCard } from '../../ui/push-card.js';
import { navigate } from '../../core/router.js';
import { announcementWatch } from '../../ui/watch.js';

/** Three counters (green / red / black) — kept for other pages. */
export function pointCounters(tot) {
  const c = (cls, n, label) => h('div', { class: `counter counter--${cls}` },
    h('span', { class: 'counter__value num' }, String(n ?? 0)),
    h('span', { class: 'counter__label' }, h('span', { class: 'chip__dot', 'aria-hidden': 'true' }), label));
  return h('div', { class: 'counter-row' },
    c('green', tot.green, t('points.green')), c('red', tot.red, t('points.red')), c('black', tot.black, t('points.black')));
}
export const pointsBadges = pointCounters;

export function rewardProgress(sum) {
  const g = Math.max(0, sum.period_totals.green), th = sum.threshold;
  return progress({ label: t('reward.progress'), value: Math.min(g, th), max: th, reward: true, valueText: `${g}/${th}`,
    hint: g >= th ? t('reward.reached') : t('reward.remaining', { n: th - g }) });
}

const cairo = (opts, d = new Date()) => new Intl.DateTimeFormat(getLang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Cairo', ...opts }).format(d);
const cairoHour = (d) => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Africa/Cairo' }).format(d));
const initial = (me) => String(displayName(me) || '').trim().charAt(0);

/** The window open right now, else the next one today (by server time). */
function windowLine(day) {
  const now = String(day.business_time || '').slice(0, 8);
  const label = (w) => (getLang() === 'ar' ? w.label_ar : w.label_en);
  const wins = (day.windows || []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const cur = wins.find((w) => now >= String(w.start) && now < String(w.end));
  if (cur) return t('home.windowNow', { label: label(cur), start: formatClock(cur.start), end: formatClock(cur.end) });
  const next = wins.find((w) => now < String(w.start));
  if (next) return t('home.windowNext', { label: label(next), start: formatClock(next.start), end: formatClock(next.end) });
  return day.check_in_closes_at ? t('home.availableUntil', { time: formatClock(day.check_in_closes_at) }) : null;
}

export async function renderStaffHome(main, { me, registerCleanup }) {
  setDocumentTitle(t('nav.home'));
  const now = new Date();
  const greet = t(cairoHour(now) < 12 ? 'home.greetMorning' : 'home.greetEvening');

  // ---- greeting (outside the cards, as in the reference)
  add(main, h('header', { class: 'greet' },
    h('div', { class: 'greet__text' },
      h('p', { class: 'greet__line' }, t('home.greetLine', { greet, role: jobTitle(me) || t('role.staff') })),
      h('h1', { class: 'greet__title' }, t('shell.welcome', { name: displayName(me) })),
      h('p', { class: 'greet__sub' }, t('home.welcomeSub'))),
    h('span', { class: 'greet__avatar', 'aria-hidden': 'true' }, initial(me))));

  // ---- gradient hero; the watch replaces the old calendar/date tile
  add(main, h('section', { class: 'hero-card' },
    h('span', { class: 'hero-card__mark', 'aria-hidden': 'true' }, 'ح'),
    h('div', { class: 'hero-card__text' },
      chip(t('home.heroChip'), { iconName: 'sparkle' }),
      h('p', { class: 'hero-card__title' }, t('home.heroTitle1'), h('br'), h('span', { class: 'hero-card__accent' }, t('home.heroTitle2'))),
      h('p', { class: 'hero-card__sub' }, t('home.heroText'))),
    announcementWatch({ size: 'compact', registerCleanup })));

  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);
  try {
    // announcements are shown by the watch in the hero (shared state)
    const [day, sum] = await Promise.all([api('my_day'), api('my_summary')]);
    const a = day.attendance;
    const go = (label) => button({ label, variant: 'primary', size: 'lg', block: true, icon: 'mapPin', iconEnd: 'arrowRight', onClick: () => navigate('/staff/attendance') });

    // one status decision for the "today" card
    let st; let muted; let bold; let ico = 'clock'; let line = null; let action = null;
    if (day.holiday) { st = chip(t('home.stHoliday'), { tone: 'accent' }); ico = 'calendar'; muted = t('home.holiday', { name: getLang() === 'ar' ? day.holiday.name_ar : day.holiday.name_en }); bold = t('home.offTitle'); }
    else if (!day.is_work_day) { st = chip(t('home.stOff'), { tone: 'neutral' }); ico = 'calendar'; muted = t('home.dayOff'); bold = t('home.offTitle'); }
    else if (a?.checked_out_at) {
      st = chip(t('home.stOut'), { tone: 'success', dot: true }); ico = 'checkCircle'; muted = t('home.outShort'); bold = t('home.outTitle');
      line = `${t('home.checkedInAt', { time: formatTime(a.checked_in_at) })} · ${t('home.checkedOutAt', { time: formatTime(a.checked_out_at) })}`;
    } else if (a?.checked_in_at) {
      st = chip(t('home.stIn'), { tone: 'success', dot: true }); muted = t('home.checkedInAt', { time: formatTime(a.checked_in_at) }); bold = t('home.inTitle');
      line = t('home.inSub', { time: formatClock(day.expected_end_time) }); action = go(t('att.checkOut'));
    } else if (day.check_in_closed) {
      st = chip(t('home.stClosed'), { tone: 'warning', dot: true }); ico = 'clockOff'; muted = t('home.notCheckedIn'); bold = t('home.closedTitle');
      line = t('home.closedSub', { time: formatClock(day.check_in_closes_at) });
    } else {
      st = chip(t('home.stPending'), { dot: true }); muted = t('home.notCheckedIn'); bold = t('home.startDay');
      line = windowLine(day); action = day.check_in_enabled ? go(t('home.goCheckIn')) : null;
    }
    const g = Math.max(0, sum.period_totals.green); const th = sum.threshold;
    const chipCount = (cls, n, label) => h('span', { class: `pt-chip pt-chip--${cls}` }, h('span', { class: 'chip__dot', 'aria-hidden': 'true' }), h('b', { class: 'num' }, String(n ?? 0)), label);

    fill(body,
      // section header: «اليوم / حالة الحضور» + date chip
      h('div', { class: 'sec-head' },
        h('div', {}, h('p', { class: 'sec-head__eyebrow' }, t('home.todayLabel')), h('h2', { class: 'sec-head__title' }, t('home.statusTitle'))),
        h('span', { class: 'chip chip--neutral' }, cairo({ weekday: 'long', day: 'numeric', month: 'long' }, now))),
      h('section', { class: 'card status-card' },
        h('div', { class: 'status-card__top' }, st),
        h('div', { class: 'status-card__row' },
          h('span', { class: 'status-card__icon', 'aria-hidden': 'true' }, icon(ico)),
          h('div', { class: 'status-card__text' }, h('p', { class: 'status-card__muted' }, muted), h('p', { class: 'status-card__bold' }, bold))),
        line ? h('p', { class: 'status-card__line' }, icon('clock', { size: 'sm' }), line) : null,
        action),
      sum.pending_black > 0 ? alert(t('home.pendingBlack', { n: sum.pending_black }), { tone: 'warning' }) : null,
      day.missing_checkouts > 0 ? alert(t('home.missingCheckouts', { n: day.missing_checkouts }), { tone: 'info' }) : null,
      h('div', { class: 'stat-pair' },
        h('section', { class: 'card mini-stat' },
          h('div', { class: 'mini-stat__head' }, h('span', { class: 'mini-stat__icon', 'aria-hidden': 'true' }, icon('calendarCheck')), h('span', {}, t('design.statDays'))),
          h('p', { class: 'mini-stat__value num' }, String(sum.days_present)),
          h('p', { class: 'mini-stat__cap' }, t('design.statMeta'))),
        h('section', { class: 'card mini-stat' },
          h('div', { class: 'mini-stat__head' }, h('span', { class: 'mini-stat__icon', 'aria-hidden': 'true' }, icon('clock')), h('span', {}, t('home.hoursTitle'))),
          h('p', { class: 'mini-stat__value num' }, formatMinutes(sum.worked_minutes)),
          h('p', { class: 'mini-stat__cap' }, t('home.monthCaption')))),
      h('section', { class: 'card month-card' },
        h('div', { class: 'card__header' }, h('div', { class: 'card__head' },
          h('span', { class: 'card__icon', 'aria-hidden': 'true' }, icon('sparkle')), h('h3', { class: 'card__title' }, t('pts.period')))),
        h('div', { class: 'pt-chips' },
          chipCount('green', sum.period_totals.green, t('points.green')),
          chipCount('red', sum.period_totals.red, t('points.red')),
          chipCount('black', sum.period_totals.black, t('points.black'))),
        h('a', { class: 'month-card__reward', href: '#/staff/points' },
          h('div', { class: 'month-card__reward-head' }, h('span', {}, icon('gift', { size: 'sm' }), t('reward.progress')), h('b', { class: 'num' }, `${g}/${th}`)),
          progress({ label: t('reward.progress'), value: Math.min(g, th), max: th, reward: true, valueText: `${g}/${th}` }))),
      installBanner(), pushCard(me));
  } catch (err) {
    fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true }));
  }
}
