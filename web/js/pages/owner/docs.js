// Owner documents: payslip (قسيمة راتب / إيصال استلام راتب) and the
// employee statement. ONE data object (from the server) feeds three outputs:
//   * on-screen preview (HTML)          * browser print (A4 print CSS)
//   * direct PDF (jsPDF + embedded IBM Plex Sans Arabic, RTL-aware runs)
// Nothing here computes money: every amount comes from the server's single
// entitlement calculation. Printing/downloading never marks anything paid.
import { h } from '../../core/dom.js';
import { t, getLang } from '../../core/i18n.js';
import { formatEGP, formatMinutes, formatClock } from '../../core/format.js';
import { MARK_SRC } from '../../ui/brand.js';
import { VENDOR, FONTS, loadScript, fetchBase64, fetchDataUrl, rtlPieces, assertPdf } from './payroll-export.js';

const ar = () => getLang() === 'ar';
export const dmy = (iso) => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const name = (o) => (ar() ? o.name_ar || o.name_en : o.name_en || o.name_ar);
const job = (o) => (ar() ? o.job_title_ar || o.job_title_en : o.job_title_en || o.job_title_ar) || '';
const money = (p) => (p == null ? '—' : formatEGP(p));
const weekday = (iso) => new Intl.DateTimeFormat(ar() ? 'ar-EG' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
const methodLabel = (m) => (m ? t(`pay.method.${m}`) : '');

/** Identity line for a payslip (draft reference or saved slip number). */
export function slipIdentity(slip) {
  return slip.mode === 'snapshot'
    ? { no: slip.slip_no, label: t('ps.versionLabel', { v: slip.version, kind: t(`ps.kind.${slip.kind}`) }), draft: false, issued: slip.data.issued_at || slip.created_at }
    : { no: slip.draft_ref, label: t('ps.draftLabel'), draft: true, issued: slip.data.generated_at };
}

/** Itemised lines (same order everywhere). */
export function payslipLines(data) {
  const e = data.entitlement;
  const earn = [[t('pay.base'), e.base_piastres == null ? null : e.base_piastres, e.base_piastres == null ? t('pay.salaryMissing') : '']];
  for (const r of e.earnings) earn.push([t('ps.reward'), r.amount_piastres, t(`ps.rewardSt.${r.status}`)]);
  const ded = e.deductions.map((d) => [t(d.kind === 'red' ? 'ps.dedRed' : 'ps.dedBlack'), d.amount_piastres,
    t('ps.times', { n: d.count, rate: formatEGP(d.rate_piastres) })]);
  return { earn, ded };
}

// ================================================================ HTML
export function payslipDoc(slip) {
  const d = slip.data; const e = d.entitlement; const id = slipIdentity(slip); const L = payslipLines(d);
  const tableRows = (rows) => rows.map(([label, amt, note]) => h('tr', {},
    h('th', { scope: 'row' }, label, note ? h('span', { class: 'doc-note' }, ' ', h('bdi', {}, note)) : null),
    h('td', { class: 'num' }, amt == null ? '—' : formatEGP(amt))));
  const pays = e.payments.filter((p) => p.kind === 'payment');
  return h('article', { class: ['print-doc', 'payslip', id.draft && 'is-draft'], lang: getLang(), dir: ar() ? 'rtl' : 'ltr' },
    id.draft ? h('div', { class: 'doc-watermark', 'aria-hidden': 'true' }, t('ps.draftMark')) : null,
    h('header', { class: 'doc-head' },
      h('img', { src: MARK_SRC, alt: '', width: '44', height: '42' }),
      h('div', { class: 'doc-head__text' }, h('p', { class: 'doc-company' }, ar() ? d.company.name_ar : d.company.name_en),
        h('h2', { class: 'doc-title' }, t('ps.title'))),
      h('dl', { class: 'doc-id' },
        h('div', {}, h('dt', {}, t('ps.no')), h('dd', {}, h('bdi', { dir: 'ltr' }, id.no))),
        h('div', {}, h('dt', {}, t('ps.issued')), h('dd', {}, h('bdi', { dir: 'ltr' }, dmy(String(id.issued).slice(0, 10))))),
        h('div', {}, h('dt', {}, t('ps.status')), h('dd', {}, id.label)))),
    h('dl', { class: 'doc-meta' },
      h('div', {}, h('dt', {}, t('ps.employee')), h('dd', {}, h('bdi', {}, name(d.employee)))),
      h('div', {}, h('dt', {}, t('ps.empId')), h('dd', {}, h('bdi', { dir: 'ltr' }, d.employee.code))),
      h('div', {}, h('dt', {}, t('ps.job')), h('dd', {}, job(d.employee) || '—')),
      h('div', {}, h('dt', {}, t('ps.period')), h('dd', {}, h('bdi', { dir: 'ltr' }, `${dmy(d.period.from)} – ${dmy(d.period.to)}`)))),
    h('section', { class: 'doc-section' }, h('h3', {}, t('ps.earnings')),
      h('table', { class: 'doc-table' }, h('tbody', {}, tableRows(L.earn)),
        h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, t('ps.totalEarnings')),
          h('td', { class: 'num' }, e.base_piastres == null ? '—' : formatEGP(e.base_piastres + e.earnings_piastres)))))),
    h('section', { class: 'doc-section' }, h('h3', {}, t('ps.deductions')),
      L.ded.length ? h('table', { class: 'doc-table' }, h('tbody', {}, tableRows(L.ded)),
        h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, t('ps.totalDeductions')), h('td', { class: 'num' }, formatEGP(e.deductions_piastres)))))
        : h('p', { class: 'doc-muted' }, t('ps.noDeductions')),
      (e.warnings_count || e.black_pending || e.pending_rewards_piastres)
        ? h('p', { class: 'doc-muted' }, t('ps.notCounted', { w: e.warnings_count, p: e.black_pending, r: formatEGP(e.pending_rewards_piastres) })) : null),
    h('section', { class: 'doc-section doc-totals' },
      h('div', { class: 'doc-total' }, h('span', {}, t('pay.net')), h('strong', { class: 'num' }, money(e.net_piastres))),
      h('div', { class: 'doc-total doc-total--sub' }, h('span', {}, t('pay.salaryPaid')), h('span', { class: 'num' }, formatEGP(e.salary_paid_piastres))),
      pays.map((p) => h('p', { class: 'doc-muted doc-pay' }, h('bdi', { dir: 'ltr' }, dmy(p.paid_on)), ' · ', formatEGP(p.amount_piastres),
        p.method ? ` · ${methodLabel(p.method)}` : '', p.reference ? ' · ' : '', p.reference ? h('bdi', {}, p.reference) : '',
        p.reversed ? ` · ${t('pay.reversed')}` : '')),
      h('div', { class: 'doc-total doc-total--sub' }, h('span', {}, t('pay.rewardPaid')), h('span', { class: 'num' }, formatEGP(e.reward_paid_piastres))),
      h('div', { class: 'doc-total doc-total--final' }, h('span', {}, t('pay.remaining')), h('strong', { class: 'num' }, money(e.remaining_piastres))),
      h('p', { class: 'doc-status' }, t('ps.payStatus'), ': ', t(`pay.st.${e.status}`), e.flags.length ? ` · ${e.flags.map((f) => t(`pay.flag.${f}`)).join('، ')}` : '')),
    h('section', { class: 'doc-section' }, h('h3', {}, t('ps.attendance')),
      h('p', {}, t('ps.attLine', { p: d.attendance.present_days, l: d.attendance.late_days, a: d.attendance.absence_days, v: d.attendance.leave_days,
        h: formatMinutes(d.attendance.worked_minutes) })),
      h('p', { class: 'doc-muted' }, t('ps.statementRef', { code: d.employee.code, from: dmy(d.period.from), to: dmy(d.period.to) }))),
    h('section', { class: 'doc-section doc-sign' },
      h('p', {}, t('ps.signEmployee'), ' ', h('span', { class: 'doc-line' })), h('p', {}, t('ps.signDate'), ' ', h('span', { class: 'doc-line doc-line--short' }))),
    h('footer', { class: 'doc-foot' }, t(id.draft ? 'ps.footDraft' : 'ps.foot'), ' ', t('ps.rules', { v: d.rules.rule_version })));
}

