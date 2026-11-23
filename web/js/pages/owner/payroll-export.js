// Payroll exports built from the SAME report data the screen shows.
//  * PDF  — jsPDF + embedded IBM Plex Sans Arabic (shaping + RTL), drawn
//           from data in chunks (no DOM/canvas snapshot of the page).
//  * XLSX — a real Office Open XML workbook (SheetJS), not a renamed CSV.
//  * CSV  — one file per click (mobile browsers block multi-downloads),
//           UTF-8 BOM, CRLF, RFC 4180 quoting, formula-injection guard.
import { t, getLang } from '../../core/i18n.js';
import { formatTime, formatDate, formatEGP, formatMinutes, monthLabel, displayName, jobTitle } from '../../core/format.js';
import { MARK_SRC } from '../../ui/brand.js';

const VENDOR = new URL('../../../vendor/', import.meta.url).href;
const FONTS = new URL('../../../assets/fonts/pdf/', import.meta.url).href;
export const MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8',
};

// neutralise spreadsheet formula injection in user-supplied text
export const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const egpNum = (p) => Number(p || 0) / 100;
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

const scriptCache = new Map();
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src;
      s.onload = () => res(window[globalName]);
      s.onerror = () => { scriptCache.delete(src); rej(new Error(`load ${src}`)); };
      document.head.append(s);
    }));
  }
  return scriptCache.get(src);
}
async function fetchBase64(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function fetchDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}

/** Cairo-local "YYYY-MM-DD h:mm AM" for exported timestamps. */
function cairoStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return `${date} ${formatTime(d, getLang())}`;
}

// ---------------------------------------------------------------- rows
export function summaryRows(rep) {
  const ar = getLang() === 'ar';
  return rep.rows.map((r) => {
    const b = r.points_breakdown;
    return {
      [ar ? 'الموظف' : 'Employee']: safeCell(displayName(r)), [ar ? 'المسمى الوظيفي' : 'Job title']: safeCell(jobTitle(r)),
      [ar ? 'الراتب الشهري (ج.م)' : 'Monthly salary (EGP)']: r.monthly_salary_piastres == null ? '' : egpNum(r.monthly_salary_piastres),
      [ar ? 'ساعات العمل' : 'Worked hours']: Math.round((r.worked_minutes / 60) * 100) / 100,
      [ar ? 'خضراء حضور' : 'Green attendance']: b.green_attendance, [ar ? 'خضراء إنجاز' : 'Green outcome']: b.green_outcome,
      [ar ? 'إنذارات حمراء' : 'Red warnings']: b.red_warnings, [ar ? 'حمراء بخصم' : 'Chargeable red']: b.red_chargeable,
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

/** Raw rows with timestamps shown in Cairo 12-hour time and text guarded. */
export function rawRows(rows) {
  return (rows || []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
    [k, /_at$/.test(k) && v ? cairoStamp(v) : safeCell(v)])));
}

export const totals = (rep) => rep.rows.reduce((a, r) => ({
  deductions: a.deductions + Number(r.deductions_piastres || 0),
  earned: a.earned + Number(r.bonuses_earned_piastres || 0),
  paid: a.paid + Number(r.bonuses_paid_piastres || 0),
  net: a.net + Number(r.net_adjustment_piastres || 0),
}), { deductions: 0, earned: 0, paid: 0, net: 0 });

// ----------------------------------------------------------------- CSV
export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => { const s = String(safeCell(v ?? '')); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}
export function csvBlob(rows) { return new Blob(['﻿', toCsv(rows)], { type: MIME.csv }); }

// ---------------------------------------------------------------- XLSX
export async function xlsxBlob(rep, raw, onProgress) {
  onProgress?.(10);
  const XLSX = await loadScript(`${VENDOR}xlsx-0.18.5/xlsx.full.min.js`, 'XLSX');
  const ar = getLang() === 'ar';
  const meta = [[t('app.name')],
    [t('pr.meta', { month: monthLabel(rep.month), tz: rep.timezone, rv: rep.rule_version, at: `${formatDate(rep.generated_at)} ${formatTime(rep.generated_at)}` })],
    [t('pr.netNote')], []];
  const wb = XLSX.utils.book_new();
  if (ar) wb.Workbook = { Views: [{ RTL: true }] };
  const ws = XLSX.utils.aoa_to_sheet(meta);
  const sum = summaryRows(rep);
  if (sum.length) XLSX.utils.sheet_add_json(ws, sum, { origin: -1 });
  ws['!cols'] = Object.keys(sum[0] || { a: 1 }).map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, ws, ar ? 'التقرير' : 'Report');
  onProgress?.(50);
  const names = { attendance: ar ? 'الحضور' : 'Attendance', point_events: ar ? 'النقاط' : 'Points', deductions: ar ? 'الخصومات' : 'Deductions' };
  for (const [k, label] of Object.entries(names)) {
    const rows = rawRows(raw?.[k]);
    const sheet = rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([[ar ? 'لا توجد بيانات' : 'No data']]);
    XLSX.utils.book_append_sheet(wb, sheet, label);
    await yieldToUi();
  }
  onProgress?.(85);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });
  return new Blob([out], { type: MIME.xlsx });
}


