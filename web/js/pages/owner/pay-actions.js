// Owner money actions. «تسجيل دفعة» RECORDS a payment made outside the app
// (cash, bank, InstaPay…). Nothing is transferred. One idempotency key per
// dialog: a double tap or a network retry can never record it twice.
import { h, fill } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatEGP } from '../../core/format.js';
import { alert } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, setFieldError } from '../../ui/field.js';
import { modal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';

const key = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const todayCairo = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
/** "1,234.50" / "1234.5" → piastres (integer) or NaN — never floating EGP math. */
export function toPiastres(v) {
  const s = String(v ?? '').replace(/[,\s٬]/g, '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0')) : NaN;
}

export function recordPayment({ employee, month, entitlement, onDone }) {
  const idem = key(); let step = 'form';
  const remaining = entitlement.remaining_piastres;
  const fAmt = input({ label: t('pay.amount'), value: remaining > 0 ? String(remaining / 100) : '', attrs: { inputmode: 'decimal', dir: 'ltr' } });
  const fDate = input({ label: t('pay.paidOn'), type: 'date', value: todayCairo(), attrs: { dir: 'ltr', max: todayCairo() } });
  const fMethod = select({ label: t('pay.methodLabel'), options: [{ value: '', label: '—' }, ...['cash', 'bank', 'instapay', 'vodafone_cash', 'other'].map((m) => ({ value: m, label: t(`pay.method.${m}`) }))] });
  const fRef = input({ label: t('pay.reference'), attrs: { maxlength: '100', dir: 'auto' } });
  const fNote = input({ label: t('pay.note'), attrs: { maxlength: '300', dir: 'auto' } });
  const box = h('div', {});
  const v = (f) => f.querySelector('input,select').value.trim();
  const form = [alert(t('pay.recordOnly'), { tone: 'info' }),
    h('p', { class: 'text-sm' }, t('pay.forLine', { name: employee, month }), ' · ', t('pay.remainingNow', { v: formatEGP(remaining) })),
    fAmt, fDate, fMethod, fRef, fNote, box];
  const go = button({ label: t('pay.review'), variant: 'primary', onClick: async () => {
    const amount = toPiastres(v(fAmt));
    if (!(amount > 0)) { setFieldError(fAmt, t('err.invalid_amount')); return; }
    if (!v(fDate)) { setFieldError(fDate, t('set.timeRequired')); return; }
    setFieldError(fAmt, null);
    if (step === 'form') {
      step = 'confirm';
      fill(box, alert(t('pay.confirmLine', { amount: formatEGP(amount), name: employee, month, date: v(fDate) }), { tone: amount > remaining ? 'warning' : 'info',
        title: amount > remaining ? t('pay.overWarn') : null }));
      go.querySelector('.btn__label').textContent = t('pay.confirm');
      return;
    }
    setLoading(go, true);
    try {
      const r = await api('salary_payment_record', { employee_id: entitlement.employee_id, month: entitlement.month, amount_piastres: amount,
        paid_on: v(fDate), method: v(fMethod) || undefined, reference: v(fRef) || undefined, note: v(fNote) || undefined,
        idempotency_key: idem, allow_overpay: amount > remaining });
      m.close();
      toast({ title: r.duplicate ? t('pay.already') : t('pay.recorded', { amount: formatEGP(amount) }), tone: 'success' });
      onDone?.(r);
    } catch (err) { setLoading(go, false); fill(box, alert(errorMessage(err), { tone: 'danger' })); }
  } });
  const m = modal({ title: t('pay.recordTitle'), body: form, actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), go] });
  m.open();
}

export function reversePayment({ payment, onDone }) {
  const idem = key();
  const fReason = input({ label: t('pay.reverseReason'), required: true, attrs: { maxlength: '300', dir: 'auto' } });
  const box = h('div', {});
  const go = button({ label: t('pay.reverse'), variant: 'danger', onClick: async () => {
    const reason = fReason.querySelector('input').value.trim();
    if (reason.length < 3) { setFieldError(fReason, t('err.reason_required')); return; }
    setLoading(go, true);
    try {
      await api('salary_payment_reverse', { payment_id: payment.id, reason, idempotency_key: idem });
      m.close(); toast({ title: t('pay.reversedOk'), tone: 'success' }); onDone?.();
    } catch (err) { setLoading(go, false); fill(box, alert(errorMessage(err), { tone: 'danger' })); }
  } });
  const m = modal({ title: t('pay.reverseTitle'), size: 'sm', body: [h('p', {}, t('pay.reverseText', { amount: formatEGP(payment.amount_piastres) })), fReason, box],
    actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), go] });
  m.open();
}