const STATUS_TONE = { present: 'ok', late: 'warn', absent: 'bad', absent_pending: 'warn', absence_excused: 'muted', leave: 'info', planned_leave: 'info',
  holiday: 'muted', weekend: 'muted', future: 'muted', open: 'muted', no_record: 'warn', not_employed: 'muted' };
/** One statement day → visible text cells (shared by HTML, PDF and CSV). */
export function statementCells(day) {
  const notes = [];
  if (day.holiday) notes.push(day.holiday);
  if (day.missing_checkout) notes.push(t('st.missingOut'));
  if (day.check_out_date && day.check_out_date !== day.date) notes.push(t('st.nextDayOut', { d: dmy(day.check_out_date) }));
  if (day.corrected) notes.push(t('st.corrected', { by: day.corrected_by || '—' }));
  for (const l of day.leave || []) notes.push(t('st.leaveNote', { type: t(`leave.${l.type}`), status: t(`status.${l.status}`) }));
  for (const r of day.early_leave || []) notes.push(t('st.earlyNote', { time: formatClock(r.time), status: t(`status.${r.status}`) }));
  for (const ev of day.events || []) {
    if (ev.reversed) continue;
    notes.push(t('st.eventNote', { color: t(`points.${ev.color}`), status: ev.warning ? t('st.warning') : t(`st.ev.${ev.status}`) }));
  }
  return {
    date: dmy(day.date), weekday: weekday(day.date), status: t(`st.s.${day.status}`), tone: STATUS_TONE[day.status] || 'muted',
    in: day.check_in ? formatClock(day.check_in) : '', out: day.check_out ? formatClock(day.check_out) : (day.missing_checkout ? t('st.none') : ''),
    worked: day.worked_minutes != null ? formatMinutes(day.worked_minutes) : '', notes: notes.join(' · '),
    deduction: day.deduction_piastres ? formatEGP(day.deduction_piastres) : '',
  };
}

