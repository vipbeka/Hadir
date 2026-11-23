// Owner payroll: monthly payroll-ready report. Salary and deductions are
// shown SEPARATELY (no net pay). Exports (PDF via print, Excel, CSV)
// render the very same data the screen shows.
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
  let rep = null; let repMonth = null; let busy = false;
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
      const r = await api('payroll', { month: `${m}-01` }, { timeoutMs: 30000 });
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
    add(body, h('header', { class: 'print-header' },
      h('img', { src: MARK_SRC, alt: '', width: '48', height: '46' }),
      h('div', {}, h('strong', {}, t('app.name')),
        h('p', { class: 'text-sm text-muted' }, `${t('pr.title')} · ${monthLabel(rep.month)}`))));
    add(body, h('p', { class: 'text-sm text-muted' }, t('pr.meta', { month: monthLabel(rep.month), tz: rep.timezone, rv: rep.rule_version, at: formatDateTime(rep.generated_at) })),
      alert(t('pr.netNote'), { tone: 'info' }));
    if (!rep.rows.length) { add(body, emptyState({ iconName: 'users', title: t('od.noStaff') })); return; }
    for (const r of rep.rows) {
      const b = r.points_breakdown;
      const line = (label, value, strong) => h('div', { class: 'kv-row' }, h('dt', {}, label), h('dd', { class: strong ? 'num strong' : 'num' }, value));
      add(body, card({ title: displayName(r), subtitle: jobTitle(r) || null,
        actions: r.incomplete ? badge(t('pr.incomplete'), { tone: 'warning' }) : null,
        body: [h('dl', { class: 'kv-grid' },
          line(t('od.salary'), r.monthly_salary_piastres == null ? t('common.notSet') : formatEGP(r.monthly_salary_piastres), true),
          line(t('pr.hours'), formatMinutes(r.worked_minutes)),
          line(t('pr.greenAtt'), b.green_attendance), line(t('pr.greenOut'), b.green_outcome),
          line(t('pr.warnings'), b.red_warnings), line(t('pr.redCharge'), `${b.red_chargeable} · ${formatEGP(b.red_amount_piastres)}`),
          line(t('pr.blackApproved'), `${b.black_approved} · ${formatEGP(b.black_amount_piastres)}`),
          line(t('pr.blackPending'), `${b.black_pending} / ${b.black_declined}`),
          line(t('pr.deductions'), formatEGP(r.deductions_piastres), true),
          line(t('pr.bonus'), formatEGP(r.bonuses_earned_piastres)), line(t('pr.paid'), formatEGP(r.bonuses_paid_piastres)),
          line(t('pr.net'), formatEGP(r.net_adjustment_piastres), true)),
          h('p', { class: 'text-sm text-muted' }, h('bdi', { dir: 'ltr', class: 'num' }, t('pr.math', { r: b.red_chargeable, rr: plain(rep.red_penalty_piastres), b: b.black_approved, br: plain(rep.black_penalty_piastres), total: plain(r.deductions_piastres) })), ' ', t('common.egp')),
          r.unresolved_flags.length ? alert(`${t('od.missing')}: ${r.unresolved_flags.map((f) => f.date).join(', ')}`, { tone: 'warning' }) : null] }));
    }
    const tt = totals(rep);
    add(body, card({ title: t('common.total'), body: h('dl', { class: 'kv-grid' },
      h('div', { class: 'kv-row' }, h('dt', {}, t('pr.deductions')), h('dd', { class: 'num strong' }, formatEGP(tt.deductions))),
      h('div', { class: 'kv-row' }, h('dt', {}, t('pr.bonus')), h('dd', { class: 'num' }, formatEGP(tt.earned))),
      h('div', { class: 'kv-row' }, h('dt', {}, t('pr.paid')), h('dd', { class: 'num' }, formatEGP(tt.paid))),
      h('div', { class: 'kv-row' }, h('dt', {}, t('pr.net')), h('dd', { class: 'num strong' }, formatEGP(tt.net)))) }));
  }
}
