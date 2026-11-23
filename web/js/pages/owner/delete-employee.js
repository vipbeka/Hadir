// «حذف الموظف نهائيًا» — two steps, server-authoritative.
// 1) the server counts EVERYTHING that will be erased (zeros shown too);
// 2) the owner types the employee's name, then confirms a final time.
// If anything changed in between, the server refuses and the new counts
// are shown for a fresh confirmation. Deactivate stays a separate option.
import { h, fill } from '../../core/dom.js';
import { t, getLang } from '../../core/i18n.js';
import { ownerEmployees } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { alert } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, setFieldError } from '../../ui/field.js';
import { modal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';

const ORDER = ['attendance_days', 'attendance_corrections', 'point_events', 'leave_requests', 'early_leave_requests', 'reward_requests', 'payroll_reports',
  'monthly_deductions', 'payslip_snapshots', 'salary_payments', 'salary_record', 'login_codes', 'device_sessions', 'push_subscriptions', 'login_attempts',
  'absence_alerts', 'notifications', 'audit_entries', 'job_report_lines', 'owner_reports', 'telegram_pending', 'files'];

export async function deleteEmployeeFlow(emp, { onDeleted, onDeactivate } = {}) {
  let preview;
  try { preview = (await ownerEmployees('delete_preview', { employee_id: emp.id })).preview; }
  catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); return; }
  const nameShown = getLang() === 'ar' ? preview.name_ar : preview.name_en;
  const countsBox = h('div', {}); let busy = false; let step = 1;
  const renderCounts = (c) => fill(countsBox, h('table', { class: 'doc-table del-counts' }, h('tbody', {},
    ORDER.map((k) => h('tr', {}, h('th', { scope: 'row' }, t(`del.c.${k}`)), h('td', { class: 'num' }, String(c[k] ?? 0)))))));
  renderCounts(preview.counts);
  const fName = input({ label: t('del.typeName', { name: nameShown }), attrs: { autocomplete: 'off', dir: 'auto', 'data-testid': 'del-name' } });
  const err = h('div', {});
  const finalBox = h('div', {});
  const next = button({ label: t('del.continue'), variant: 'danger', onClick: () => go() });
  async function go() {
    if (busy) return;
    const typed = fName.querySelector('input').value.trim();
    const ok = typed && (typed === preview.name_ar.trim() || typed.toLowerCase() === preview.name_en.trim().toLowerCase());
    if (!ok) { setFieldError(fName, t('del.nameMismatch')); return; }
    setFieldError(fName, null);
    if (step === 1) {                      // distinct final confirmation
      step = 2;
      fill(finalBox, alert(t('del.finalText', { name: nameShown }), { tone: 'danger', title: t('del.finalTitle') }));
      next.querySelector('.btn__label').textContent = t('del.final');
      fName.querySelector('input').readOnly = true;
      return;
    }
    busy = true; setLoading(next, true); fill(err);
    try {
      const r = await ownerEmployees('delete', { employee_id: emp.id, confirm_name: typed, preview_token: preview.preview_token });
      m.close();
      if (r.deletion?.status === 'complete') toast({ title: t('del.done'), tone: 'success' });
      else toast({ title: t('del.incomplete'), text: t('del.incompleteText'), tone: 'warning', duration: 0 });
      onDeleted?.(r.deletion);
    } catch (e) {
      busy = false; setLoading(next, false);
      if (e.code === 'preview_changed' && e.detail?.counts) {     // re-confirm the NEW counts
        preview = { ...preview, counts: e.detail.counts, preview_token: e.detail.preview_token };
        renderCounts(preview.counts); step = 1; fill(finalBox); fName.querySelector('input').readOnly = false;
        next.querySelector('.btn__label').textContent = t('del.continue');
        fill(err, alert(t('del.changed'), { tone: 'warning' }));
      } else fill(err, alert(errorMessage(e), { tone: 'danger' }));
    }
  }
  const m = modal({ title: t('del.title', { name: nameShown }), body: [
    alert(t('del.warn'), { tone: 'danger', title: t('del.warnTitle') }),
    h('p', { class: 'text-sm', lang: 'en', dir: 'ltr' }, t('del.warnEn')),
    h('p', { class: 'text-sm text-muted' }, t('del.backups')),
    h('h3', { class: 'card__subtitle' }, t('del.countsTitle')), countsBox,
    h('p', { class: 'text-sm text-muted' }, t('del.shared')),
    fName, finalBox, err],
  actions: [button({ label: t('common.cancel'), onClick: () => m.close() }),
    onDeactivate && emp.active ? button({ label: t('del.deactivateInstead'), onClick: () => { m.close(); onDeactivate(); } }) : null, next].filter(Boolean) });
  m.open();
}