export function statementTotals(st) {
  const x = st.totals;
  return [[t('st.t.work'), x.working_days_elapsed], [t('st.t.present'), x.present], [t('st.t.late'), x.late], [t('st.t.absent'), x.absent],
    [t('st.t.absentPending'), x.absent_pending], [t('st.t.excused'), x.absence_excused], [t('st.t.noRecord'), x.no_record],
    [t('st.t.leave'), x.leave_days], [t('st.t.missing'), x.missing_checkouts], [t('st.t.worked'), formatMinutes(x.worked_minutes)],
    [t('st.t.deductions'), formatEGP(x.deductions_piastres)]];
}

export function statementDoc(st, days = st.days) {
  return h('article', { class: ['print-doc', 'statement'], lang: getLang(), dir: ar() ? 'rtl' : 'ltr' },
    h('header', { class: 'doc-head' }, h('img', { src: MARK_SRC, alt: '', width: '44', height: '42' }),
      h('div', { class: 'doc-head__text' }, h('p', { class: 'doc-company' }, t('app.name')), h('h2', { class: 'doc-title' }, t('st.title'))),
      h('dl', { class: 'doc-id' }, h('div', {}, h('dt', {}, t('ps.employee')), h('dd', {}, h('bdi', {}, name(st.employee)))),
        h('div', {}, h('dt', {}, t('ps.empId')), h('dd', {}, h('bdi', { dir: 'ltr' }, st.employee.code))),
        h('div', {}, h('dt', {}, t('ps.period')), h('dd', {}, h('bdi', { dir: 'ltr' }, `${dmy(st.from)} – ${dmy(st.to)}`))))),
    h('dl', { class: 'doc-meta doc-meta--totals' }, statementTotals(st).map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { class: 'num' }, String(v))))),
    h('table', { class: 'doc-table doc-table--grid' },
      h('thead', {}, h('tr', {}, [t('st.c.date'), t('st.c.day'), t('st.c.status'), t('st.c.in'), t('st.c.out'), t('st.c.worked'), t('st.c.notes'), t('st.c.deduction')]
        .map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, days.map((d) => { const c = statementCells(d); return h('tr', { class: `st-row st-row--${c.tone}` },
        h('td', {}, h('bdi', { dir: 'ltr' }, c.date)), h('td', {}, c.weekday), h('td', {}, c.status), h('td', { class: 'num' }, c.in),
        h('td', { class: 'num' }, c.out), h('td', { class: 'num' }, c.worked), h('td', { class: 'st-notes' }, c.notes), h('td', { class: 'num' }, c.deduction)); }))),
    h('footer', { class: 'doc-foot' }, t('st.foot')));
}

