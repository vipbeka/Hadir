// Staff points: period + lifetime counters, reward progress and request,
// full point history (own rows via RLS).
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { sb } from '../../core/supabase.js';
import { errorMessage } from '../../core/errors.js';
import { formatEGP, formatDate, monthLabel } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, chip, progress, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { icon } from '../../ui/icons.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, setFieldError } from '../../ui/field.js';
import { modal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { pointCounters } from './home.js';

export function eventRow(e) {
  const tone = e.color === 'green' ? 'point-green' : e.color === 'red' ? 'point-red' : 'point-black';
  const sign = e.delta > 0 ? `+${e.delta}` : String(e.delta);
  const extra = [];
  if (e.warning_only) extra.push(badge(t('points.warning'), { tone: 'warning' }));
  if (e.status !== 'active') extra.push(badge(t(`status.${e.status}`), { tone: 'neutral' }));
  if (e.deduction_amount_piastres > 0) extra.push(badge(`− ${formatEGP(e.deduction_amount_piastres)}`, { tone: 'danger' }));
  const ico = e.source === 'auto_window' ? 'logIn' : e.source === 'auto_absence' ? 'calendar' : e.source === 'owner_outcome' ? 'trophy' : 'star';
  return h('li', { class: ['event-row', `event-row--${e.color}`] },
    h('span', { class: 'event-row__icon', 'aria-hidden': 'true' }, icon(ico)),
    h('div', { class: 'event-row__main' },
      h('span', { class: 'event-row__title' }, e.outcome_category ? t(`cat.${e.outcome_category}`) : t(`src.${e.source}`),
        e.reason && ['owner_manual', 'owner_outcome'].includes(e.source) ? h('span', { class: 'text-muted' }, ` — ${e.reason}`) : null),
      h('span', { class: 'event-row__date num' }, icon('calendar', { size: 'sm' }), formatDate(e.effective_work_date))),
    h('div', { class: 'cluster cluster--sm' }, badge(`${sign} ${t(`points.${e.color}`)}`, { tone, dot: true }), extra));
}

export async function renderStaffPoints(main, { me }) {
  setDocumentTitle(t('pts.title'));
  const balance = h('span', { class: 'hero-aside__value num' }, '—');
  add(main, pageHeader({ chips: [chip(t('pts.system'), { dot: true })], title: t('pts.title'),
    aside: h('div', { class: 'hero-aside' }, icon('trophy'), h('span', { class: 'hero-aside__label' }, t('pts.active')), balance) }));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);

  async function load() {
    try {
      const [sum, ev] = await Promise.all([api('my_summary'),
        sb.from('point_events').select('*').eq('employee_id', me.id).order('created_at', { ascending: false }).limit(200)]);
      if (ev.error) throw ev.error;
      render(sum, ev.data || []);
    } catch (err) {
      fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true }));
    }
  }

  function render(sum, events) {
    clear(body);
    const g = Math.max(0, sum.period_totals.green); const th = sum.threshold;
    balance.textContent = `${g} ${t('pts.pointUnit')}`;
    const rr = sum.reward_request;
    let rewardAction = null;
    if (rr && rr.status !== 'rejected') rewardAction = alert(t('rw.current', { status: t(`status.${rr.status}`) }), { tone: rr.status === 'paid' ? 'success' : 'info' });
    else if (g >= th) rewardAction = button({ label: t('reward.request'), variant: 'reward', icon: 'gift', block: true, onClick: () => openRequest(sum) });
    const guide = card({ iconName: 'bulb', title: t('pts.guideTitle'), className: 'pts-guide',
      body: h('ul', { class: 'guide-list', role: 'list' },
        h('li', { class: 'guide-list__item guide-list__item--green' }, h('strong', {}, t('pts.gGreenL')), ' ', t('pts.gGreen', { n: th, amount: formatEGP(sum.reward_amount_piastres) })),
        h('li', { class: 'guide-list__item guide-list__item--red' }, h('strong', {}, t('pts.gRedL')), ' ', t('pts.gRed')),
        h('li', { class: 'guide-list__item guide-list__item--black' }, h('strong', {}, t('pts.gBlackL')), ' ', t('pts.gBlack'))) });
    guide.id = 'points-guide';
    add(body,
      card({ iconName: 'star', title: t('reward.progress'), subtitle: t('pts.cycle', { month: monthLabel(sum.period) }), className: 'reward-card',
        actions: h('div', { class: 'reward-card__count num' }, h('strong', {}, String(g)), ` / ${th}`),
        body: [
          progress({ label: t('reward.progress'), value: Math.min(g, th), max: th, reward: true, valueText: `${g}/${th}` }),
          h('div', { class: 'reward-card__scale' }, h('span', {}, icon('flag', { size: 'sm' }), t('pts.start')), h('span', {}, icon('target', { size: 'sm' }), t('pts.goal', { n: th }))),
          h('div', { class: 'reward-card__foot' },
            h('span', { class: 'hint-line' }, icon('info'), g >= th ? t('reward.reached') : t('reward.remaining', { n: th - g })),
            chip(formatEGP(sum.reward_amount_piastres), { iconName: 'wallet', tone: 'reward' })),
          rewardAction] }),
      card({ iconName: 'calendar', title: t('pts.period'), actions: chip(monthLabel(sum.period), { tone: 'neutral' }), body: pointCounters(sum.period_totals) }),
      card({ iconName: 'history', title: t('pts.lifetime'), actions: chip(t('pts.cumulative'), { tone: 'neutral' }), body: pointCounters(sum.lifetime_totals) }),
      sum.pending_black > 0 ? alert(t('pts.pendingNote', { n: sum.pending_black }), { tone: 'info' }) : null,
      card({ iconName: 'list', title: t('pts.history'),
        actions: h('a', { class: 'link-more', href: '#/staff/points', onClick: (ev) => { ev.preventDefault(); guide.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, t('pts.guideLink'), icon('chevronRight', { size: 'sm', flip: true })),
        body: events.length ? h('ul', { class: 'event-list', role: 'list' }, events.map(eventRow)) : h('p', { class: 'text-sm text-muted' }, t('pts.empty')) }),
      guide);
  }

  function openRequest(sum) {
    const fMethod = select({ label: t('rw.method'), options: sum.payout_methods.map((m) => ({ value: m, label: t(`rw.${m}`) })) });
    const fNum = input({ label: t('rw.number'), required: true, attrs: { inputmode: 'tel', dir: 'ltr', maxlength: '64', autocomplete: 'tel' } });
    const send = button({ label: t('reward.request'), variant: 'reward', icon: 'gift', type: 'submit', attrs: { form: 'rw-form' } });
    const form = h('form', { id: 'rw-form', class: 'stack', novalidate: true, onSubmit: async (e) => {
      e.preventDefault();
      const num = fNum.querySelector('input').value.trim();
      if (!/^[0-9A-Za-z@._+ -]{4,64}$/.test(num)) { setFieldError(fNum, t('err.invalid_payout_number')); return; }
      setLoading(send, true);
      try {
        await api('request_reward', { payout_method: fMethod.querySelector('select').value, payout_number: num });
        m.close(); toast({ title: t('rw.sent'), tone: 'reward' }); load();
      } catch (err) { setFieldError(fNum, errorMessage(err)); }
      finally { setLoading(send, false); }
    } }, h('p', {}, t('rw.congratsText', { amount: formatEGP(sum.reward_amount_piastres) })), fMethod, fNum);
    const m = modal({ title: t('rw.congratsTitle'), body: form, actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), send] });
    m.open();
  }

  load();
}
