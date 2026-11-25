// Owner employee details: #/owner/employee?id=<uuid>
// Statement (every Cairo calendar day of a month / custom range, with
// filters), its totals and leave summary, print / PDF / CSV, links to the
// month's payslip, and the danger zone (permanent deletion).
import { h, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api, ownerEmployees } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { monthLabel } from '../../core/format.js';
import { navigate } from '../../core/router.js';
import { pageHeader } from '../../shell/shell.js';
import { card, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, setFieldError } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { statementDoc, statementPdf, statementCsvRows, statementTotals, printDocs, dmy, allowanceLine } from './docs.js';
import { csvBlob } from './payroll-export.js';
import { offerPdf } from './payslip.js';
import { deleteEmployeeFlow } from './delete-employee.js';
import { renderEmployeeTools } from './employee-tools.js';

const PAGE = 31;
const cairoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
const monthRange = (ym) => { const [y, m] = ym.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`]; };

export async function renderEmployee(main) {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  const head = h('div', {}); const body = h('div', { class: 'stack' });
  add(main, head, body);
  setDocumentTitle(t('emp.statement'));
  if (!id) { fill(body, emptyState({ iconName: 'alertTriangle', title: t('nf.title'), error: true })); return; }

  const ym = cairoToday().slice(0, 7);
  const fMonth = input({ label: t('common.month'), type: 'month', value: ym, attrs: { dir: 'ltr' } });
  const fFrom = input({ label: t('common.from'), type: 'date', value: monthRange(ym)[0], attrs: { dir: 'ltr' } });
  const fTo = input({ label: t('common.to'), type: 'date', value: monthRange(ym)[1], attrs: { dir: 'ltr' } });
  const fFilter = select({ label: t('st.filter'), value: 'all', attrs: { 'data-testid': 'st-filter' }, options: ['all', 'present', 'late', 'absent', 'absent_pending', 'leave', 'no_record', 'missing', 'workdays']
    .map((v) => ({ value: v, label: t(`st.f.${v}`) })) });
  fMonth.querySelector('input').addEventListener('change', (ev) => { if (!ev.target.value) return; const [a, b] = monthRange(ev.target.value);
    fFrom.querySelector('input').value = a; fTo.querySelector('input').value = b; load(); });
  const show = button({ label: t('st.show'), variant: 'primary', onClick: () => load() });
  const status = h('p', { class: 'text-sm text-muted', role: 'status', 'aria-live': 'polite' });
  const result = h('div', { class: 'stack' });
  let st = null; let page = 0; let reqId = 0;

  const v = (f) => f.querySelector('input,select').value;
  async function load() {
    const from = v(fFrom); const to = v(fTo);
    if (!from || !to || to < from) { setFieldError(fTo, t('err.invalid_range')); return; }
    setFieldError(fTo, null);
    const my = ++reqId; st = null; page = 0; status.textContent = '';
    fill(result, skeletonCard(t('common.loading')));
    try {
      const r = await api('employee_statement', { employee_id: id, from, to }, { timeoutMs: 30000 });
      if (my !== reqId) return;                       // stale response: a newer range was asked for
      st = r; renderHead(); renderStatement();
    } catch (err) {
      if (my !== reqId) return;
      fill(result, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true, action: button({ label: t('common.retry'), onClick: load }) }));
    }
  }
  function renderHead() {
    const e = st.employee; const name = getLang() === 'ar' ? e.name_ar : e.name_en;
    setDocumentTitle(`${t('emp.statement')} · ${name}`);
    fill(head, pageHeader({ iconName: 'user', title: name, subtitle: `${e.code}${e.active ? '' : ` · ${t('emp.inactive')}`}`,
      actions: [button({ label: t('nav.employees'), icon: 'arrowRight', onClick: () => navigate('/owner/employees') })] }));
  }
  const filtered = () => {
    const f = v(fFilter);
    return st.days.filter((d) => f === 'all' || (f === 'missing' ? d.missing_checkout : f === 'workdays' ? !['weekend', 'holiday', 'future', 'not_employed'].includes(d.status) : d.status === f));
  };
  function renderStatement() {
    const days = filtered(); const pages = Math.max(1, Math.ceil(days.length / PAGE)); page = Math.min(page, pages - 1);
    const slice = days.slice(page * PAGE, page * PAGE + PAGE);
    const totals = h('dl', { class: 'kv-grid st-totals' }, statementTotals(st).map(([k, val]) => h('div', { class: 'kv-row' }, h('dt', {}, k), h('dd', { class: 'num' }, String(val)))));
    const leave = st.leave_summary.length ? h('ul', { class: 'event-list', role: 'list' }, st.leave_summary.map((l) => h('li', { class: 'event-row' },
      h('span', {}, `${t(`leave.${l.type}`)} · ${t(`status.${l.status}`)}`), h('span', { class: 'num' }, t('st.leaveDays', { taken: l.taken_days, planned: l.planned_days })))))
      : h('p', { class: 'text-sm text-muted' }, t('st.noLeave'));
    const pdfBtn = button({ label: t('doc.pdf'), icon: 'download', onClick: async () => {
      setLoading(pdfBtn, true, t('doc.preparing'));
      try { await offerPdf(await statementPdf(st), `hadir-statement-${st.employee.code}-${st.from}_${st.to}.pdf`, status); }
      catch (err) { status.textContent = `${t('doc.failed')} ${errorMessage(err)}`; }
      finally { setLoading(pdfBtn, false); }
    } });
    const csvBtn = button({ label: 'CSV', icon: 'download', onClick: () => offerPdf(csvBlob(statementCsvRows(st)), `hadir-statement-${st.employee.code}-${st.from}_${st.to}.csv`, status) });
    const printBtn = button({ label: t('doc.print'), icon: 'fileText', onClick: () => { printDocs([statementDoc(st)]); status.textContent = t('doc.printOpened'); } });
    const months = st.months.map((m) => button({ label: t('st.payslipFor', { m: monthLabel(`${m}-01`) }), size: 'sm', variant: 'ghost',
      onClick: () => navigate(`/owner/payslip?e=${id}&m=${m}`) }));
    const pager = pages > 1 ? h('div', { class: 'cluster pager no-print' },
      button({ label: t('st.prev'), size: 'sm', disabled: page === 0, onClick: () => { page--; renderStatement(); } }),
      h('span', { class: 'text-sm' }, t('st.page', { p: page + 1, n: pages, total: days.length })),
      button({ label: t('st.next'), size: 'sm', disabled: page >= pages - 1, onClick: () => { page++; renderStatement(); } })) : null;
    fill(result,
      card({ title: t('st.totalsTitle', { from: dmy(st.from), to: dmy(st.to) }), body: [totals, h('h4', { class: 'card__subtitle' }, t('st.leaveTitle')), leave,
        h('p', { class: 'text-sm text-muted' }, allowanceLine(st))] }),
      card({ body: [h('div', { class: 'cluster doc-toolbar' }, printBtn, pdfBtn, csvBtn), h('div', { class: 'cluster' }, months), status] }),
      h('div', { class: 'doc-preview doc-preview--wide' }, statementDoc(st, slice)), pager);
  }
  fFilter.addEventListener('change', () => { if (st) { page = 0; renderStatement(); } });

  fill(head, pageHeader({ iconName: 'user', title: t('emp.statement'), subtitle: '' }));
  const tools = h('div', { class: 'stack' });
  add(body, card({ title: t('st.title'), body: h('div', { class: 'form-grid' }, fMonth, fFrom, fTo, fFilter, h('div', { class: 'cluster' }, show)) }), result, tools,
    card({ title: t('del.section'), body: [h('p', { class: 'text-sm text-muted' }, t('del.sectionText')),
      button({ label: t('del.button'), variant: 'danger', icon: 'trash', onClick: async () => {
        const list = (await ownerEmployees('list')).employees || [];
        const emp = list.find((x) => x.id === id);
        if (!emp) { toast({ title: t('err.not_found'), tone: 'danger' }); return; }
        deleteEmployeeFlow(emp, { onDeleted: () => navigate('/owner/employees', { replace: true }) });
      } })] }));
  renderEmployeeTools(tools, id);
  load();
}
