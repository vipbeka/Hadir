// Owner approvals: absences (black points), leave, early leave, rewards,
// missing check-outs. Every decision goes through the api function.
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatDate, formatDateTime, formatEGP, formatClock } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, textarea, setFieldError } from '../../ui/field.js';
import { modal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { store } from '../../core/storage.js';

const nm = (r) => (getLang() === 'ar' ? r.name_ar : r.name_en);
const TABS = ['black', 'leave', 'early', 'reward', 'missing'];
const tone = (s) => ({ pending: 'warning', approved: 'success', paid: 'success', rejected: 'danger', cancelled: 'neutral' }[s] || 'neutral');

export async function renderApprovals(main) {
  setDocumentTitle(t('ap.title'));
  const fromHash = location.hash.split('?')[1];
  let tab = TABS.includes(fromHash) ? fromHash : store.get('zh.apTab', 'black');
  add(main, pageHeader({ iconName: 'checkCircle', title: t('ap.title') }));
  const tabs = h('div', { class: 'segmented tabs', role: 'tablist', 'aria-label': t('ap.title') });
  const body = h('div', { class: 'stack', role: 'tabpanel' });
  add(main, tabs, body);
  let data;

  async function load() {
    fill(body, skeletonCard(t('common.loading')));
    try { data = await api('pending'); render(); }
    catch (err) { fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true })); }
  }

  const act = async (btn, action, params, okMsg = t('ap.decided')) => {
    setLoading(btn, true);
    try {
      const r = await api(action, params);
      toast({ title: r?.result === 'already_decided' ? t('ap.already') : okMsg, tone: 'success' });
      load();
    } catch (err) { setLoading(btn, false); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
  };

  function render() {
    const counts = { black: data.black.length, leave: data.leave.filter((x) => x.status === 'pending').length,
      early: data.early_leave.filter((x) => x.status === 'pending').length,
      reward: data.reward.filter((x) => ['pending', 'approved'].includes(x.status)).length, missing: data.missing_checkout.length };
    tabs.replaceChildren(...TABS.map((k) => h('button', { type: 'button', class: 'segmented__btn', role: 'tab', 'aria-selected': String(tab === k), 'aria-pressed': String(tab === k),
      onClick: () => { tab = k; store.set('zh.apTab', k); render(); } }, t(`ap.${k}`), counts[k] ? h('span', { class: 'badge badge--accent num' }, String(counts[k])) : null)));
    clear(body);
    const list = { black: blackList, leave: leaveList, early: earlyList, reward: rewardList, missing: missingList }[tab]();
    add(body, list.length ? h('div', { class: 'stack' }, list) : emptyState({ iconName: 'checkCircle', title: t('ap.empty') }));
  }

  const row = (title, meta, statusBadge, actions) => card({ body: h('div', { class: 'approval-row' },
    h('div', { class: 'stack stack--sm' }, h('strong', {}, title), meta.filter(Boolean).map((m) => h('span', { class: 'text-sm text-muted' }, m))),
    h('div', { class: 'cluster cluster--sm' }, statusBadge, actions)) });

  function blackList() {
    return data.black.map((e) => {
      const yes = button({ label: t('common.approve'), variant: 'danger', size: 'sm', onClick: async () => {
        const ok = await confirmDialog({ title: t('ap.black'), text: t('ap.blackConfirm', { amount: formatEGP(e.amount_piastres), name: nm(e), date: formatDate(e.date) }), confirmLabel: t('common.approve'), variant: 'danger' });
        if (ok) act(yes, 'decide_black', { event_id: e.id, approve: true, confirm_amount_piastres: e.amount_piastres });
      } });
      const no = button({ label: t('common.decline'), size: 'sm', onClick: () => act(no, 'decide_black', { event_id: e.id, approve: false }) });
      return row(nm(e), [formatDate(e.date), formatEGP(e.amount_piastres)], badge(t('status.pending_approval'), { tone: 'warning' }), [no, yes]);
    });
  }

  function commentPrompt(title, cb) {
    const f = textarea({ label: t('common.comment'), rows: 2 });
    const save = button({ label: t('common.save'), variant: 'primary', onClick: async () => { await cb(f.querySelector('textarea').value); m.close(); } });
    const m = modal({ title, size: 'sm', body: f, actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), save] });
    m.open();
  }

  function leaveList() {
    return data.leave.map((r) => {
      const actions = [];
      if (r.status === 'pending' || r.status === 'approved') {
        if (r.status === 'pending') { const yes = button({ label: t('common.approve'), variant: 'primary', size: 'sm', onClick: () => act(yes, 'decide_leave', { id: r.id, approve: true }) }); actions.push(yes); }
        const no = button({ label: t('common.reject'), size: 'sm', onClick: () => act(no, 'decide_leave', { id: r.id, approve: false }) }); actions.push(no);
      }
      actions.push(button({ label: t('common.comment'), size: 'sm', variant: 'ghost', onClick: () => commentPrompt(t('common.comment'), async (c) => {
        try { await api('comment_leave', { id: r.id, comment: c }); toast({ title: t('ap.decided'), tone: 'success' }); load(); }
        catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      }) }));
      return row(nm(r), [`${t(`req.${r.type}`)} · ${formatDate(r.from_date)} → ${formatDate(r.to_date)}`, r.reason, r.admin_comment ? t('req.ownerComment', { c: r.admin_comment }) : null],
        badge(t(`status.${r.status}`), { tone: tone(r.status), dot: true }), actions);
    });
  }

  function earlyList() {
    return data.early_leave.map((r) => {
      const actions = [];
      if (r.status === 'pending') {
        const yes = button({ label: t('common.approve'), variant: 'primary', size: 'sm', onClick: () => act(yes, 'decide_early_leave', { id: r.id, approve: true, channel: 'dashboard' }) });
        const no = button({ label: t('common.reject'), size: 'sm', onClick: () => act(no, 'decide_early_leave', { id: r.id, approve: false, channel: 'dashboard' }) });
        actions.push(no, yes);
      } else if (r.status === 'approved') {
        const rv = button({ label: t('common.reject'), size: 'sm', onClick: () => act(rv, 'decide_early_leave', { id: r.id, approve: false, revoke: true, channel: 'dashboard' }) });
        actions.push(rv);
      }
      return row(`#${r.id} · ${nm(r)}`, [`${formatDate(r.work_date)} · ${formatClock(r.requested_leave_time)}`, r.reason, r.decision_channel ? `via ${r.decision_channel}` : null],
        badge(t(`status.${r.status}`), { tone: tone(r.status), dot: true }), actions);
    });
  }

  function rewardList() {
    return data.reward.map((r) => {
      const actions = [];
      if (r.status === 'pending') { const yes = button({ label: t('common.approve'), variant: 'reward', size: 'sm', onClick: () => act(yes, 'decide_reward', { id: r.id, action: 'approve' }) }); actions.push(yes); }
      if (r.status === 'approved') actions.push(button({ label: t('ap.markPaid'), variant: 'reward', size: 'sm', onClick: () => {
        const f = input({ label: t('ap.reference'), required: true, attrs: { maxlength: '120' } });
        const save = button({ label: t('ap.markPaid'), variant: 'reward', onClick: async () => {
          const ref = f.querySelector('input').value.trim();
          if (ref.length < 2) { setFieldError(f, t('err.reference_required')); return; }
          setLoading(save, true);
          try { await api('decide_reward', { id: r.id, action: 'paid', reference: ref }); m.close(); toast({ title: t('ap.decided'), tone: 'success' }); load(); }
          catch (err) { setLoading(save, false); setFieldError(f, errorMessage(err)); }
        } });
        const m = modal({ title: t('ap.markPaid'), size: 'sm', body: [h('p', {}, t('ap.payTo', { method: t(`rw.${r.payout_method}`), number: r.payout_number })), f], actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), save] });
        m.open();
      } }));
      if (['pending', 'approved'].includes(r.status)) { const no = button({ label: t('common.reject'), size: 'sm', onClick: () => act(no, 'decide_reward', { id: r.id, action: 'reject' }) }); actions.push(no); }
      return row(nm(r), [`${r.period_month?.slice(0, 7)} · ${formatEGP(r.reward_amount_piastres)}`, t('ap.payTo', { method: t(`rw.${r.payout_method}`), number: r.payout_number }),
        r.paid_reference ? `${t('ap.reference')}: ${r.paid_reference}` : null, r.needs_owner_review ? t('ap.reviewFlag') : null],
        badge(t(`status.${r.status}`), { tone: tone(r.status), dot: true }), actions);
    });
  }

  function missingList() {
    return data.missing_checkout.map((a) => {
      const fix = button({ label: t('ap.correct'), variant: 'primary', size: 'sm', onClick: () => {
        const fTime = input({ label: t('ap.checkoutTime'), type: 'datetime-local', required: true, attrs: { dir: 'ltr' } });
        const fReason = textarea({ label: t('common.reason'), required: true, rows: 2 });
        const save = button({ label: t('common.save'), variant: 'primary', onClick: async () => {
          const v = fTime.querySelector('input').value; const reason = fReason.querySelector('textarea').value.trim();
          if (!v) { setFieldError(fTime, t('err.invalid_time')); return; }
          if (reason.length < 3) { setFieldError(fReason, t('err.reason_required')); return; }
          setLoading(save, true);
          // datetime-local is interpreted in Cairo time
          const iso = `${v}:00+${cairoOffset(v)}`;
          try { await api('correct_attendance', { attendance_id: a.id, checked_out_at: iso, reason }); m.close(); toast({ title: t('ap.corrected'), tone: 'success' }); load(); }
          catch (err) { setLoading(save, false); setFieldError(fTime, errorMessage(err)); }
        } });
        const m = modal({ title: `${t('ap.correct')} — ${nm(a)}`, size: 'sm', body: [h('p', { class: 'text-sm text-muted' }, `${formatDate(a.work_date)} · ${t('home.checkedInAt', { time: formatDateTime(a.checked_in_at) })}`), fTime, fReason],
          actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), save] });
        m.open();
      } });
      return row(nm(a), [formatDate(a.work_date), t('home.checkedInAt', { time: formatDateTime(a.checked_in_at) })], badge(t('od.missing'), { tone: 'warning' }), [fix]);
    });
  }

  load();
}

// UTC offset of Africa/Cairo at a given local date-time ("HH:MM"), DST-aware.
function cairoOffset(local) {
  const probe = new Date(`${local}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', timeZoneName: 'shortOffset' }).formatToParts(probe);
  const off = (parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+2').replace('GMT', '');
  const [hh, mm = '00'] = off.replace('+', '').split(':');
  return `${String(Math.abs(Number(hh))).padStart(2, '0')}:${mm.padStart(2, '0')}`;
}
