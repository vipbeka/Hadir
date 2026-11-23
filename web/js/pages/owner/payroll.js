// Owner payroll: one server calculation per employee — base salary,
// approved earnings, approved deductions, net entitlement, what was paid and
// what remains. Exports (PDF, Excel, CSV), payslips and the Telegram summary
// all use the same figures. Inactive staff stay in the month they worked.
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatEGP, formatMinutes, formatDateTime, monthLabel, displayName, jobTitle } from '../../core/format.js';
import { pdfBlob, xlsxBlob, csvBlob, summaryRows, rawRows, deliver, totals } from './payroll-export.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, setFieldError } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { MARK_SRC } from '../../ui/brand.js';
import { navigate } from '../../core/router.js';
import { payslipDoc, payslipsPdf, printDocs } from './docs.js';
import { offerPdf } from './payslip.js';
import { recordPayment } from './pay-actions.js';

const egpNum = (p) => Number(p || 0) / 100;
const plain = (p) => new Intl.NumberFormat('en-US').format(egpNum(p));
export { safeCell } from './payroll-export.js';

export async function renderPayroll(main) {
  setDocumentTitle(t('pr.title'));
  const now = new Date();
  const fMonth = input({ label: t('common.month'), type: 'month', value: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, attrs: { dir: 'ltr' } });
  const gen = button({ label: t('pr.generate'), variant: 'primary', icon: 'fileText', onClick: () => generate() });
  const pdf = button({ label: t('pr.pdf'), icon: 'download', onClick: () => runExport('PDF', pdf, async (p) => ({ blob: await pdfBlob(rep, p), ext: 'pdf' })) });
  const xls = button({ label: t('pr.excel'), icon: 'download', onClick: () => runExport('Excel', xls, async (p) => {
    const raw = await api('export_raw', { month: rep.month }, { timeoutMs: 30000 });
    return { blob: await xlsxBlob(rep, raw, p), ext: 'xlsx' };
  }) });
  const fCsv = select({ label: t('pr.csvWhich'), options: [
    { value: 'summary', label: t('pr.csvSummary') }, { value: 'attendance', label: t('pr.csvAttendance') },
    { value: 'point_events', label: t('pr.csvPoints') }, { value: 'deductions', label: t('pr.csvDeductions') }] });
  const csv = button({ label: t('pr.csv'), icon: 'download', onClick: () => runExport('CSV', csv, async () => {
    const which = fCsv.querySelector('select').value;
    if (which === 'summary') return { blob: csvBlob(summaryRows(rep)), ext: 'csv', name: 'summary' };
    const raw = await api('export_raw', { month: rep.month }, { timeoutMs: 30000 });
    return { blob: csvBlob(rawRows(raw[which])), ext: 'csv', name: which };
  }) });
  const exportBtns = [pdf, xls, csv];
  // Exports exist only for a report generated successfully for the month on
  // screen: disabled (with a reason) until then, and again when the month
  // changes or a generation fails. Handlers re-check (never trust the button).
  const exportHint = h('p', { class: 'text-sm text-muted export-hint', id: 'export-hint' }, t('pr.exportNeedsReport'));
  const setExports = (on) => exportBtns.forEach((b) => { b.disabled = !on; if (on) b.removeAttribute('aria-describedby'); else b.setAttribute('aria-describedby', 'export-hint'); });
  const syncHint = () => { exportHint.hidden = !!rep; };
  setExports(false);
  const status = h('p', { class: 'text-sm text-muted', role: 'status', 'aria-live': 'polite' });
  add(main, pageHeader({ iconName: 'fileText', title: t('pr.title'), subtitle: t('pr.subtitle') }),
    h('div', { class: 'toolbar no-print' }, fMonth, h('div', { class: 'cluster cluster--sm' }, gen, pdf, xls), h('div', { class: 'cluster cluster--sm' }, fCsv, csv)),
    exportHint, status);
  const body = h('div', { class: 'stack' }, emptyState({ iconName: 'fileText', title: t('pr.empty') }));
  add(main, body);
  let rep = null; let repMonth = null; let busy = false; const selected = new Set();
  const fShow = select({ label: t('pay.showStaff'), value: 'all', attrs: { 'data-testid': 'pay-show' }, options: [{ value: 'all', label: t('pay.showAll') }, { value: 'active', label: t('pay.showActive') }, { value: 'inactive', label: t('pay.showInactive') }] });
  fShow.querySelector('select').addEventListener('change', () => { if (rep) render(); });
  const monthVal = () => fMonth.querySelector('input').value;
  // a different month (or filter) invalidates the report and its exports
  const invalidate = () => { if (!rep && !repMonth) return; rep = null; repMonth = null; setExports(false); syncHint();
    fill(body, emptyState({ iconName: 'fileText', title: t('pr.empty') })); status.textContent = ''; };
  fMonth.querySelector('input').addEventListener('change', () => { if (monthVal() !== repMonth) invalidate(); });

  async function generate() {
    if (busy) return;
    if (!/^\d{4}-\d{2}$/.test(monthVal())) { setFieldError(fMonth, t('pr.pickMonth')); return; }
    setFieldError(fMonth, null);
    busy = true; setLoading(gen, true); rep = null; repMonth = null; setExports(false); syncHint();
    fill(body, skeletonCard(t('common.loading')));
    const m = monthVal();
    try {
      const r = await api('payroll_v2', { month: `${m}-01` }, { timeoutMs: 30000 });
      if (monthVal() !== m) { fill(body, emptyState({ iconName: 'fileText', title: t('pr.empty') })); return; } // month changed while loading: discard
      rep = r; repMonth = m;
      render();
      setExports(true); syncHint();
    } catch (err) { rep = null; repMonth = null; setExports(false); syncHint(); fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true, action: button({ label: t('common.retry'), onClick: () => generate() }) })); }
    finally { busy = false; setLoading(gen, false); }
  }

  /** One export at a time: immediate signal, progress, result or retry. */
  async function runExport(format, btn, build) {
    if (busy || !rep || repMonth !== monthVal()) { if (!rep) status.textContent = t('pr.exportNeedsReport'); return; }
    busy = true; exportBtns.forEach((b) => { b.disabled = true; });
    setLoading(btn, true, t('pr.exporting', { format }));
    status.textContent = t('pr.exporting', { format });
    const t0 = performance.now();
    try {
      const out = await build((pct) => { status.textContent = `${t('pr.exporting', { format })} ${pct}%`; });
      const file = `hadir-payroll-${rep.month.slice(0, 7)}${out.name ? `-${out.name}` : ''}.${out.ext}`;
      const { file: f, canShare } = deliver(out.blob, file);
      const ms = Math.round(performance.now() - t0);
      main.dataset.lastExport = JSON.stringify({ format, ms, bytes: out.blob.size, file });
      status.textContent = t('pr.exported', { format, file });
      const share = canShare ? button({ label: t('pr.share'), size: 'sm', variant: 'secondary', icon: 'share', onClick: () => navigator.share({ files: [f], title: file }).catch(() => {}) }) : null;
      toast({ title: t('pr.exported', { format, file }), tone: 'success' });
      if (share) { fill(status, h('span', {}, t('pr.exported', { format, file })), ' ', share); }
    } catch (err) {
      console.error('export failed', format, err?.message);
      status.textContent = t('pr.exportFailed', { format });
      toast({ title: t('pr.exportFailed', { format }), text: errorMessage(err), tone: 'danger' });
    } finally {
      busy = false; setLoading(btn, false); setExports(!!rep);
    }
  }

  function render() {
    fill(body);
    const ttl = rep.totals_v2; const mParam = rep.month.slice(0, 7);
    add(body, h('header', { class: 'print-header' },
      h('img', { src: MARK_SRC, alt: '', width: '48', height: '46' }),
      h('div', {}, h('strong', {}, t('app.name')),
        h('p', { class: 'text-sm text-muted' }, `${t('pr.title')} · ${monthLabel(rep.month)}`))));
    add(body, h('p', { class: 'text-sm text-muted' }, t('pr.meta', { month: monthLabel(rep.month), tz: rep.timezone, rv: rep.rule_version, at: formatDateTime(rep.generated_at) })),
      alert(t('pay.formulaNote'), { tone: 'info' }));
    if (!rep.rows.length) { add(body, emptyState({ iconName: 'users', title: t('od.noStaff') })); return; }
    const show = fShow.querySelector('select').value;
    const rows = rep.rows.filter((r) => show === 'all' || (show === 'active' ? r.active : !r.active));
    // batch payslips (owner-selected), each on its own page
    const batchStatus = h('p', { class: 'text-sm text-muted', role: 'status', 'aria-live': 'polite' });
    const batchBtn = button({ label: t('ps.batch', { n: selected.size }), icon: 'fileText', disabled: !selected.size, onClick: async () => {
      setLoading(batchBtn, true, t('doc.preparing'));
      try {
        const slips = await Promise.all([...selected].map((id) => api('payslip', { employee_id: id, month: rep.month })));
        if (repMonth !== mParam) return;                      // month changed meanwhile: discard
        await offerPdf(await payslipsPdf(slips), `hadir-payslips-${mParam}.pdf`, batchStatus);
      } catch (err) { batchStatus.textContent = `${t('doc.failed')} ${errorMessage(err)}`; }
      finally { setLoading(batchBtn, false); }
    } });
    const batchPrint = button({ label: t('ps.batchPrint'), icon: 'fileText', disabled: !selected.size, onClick: async () => {
      setLoading(batchPrint, true);
      try { const slips = await Promise.all([...selected].map((id) => api('payslip', { employee_id: id, month: rep.month })));
        printDocs(slips.map((sl) => payslipDoc(sl))); batchStatus.textContent = t('doc.printOpened'); }
      catch (err) { batchStatus.textContent = `${t('doc.failed')} ${errorMessage(err)}`; }
      finally { setLoading(batchPrint, false); }
    } });
    const syncBatch = () => { batchBtn.disabled = batchPrint.disabled = !selected.size;
      const l = batchBtn.querySelector('.btn__label'); if (l) l.textContent = t('ps.batch', { n: selected.size }); };
    add(body, card({ body: [h('div', { class: 'form-grid' }, fShow), h('div', { class: 'cluster' }, batchBtn, batchPrint), batchStatus] }));
    for (const r of rows) {
      const e = r.entitlement; const b = r.points_breakdown;
      const line = (label, value, strong) => h('div', { class: 'kv-row' }, h('dt', {}, label), h('dd', { class: strong ? 'num strong' : 'num' }, value));
      const pick = h('input', { type: 'checkbox', class: 'pick', checked: selected.has(r.employee_id), 'aria-label': t('ps.pick', { name: displayName(r) }),
        onChange: (ev) => { if (ev.target.checked) selected.add(r.employee_id); else selected.delete(r.employee_id); syncBatch(); } });
      const tone = { paid: 'success', partial: 'warning', unpaid: 'info', overpaid: 'danger', review: 'danger', nothing_due: 'neutral' }[e.status] || 'neutral';
      add(body, card({ title: h('span', { class: 'cluster cluster--sm' }, h('label', { class: 'pick-wrap' }, pick), displayName(r)), subtitle: `${r.employee_code}${jobTitle(r) ? ` · ${jobTitle(r)}` : ''}`,
        actions: h('div', { class: 'cluster cluster--sm' }, r.active ? null : badge(t('emp.inactive'), { tone: 'neutral' }), badge(t(`pay.st.${e.status}`), { tone, dot: true }),
          r.snapshot ? badge(`${r.snapshot.slip_no}${r.snapshot.changed ? ` · ${t('ps.changedShort')}` : ''}`, { tone: r.snapshot.changed ? 'warning' : 'neutral' }) : null),
        body: [h('dl', { class: 'kv-grid' },
          line(t('pay.base'), e.base_piastres == null ? t('pay.salaryMissing') : formatEGP(e.base_piastres), true),
          line(t('pay.earnings'), formatEGP(e.earnings_piastres)),
          line(t('pay.deductions'), formatEGP(e.deductions_piastres)),
          line(t('pay.net'), e.net_piastres == null ? '—' : formatEGP(e.net_piastres), true),
          line(t('pay.salaryPaid'), formatEGP(e.salary_paid_piastres)), line(t('pay.rewardPaid'), formatEGP(e.reward_paid_piastres)),
          line(t('pay.remaining'), e.remaining_piastres == null ? '—' : formatEGP(e.remaining_piastres), true),
          line(t('pr.hours'), formatMinutes(r.worked_minutes)), line(t('pr.warnings'), b.red_warnings),
          line(t('pr.blackPending'), `${b.black_pending} / ${b.black_declined}`),
          e.pending_rewards_piastres ? line(t('pay.pendingRewards'), formatEGP(e.pending_rewards_piastres)) : null,
          line(t('pay.netAdjSecondary'), formatEGP(e.net_adjustment_piastres))),
          e.flags.filter((f) => f !== 'inactive').length ? alert(e.flags.filter((f) => f !== 'inactive').map((f) => t(`pay.flag.${f}`)).join(' · '), { tone: 'warning' }) : null,
          r.unresolved_flags.length ? alert(`${t('od.missing')}: ${r.unresolved_flags.map((f) => f.date).join(', ')}`, { tone: 'warning' }) : null,
          h('div', { class: 'cluster no-print' },
            button({ label: t('ps.open'), size: 'sm', variant: 'primary', icon: 'fileText', onClick: () => navigate(`/owner/payslip?e=${r.employee_id}&m=${mParam}`) }),
            button({ label: t('emp.statement'), size: 'sm', onClick: () => navigate(`/owner/employee?id=${r.employee_id}`) }),
            e.salary_set ? button({ label: t('pay.record'), size: 'sm', icon: 'plus', onClick: () => recordPayment({ employee: displayName(r), month: monthLabel(rep.month), entitlement: e, onDone: () => generate() }) }) : null)] }));
    }
    const tt = (label, v, strong) => h('div', { class: 'kv-row' }, h('dt', {}, label), h('dd', { class: strong ? 'num strong' : 'num' }, formatEGP(v)));
    add(body, card({ title: t('common.total'), body: [h('dl', { class: 'kv-grid' },
      tt(t('pay.base'), ttl.base_piastres), tt(t('pay.earnings'), ttl.earnings_piastres), tt(t('pay.deductions'), ttl.deductions_piastres),
      tt(t('pay.net'), ttl.net_piastres, true), tt(t('pay.salaryPaid'), ttl.salary_paid_piastres), tt(t('pay.rewardPaid'), ttl.reward_paid_piastres),
      tt(t('pay.remaining'), ttl.remaining_piastres, true)),
      ttl.salary_missing ? alert(t('pay.missingTotals', { n: ttl.salary_missing }), { tone: 'warning' }) : null] }));
  }
}
