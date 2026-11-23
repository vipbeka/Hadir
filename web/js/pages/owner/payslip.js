// Owner payslip page: #/owner/payslip?e=<employee>&m=YYYY-MM[&v=<version>]
// Shows the live draft or a saved (immutable) version; print, PDF, issue a
// version, record/reverse payments. Viewing, printing and downloading never
// mark anything as paid.
import { h, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatEGP, monthLabel } from '../../core/format.js';
import { navigate } from '../../core/router.js';
import { pageHeader } from '../../shell/shell.js';
import { card, alert, badge, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { select } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { payslipDoc, payslipsPdf, printDocs, dmy } from './docs.js';
import { deliver, shareOrOpen } from './payroll-export.js';
import { recordPayment, reversePayment } from './pay-actions.js';

const params = () => new URLSearchParams(location.hash.split('?')[1] || '');

/** Deliver a ready PDF with an honest status (download / share sheet / open). */
export async function offerPdf(blob, filename, statusEl) {
  const r = deliver(blob, filename);
  if (r.downloaded) { statusEl.textContent = t('doc.downloaded', { file: filename }); return; }
  fill(statusEl, h('span', {}, t('doc.readyTap')), ' ', button({ label: t('doc.openShare'), size: 'sm', variant: 'primary', icon: 'download', onClick: async () => {
    const how = await shareOrOpen(r.file);
    statusEl.textContent = how === 'blocked' ? t('doc.blocked') : how === 'cancelled' ? t('doc.cancelled') : t('doc.handed', { file: filename });
  } }));
}

export async function renderPayslip(main) {
  setDocumentTitle(t('ps.title'));
  const q = params(); const emp = q.get('e'); const month = q.get('m'); const ver = q.get('v');
  if (!emp || !/^\d{4}-\d{2}$/.test(month || '')) { add(main, emptyState({ iconName: 'alertTriangle', title: t('nf.title'), error: true })); return; }
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, pageHeader({ iconName: 'fileText', title: t('ps.title'), subtitle: monthLabel(`${month}-01`),
    actions: [button({ label: t('ps.back'), icon: 'arrowRight', onClick: () => navigate('/owner/payroll') })] }), body);
  let reqId = 0;
  async function load() {
    const my = ++reqId; fill(body, skeletonCard(t('common.loading')));
    try {
      const live = await api('payslip', { employee_id: emp, month: `${month}-01` });
      const shown = ver ? await api('payslip', { employee_id: emp, month: `${month}-01`, version: Number(ver) }) : live;
      if (my !== reqId) return;                       // a newer selection won
      render(live, shown);
    } catch (err) {
      if (my !== reqId) return;
      fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true, action: button({ label: t('common.retry'), onClick: load }) }));
    }
  }
  function render(live, shown) {
    const e = live.data.entitlement; const name = getLang() === 'ar' ? live.data.employee.name_ar : live.data.employee.name_en;
    const doc = payslipDoc(shown);
    const status = h('p', { class: 'text-sm text-muted', role: 'status', 'aria-live': 'polite' });
    const verSel = select({ label: t('ps.show'), value: ver || '', options: [{ value: '', label: t('ps.liveDraft') },
      ...live.versions.map((v) => ({ value: String(v.version), label: `${v.slip_no} · ${t(`ps.kind.${v.kind}`)}${v.changed ? ` · ${t('ps.changedShort')}` : ''}` }))] });
    verSel.querySelector('select').addEventListener('change', (ev) => navigate(`/owner/payslip?e=${emp}&m=${month}${ev.target.value ? `&v=${ev.target.value}` : ''}`));
    const pdfBtn = button({ label: t('doc.pdf'), icon: 'download', onClick: async () => {
      setLoading(pdfBtn, true, t('doc.preparing')); status.textContent = t('doc.preparing');
      try { const blob = await payslipsPdf([shown]); await offerPdf(blob, `hadir-payslip-${month}-${live.data.employee.code}${shown.mode === 'snapshot' ? `-v${shown.version}` : '-draft'}.pdf`, status); }
      catch (err) { status.textContent = `${t('doc.failed')} ${errorMessage(err)}`; toast({ title: t('doc.failed'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(pdfBtn, false); }
    } });
    const printBtn = button({ label: t('doc.print'), icon: 'fileText', onClick: () => { printDocs([doc]); status.textContent = t('doc.printOpened'); } });
    const finBtn = live.month_closed && shown.mode === 'draft' && e.salary_set ? button({ label: t('ps.finalize'), variant: 'primary', icon: 'check', onClick: async () => {
      setLoading(finBtn, true);
      try { const r = await api('payslip_finalize', { employee_id: emp, month: `${month}-01` }); toast({ title: t('ps.finalized', { no: r.slip_no }), tone: 'success' });
        navigate(`/owner/payslip?e=${emp}&m=${month}&v=${r.version}`); }
      catch (err) { setLoading(finBtn, false); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
    } }) : null;
    const payBtn = e.salary_set ? button({ label: t('pay.record'), icon: 'plus', onClick: () => recordPayment({ employee: name, month: monthLabel(`${month}-01`), entitlement: e, onDone: load }) }) : null;
    const payments = e.payments.filter((p) => p.kind === 'payment');
    fill(body,
      shown.mode === 'draft' ? alert(live.month_closed ? t('ps.draftNote') : t('ps.openMonthNote'), { tone: 'info' }) : null,
      shown.mode === 'snapshot' && live.versions.find((v) => v.version === shown.version)?.changed ? alert(t('ps.changedSince'), { tone: 'warning' }) : null,
      !e.salary_set ? alert(t('pay.salaryMissingNote'), { tone: 'warning' }) : null,
      card({ body: [h('div', { class: 'cluster doc-toolbar no-print' }, verSel, printBtn, pdfBtn, finBtn, payBtn), status] }),
      h('div', { class: 'doc-preview' }, doc),
      payments.length ? card({ title: t('pay.history'), body: h('ul', { class: 'event-list', role: 'list' }, payments.map((p) => h('li', { class: 'event-row' },
        h('div', { class: 'event-row__main' }, h('span', {}, formatEGP(p.amount_piastres), ' · ', h('bdi', { dir: 'ltr' }, dmy(p.paid_on)), p.method ? ` · ${t(`pay.method.${p.method}`)}` : ''),
          p.note ? h('span', { class: 'text-xs text-muted' }, p.note) : null),
        p.reversed ? badge(t('pay.reversed'), { tone: 'neutral' }) : button({ label: t('pay.reverse'), size: 'sm', variant: 'ghost', onClick: () => reversePayment({ payment: p, onDone: load }) })))) }) : null);
  }
  load();
}
