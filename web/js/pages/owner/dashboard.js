// Owner dashboard: pending counts, team today, per-employee counters with salary.
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { displayName, formatEGP, formatTime, jobTitle } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, stat, badge, table, emptyState, skeletonCard } from '../../ui/display.js';
import { button } from '../../ui/button.js';
import { installBanner } from '../../ui/install.js';
import { pushCard } from '../../ui/push-card.js';
import { navigate } from '../../core/router.js';

export async function renderOwnerDashboard(main, { me }) {
  setDocumentTitle(t('od.title'));
  add(main, pageHeader({ iconName: 'grid', eyebrow: t('shell.welcome', { name: displayName(me) }), title: t('od.title'),
    actions: [button({ label: t('common.refresh'), icon: 'clock', onClick: () => load() })] }), installBanner(),
    pushCard(me, { title: t('opush.title'), text: t('opush.text'), dismissKey: 'zh.ownerPushDismissed' }));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);
  async function load() {
    try {
      const d = await api('owner_dashboard');
      const tile = (label, n, tab) => card({ interactive: true, onClick: () => navigate(`/owner/approvals?${tab}`),
        body: stat({ label, value: String(n) }) });
      const status = (e) => !e.today ? badge(t(e.day_off ? 'od.dayOff' : 'od.absent'), { tone: 'neutral' })
        : e.today.checked_out_at ? badge(t('od.out', { time: formatTime(e.today.checked_out_at) }), { tone: 'info' })
        : badge(t('od.present', { time: formatTime(e.today.checked_in_at) }), { tone: e.today.outcome === 'red' ? 'point-red' : 'success', dot: true });
      // today's operational view: active staff only; deactivated staff are
      // listed only on request (their payroll history stays in Payroll)
      const inactive = d.employees.filter((e) => !e.active);
      const team = showInactive ? d.employees : d.employees.filter((e) => e.active);
      const toggle = inactive.length ? button({ label: t(showInactive ? 'od.hideInactive' : 'od.showInactive', { n: inactive.length }), size: 'sm', variant: 'ghost',
        onClick: () => { showInactive = !showInactive; load(); } }) : null;
      fill(body, 
        h('div', { class: 'stats-grid' },
          tile(t('od.pendingBlack'), d.pending.black, 'black'), tile(t('od.pendingLeave'), d.pending.leave, 'leave'),
          tile(t('od.pendingEarly'), d.pending.early_leave, 'early'), tile(t('od.pendingReward'), d.pending.reward, 'reward'),
          tile(t('od.pendingPermission'), d.pending.permission ?? 0, 'permission'), tile(t('od.pendingCorrection'), d.pending.correction ?? 0, 'correction'),
          tile(t('od.missing'), d.pending.missing_checkout, 'missing')),
        h('section', { class: 'section' }, h('div', { class: 'cluster', style: { 'justify-content': 'space-between' } }, h('h2', { class: 'section__title' }, t('od.team')), toggle),
          team.length ? table({ caption: t('od.team'), captionHidden: true, rows: team, columns: [
            { key: 'n', label: t('emp.colName'), render: (e) => h('span', { class: 'name-cell' }, h('strong', {}, displayName(e)), jobTitle(e) ? h('span', { class: 'name-cell__alt' }, jobTitle(e)) : null,
              e.active ? null : badge(t('emp.inactive'), { tone: 'neutral' })) },
            { key: 's', label: t('home.today'), render: status },
            { key: 'g', label: t('points.green'), numeric: true, render: (e) => badge(String(e.green), { tone: 'point-green', dot: true }) },
            { key: 'r', label: t('points.red'), numeric: true, render: (e) => badge(String(e.red), { tone: 'point-red', dot: true }) },
            { key: 'b', label: t('points.black'), numeric: true, render: (e) => h('span', { class: 'cluster cluster--sm' }, badge(String(e.black), { tone: 'point-black', dot: true }),
              e.pending_black ? badge(`+${e.pending_black} ${t('points.pending')}`, { tone: 'warning' }) : null) },
            { key: 'sal', label: t('od.salary'), numeric: true, render: (e) => e.monthly_salary_piastres == null
              ? h('a', { href: '#/owner/employees' }, t('od.salaryNotSet')) : h('span', { class: 'num' }, formatEGP(e.monthly_salary_piastres)) },
          ] }) : emptyState({ iconName: 'users', title: t('od.noStaff'), action: button({ label: t('emp.add'), variant: 'primary', onClick: () => navigate('/owner/employees') }) })));
    } catch (err) { fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true })); }
  }
  let showInactive = false;
  load();
}
