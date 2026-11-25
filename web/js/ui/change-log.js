// The change log (what the owner — or the system — changed for an
// employee, with the reason and who did it). Shared by the employee's
// «كشف حسابي» page and the owner's employee page.
import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { formatDate, formatDateTime, formatClock, formatEGP } from '../core/format.js';
import { badge } from './display.js';

const TONE = { 'black.approve': 'danger', 'points.manual': 'warning', 'correction.rejected': 'danger', 'permission.rejected': 'danger',
  'leave.rejected': 'danger', 'early_leave.rejected': 'danger', 'black.decline': 'success', 'points.absence_cancelled': 'success',
  'points.absence_reversed': 'success', 'correction.approved': 'success', 'permission.approved': 'success', 'leave.approved': 'success',
  'early_leave.approved': 'success', 'reward.approve': 'success', 'reward.paid': 'success' };

const AUTO_NOTE = new Set(['points.absence_cancelled', 'points.absence_reversed']);

function detail(x) {
  const a = x.after || {}; const b = x.before || {};
  switch (x.action) {
    case 'attendance.correct': return a.checked_out_at ? t('chg.d.checkout', { time: formatDateTime(a.checked_out_at) }) : null;
    case 'attendance.manual_check_in': return a.time ? t('chg.d.checkin', { time: formatClock(a.time), date: formatDate(a.date) }) : null;
    case 'points.manual': return a.color ? t('chg.d.points', { color: t(`points.${a.color}`), from: b.total ?? '—', to: a.total ?? '—' }) : null;
    case 'leave_balance.set': return a.entitled != null ? t('chg.d.balance', { from: b.entitled ?? '—', to: a.entitled }) : null;
    case 'black.approve': return a.deduction_piastres ? formatEGP(a.deduction_piastres) : null;
    case 'salary_payment.record': return a.amount_piastres ? formatEGP(a.amount_piastres) : null;
    default: return null;
  }
}

export function changeList(rows) {
  if (!rows?.length) return h('p', { class: 'text-sm text-muted' }, t('chg.empty'));
  return h('ul', { class: 'event-list change-log', role: 'list' }, rows.map((x) => {
    const label = t(`chg.${x.action}`);
    const d = detail(x);
    return h('li', { class: 'event-row' },
      badge(label === `chg.${x.action}` ? x.action : label, { tone: TONE[x.action] || 'neutral', dot: true }),
      h('div', { class: 'event-row__main' },
        h('span', { class: 'text-sm' }, formatDateTime(x.at), x.date ? ` · ${t('chg.forDay', { date: formatDate(x.date) })}` : ''),
        d ? h('span', { class: 'text-sm' }, d) : null,
        // automatic entries carry an internal (English) note: the label says it all
        x.reason && !AUTO_NOTE.has(x.action) ? h('span', { class: 'text-xs text-muted' }, t('chg.reason', { r: x.reason })) : null,
        h('span', { class: 'text-xs text-muted' }, x.by ? t('chg.by', { name: x.by }) : t('chg.system'))));
  }));
}
