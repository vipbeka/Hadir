// Staff points: period + lifetime counters, reward progress and request,
// full point history (own rows via RLS).
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { sb } from '../../core/supabase.js';
import { errorMessage } from '../../core/errors.js';
import { formatEGP, formatDate } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, setFieldError } from '../../ui/field.js';
import { modal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { pointsBadges, rewardProgress } from './home.js';

export function eventRow(e) {
  const tone = e.color === 'green' ? 'point-green' : e.color === 'red' ? 'point-red' : 'point-black';
  const sign = e.delta > 0 ? `+${e.delta}` : String(e.delta);
  const extra = [];
  if (e.warning_only) extra.push(badge(t('points.warning'), { tone: 'warning' }));
  if (e.status !== 'active') extra.push(badge(t(`status.${e.status}`), { tone: 'neutral' }));
  if (e.deduction_amount_piastres > 0) extra.push(badge(`− ${formatEGP(e.deduction_amount_piastres)}`, { tone: 'danger' }));
  return h('li', { class: 'event-row' },
    badge(`${sign} ${t(`points.${e.color}`)}`, { tone, dot: true }),
    h('div', { class: 'event-row__main' },
      h('span', {}, e.outcome_category ? t(`cat.${e.outcome_category}`) : t(`src.${e.source}`),
        e.reason && ['owner_manual', 'owner_outcome'].includes(e.source) ? h('span', { class: 'text-muted' }, ` — ${e.reason}`) : null),
      h('span', { class: 'text-xs text-muted num' }, formatDate(e.effective_work_date))),
    h('div', { class: 'cluster cluster--sm' }, extra));
}

export async function renderStaffPoints(main, { me }) {
  setDocumentTitle(t('pts.title'));
  add(main, pageHeader({ title: t('pts.title') }));
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
    const g = sum.period_totals.green;
    const rr = sum.reward_request;
    let rewardAction = null;
    if (rr && rr.status !== 'rejected') rewardAction = alert(t('rw.current', { status: t(`status.${rr.status}`) }), { tone: rr.status === 'paid' ? 'success' : 'info' });
    else if (g >= sum.threshold) rewardAction = button({ label: t('reward.request'), variant: 'reward', icon: 'gift', block: true, onClick: () => openRequest(sum) });
    add(body, 
      card({ facet: true, body: [rewardProgress(sum), h('p', { class: 'text-sm text-muted' }, formatEGP(sum.reward_amount_piastres)), rewardAction] }),
      h('div', { class: 'grid-auto' },
        card({ title: t('pts.period'), body: pointsBadges(sum.period_totals) }),
        card({ title: t('pts.lifetime'), body: pointsBadges(sum.lifetime_totals) })),
      sum.pending_black > 0 ? alert(t('pts.pendingNote', { n: sum.pending_black }), { tone: 'info' }) : null,
      card({ title: t('pts.history'), body: events.length ? h('ul', { class: 'event-list', role: 'list' }, events.map(eventRow)) : h('p', { class: 'text-sm text-muted' }, t('pts.empty')) }));
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