/** Print the given documents only (menus, bars, banners and dialogs hidden). */
export function printDocs(docs) {
  document.getElementById('print-root')?.remove();
  const root = h('div', { id: 'print-root' }, docs.map((d) => d.cloneNode(true)));
  document.body.append(root); document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); root.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(() => { if (!window.matchMedia('print').matches) done(); }, 1000);   // engines without afterprint
}

// ================================================================ PDF kit
export async function pdfKit(title) {
  const ns = await loadScript(`${VENDOR}jspdf-3.0.4/jspdf.umd.min.js`, 'jspdf');
  const [reg, bold, logo] = await Promise.all([fetchBase64(`${FONTS}IBMPlexSansArabic-Regular.ttf`), fetchBase64(`${FONTS}IBMPlexSansArabic-Bold.ttf`),
    fetchDataUrl(MARK_SRC).catch(() => null)]);
  const RTL = ar();
  const doc = new ns.jsPDF({ unit: 'pt', format: 'a4', compress: true });
  doc.addFileToVFS('Plex-Regular.ttf', reg); doc.addFont('Plex-Regular.ttf', 'Plex', 'normal');
  doc.addFileToVFS('Plex-Bold.ttf', bold); doc.addFont('Plex-Bold.ttf', 'Plex', 'bold');
  doc.setLanguage(RTL ? 'ar' : 'en-US'); doc.setProperties({ title, creator: 'حاضر' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40, BOTTOM = H - 50;
  const ink = [11, 21, 48], muted = [74, 88, 120], line = [200, 208, 222];
  const k = { doc, W, H, M, y: M, RTL, ink, muted };
  k.text = (s, x, yy, opts = {}) => {
    if (!RTL) return doc.text(String(s ?? ''), x, yy, opts);
    const pieces = rtlPieces(s).map((p) => ({ ...p, w: doc.getTextWidth(p.s) }));
    const total = pieces.reduce((a, p) => a + p.w, 0);
    let left = opts.align === 'right' ? x - total : opts.align === 'center' ? x - total / 2 : x;
    for (const p of pieces) { if (p.s.trim()) doc.text(p.s, left, yy); left += p.w; }
  };
  k.start = RTL ? W - M : M; k.end = RTL ? M : W - M; k.aStart = RTL ? 'right' : 'left'; k.aEnd = RTL ? 'left' : 'right';
  k.font = (style = 'normal', size = 10, color = ink) => { doc.setFont('Plex', style); doc.setFontSize(size); doc.setTextColor(...color); };
  k.wrap = (s, width) => doc.splitTextToSize(String(s ?? ''), width);
  k.header = (heading, idText, sub) => {
    k.y = M;
    if (logo) doc.addImage(logo, 'PNG', RTL ? W - M - 34 : M, k.y - 4, 34, 33);
    k.font('bold', 15); k.text(heading, RTL ? W - M - 44 : M + 44, k.y + 12, { align: k.aStart });
    k.font('normal', 9, muted); k.text(t('app.name'), RTL ? W - M - 44 : M + 44, k.y + 27, { align: k.aStart });
    k.text(idText, k.end, k.y + 12, { align: k.aEnd }); if (sub) k.text(sub, k.end, k.y + 27, { align: k.aEnd });
    k.y += 44; doc.setDrawColor(2, 69, 160); doc.setLineWidth(1.2); doc.line(M, k.y, W - M, k.y); k.y += 18;
  };
  k.onNewPage = null;
  k.ensure = (need) => { if (k.y + need > BOTTOM) { doc.addPage(); k.onNewPage?.(); } };
  k.kv = (label, value, { strong = false, size = 10 } = {}) => {
    k.ensure(18); k.font(strong ? 'bold' : 'normal', size, muted); k.text(label, k.start, k.y, { align: k.aStart });
    k.font(strong ? 'bold' : 'normal', size, ink); k.text(value, k.end, k.y, { align: k.aEnd });
    doc.setDrawColor(...line); doc.setLineWidth(0.4); doc.line(M, k.y + 5, W - M, k.y + 5); k.y += size + 9;
  };
  k.title = (s) => { k.ensure(30); k.y += 6; k.font('bold', 11.5); k.text(s, k.start, k.y, { align: k.aStart }); k.y += 16; };
  k.para = (s, size = 9, color = muted) => { k.font('normal', size, color); for (const ln of k.wrap(s, W - 2 * M)) { k.ensure(14); k.text(ln, k.start, k.y, { align: k.aStart }); k.y += size + 4; } };
  /** cols: [{ label, w (share), align: 'start'|'end' }]; rows: string[][]; header repeats on each page. */
  k.table = (cols, rows) => {
    const usable = W - 2 * M; const ws = cols.map((c) => c.w * usable);
    const xs = []; let acc = 0; for (const w of ws) { xs.push(RTL ? W - M - acc : M + acc); acc += w; }
    const head = () => {
      k.font('bold', 8, ink); doc.setFillColor(235, 240, 248); doc.rect(M, k.y - 10, usable, 16, 'F');
      cols.forEach((c, i) => { const end = c.align === 'end';
        k.text(c.label, end ? (RTL ? xs[i] - ws[i] + 3 : xs[i] + ws[i] - 3) : (RTL ? xs[i] - 3 : xs[i] + 3), k.y, { align: end ? k.aEnd : k.aStart }); });
      k.y += 12;
    };
    const prev = k.onNewPage; k.onNewPage = () => { prev?.(); head(); };
    head();
    for (const r of rows) {
      k.font('normal', 8, ink);
      const lines = r.map((cell, i) => k.wrap(cell, ws[i] - 6));
      const hgt = Math.max(...lines.map((l) => l.length)) * 10 + 4;
      k.ensure(hgt);
      lines.forEach((ls, i) => ls.forEach((ln, j) => {
        const end = cols[i].align === 'end';
        const x = end ? (RTL ? xs[i] - ws[i] + 3 : xs[i] + ws[i] - 3) : (RTL ? xs[i] - 3 : xs[i] + 3);
        k.text(ln, x, k.y + j * 10, { align: end ? k.aEnd : k.aStart });
      }));
      k.y += hgt; doc.setDrawColor(...line); doc.setLineWidth(0.3); doc.line(M, k.y - 8, W - M, k.y - 8);
    }
    k.onNewPage = prev;
  };
  k.finish = async (footer) => {
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) { doc.setPage(p); k.font('normal', 7.5, muted); k.text(`${footer} · ${t('doc.page', { p, n })}`, W / 2, H - 24, { align: 'center' }); }
    return assertPdf(doc.output('blob'));
  };
  return k;
}

/** One PDF; every payslip starts on a new page with its own identity. */
export async function payslipsPdf(slips) {
  const k = await pdfKit(t('ps.title'));
  slips.forEach((slip, idx) => {
    const d = slip.data; const e = d.entitlement; const id = slipIdentity(slip); const L = payslipLines(d);
    if (idx > 0) k.doc.addPage();
    const hdr = () => k.header(t('ps.title'), id.no, id.draft ? t('ps.draftMark') : id.label);
    hdr(); k.onNewPage = hdr;
    k.kv(t('ps.employee'), name(d.employee), { strong: true }); k.kv(t('ps.empId'), d.employee.code);
    k.kv(t('ps.job'), job(d.employee) || '—'); k.kv(t('ps.period'), `${dmy(d.period.from)} – ${dmy(d.period.to)}`);
    k.kv(t('ps.issued'), dmy(String(id.issued).slice(0, 10)));
    k.title(t('ps.earnings'));
    for (const [label, amt, note] of L.earn) k.kv(note ? `${label} (${note})` : label, amt == null ? '—' : formatEGP(amt));
    k.kv(t('ps.totalEarnings'), e.base_piastres == null ? '—' : formatEGP(e.base_piastres + e.earnings_piastres), { strong: true });
    k.title(t('ps.deductions'));
    if (!L.ded.length) k.para(t('ps.noDeductions'));
    for (const [label, amt, note] of L.ded) k.kv(`${label} (${note})`, formatEGP(amt));
    k.kv(t('ps.totalDeductions'), formatEGP(e.deductions_piastres), { strong: true });
    if (e.warnings_count || e.black_pending || e.pending_rewards_piastres) k.para(t('ps.notCounted', { w: e.warnings_count, p: e.black_pending, r: formatEGP(e.pending_rewards_piastres) }));
    k.y += 4;
    k.kv(t('pay.net'), money(e.net_piastres), { strong: true, size: 12 });
    k.kv(t('pay.salaryPaid'), formatEGP(e.salary_paid_piastres));
    for (const p of e.payments.filter((x) => x.kind === 'payment')) k.para(`${dmy(p.paid_on)} · ${formatEGP(p.amount_piastres)}${p.method ? ` · ${methodLabel(p.method)}` : ''}${p.reference ? ` · ${p.reference}` : ''}${p.reversed ? ` · ${t('pay.reversed')}` : ''}`, 8.5);
    k.kv(t('pay.rewardPaid'), formatEGP(e.reward_paid_piastres));
    k.kv(t('pay.remaining'), money(e.remaining_piastres), { strong: true, size: 13 });
    k.para(`${t('ps.payStatus')}: ${t(`pay.st.${e.status}`)}${e.flags.length ? ` · ${e.flags.map((f) => t(`pay.flag.${f}`)).join('، ')}` : ''}`, 9, k.ink);
    k.title(t('ps.attendance'));
    k.para(t('ps.attLine', { p: d.attendance.present_days, l: d.attendance.late_days, a: d.attendance.absence_days, v: d.attendance.leave_days, h: formatMinutes(d.attendance.worked_minutes) }), 9, k.ink);
    k.para(t('ps.statementRef', { code: d.employee.code, from: dmy(d.period.from), to: dmy(d.period.to) }));
    k.y += 18; k.ensure(40);
    k.para(`${t('ps.signEmployee')} ____________________    ${t('ps.signDate')} ____________`, 9.5, k.ink);
    k.para(`${t(id.draft ? 'ps.footDraft' : 'ps.foot')} ${t('ps.rules', { v: d.rules.rule_version })}`, 8);
    k.onNewPage = null;
  });
  return k.finish(t('ps.title'));
}

export async function statementPdf(st) {
  const k = await pdfKit(t('st.title'));
  const idText = `${st.employee.code} · ${dmy(st.from)} – ${dmy(st.to)}`;
  const hdr = () => k.header(t('st.title'), idText, name(st.employee));
  hdr(); k.onNewPage = hdr;
  for (const [label, v] of statementTotals(st)) k.kv(label, String(v));
  if (st.leave_summary.length) {
    k.title(t('st.leaveTitle'));
    for (const l of st.leave_summary) k.kv(`${t(`leave.${l.type}`)} · ${t(`status.${l.status}`)}`, t('st.leaveDays', { taken: l.taken_days, planned: l.planned_days }));
  }
  k.para(t('st.allowanceNot'));
  k.title(t('st.daily'));
  k.table([{ label: t('st.c.date'), w: 0.11 }, { label: t('st.c.day'), w: 0.1 }, { label: t('st.c.status'), w: 0.13 }, { label: t('st.c.in'), w: 0.08, align: 'end' },
    { label: t('st.c.out'), w: 0.08, align: 'end' }, { label: t('st.c.worked'), w: 0.1, align: 'end' }, { label: t('st.c.notes'), w: 0.3 }, { label: t('st.c.deduction'), w: 0.1, align: 'end' }],
  st.days.map((d) => { const c = statementCells(d); return [c.date, c.weekday, c.status, c.in, c.out, c.worked, c.notes, c.deduction]; }));
  k.onNewPage = null;
  return k.finish(t('st.title'));
}

export function statementCsvRows(st) {
  return st.days.map((d) => { const c = statementCells(d); return {
    [t('st.c.date')]: d.date, [t('st.c.day')]: c.weekday, [t('st.c.status')]: c.status, [t('st.c.in')]: d.check_in || '', [t('st.c.out')]: d.check_out || '',
    [t('st.c.worked')]: d.worked_minutes ?? '', [t('st.c.notes')]: c.notes, [t('st.c.deduction')]: (d.deduction_piastres || 0) / 100 }; });
}
