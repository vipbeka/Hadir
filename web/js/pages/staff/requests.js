// Staff requests: leave (personal/sick) and early-leave history.
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { sb } from '../../core/supabase.js';
import { errorMessage } from '../../core/errors.js';
import { formatDate, formatClock } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, textarea, setFieldError } from '../../ui/field.js';
import { modal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';

const tone = (s) => ({ pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' }[s] || 'neutral');

export async function renderStaffRequests(main, { me }) {
  setDocumentTitle(t('req.title'));
  add(main, pageHeader({ iconName: 'inbox', title: t('req.title'), actions: [button({ label: t('req.newLeave'), variant: 'primary', icon: 'plus', onClick: openLeave })] }));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);

  async function load() {
    try {
      const [lv, el] = await Promise.all([
        sb.from('leave_requests').select('*').eq('employee_id', me.id).order('created_at', { ascending: false }).limit(100),
        sb.from('early_leave_requests').select('*').eq('employee_id', me.id).order('created_at', { ascending: false }).limit(60)]);
      if (lv.error || el.error) throw lv.error || el.error;
      fill(body, 
        card({ title: t('req.leave'), body: lv.data.length ? h('ul', { class: 'event-list', role: 'list' }, lv.data.map(leaveRow)) : h('p', { class: 'text-sm text-muted' }, t('req.empty')) }),
        card({ title: t('req.early'), body: el.data.length ? h('ul', { class: 'event-list', role: 'list' }, el.data.map((r) => h('li', { class: 'event-row' },
          badge(t(`status.${r.status}`), { tone: tone(r.status), dot: true }),
          h('div', { class: 'event-row__main' }, h('span', { class: 'num' }, `${formatDate(r.work_date)} · ${formatClock(r.requested_leave_time)}`),
            r.reason ? h('span', { class: 'text-xs text-muted' }, r.reason) : null,
            r.admin_comment ? h('span', { class: 'text-xs text-muted' }, t('req.ownerComment', { c: r.admin_comment })) : null)))) : h('p', { class: 'text-sm text-muted' }, t('req.empty')) }));
    } catch (err) { fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true })); }
  }

  function leaveRow(r) {
    const cancel = ['pending', 'approved'].includes(r.status) ? button({ label: t('common.cancel'), size: 'sm', onClick: async () => {
      if (!(await confirmDialog({ title: t('el.cancel'), text: `${formatDate(r.from_date)} → ${formatDate(r.to_date)}`, variant: 'danger' }))) return;
      try { await api('cancel_leave', { id: r.id }); toast({ title: t('req.cancelled'), tone: 'success' }); load(); }
      catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
    } }) : null;
    return h('li', { class: 'event-row' },
      badge(t(`status.${r.status}`), { tone: tone(r.status), dot: true }),
      h('div', { class: 'event-row__main' },
        h('span', {}, `${t(`req.${r.type}`)} · `, h('span', { class: 'num' }, `${formatDate(r.from_date)} → ${formatDate(r.to_date)}`)),
        r.reason ? h('span', { class: 'text-xs text-muted' }, r.reason) : null,
        r.admin_comment ? h('span', { class: 'text-xs text-muted' }, t('req.ownerComment', { c: r.admin_comment })) : null),
      cancel);
  }

  function openLeave() {
    const fType = select({ label: t('req.type'), options: [{ value: 'personal', label: t('req.personal') }, { value: 'sick', label: t('req.sick') }] });
    const fFrom = input({ label: t('common.from'), type: 'date', required: true, attrs: { dir: 'ltr' } });
    const fTo = input({ label: t('common.to'), type: 'date', required: true, attrs: { dir: 'ltr' } });
    const fReason = textarea({ label: t('common.reason'), hint: t('common.optional'), rows: 2 });
    fFrom.querySelector('input').addEventListener('change', (e) => { const to = fTo.querySelector('input'); if (!to.value) to.value = e.target.value; });
    const send = button({ label: t('common.submit'), variant: 'primary', type: 'submit', attrs: { form: 'leave-form' } });
    let sending = false;
    const form = h('form', { id: 'leave-form', class: 'stack', novalidate: true, onSubmit: async (e) => {
      e.preventDefault();
      if (sending) return;                                   // no double submission
      const from = fFrom.querySelector('input').value, to = fTo.querySelector('input').value;
      if (!from || !to || to < from) { setFieldError(fTo, t('err.invalid_dates')); return; }
      setFieldError(fTo, null); sending = true; setLoading(send, true);
      let saved = false;
      try {
        await api('request_leave', { type: fType.querySelector('select').value, from_date: from, to_date: to, reason: fReason.querySelector('textarea').value });
        saved = true;
      } catch (err) {
        // stays open with the entered data and a clear message
        setFieldError(fTo, errorMessage(err));
      } finally { sending = false; setLoading(send, false); }
      if (saved) {
        // The request is saved; the owner's Telegram alert is sent separately
        // in the background and can never keep this dialog open.
        m.close('saved');
        toast({ title: t('req.sent'), tone: 'success' });
        load();
      }
    } }, fType, h('div', { class: 'form-grid' }, fFrom, fTo), fReason);
    const m = modal({ title: t('req.newLeave'), body: form, actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), send] });
    m.open();
  }

  load();
}
