// Owner → employee page: the employee's own work schedule (personal days
// off and hours), their annual leave balance, and the change log (every
// change the owner / system made for them, with reasons).
import { h, fill } from '../../core/dom.js';
import { t, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatClock, formatEGP, monthLabel } from '../../core/format.js';
import { sb } from '../../core/supabase.js';
import { advanceProgress } from '../staff/requests.js';
import { card, alert, badge, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, textarea, switchControl, setFieldError } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { changeList } from '../../ui/change-log.js';

// 2026-11-22 is a Sunday (day_of_week 0)
const dayName = (dow) => new Intl.DateTimeFormat(getLang() === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'long', timeZone: 'UTC' })
  .format(new Date(Date.UTC(2026, 10, 22 + dow)));
const num = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1));
const hm = (v) => (v ? String(v).slice(0, 5) : '');

export function renderEmployeeTools(slot, employeeId) {
  const sched = h('div', {}, skeletonCard(t('common.loading')));
  const bal = h('div', {}, skeletonCard(t('common.loading')));
  const log = h('div', {}, skeletonCard(t('common.loading')));
  const adv = h('div', {}, skeletonCard(t('common.loading')));
  fill(slot,
    card({ title: t('sch.title'), subtitle: t('sch.subtitle'), iconName: 'calendar', body: sched }),
    card({ title: t('bal.ownerTitle'), iconName: 'calendarCheck', body: bal }),
    card({ title: t('adv.title'), iconName: 'wallet', body: adv }),
    card({ title: t('chg.title'), subtitle: t('chg.ownerSubtitle'), iconName: 'history', body: h('details', {
      onToggle: (e) => { if (e.target.open && !log.dataset.loaded) loadLog(); } }, h('summary', {}, t('chg.show')), log) }));

  const reloadLog = () => { log.dataset.loaded = ''; if (log.closest('details')?.open) loadLog(); };

  // ---------------------------------------------------------- schedule
  async function loadSchedule() {
    try { renderSchedule(await api('employee_schedule', { employee_id: employeeId })); }
    catch (err) { fill(sched, alert(errorMessage(err), { tone: 'danger' })); }
  }
  function renderSchedule(s) {
    const rows = s.days.map((d) => {
      const company = d.company_work_day;
      const sw = switchControl({ label: t('sch.works'), checked: !!d.is_work_day, disabled: !company });
      const fs = input({ label: t('sch.start'), type: 'time', value: hm(d.start_time), attrs: { dir: 'ltr' } });
      const fe = input({ label: t('sch.end'), type: 'time', value: hm(d.end_time), attrs: { dir: 'ltr' } });
      const sync = () => { const on = sw.querySelector('input').checked && company; fs.hidden = !on; fe.hidden = !on; };
      sw.querySelector('input').addEventListener('change', sync); sync();
      const el = h('div', { class: 'sched-row', 'data-dow': String(d.day_of_week) },
        h('div', { class: 'sched-row__day' }, h('strong', {}, dayName(d.day_of_week)),
          h('span', { class: 'text-xs text-muted' }, company ? t('sch.default', { from: formatClock(s.company_start), to: formatClock(s.company_end) }) : t('sch.companyOff'))),
        sw, h('div', { class: 'form-grid sched-row__times' }, fs, fe));
      return { d, el, sw, fs, fe, company };
    });
    const fReason = input({ label: t('common.reason'), hint: t('common.optional'), attrs: { maxlength: '200' } });
    const status = h('p', { class: 'text-sm text-muted', role: 'status' });
    const save = button({ label: t('common.save'), variant: 'primary', onClick: async () => {
      const days = [];
      for (const r of rows) {
        if (!r.company) continue;
        const work = r.sw.querySelector('input').checked;
        const a = r.fs.querySelector('input').value; const b = r.fe.querySelector('input').value;
        setFieldError(r.fe, null);
        if (work && (!!a !== !!b || (a && b <= a))) { setFieldError(r.fe, t('sch.errTimes')); return; }
        days.push({ day_of_week: r.d.day_of_week, is_work_day: work, start_time: work && a ? a : null, end_time: work && b ? b : null });
      }
      setLoading(save, true);
      try {
        renderSchedule(await api('save_employee_schedule', { employee_id: employeeId, days, reason: fReason.querySelector('input').value }));
        toast({ title: t('set.saved'), tone: 'success' }); reloadLog();
      } catch (err) { status.textContent = errorMessage(err); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(save, false); }
    } });
    fill(sched, h('div', { class: 'stack' }, h('p', { class: 'text-sm text-muted' }, t('sch.help')), ...rows.map((r) => r.el), fReason,
      h('div', { class: 'cluster' }, save, status)));
  }

  // ---------------------------------------------------------- leave balance
  const thisYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric' }).format(new Date()));
  const fYear = select({ label: t('bal.year'), value: String(thisYear), options: [thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: String(y), label: String(y) })) });
  fYear.querySelector('select').addEventListener('change', () => loadBalance());
  async function loadBalance() {
    const year = Number(fYear.querySelector('select').value);
    try {
      const r = await api('leave_balances', { year, employee_id: employeeId });
      const b = (r.employees || [])[0];
      if (!b) { fill(bal, alert(t('err.not_found'), { tone: 'danger' })); return; }
      const fDays = input({ label: t('bal.entitled'), type: 'number', value: num(b.entitled), attrs: { min: '0', max: '365', step: '0.5', inputmode: 'decimal', dir: 'ltr' },
        hint: b.custom ? t('bal.custom') : t('bal.default', { n: num(r.default_days) }) });
      const fNote = textarea({ label: t('bal.noteLabel'), value: b.note || '', rows: 2, hint: t('common.optional') });
      const save = button({ label: t('common.save'), variant: 'primary', onClick: async () => {
        const v = Number(fDays.querySelector('input').value);
        if (!Number.isFinite(v) || v < 0 || v > 365 || Math.round(v * 2) !== v * 2) { setFieldError(fDays, t('bal.errDays')); return; }
        setFieldError(fDays, null); setLoading(save, true);
        try {
          await api('set_leave_balance', { employee_id: employeeId, year, entitled_days: v, note: fNote.querySelector('textarea').value });
          toast({ title: t('set.saved'), tone: 'success' }); reloadLog(); loadBalance();
        } catch (err) { setFieldError(fDays, errorMessage(err)); setLoading(save, false); }
      } });
      const kv = (k, v) => h('div', { class: 'kv-row' }, h('dt', {}, k), h('dd', { class: 'num' }, v));
      fill(bal, h('div', { class: 'stack' }, fYear,
        h('dl', { class: 'kv-grid' }, kv(t('bal.entitled'), num(b.entitled)), kv(t('bal.used'), num(b.used)), kv(t('bal.pending'), num(b.pending)),
          kv(t('bal.remaining'), num(b.remaining)), kv(t('bal.available'), num(b.available)), kv(t('bal.sick'), num(b.sick_used))),
        h('div', { class: 'form-grid' }, fDays, fNote), h('div', { class: 'cluster' }, save)));
    } catch (err) { fill(bal, alert(errorMessage(err), { tone: 'danger' })); }
  }

  // ---------------------------------------------------------- change log
  async function loadLog() {
    log.dataset.loaded = '1';
    fill(log, h('p', { class: 'text-muted' }, t('common.loading')));
    try { fill(log, changeList(await api('employee_changes', { employee_id: employeeId, limit: 100 }))); }
    catch (err) { fill(log, alert(errorMessage(err), { tone: 'danger' })); log.dataset.loaded = ''; }
  }

  // ---------------------------------------------------------- advances
  async function loadAdvances() {
    const { data, error } = await sb.from('salary_advances').select('*').eq('employee_id', employeeId).order('created_at', { ascending: false }).limit(20);
    if (error) { fill(adv, alert(errorMessage(error), { tone: 'danger' })); return; }
    const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date()).slice(0, 7);
    const months = Array.from({ length: 6 }, (_, i) => { const [y, m] = now.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 10); });
    const fAmt = input({ label: t('adv.amount'), type: 'number', attrs: { min: '1', step: '1', inputmode: 'numeric', dir: 'ltr' } });
    const fN = select({ label: t('adv.installmentsLabel'), value: '1', options: Array.from({ length: 24 }, (_, i) => ({ value: String(i + 1), label: t('adv.installments', { n: i + 1 }) })) });
    const fStart = select({ label: t('adv.startMonth'), options: months.map((v) => ({ value: v, label: monthLabel(v) })) });
    const fReason = input({ label: t('common.reason'), hint: t('common.optional'), attrs: { maxlength: '200' } });
    const save = button({ label: t('adv.record'), variant: 'primary', onClick: async () => {
      const v = Number(fAmt.querySelector('input').value);
      if (!Number.isInteger(v) || v < 1 || v > 1000000) { setFieldError(fAmt, t('adv.errAmount')); return; }
      setFieldError(fAmt, null); setLoading(save, true);
      try {
        await api('create_advance', { employee_id: employeeId, amount_egp: v, installments: Number(fN.querySelector('select').value),
          start_month: fStart.querySelector('select').value, reason: fReason.querySelector('input').value });
        toast({ title: t('set.saved'), tone: 'success' }); reloadLog(); loadAdvances();
      } catch (err) { setFieldError(fAmt, errorMessage(err)); setLoading(save, false); }
    } });
    const rows = (data || []).map((r) => h('li', { class: 'event-row' }, badge(t(`status.${r.status}`), { tone: { approved: 'success', pending: 'warning', rejected: 'danger' }[r.status] || 'neutral', dot: true }),
      h('div', { class: 'event-row__main' }, h('span', { class: 'num' }, `${formatEGP(r.amount_piastres)} · ${t('adv.installments', { n: r.installments })}`),
        r.status === 'approved' ? h('span', { class: 'text-xs text-muted' }, advanceProgress(r)) : null,
        r.reason ? h('span', { class: 'text-xs text-muted' }, r.reason) : null)));
    fill(adv, h('div', { class: 'stack' }, rows.length ? h('ul', { class: 'event-list', role: 'list' }, rows) : h('p', { class: 'text-sm text-muted' }, t('adv.none')),
      h('p', { class: 'text-sm text-muted' }, t('adv.ownerHint')), h('div', { class: 'form-grid' }, fAmt, fN, fStart, fReason), h('div', { class: 'cluster' }, save)));
  }

  loadSchedule(); loadBalance(); loadAdvances();
}
