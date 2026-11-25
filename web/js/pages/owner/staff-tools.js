// Owner settings → «الأذونات والإجازات والتذكيرات»: monthly permission
// limit and maximum length, default annual leave days, the check-out
// overdue reminder, and whether employees see their salary / expected net
// in «كشف حسابي» (off by default).
import { h, fill } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { card, alert, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, switchControl, setFieldError } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';

export async function renderStaffTools(slot) {
  fill(slot, skeletonCard(t('common.loading')));
  let s;
  try { s = await api('staff_tools'); }
  catch (err) { fill(slot, card({ title: t('stt.title'), body: alert(errorMessage(err), { tone: 'danger' }) })); return; }
  const n = (label, key, min, max, step, hint) => input({ label, type: 'number', value: String(Number(s[key])), hint,
    attrs: { min: String(min), max: String(max), step: String(step), inputmode: step < 1 ? 'decimal' : 'numeric', dir: 'ltr', 'data-key': key } });
  const fLimit = n(t('stt.limit'), 'permission_monthly_limit', 0, 31, 1, t('stt.limitHint'));
  const fMax = n(t('stt.maxMin'), 'permission_max_minutes', 15, 600, 5);
  const fDays = n(t('stt.annual'), 'annual_leave_days', 0, 365, 0.5, t('stt.annualHint'));
  const fOverMin = n(t('stt.overdueMin'), 'checkout_overdue_min', 5, 240, 5);
  const sOver = switchControl({ label: t('stt.overdue'), checked: !!s.checkout_overdue_reminder });
  const sPay = switchControl({ label: t('stt.payVisible'), checked: !!s.staff_pay_visible });
  const status = h('p', { class: 'save-status text-sm', role: 'status' });
  const fields = [[fLimit, 0, 31, 1], [fMax, 15, 600, 1], [fDays, 0, 365, 0.5], [fOverMin, 5, 240, 1]];
  const save = button({ label: t('common.save'), variant: 'primary', size: 'sm', onClick: async () => {
    const out = {};
    for (const [f, min, max, step] of fields) {
      const el = f.querySelector('input'); const v = Number(el.value);
      setFieldError(f, null);
      if (el.value === '' || !Number.isFinite(v) || v < min || v > max || Math.round(v / step) * step !== v) { setFieldError(f, t('stt.errRange', { min, max })); return; }
      out[el.dataset.key] = v;
    }
    out.checkout_overdue_reminder = sOver.querySelector('input').checked;
    out.staff_pay_visible = sPay.querySelector('input').checked;
    setLoading(save, true);
    try { s = await api('save_staff_tools', out); status.textContent = t('set.saved'); toast({ title: t('set.saved'), tone: 'success' }); }
    catch (err) { status.textContent = errorMessage(err); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
    finally { setLoading(save, false); }
  } });
  fill(slot, card({ title: t('stt.title'), subtitle: t('stt.subtitle'), iconName: 'clock', body: h('div', { class: 'stack' },
    h('h4', { class: 'text-sm' }, t('stt.permTitle')), h('div', { class: 'form-grid' }, fLimit, fMax),
    h('h4', { class: 'text-sm' }, t('stt.leaveTitle')), h('div', { class: 'form-grid' }, fDays),
    h('h4', { class: 'text-sm' }, t('stt.remTitle')), sOver, h('div', { class: 'form-grid' }, fOverMin),
    h('h4', { class: 'text-sm' }, t('stt.payTitle')), sPay, h('p', { class: 'text-xs text-muted' }, t('stt.payHint')),
    h('div', { class: 'cluster' }, save, status)) }));
}
