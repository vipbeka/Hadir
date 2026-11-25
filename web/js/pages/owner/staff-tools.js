// Owner settings → «الأذونات والإجازات والتذكيرات والرواتب»: permission limits,
// yearly leave, the check-out reminder, what employees see in «كشف حسابي»,
// overtime, salary advances, the monthly employee report and the weekly
// backup (+ download a backup now). The selfie switch lives on the dashboard.
import { h, fill } from '../../core/dom.js';
import { t, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { card, alert, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, switchControl, setFieldError } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';

const dayName = (dow) => new Intl.DateTimeFormat(getLang() === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 22 + dow)));

/** Save a JSON object as a file on the device. */
export function downloadJson(obj, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function renderStaffTools(slot) {
  fill(slot, skeletonCard(t('common.loading')));
  let s;
  try { s = await api('staff_tools'); }
  catch (err) { fill(slot, card({ title: t('stt.title'), body: alert(errorMessage(err), { tone: 'danger' }) })); return; }
  const n = (label, key, min, max, step, hint, value = s[key]) => input({ label, type: 'number', value: String(Number(value)), hint,
    attrs: { min: String(min), max: String(max), step: String(step), inputmode: step < 1 ? 'decimal' : 'numeric', dir: 'ltr', 'data-key': key } });
  const sw = (label, key) => switchControl({ label, checked: !!s[key] });
  const fLimit = n(t('stt.limit'), 'permission_monthly_limit', 0, 31, 1, t('stt.limitHint'));
  const fMax = n(t('stt.maxMin'), 'permission_max_minutes', 15, 600, 5);
  const fDays = n(t('stt.annual'), 'annual_leave_days', 0, 365, 0.5, t('stt.annualHint'));
  const fOverMin = n(t('stt.overdueMin'), 'checkout_overdue_min', 5, 240, 5);
  const fOtMin = n(t('ot.minMinutes'), 'overtime_min_minutes', 5, 240, 5, t('ot.minHint'));
  const fOtRate = n(t('ot.rate'), 'overtime_rate_egp', 0, 100000, 0.5, t('ot.rateHint'), (s.overtime_rate_piastres || 0) / 100);
  const fAdvMax = n(t('adv.maxInstallments'), 'advance_max_installments', 1, 24, 1);
  const sOver = sw(t('stt.overdue'), 'checkout_overdue_reminder');
  const sPay = sw(t('stt.payVisible'), 'staff_pay_visible');
  const sOt = sw(t('ot.enabled'), 'overtime_enabled');
  const sAdv = sw(t('adv.enabled'), 'advances_enabled');
  const sRep = sw(t('mrep.enabled'), 'monthly_reports_enabled');
  const sBak = sw(t('bak.enabled'), 'backup_enabled');
  const fBakDow = select({ label: t('bak.day'), value: String(s.backup_dow), options: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: String(d), label: dayName(d) })) });
  const fBakTime = input({ label: t('bak.time'), type: 'time', value: s.backup_time, attrs: { dir: 'ltr' } });
  const status = h('p', { class: 'save-status text-sm', role: 'status' });
  const fields = [[fLimit, 0, 31, 1], [fMax, 15, 600, 1], [fDays, 0, 365, 0.5], [fOverMin, 5, 240, 1], [fOtMin, 5, 240, 1], [fOtRate, 0, 100000, 0.5], [fAdvMax, 1, 24, 1]];
  const on = (x) => x.querySelector('input').checked;
  const save = button({ label: t('common.save'), variant: 'primary', size: 'sm', onClick: async () => {
    const out = {};
    for (const [f, min, max, step] of fields) {
      const el = f.querySelector('input'); const v = Number(el.value);
      setFieldError(f, null);
      if (el.value === '' || !Number.isFinite(v) || v < min || v > max || Math.round(v / step) * step !== v) { setFieldError(f, t('stt.errRange', { min, max })); return; }
      out[el.dataset.key] = v;
    }
    const bt = fBakTime.querySelector('input').value;
    if (!bt) { setFieldError(fBakTime, t('err.invalid_time')); return; }
    Object.assign(out, { checkout_overdue_reminder: on(sOver), staff_pay_visible: on(sPay), overtime_enabled: on(sOt), advances_enabled: on(sAdv),
      monthly_reports_enabled: on(sRep), backup_enabled: on(sBak), backup_dow: Number(fBakDow.querySelector('select').value), backup_time: bt });
    setLoading(save, true);
    try { s = await api('save_staff_tools', out); status.textContent = t('set.saved'); toast({ title: t('set.saved'), tone: 'success' }); }
    catch (err) { status.textContent = errorMessage(err); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
    finally { setLoading(save, false); }
  } });
  const dl = button({ label: t('bak.download'), size: 'sm', icon: 'download', onClick: async () => {
    setLoading(dl, true, t('doc.preparing'));
    try {
      const data = await api('backup_export', {}, { timeoutMs: 60000 });
      downloadJson(data, `hadir-backup-${new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date())}.json`);
      toast({ title: t('bak.downloaded'), tone: 'success' });
    } catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
    finally { setLoading(dl, false); }
  } });
  const sec = (title) => h('h4', { class: 'text-sm' }, title);
  fill(slot, card({ title: t('stt.title'), subtitle: t('stt.subtitle'), iconName: 'clock', body: h('div', { class: 'stack' },
    sec(t('stt.permTitle')), h('div', { class: 'form-grid' }, fLimit, fMax),
    sec(t('stt.leaveTitle')), h('div', { class: 'form-grid' }, fDays),
    sec(t('stt.remTitle')), sOver, h('div', { class: 'form-grid' }, fOverMin),
    sec(t('ot.title')), sOt, h('div', { class: 'form-grid' }, fOtMin, fOtRate),
    sec(t('adv.title')), sAdv, h('div', { class: 'form-grid' }, fAdvMax),
    sec(t('stt.payTitle')), sPay, h('p', { class: 'text-xs text-muted' }, t('stt.payHint')),
    sec(t('mrep.title')), sRep, h('p', { class: 'text-xs text-muted' }, t('mrep.hint')),
    sec(t('bak.title')), sBak, h('div', { class: 'form-grid' }, fBakDow, fBakTime),
    s.owner_chat_verified ? h('p', { class: 'text-xs text-muted' }, t('bak.hint')) : alert(t('bak.unverified'), { tone: 'warning' }),
    h('div', { class: 'cluster' }, save, dl, status)) }));
}
