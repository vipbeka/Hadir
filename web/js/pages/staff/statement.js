// «كشف حسابي» (employee): this month's (or an earlier month's) deductions,
// rewards, warnings, attendance and — only if the owner allows it — the
// salary and the expected net; plus the change log (what the owner changed,
// with the reason). Read-only; everything comes from the server.
import { h, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatDate, formatEGP, formatMinutes, monthLabel } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { select } from '../../ui/field.js';
import { changeList } from '../../ui/change-log.js';
import { cairoToday } from './requests.js';

const months = () => {
  const [y, m] = cairoToday().split('-').map(Number);
  return Array.from({ length: 6 }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - i, 1)); return d.toISOString().slice(0, 10); });
};

export async function renderStaffStatement(main) {
  setDocumentTitle(t('mys.title'));
  add(main, pageHeader({ iconName: 'fileText', title: t('mys.title'), subtitle: t('mys.subtitle') }));
  const fMonth = select({ label: t('common.month'), options: months().map((v) => ({ value: v, label: monthLabel(v) })) });
  const pay = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  const log = h('div', {}, skeletonCard(t('common.loading')));
  add(main, card({ body: fMonth }), pay, card({ title: t('chg.title'), subtitle: t('chg.subtitle'), iconName: 'history', body: log }));
  fMonth.querySelector('select').addEventListener('change', loadPay);

  async function loadPay() {
    fill(pay, skeletonCard(t('common.loading')));
    try {
      const p = await api('my_pay', { month: fMonth.querySelector('select').value });
      const kv = (k, v, strong) => h('div', { class: 'kv-row' }, h('dt', {}, k), h('dd', { class: ['num', strong && 'strong'] }, v));
      const summary = [];
      if (p.pay_visible) {
        summary.push(kv(t('mys.base'), p.base_piastres == null ? t('mys.noSalary') : formatEGP(p.base_piastres)));
      }
      summary.push(kv(t('mys.deductions'), formatEGP(p.deductions_piastres)), kv(t('mys.rewards'), formatEGP(p.earnings_piastres)));
      if (p.pending_rewards_piastres) summary.push(kv(t('mys.pendingRewards'), formatEGP(p.pending_rewards_piastres)));
      if (p.pay_visible && p.net_piastres != null) {
        summary.push(kv(p.is_current ? t('mys.netExpected') : t('mys.net'), formatEGP(p.net_piastres), true));
        if (p.paid_piastres) summary.push(kv(t('mys.paid'), formatEGP(p.paid_piastres)));
        if (p.remaining_piastres != null) summary.push(kv(t('mys.remaining'), formatEGP(p.remaining_piastres)));
      }
      const at = p.attendance || {};
      const notes = [];
      if (p.warnings_count) notes.push(t('mys.warnings', { n: p.warnings_count }));
      if (p.black_pending) notes.push(t('mys.blackPending', { n: p.black_pending }));
      if (p.missing_checkouts) notes.push(t('mys.missing', { n: p.missing_checkouts }));
      const ev = (p.events || []).map((e) => h('li', { class: 'event-row' },
        badge(t(`points.${e.color}`), { tone: e.color === 'black' ? 'danger' : 'warning', dot: true }),
        h('div', { class: 'event-row__main' },
          h('span', { class: 'num' }, formatDate(e.date)),
          h('span', { class: 'text-xs text-muted' }, e.status === 'pending_approval' ? t('mys.ev.pending') : e.reversed ? t('mys.ev.reversed')
            : e.warning ? t('mys.ev.warning') : t('mys.ev.charged')),
          h('span', { class: 'text-xs text-muted' }, e.source === 'auto_window' ? t('mys.src.late') : e.source === 'auto_absence' ? t('mys.src.absence')
            : e.reason ? t('chg.reason', { r: e.reason }) : t('mys.src.owner'))),
        h('span', { class: 'num' }, e.deduction_piastres ? `− ${formatEGP(e.deduction_piastres)}` : '—')));
      fill(pay,
        card({ title: t('mys.payTitle', { m: monthLabel(p.month) }), iconName: 'wallet', body: [
          h('dl', { class: 'kv-grid' }, summary),
          p.pay_visible ? null : h('p', { class: 'text-xs text-muted' }, t('mys.salaryHidden')),
          p.is_current ? h('p', { class: 'text-xs text-muted' }, t('mys.soFar')) : null,
          notes.length ? alert(notes.join(' · '), { tone: 'warning' }) : null] }),
        card({ title: t('mys.attTitle'), body: h('dl', { class: 'kv-grid' },
          kv(t('st.t.present'), String(at.present_days ?? 0)), kv(t('st.t.late'), String(at.late_days ?? 0)),
          kv(t('st.t.absent'), String(at.absence_days ?? 0)), kv(t('st.t.leave'), String(at.leave_days ?? 0)),
          kv(t('st.t.worked'), formatMinutes(at.worked_minutes ?? 0)), kv(t('points.green'), String(p.green_points ?? 0))) }),
        card({ title: t('mys.eventsTitle'), body: ev.length ? h('ul', { class: 'event-list', role: 'list' }, ev) : h('p', { class: 'text-sm text-muted' }, t('mys.noEvents')) }));
    } catch (err) { fill(pay, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true })); }
  }
  async function loadLog() {
    try { fill(log, changeList(await api('my_changes', { limit: 60 }))); }
    catch (err) { fill(log, alert(errorMessage(err), { tone: 'danger' })); }
  }
  loadPay(); loadLog();
}
