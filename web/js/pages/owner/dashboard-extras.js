// Owner dashboard extras: the selfie switch (feature 10) and the month's
// statistics (feature 9): daily attendance bars, most committed employees,
// absences by weekday (last 90 days). One series → one hue, no legend; every
// bar has a tooltip and the numbers are also in a table (no colour-only data).
import { h, fill } from '../../core/dom.js';
import { t, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatMinutes, monthLabel } from '../../core/format.js';
import { card, alert, skeletonCard } from '../../ui/display.js';
import { switchControl } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';

const dayName = (dow) => new Intl.DateTimeFormat(getLang() === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 22 + dow)));
const dm = (iso) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;

export function selfieSwitch(on) {
  const sw = switchControl({ label: t('selfie.switch'), checked: !!on, onChange: async (e) => {
    const want = e.target.checked; e.target.disabled = true;
    try { await api('save_staff_tools', { selfie_required: want }); toast({ title: want ? t('selfie.onToast') : t('selfie.offToast'), tone: 'success' }); }
    catch (err) { e.target.checked = !want; toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
    finally { e.target.disabled = false; }
  } });
  return card({ title: t('selfie.cardTitle'), iconName: 'user', body: [sw, h('p', { class: 'text-xs text-muted' }, t('selfie.cardHint'))] });
}

function bars(days) {
  const W = 320, H = 120, P = 18;
  const max = Math.max(1, ...days.map((d) => d.present + d.absent + d.leave));
  const bw = Math.max(3, Math.min(18, (W - 8) / Math.max(days.length, 1) - 2));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + P}`); svg.setAttribute('class', 'stat-bars'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('stats.barsLabel'));
  const ns = (tag, attrs, text) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v)); if (text) el.textContent = text; return el; };
  svg.append(ns('line', { x1: 0, x2: W, y1: H, y2: H, class: 'stat-bars__axis' }));
  const step = (W - 8) / Math.max(days.length, 1);
  days.forEach((d, i) => {
    const x = 4 + i * step + (step - bw) / 2; const hgt = Math.round((d.present / max) * (H - 8));
    const g = ns('g', { class: 'stat-bars__bar', tabindex: '0' });
    g.append(ns('title', {}, t('stats.tip', { d: dm(d.date), p: d.present, l: d.late, a: d.absent, v: d.leave })));
    g.append(ns('rect', { x: x - 2, y: 0, width: bw + 4, height: H, class: 'stat-bars__hit' }));
    if (hgt > 0) g.append(ns('rect', { x, y: H - hgt, width: bw, height: hgt, rx: Math.min(4, bw / 2), class: 'stat-bars__fill' }));
    if (days.length <= 10 || i % Math.ceil(days.length / 8) === 0) g.append(ns('text', { x: x + bw / 2, y: H + 13, 'text-anchor': 'middle', class: 'stat-bars__tick' }, dm(d.date)));
    svg.append(g);
  });
  return svg;
}

export async function renderStats(slot) {
  fill(slot, skeletonCard(t('common.loading')));
  let s;
  try { s = await api('dashboard_stats'); }
  catch (err) { fill(slot, card({ title: t('stats.title'), body: alert(errorMessage(err), { tone: 'danger' }) })); return; }
  const totals = s.days.reduce((a, d) => ({ p: a.p + d.present, l: a.l + d.late, x: a.x + d.absent }), { p: 0, l: 0, x: 0 });
  const top = s.employees.slice(0, 5);
  const maxAbs = Math.max(0, ...s.absence_by_weekday.map((w) => w.count));
  const table = h('table', { class: 'visually-hidden' }, h('caption', {}, t('stats.barsLabel')),
    h('tr', {}, h('th', {}, t('common.date')), h('th', {}, t('stats.present')), h('th', {}, t('stats.late')), h('th', {}, t('stats.absent')), h('th', {}, t('stats.leave'))),
    ...s.days.map((d) => h('tr', {}, h('td', {}, d.date), h('td', {}, String(d.present)), h('td', {}, String(d.late)), h('td', {}, String(d.absent)), h('td', {}, String(d.leave)))));
  fill(slot, card({ title: t('stats.title', { m: monthLabel(s.month) }), iconName: 'activity', body: h('div', { class: 'stack' },
    h('p', { class: 'text-sm text-muted' }, t('stats.summary', { p: totals.p, l: totals.l, a: totals.x })),
    s.days.length ? h('div', { class: 'stat-bars__wrap' }, h('p', { class: 'text-sm' }, t('stats.barsLabel')), bars(s.days), table) : h('p', { class: 'text-sm text-muted' }, t('stats.noDays')),
    h('div', { class: 'stat-cols' },
      h('section', {}, h('h4', { class: 'text-sm' }, t('stats.top')),
        top.length ? h('ol', { class: 'stat-list' }, top.map((e) => h('li', {}, h('strong', {}, getLang() === 'ar' ? e.name_ar : e.name_en),
          h('span', { class: 'text-xs text-muted' }, t('stats.topLine', { g: e.green, l: e.late, a: e.absent, w: formatMinutes(e.worked_minutes) })))))
          : h('p', { class: 'text-sm text-muted' }, t('od.noStaff'))),
      h('section', {}, h('h4', { class: 'text-sm' }, t('stats.byDay')),
        maxAbs ? h('ul', { class: 'stat-list' }, s.absence_by_weekday.filter((w) => w.count > 0).sort((a, b) => b.count - a.count)
          .map((w) => h('li', {}, h('strong', {}, dayName(w.dow)), h('span', { class: 'text-xs text-muted' }, t('stats.absences', { n: w.count })))))
          : h('p', { class: 'text-sm text-muted' }, t('stats.noAbsence')))) ) }));
}
