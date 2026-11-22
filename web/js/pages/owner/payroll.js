// Owner payroll: monthly payroll-ready report. Salary and deductions are
// shown SEPARATELY (no net pay). Exports (PDF via print, Excel, CSV)
// render the very same data the screen shows.
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatEGP, formatMinutes, formatDateTime, monthLabel, displayName, jobTitle } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { MARK_SRC } from '../../ui/brand.js';

const egpNum = (p) => Number(p || 0) / 100;
const plain = (p) => new Intl.NumberFormat('en-US').format(egpNum(p));
// neutralise spreadsheet formula injection in user-supplied text
export const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export async function renderPayroll(main) {
  setDocumentTitle(t('pr.title'));
  const now = new Date();
  const fMonth = input({ label: t('common.month'), type: 'month', value: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, attrs: { dir: 'ltr' } });
  const gen = button({ label: t('pr.generate'), variant: 'primary', icon: 'fileText', onClick: () => generate() });
  const pdf = button({ label: t('pr.pdf'), icon: 'download', onClick: () => window.print() });
  const xls = button({ label: t('pr.excel'), icon: 'download', onClick: () => exportExcel() });
  const csv = button({ label: t('pr.csv'), icon: 'download', onClick: () => exportCsv() });
  [pdf, xls, csv].forEach((b) => { b.disabled = true; });
  add(main, pageHeader({ title: t('pr.title'), subtitle: t('pr.subtitle') }),
    h('div', { class: 'toolbar no-print' }, fMonth, h('div', { class: 'cluster cluster--sm' }, gen, pdf, xls, csv)));
  const body = h('div', { class: 'stack' }, emptyState({ iconName: 'fileText', title: t('pr.empty') }));
  add(main, body);
  let rep;

  async function generate() {
    setLoading(gen, true);
    fill(body, skeletonCard(t('common.loading')));
    try {
      rep = await api('payroll', { month: `${fMonth.querySelector('input').value}-01` });
      render();
      [pdf, xls, csv].forEach((b) => { b.disabled = false; });
    } catch (err) { fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true })); }
    finally { setLoading(gen, false); }
  }

  function render() {
    clear(body);
    add(body, h('header', { class: 'print-header' },
      h('img', { src: MARK_SRC, alt: '', width: '48', height: '46' }),
      h('div', {}, h('strong', {}, h('bdi', { dir: 'ltr' }, t('app.name')), ' — ', t('company.name'), ' / ', h('bdi', { dir: 'ltr' }, 'Zintra')),
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
  }

  function rowsForExport() {
    const ar = getLang() === 'ar';
    return rep.rows.map((r) => {
      const b = r.points_breakdown;
      return {
        [ar ? 'الموظف' : 'Employee']: safeCell(displayName(r)), [ar ? 'المسمى' : 'Job title']: safeCell(jobTitle(r)),
        [ar ? 'الراتب الشهري (ج.م)' : 'Monthly salary (EGP)']: r.monthly_salary_piastres == null ? '' : egpNum(r.monthly_salary_piastres),
        [ar ? 'ساعات العمل' : 'Worked hours']: Math.round((r.worked_minutes / 60) * 100) / 100,
        [ar ? 'خضراء حضور' : 'Green attendance']: b.green_attendance, [ar ? 'خضراء إنجاز' : 'Green outcome']: b.green_outcome,
        [ar ? 'إنذارات' : 'Red warnings']: b.red_warnings, [ar ? 'حمراء بخصم' : 'Chargeable red']: b.red_chargeable,
        [ar ? 'خصم الأحمر (ج.م)' : 'Red deduction (EGP)']: egpNum(b.red_amount_piastres),
        [ar ? 'سوداء معتمدة' : 'Approved black']: b.black_approved, [ar ? 'خصم الأسود (ج.م)' : 'Black deduction (EGP)']: egpNum(b.black_amount_piastres),
        [ar ? 'سوداء معلّقة' : 'Black pending']: b.black_pending, [ar ? 'سوداء مرفوضة' : 'Black declined']: b.black_declined,
        [ar ? 'إجمالي الخصومات (ج.م)' : 'Total deductions (EGP)']: egpNum(r.deductions_piastres),
        [ar ? 'مكافأة مستحقة (ج.م)' : 'Earned bonus (EGP)']: egpNum(r.bonuses_earned_piastres), [ar ? 'مدفوع (ج.م)' : 'Paid (EGP)']: egpNum(r.bonuses_paid_piastres),
        [ar ? 'صافي التسوية (ج.م)' : 'Net adjustment (EGP)']: egpNum(r.net_adjustment_piastres),
        [ar ? 'غير مكتمل' : 'Incomplete']: r.incomplete ? (ar ? 'نعم' : 'yes') : '',
      };
    });
  }

  async function loadXlsx() {
    if (window.XLSX) return window.XLSX;
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('../../../vendor/xlsx-0.18.5/xlsx.full.min.js', import.meta.url).href; s.onload = res; s.onerror = rej; document.head.append(s); });
    return window.XLSX;
  }

  async function exportExcel() {
    try {
      const XLSX = await loadXlsx();
      const ar = getLang() === 'ar';
      const meta = [[`${t('app.name')} — ${t('company.name')} / Zintra`], [t('pr.meta', { month: monthLabel(rep.month), tz: rep.timezone, rv: rep.rule_version, at: formatDateTime(rep.generated_at) })], [t('pr.netNote')], []];
      const ws = XLSX.utils.aoa_to_sheet(meta);
      XLSX.utils.sheet_add_json(ws, rowsForExport(), { origin: -1 });
      ws['!cols'] = Object.keys(rowsForExport()[0] || {}).map(() => ({ wch: 18 }));
      const wb = XLSX.utils.book_new();
      if (ar) wb.Workbook = { Views: [{ RTL: true }] };
      XLSX.utils.book_append_sheet(wb, ws, ar ? 'التقرير' : 'Report');
      XLSX.writeFile(wb, `zintra-payroll-${rep.month.slice(0, 7)}.xlsx`);
    } catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
  }

  async function exportCsv() {
    try {
      const raw = await api('export_raw', { month: rep.month });
      const toCsv = (rows) => {
        if (!rows.length) return '';
        const cols = Object.keys(rows[0]);
        const esc = (v) => { v = safeCell(v ?? ''); const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
      };
      for (const [name, rows] of Object.entries(raw)) {
        const blob = new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `zintra-${name}-${rep.month.slice(0, 7)}.csv` });
        document.body.append(a); a.click(); a.remove();
      }
    } catch (err) { console.error('csv export failed', err?.message); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
  }
}
