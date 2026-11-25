// Staff points: period + lifetime counters, reward progress and request,
// full point history (own rows via RLS).
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { sb } from '../../core/supabase.js';
import { errorMessage } from '../../core/errors.js';
import { formatEGP, formatDate } from '../../core/format.js';
import { card, badge, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { icon } from '../../ui/icons.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, setFieldError } from '../../ui/field.js';
import { modal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { goalHint } from './home.js';

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
  // gradient hero: title + reward ring panel (filled once the summary loads)
  const ringHost = h('div', { class: 'pts-hero__panel' }, h('div', { class: 'skeleton skeleton--block' }));
  add(main, h('header', { class: 'page-header pts-hero' },
    h('div', { class: 'pts-hero__top' },
      h('div', { class: 'page-header__main' }, h('h1', { class: 'page-header__title' }, t('pts.title')), h('p', { class: 'page-header__subtitle' }, t('pts.heroSub'))),
      h('span', { class: 'page-header__icon', 'aria-hidden': 'true' }, icon('star'))),
    ringHost));
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
    // ring: exactly empty at 0, full at the threshold
    const frac = th > 0 ? Math.min(g, th) / th : 0;
    const C = 2 * Math.PI * 42;
    const ring = h('div', { class: 'ring', role: 'progressbar', 'aria-label': t('reward.progress'), 'aria-valuemin': '0', 'aria-valuemax': String(th), 'aria-valuenow': String(Math.min(g, th)), 'aria-valuetext': `${g}/${th}` });
    ring.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring__track" cx="50" cy="50" r="42"/>${frac > 0 ? `<circle class="ring__fill" cx="50" cy="50" r="42" stroke-dasharray="${(C * frac).toFixed(2)} ${C.toFixed(2)}"/>` : ''}</svg>`;
    ring.append(h('span', { class: 'ring__value num' }, `${g}/${th}`));
    fill(ringHost, ring, h('div', { class: 'pts-hero__text' },
      h('p', { class: 'pts-hero__title' }, t('reward.progress')),
      h('p', { class: 'pts-hero__sub' }, g >= th ? t('reward.reached') : goalHint(th - g, sum.work_days_left)),
      h('span', { class: 'pts-hero__chip' }, icon('gift', { size: 'sm' }), formatEGP(sum.reward_amount_piastres))));
    const rr = sum.reward_request;
    let rewardAction = null;
    if (rr && rr.status !== 'rejected') rewardAction = alert(t('rw.current', { status: t(`status.${rr.status}`) }), { tone: rr.status === 'paid' ? 'success' : 'info' });
    else if (g >= th) rewardAction = button({ label: t('reward.request'), variant: 'reward', icon: 'gift', block: true, onClick: () => openRequest(sum) });
    const tallies = (tot) => h('div', { class: 'tally-row' },
      [['green', tot.green, t('points.green'), t('pts.capGreen')], ['red', tot.red, t('points.red'), t('pts.capRed')], ['black', tot.black, t('points.black'), t('pts.capBlack')]]
        .map(([cls, n, label, cap]) => h('div', { class: `tally tally--${cls}` },
          h('span', { class: 'tally__label' }, h('span', { class: 'chip__dot', 'aria-hidden': 'true' }), label),
          h('span', { class: 'tally__value num' }, String(n ?? 0)),
          h('span', { class: 'tally__cap' }, cap))));
    add(body,
      rewardAction,
      card({ iconName: 'calendar', title: t('pts.period'), body: tallies(sum.period_totals) }),
      card({ iconName: 'infinity', title: t('pts.lifetime'), body: tallies(sum.lifetime_totals) }),
      sum.pending_black > 0 ? alert(t('pts.pendingNote', { n: sum.pending_black }), { tone: 'info' }) : null,
      card({ iconName: 'history', title: t('pts.history'),
        body: events.length ? h('ul', { class: 'event-list', role: 'list' }, events.map(eventRow)) : h('p', { class: 'text-sm text-muted' }, t('pts.empty')) }));
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
