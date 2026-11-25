// Staff requests: leave (personal/sick, with the annual balance), permission
// (إذن: leave for a few hours and come back), attendance correction
// (forgot to check in / out, app or network problem) and early-leave history.
// Every write goes through the API; the owner is notified by the server.
import { h, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { sb } from '../../core/supabase.js';
import { errorMessage } from '../../core/errors.js';
import { formatDate, formatClock } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, textarea, setFieldError } from '../../ui/field.js';
import { modal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';

const tone = (s) => ({ pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' }[s] || 'neutral');
export const cairoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const num = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : String(Number(n).toFixed(1)));
const val = (f) => f.querySelector('input,select,textarea').value;

export async function renderStaffRequests(main, { me }) {
  setDocumentTitle(t('req.title'));
  add(main, pageHeader({ iconName: 'inbox', title: t('req.title'), subtitle: t('req.subtitle') }));
  const actions = h('div', { class: 'req-actions' },
    button({ label: t('req.newLeave'), variant: 'primary', icon: 'calendar', onClick: openLeave }),
    button({ label: t('perm.new'), variant: 'secondary', icon: 'clock', onClick: openPermission }),
    button({ label: t('corr.new'), variant: 'secondary', icon: 'history', onClick: openCorrection }));
  const balanceSlot = h('div', {});
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, actions, balanceSlot, body);
  let balance = null;

  async function loadBalance() {
    try {
      balance = await api('my_leave_balance');
      const b = balance;
      fill(balanceSlot, card({ title: t('bal.title', { year: b.year }), iconName: 'calendar', body: [
        h('div', { class: 'balance-row' },
          h('div', { class: 'balance-row__main' }, h('span', { class: 'balance-row__value num' }, num(b.available)), h('span', { class: 'text-sm text-muted' }, t('bal.available'))),
          h('dl', { class: 'kv-grid balance-row__kv' },
            h('div', { class: 'kv-row' }, h('dt', {}, t('bal.entitled')), h('dd', { class: 'num' }, num(b.entitled))),
            h('div', { class: 'kv-row' }, h('dt', {}, t('bal.used')), h('dd', { class: 'num' }, num(b.used))),
            h('div', { class: 'kv-row' }, h('dt', {}, t('bal.pending')), h('dd', { class: 'num' }, num(b.pending))),
            h('div', { class: 'kv-row' }, h('dt', {}, t('bal.sick')), h('dd', { class: 'num' }, num(b.sick_used))))),
        h('p', { class: 'text-xs text-muted' }, t('bal.note'))] }));
    } catch { fill(balanceSlot); }
  }

  async function load() {
    try {
      const [lv, el, pm, cr] = await Promise.all([
        sb.from('leave_requests').select('*').eq('employee_id', me.id).order('created_at', { ascending: false }).limit(100),
        sb.from('early_leave_requests').select('*').eq('employee_id', me.id).order('created_at', { ascending: false }).limit(60),
        sb.from('permission_requests').select('*').eq('employee_id', me.id).order('created_at', { ascending: false }).limit(60),
        sb.from('correction_requests').select('*').eq('employee_id', me.id).order('created_at', { ascending: false }).limit(60)]);
      const bad = [lv, el, pm, cr].find((x) => x.error);
      if (bad) throw bad.error;
      const list = (rows, fn) => (rows.length ? h('ul', { class: 'event-list', role: 'list' }, rows.map(fn)) : h('p', { class: 'text-sm text-muted' }, t('req.empty')));
      fill(body,
        card({ title: t('perm.title'), body: list(pm.data, permRow) }),
        card({ title: t('corr.title'), body: list(cr.data, corrRow) }),
        card({ title: t('req.leave'), body: list(lv.data, leaveRow) }),
        card({ title: t('req.early'), body: list(el.data, (r) => h('li', { class: 'event-row' },
          badge(t(`status.${r.status}`), { tone: tone(r.status), dot: true }),
          h('div', { class: 'event-row__main' }, h('span', { class: 'num' }, `${formatDate(r.work_date)} · ${formatClock(r.requested_leave_time)}`),
            r.reason ? h('span', { class: 'text-xs text-muted' }, r.reason) : null,
            r.admin_comment ? h('span', { class: 'text-xs text-muted' }, t('req.ownerComment', { c: r.admin_comment })) : null))) }));
    } catch (err) { fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true })); }
  }
  const reload = () => { load(); loadBalance(); };

  const cancelBtn = (action, id, text) => button({ label: t('common.cancel'), size: 'sm', onClick: async () => {
    if (!(await confirmDialog({ title: t('req.cancelTitle'), text, variant: 'danger' }))) return;
    try { await api(action, { id }); toast({ title: t('req.cancelled'), tone: 'success' }); reload(); }
    catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
  } });

  function permRow(r) {
    const range = `${formatDate(r.work_date)} · ${formatClock(r.from_time)} → ${formatClock(r.to_time)}`;
    const canCancel = (r.status === 'pending' || (r.status === 'approved' && r.work_date >= cairoToday())) && !r.deduction_event_id;
    return h('li', { class: 'event-row' },
      badge(t(`status.${r.status}`), { tone: tone(r.status), dot: true }),
      h('div', { class: 'event-row__main' }, h('span', { class: 'num' }, range),
        h('span', { class: 'text-xs text-muted' }, t('perm.minutes', { n: r.minutes })),
        r.over_limit ? h('span', {}, badge(r.deduction_event_id ? t('perm.deducted') : t('perm.overLimit'), { tone: 'warning', size: 'sm' })) : null,
        r.reason ? h('span', { class: 'text-xs text-muted' }, r.reason) : null,
        r.admin_comment ? h('span', { class: 'text-xs text-muted' }, t('req.ownerComment', { c: r.admin_comment })) : null),
      canCancel ? cancelBtn('cancel_permission', r.id, range) : null);
  }

  function corrRow(r) {
    const what = r.kind === 'check_in' ? t('corr.inAt', { time: formatClock(r.check_in_time) })
      : r.kind === 'check_out' ? t('corr.outAt', { time: formatClock(r.check_out_time) })
      : `${t('corr.inAt', { time: formatClock(r.check_in_time) })} · ${t('corr.outAt', { time: formatClock(r.check_out_time) })}`;
    return h('li', { class: 'event-row' },
      badge(t(`status.${r.status}`), { tone: tone(r.status), dot: true }),
      h('div', { class: 'event-row__main' }, h('span', { class: 'num' }, `${formatDate(r.work_date)} · ${what}`),
        h('span', { class: 'text-xs text-muted' }, r.reason),
        r.admin_comment ? h('span', { class: 'text-xs text-muted' }, t('req.ownerComment', { c: r.admin_comment })) : null),
      r.status === 'pending' ? cancelBtn('cancel_correction', r.id, `${formatDate(r.work_date)} · ${what}`) : null);
  }

  function leaveRow(r) {
    const cancel = ['pending', 'approved'].includes(r.status) ? cancelBtn('cancel_leave', r.id, `${formatDate(r.from_date)} → ${formatDate(r.to_date)}`) : null;
    return h('li', { class: 'event-row' },
      badge(t(`status.${r.status}`), { tone: tone(r.status), dot: true }),
      h('div', { class: 'event-row__main' },
        h('span', {}, `${t(`req.${r.type}`)} · `, h('span', { class: 'num' }, `${formatDate(r.from_date)} → ${formatDate(r.to_date)}`)),
        r.reason ? h('span', { class: 'text-xs text-muted' }, r.reason) : null,
        r.admin_comment ? h('span', { class: 'text-xs text-muted' }, t('req.ownerComment', { c: r.admin_comment })) : null),
      cancel);
  }

  /** One request dialog: validates, sends once, stays open with a clear message on error. */
  function requestDialog({ id, title, fields, intro, validate, send, errorField }) {
    const submit = button({ label: t('common.submit'), variant: 'primary', type: 'submit', attrs: { form: id } });
    let sending = false;
    const form = h('form', { id, class: 'stack', novalidate: true, onSubmit: async (e) => {
      e.preventDefault();
      if (sending) return;                                   // no double submission
      fields.forEach((f) => setFieldError(f, null));
      const params = validate();
      if (!params) return;
      sending = true; setLoading(submit, true);
      let saved = false;
      try { await api(send, params); saved = true; }
      catch (err) { setFieldError(errorField(), errorMessage(err)); }
      finally { sending = false; setLoading(submit, false); }
      if (saved) { m.close('saved'); toast({ title: t('req.sent'), tone: 'success' }); reload(); }
    } }, intro || null, ...fields);
    const m = modal({ title, body: form, actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), submit] });
    m.open();
    return m;
  }

  function openLeave() {
    const fType = select({ label: t('req.type'), options: [{ value: 'personal', label: t('req.personal') }, { value: 'sick', label: t('req.sick') }] });
    const fFrom = input({ label: t('common.from'), type: 'date', required: true, attrs: { dir: 'ltr' } });
    const fTo = input({ label: t('common.to'), type: 'date', required: true, attrs: { dir: 'ltr' } });
    const fReason = textarea({ label: t('common.reason'), hint: t('common.optional'), rows: 2 });
    fFrom.querySelector('input').addEventListener('change', (e) => { const to = fTo.querySelector('input'); if (!to.value) to.value = e.target.value; });
    const intro = balance ? alert(t('bal.hint', { n: num(balance.available) }), { tone: 'info' }) : null;
    const dates = h('div', { class: 'form-grid' }, fFrom, fTo);
    requestDialog({ id: 'leave-form', title: t('req.newLeave'), intro, fields: [fType, dates, fReason], errorField: () => fTo,
      validate: () => {
        const from = val(fFrom), to = val(fTo);
        if (!from || !to || to < from) { setFieldError(fTo, t('err.invalid_dates')); return null; }
        return { type: val(fType), from_date: from, to_date: to, reason: val(fReason) };
      }, send: 'request_leave' });
  }

  function openPermission() {
    const today = cairoToday();
    const fDate = input({ label: t('common.date'), type: 'date', value: today, required: true, attrs: { dir: 'ltr', min: today, max: addDays(today, 30) } });
    const fFrom = input({ label: t('perm.from'), type: 'time', required: true, attrs: { dir: 'ltr' } });
    const fTo = input({ label: t('perm.to'), type: 'time', required: true, attrs: { dir: 'ltr' } });
    const fReason = textarea({ label: t('common.reason'), hint: t('common.optional'), rows: 2 });
    requestDialog({ id: 'perm-form', title: t('perm.new'), intro: h('p', { class: 'text-sm text-muted' }, t('perm.intro')),
      fields: [fDate, h('div', { class: 'form-grid' }, fFrom, fTo), fReason], errorField: () => fTo,
      validate: () => {
        const d = val(fDate), a = val(fFrom), b = val(fTo);
        if (!d) { setFieldError(fDate, t('err.invalid_dates')); return null; }
        if (!a || !b || b <= a) { setFieldError(fTo, t('perm.errOrder')); return null; }
        return { date: d, from_time: a, to_time: b, reason: val(fReason) };
      }, send: 'request_permission' });
  }

  function openCorrection() {
    const today = cairoToday();
    const fDate = input({ label: t('common.date'), type: 'date', value: today, required: true, attrs: { dir: 'ltr', min: addDays(today, -31), max: today } });
    const fKind = select({ label: t('corr.kind'), value: 'check_out', options: ['check_out', 'check_in', 'both'].map((k) => ({ value: k, label: t(`corr.k.${k}`) })) });
    const fIn = input({ label: t('corr.inTime'), type: 'time', attrs: { dir: 'ltr' } });
    const fOut = input({ label: t('corr.outTime'), type: 'time', attrs: { dir: 'ltr' } });
    const fReason = textarea({ label: t('common.reason'), required: true, rows: 2, hint: t('corr.reasonHint') });
    const sync = () => { const k = val(fKind); fIn.hidden = k === 'check_out'; fOut.hidden = k === 'check_in'; };
    fKind.querySelector('select').addEventListener('change', sync); sync();
    requestDialog({ id: 'corr-form', title: t('corr.new'), intro: h('p', { class: 'text-sm text-muted' }, t('corr.intro')),
      fields: [fDate, fKind, h('div', { class: 'form-grid' }, fIn, fOut), fReason], errorField: () => fReason,
      validate: () => {
        const d = val(fDate), k = val(fKind), a = val(fIn), b = val(fOut), reason = val(fReason).trim();
        if (!d || d > today) { setFieldError(fDate, t('err.invalid_dates')); return null; }
        if (k !== 'check_out' && !a) { setFieldError(fIn, t('err.invalid_time')); return null; }
        if (k !== 'check_in' && !b) { setFieldError(fOut, t('err.invalid_time')); return null; }
        if (k === 'both' && b <= a) { setFieldError(fOut, t('perm.errOrder')); return null; }
        if (reason.length < 3) { setFieldError(fReason, t('err.reason_required')); return null; }
        return { date: d, kind: k, check_in_time: k === 'check_out' ? null : a, check_out_time: k === 'check_in' ? null : b, reason };
      }, send: 'request_correction' });
  }

  reload();
}