// ------------------------------------------------------------ bidi (PDF)
// jsPDF shapes Arabic correctly but mis-orders lines that MIX Arabic with
// digits/Latin ("1 × 50 ج.م = 50 ج.م", "112 س 30 د", "(حضور)"). For Arabic
// output we split a line into single-direction runs, order them for an RTL
// paragraph (simplified UBA: Latin/number runs keep LTR order, neutrals take
// RTL, brackets mirror) and draw each run separately.
const AR = '؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿';
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
const reAr = new RegExp(`^[${AR}]+(?:[ .،][${AR}]+)*`);
const reL = /^[-+−]?[A-Za-z0-9À-ɏ]+(?:[ .,:/×=%'‐-—+−-]+[A-Za-z0-9À-ɏ]+)*/;
/** logical string → visual-order pieces [{ s, kind: 'ar'|'l'|'n' }] (left → right). */
export function rtlPieces(str) {
  const src = String(str ?? '').replace(/[‎‏؜‪-‮⁦-⁩]/g, '').replace(/[  ]/g, ' ');
  const toks = []; let i = 0;
  while (i < src.length) {
    const rest = src.slice(i); let m;
    if ((m = rest.match(reAr))) toks.push({ s: m[0], kind: 'ar' });
    else if ((m = rest.match(reL))) toks.push({ s: m[0], kind: 'l' });
    else { m = [rest[0]]; toks.push({ s: MIRROR[rest[0]] || rest[0], kind: 'n' }); }
    i += m[0].length;
  }
  // RTL paragraph: reverse token order; consecutive LTR tokens stay in order
  const out = []; let k = toks.length - 1;
  while (k >= 0) {
    if (toks[k].kind === 'l') { let j = k; while (j - 1 >= 0 && toks[j - 1].kind === 'l') j--; for (let q = j; q <= k; q++) out.push(toks[q]); k = j - 1; }
    else { out.push(toks[k]); k--; }
  }
  return out;
}

// ----------------------------------------------------------------- PDF
export async function pdfBlob(rep, onProgress) {
  onProgress?.(5);
  const ns = await loadScript(`${VENDOR}jspdf-3.0.4/jspdf.umd.min.js`, 'jspdf');
  const [reg, bold, logo] = await Promise.all([
    fetchBase64(`${FONTS}IBMPlexSansArabic-Regular.ttf`), fetchBase64(`${FONTS}IBMPlexSansArabic-Bold.ttf`), fetchDataUrl(MARK_SRC).catch(() => null)]);
  onProgress?.(20);
  const ar = getLang() === 'ar';
  const doc = new ns.jsPDF({ unit: 'pt', format: 'a4', compress: true });
  doc.addFileToVFS('Plex-Regular.ttf', reg); doc.addFont('Plex-Regular.ttf', 'Plex', 'normal');
  doc.addFileToVFS('Plex-Bold.ttf', bold); doc.addFont('Plex-Bold.ttf', 'Plex', 'bold');
  doc.setLanguage(ar ? 'ar' : 'en-US');
  doc.setProperties({ title: `حاضر — ${t('pr.title')} ${rep.month.slice(0, 7)}`, creator: 'حاضر' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40, BOTTOM = H - 50;
  // In Arabic: labels at the right edge, values at the left edge; English mirrors it.
  const startX = ar ? W - M : M, endX = ar ? M : W - M;
  const alignStart = ar ? 'right' : 'left', alignEnd = ar ? 'left' : 'right';
  const ink = [11, 21, 48], muted = [74, 88, 120], line = [211, 220, 235], brand = [2, 69, 160];
  let y = M;

  const plainText = (s, x, yy, opts = {}) => doc.text(String(s ?? ''), x, yy, opts);
  // Arabic: draw run by run in visual order (see rtlPieces); English: as-is.
  const text = (s, x, yy, opts = {}) => {
    if (!ar) return plainText(s, x, yy, opts);
    const pieces = rtlPieces(s).map((p) => ({ ...p, w: doc.getTextWidth(p.s) }));
    const total = pieces.reduce((a, p) => a + p.w, 0);
    let left = opts.align === 'right' ? x - total : opts.align === 'center' ? x - total / 2 : x;
    for (const p of pieces) { if (p.s.trim()) doc.text(p.s, left, yy); left += p.w; }
  };
  const header = () => {
    if (logo) doc.addImage(logo, 'PNG', ar ? W - M - 34 : M, y - 4, 34, 33);
    doc.setFont('Plex', 'bold'); doc.setFontSize(16); doc.setTextColor(...ink);
    const tx = ar ? W - M - 44 : M + 44;
    text(t('pr.title'), tx, y + 12, { align: alignStart });
    doc.setFont('Plex', 'normal'); doc.setFontSize(10); doc.setTextColor(...muted);
    // product name (Arabic only)
    text(t('app.name'), ar ? M : W - M, y + 12, { align: alignEnd });
    text(monthLabel(rep.month), ar ? M : W - M, y + 28, { align: alignEnd });
    y += 48;
    doc.setDrawColor(...brand); doc.setLineWidth(1.2); doc.line(M, y, W - M, y); y += 16;
  };
  const ensure = (need) => { if (y + need > BOTTOM) { doc.addPage(); y = M; header(); } };

  header();
  const metaRow = (label, value) => {
    doc.setFont('Plex', 'normal'); doc.setFontSize(9); doc.setTextColor(...muted);
    text(label, startX, y, { align: alignStart }); text(value, endX, y, { align: alignEnd }); y += 14;
  };
  metaRow(ar ? 'المنطقة الزمنية' : 'Timezone', rep.timezone);
  metaRow(ar ? 'إصدار القواعد' : 'Rule version', String(rep.rule_version));
  metaRow(ar ? 'وقت الإنشاء' : 'Generated', `${formatDate(rep.generated_at)} ${formatTime(rep.generated_at)}`);
  doc.setFontSize(9); doc.setTextColor(...muted);
  for (const ln of doc.splitTextToSize(t('pr.netNote'), W - 2 * M)) { text(ln, startX, y, { align: alignStart }); y += 13; }
  y += 8;

  if (!rep.rows.length) {
    doc.setFontSize(12); doc.setTextColor(...ink); text(t('od.noStaff'), startX, y + 10, { align: alignStart });
  }
  const row = (label, value, strong = false) => {
    ensure(18);
    doc.setFont('Plex', strong ? 'bold' : 'normal'); doc.setFontSize(10);
    doc.setTextColor(...muted); text(label, startX, y, { align: alignStart });
    doc.setTextColor(...ink); text(value, endX, y, { align: alignEnd });
    doc.setDrawColor(...line); doc.setLineWidth(0.5); doc.line(M, y + 5, W - M, y + 5);
    y += 18;
  };
  for (let i = 0; i < rep.rows.length; i++) {
    const r = rep.rows[i]; const b = r.points_breakdown;
    ensure(60);
    doc.setFont('Plex', 'bold'); doc.setFontSize(13); doc.setTextColor(...ink);
    text(displayName(r), startX, y, { align: alignStart });
    if (r.incomplete) { doc.setFontSize(9); doc.setTextColor(181, 71, 8); text(t('pr.incomplete'), endX, y, { align: alignEnd }); }
    y += 6;
    if (jobTitle(r)) { y += 10; doc.setFont('Plex', 'normal'); doc.setFontSize(9); doc.setTextColor(...muted); text(jobTitle(r), startX, y, { align: alignStart }); }
    y += 16;
    row(t('od.salary'), r.monthly_salary_piastres == null ? t('common.notSet') : formatEGP(r.monthly_salary_piastres), true);
    row(t('pr.hours'), formatMinutes(r.worked_minutes));
    row(t('pr.greenAtt'), String(b.green_attendance));
    row(t('pr.greenOut'), String(b.green_outcome));
    row(t('pr.warnings'), String(b.red_warnings));
    row(t('pr.redCharge'), `${b.red_chargeable} × ${formatEGP(rep.red_penalty_piastres)} = ${formatEGP(b.red_amount_piastres)}`);
    row(t('pr.blackApproved'), `${b.black_approved} × ${formatEGP(rep.black_penalty_piastres)} = ${formatEGP(b.black_amount_piastres)}`);
    row(t('pr.blackPending'), `${b.black_pending} / ${b.black_declined}`);
    row(t('pr.deductions'), formatEGP(r.deductions_piastres), true);
    row(t('pr.bonus'), formatEGP(r.bonuses_earned_piastres));
    row(t('pr.paid'), formatEGP(r.bonuses_paid_piastres));
    row(t('pr.net'), formatEGP(r.net_adjustment_piastres), true);
    if (r.unresolved_flags?.length) {
      ensure(18); doc.setFontSize(9); doc.setTextColor(181, 71, 8);
      text(`${t('od.missing')}: ${r.unresolved_flags.map((f) => f.date).join(', ')}`, startX, y, { align: alignStart, maxWidth: W - 2 * M }); y += 16;
    }
    y += 14;
    if (i % 5 === 4) { onProgress?.(20 + Math.round((70 * (i + 1)) / rep.rows.length)); await yieldToUi(); }
  }
  // totals (same source as the screen)
  if (rep.rows.length) {
    const tt = totals(rep);
    ensure(90);
    doc.setDrawColor(...brand); doc.setLineWidth(1); doc.line(M, y - 6, W - M, y - 6); y += 8;
    doc.setFont('Plex', 'bold'); doc.setFontSize(12); doc.setTextColor(...ink);
    text(t('common.total'), startX, y, { align: alignStart }); y += 20;
    row(t('pr.deductions'), formatEGP(tt.deductions), true);
    row(t('pr.bonus'), formatEGP(tt.earned));
    row(t('pr.paid'), formatEGP(tt.paid));
    row(t('pr.net'), formatEGP(tt.net), true);
  }
  // page numbers
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p); doc.setFont('Plex', 'normal'); doc.setFontSize(8); doc.setTextColor(...muted);
    text(`${ar ? 'صفحة' : 'Page'} ${p} / ${n}`, W / 2, H - 24, { align: 'center' });
  }
  onProgress?.(95);
  return doc.output('blob');
}

// ------------------------------------------------------------ delivery
/**
 * Hand a file to the user. Programmatic download where supported; the
 * Object URL is revoked after use. Returns { file } so the caller can offer
 * a Share button (needs a fresh user tap) on phones.
 */
export function deliver(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  const file = typeof File === 'function' ? new File([blob], filename, { type: blob.type }) : null;
  return { file, canShare: !!(file && navigator.canShare?.({ files: [file] })) };
}
