// Owner settings: every business rule, saved through the api function
// (validated + audited server-side; financial/hours edits bump the rule
// version and apply to future events only).
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { sb } from '../../core/supabase.js';
import { errorMessage } from '../../core/errors.js';
import { formatDateTime, formatClock, hhmm } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, switchControl, setFieldError } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { icon } from '../../ui/icons.js';

export async function renderSettings(main) {
  setDocumentTitle(t('set.title'));
  add(main, pageHeader({ title: t('set.title'), subtitle: t('set.subtitle') }));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);
  let s; let rules; let windows;

  async function load() {
    const [a, b, c] = await Promise.all([
      sb.from('settings').select('*').eq('id', true).single(),
      sb.from('day_rules').select('*').order('day_of_week'),
      sb.from('check_in_windows').select('*').order('start_time')]);
    if (a.error || b.error || c.error) { fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(a.error || b.error || c.error), error: true })); return; }
    s = a.data; rules = b.data; windows = c.data;
    render();
  }

  const num = (label, value, attrs = {}) => input({ label, value: String(value ?? ''), attrs: { inputmode: 'numeric', dir: 'ltr', ...attrs } });
  const time = (label, value) => input({ label, type: 'time', value: hhmm(value), attrs: { dir: 'ltr' } });
  const val = (f) => f.querySelector('input,select').value.trim();
  const chk = (f) => f.querySelector('input').checked;

  async function save(btn, patch, okMsg = t('set.saved')) {
    setLoading(btn, true);
    try { await api('update_settings', patch); toast({ title: okMsg, tone: 'success' }); await load(); }
    catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
    finally { setLoading(btn, false); }
  }

  function section(title, iconName, fields, onSave, extra) {
    const btn = button({ label: t('common.save'), variant: 'primary' });
    btn.addEventListener('click', () => onSave(btn));
    return card({ title: h('span', { class: 'cluster cluster--sm' }, icon(iconName), title), body: [h('div', { class: 'form-grid' }, fields), extra || null], footer: [btn] });
  }

  function render() {
    clear(body);
    add(body, alert(t('set.version', { v: s.rule_version, at: formatDateTime(s.updated_at) }), { tone: 'info' }));

    // ---- money & points
    const fRed = num(t('set.redPenalty'), s.red_penalty_piastres / 100), fBlack = num(t('set.blackPenalty'), s.black_penalty_piastres / 100);
    const fTh = num(t('set.threshold'), s.green_reward_threshold), fRw = num(t('set.rewardAmount'), s.reward_amount_piastres / 100);
    const fWarn = switchControl({ label: t('set.firstRed'), checked: s.first_red_warning });
    add(body, section(t('set.money'), 'gift', [fRed, fBlack, fTh, fRw, fWarn], (btn) => {
      const egp = (f) => { const v = val(f); return /^\d{1,7}$/.test(v) ? Number(v) * 100 : NaN; };
      const patch = { red_penalty_piastres: egp(fRed), black_penalty_piastres: egp(fBlack), reward_amount_piastres: egp(fRw), green_reward_threshold: Number(val(fTh)), first_red_warning: chk(fWarn) };
      let bad = false;
      [[fRed, patch.red_penalty_piastres], [fBlack, patch.black_penalty_piastres], [fRw, patch.reward_amount_piastres]].forEach(([f, v]) => { const ok = Number.isFinite(v); setFieldError(f, ok ? null : t('err.invalid_amount')); bad ||= !ok; });
      const thOk = Number.isInteger(patch.green_reward_threshold) && patch.green_reward_threshold >= 1 && patch.green_reward_threshold <= 1000;
      setFieldError(fTh, thOk ? null : t('err.invalid_settings')); bad ||= !thOk;
      if (!bad) save(btn, patch);
    }));

    // ---- working hours
    const fStart = time(t('set.workStart'), s.work_start_time), fEnd = time(t('set.workEnd'), s.work_end_time), fCut = time(t('set.cutoff'), s.absence_cutoff);
    add(body, section(t('set.hours'), 'clock', [fStart, fEnd, fCut], (btn) => {
      if (!val(fStart) || !val(fEnd) || val(fStart) >= val(fEnd)) { setFieldError(fEnd, t('err.invalid_settings')); return; }
      setFieldError(fEnd, null);
      save(btn, { work_start_time: val(fStart), work_end_time: val(fEnd), absence_cutoff: val(fCut) });
    }, h('p', { class: 'text-sm text-muted' }, t('set.hoursNote'))));

    // ---- office geofence
    const fLat = input({ label: t('set.lat'), value: String(s.geofence_lat), attrs: { inputmode: 'decimal', dir: 'ltr' } });
    const fLng = input({ label: t('set.lng'), value: String(s.geofence_lng), attrs: { inputmode: 'decimal', dir: 'ltr' } });
    const fRad = num(t('set.radius'), s.geofence_radius_m);
    add(body, section(t('set.office'), 'mapPin', [fLat, fLng, fRad], (btn) => {
      const lat = Number(val(fLat)), lng = Number(val(fLng)), r = Number(val(fRad));
      if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180) || !(r >= 10 && r <= 5000)) { setFieldError(fRad, t('err.invalid_settings')); return; }
      save(btn, { geofence_lat: lat, geofence_lng: lng, geofence_radius_m: Math.round(r) });
    }));

    // ---- days & windows
    add(body, card({ title: h('span', { class: 'cluster cluster--sm' }, icon('calendar'), t('set.windows')),
      body: h('div', { class: 'stack' }, rules.map(dayEditor)) }));

    // ---- notifications (Telegram)
    const fChat = input({ label: t('set.chatId'), value: s.owner_telegram_chat_id, attrs: { dir: 'ltr', inputmode: 'numeric' } });
    const fChan = select({ label: t('set.channel'), options: [{ value: 'telegram', label: 'Telegram' }, { value: 'off', label: t('common.disabled') }], value: s.owner_alert_channel });
    const fDig = switchControl({ label: t('set.digest'), checked: s.digest_enabled }), fDigT = time(t('set.digestTime'), s.digest_time);
    const fWk = switchControl({ label: t('set.weekly'), checked: s.weekly_summary_enabled });
    const fWkD = select({ label: t('set.weeklyDay'), value: s.weekly_summary_dow == null ? '' : String(s.weekly_summary_dow),
      options: [{ value: '', label: t('set.lastWorkDay') }, ...[0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: String(d), label: t(`dow.${d}`) }))] });
    const fWkT = time(t('set.weeklyTime'), s.weekly_summary_time);
    const tgStatus = h('p', { class: 'text-sm text-muted', role: 'status' });
    const tgBtn = (label, action) => { const b = button({ label, size: 'sm', icon: 'bell', onClick: async () => {
      setLoading(b, true);
      try { await api(action); toast({ title: t('set.tgOk'), tone: 'success' }); refreshTg(); }
      catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(b, false); }
    } }); return b; };
    const refreshTg = async () => { try { const r = await api('telegram_status'); tgStatus.textContent = r.token_missing ? t('err.telegram_token_missing') : t('set.tgStatus', { s: r.connected ? '✅' : '—' }); } catch (err) { tgStatus.textContent = errorMessage(err); } };
    add(body, section(t('set.notify'), 'bell', [fChat, fChan, fDig, fDigT, fWk, fWkD, fWkT], (btn) => {
      if (!/^-?\d{3,20}$/.test(val(fChat))) { setFieldError(fChat, t('err.invalid_settings')); return; }
      save(btn, { owner_telegram_chat_id: val(fChat), owner_alert_channel: val(fChan), digest_enabled: chk(fDig), digest_time: val(fDigT),
        weekly_summary_enabled: chk(fWk), weekly_summary_dow: val(fWkD) === '' ? null : Number(val(fWkD)), weekly_summary_time: val(fWkT) });
    }, h('div', { class: 'cluster' }, tgBtn(t('set.tgConnect'), 'telegram_connect'), tgBtn(t('set.tgTest'), 'telegram_test'), tgStatus)));
    refreshTg();

    // ---- reminders
    const fSh = switchControl({ label: t('set.shiftDefault'), checked: s.shift_reminders_default }), fLead = num(t('set.lead'), s.shift_reminder_lead_min);
    const fMs = switchControl({ label: t('set.missed'), checked: s.missed_checkin_reminder_enabled }), fMsL = num(t('set.missedLead'), s.missed_checkin_lead_min);
    add(body, section(t('set.reminders'), 'clock', [fSh, fLead, fMs, fMsL], (btn) => {
      const a = Number(val(fLead)), b = Number(val(fMsL));
      if (!(a >= 1 && a <= 120) || !(b >= 1 && b <= 120)) { setFieldError(fMsL, t('err.invalid_settings')); return; }
      save(btn, { shift_reminders_default: chk(fSh), shift_reminder_lead_min: a, missed_checkin_reminder_enabled: chk(fMs), missed_checkin_lead_min: b });
    }));

    // ---- other
    const fLb = switchControl({ label: t('set.leaderboard'), checked: s.leaderboard_visible });
    add(body, section(t('set.other'), 'trophy', [fLb], (btn) => save(btn, { leaderboard_visible: chk(fLb) })));

    // ---- manual job runs
    const run = (label, job) => { const b = button({ label, size: 'sm', onClick: async () => {
      setLoading(b, true);
      try { await api('run_job', { job }); toast({ title: t('set.jobDone'), tone: 'success' }); }
      catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(b, false); }
    } }); return b; };
    add(body, card({ title: t('set.jobs'), body: h('div', { class: 'cluster' }, run(t('set.runAbsence'), 'absence'), run(t('set.runDigest'), 'digest')) }));
  }

  function dayEditor(rule) {
    const dow = rule.day_of_week;
    const fWork = switchControl({ label: t('set.workDay'), checked: rule.is_work_day });
    const fCheck = switchControl({ label: t('set.checkInEnabled'), checked: rule.check_in_enabled });
    const fPts = switchControl({ label: t('set.pointsEnabled'), checked: rule.points_enabled });
    const list = h('div', { class: 'stack stack--sm' });
    const addRow = (w = { label_ar: '', label_en: '', start_time: '', end_time: '', enabled: true, awards_green_point: true }) => {
      const r = h('div', { class: 'window-row' },
        input({ label: t('hol.nameAr'), value: w.label_ar, attrs: { lang: 'ar', dir: 'rtl', maxlength: '40', 'data-k': 'label_ar' } }),
        input({ label: t('hol.nameEn'), value: w.label_en, attrs: { lang: 'en', dir: 'ltr', maxlength: '40', 'data-k': 'label_en' } }),
        input({ label: t('common.from'), type: 'time', value: hhmm(w.start_time), attrs: { dir: 'ltr', 'data-k': 'start' } }),
        input({ label: t('common.to'), type: 'time', value: hhmm(w.end_time), attrs: { dir: 'ltr', 'data-k': 'end' } }),
        switchControl({ label: t('common.enabled'), checked: w.enabled }),
        switchControl({ label: t('set.greenAward'), checked: w.awards_green_point }),
        button({ label: t('common.close'), variant: 'ghost', size: 'sm', icon: 'x', iconOnly: true, onClick: () => r.remove() }));
      list.append(r);
    };
    windows.filter((w) => w.day_of_week === dow).forEach(addRow);
    const saveBtn = button({ label: t('set.saveDay'), variant: 'primary', size: 'sm', onClick: async () => {
      const ws = [...list.querySelectorAll('.window-row')].map((r) => {
        const get = (k) => r.querySelector(`[data-k="${k}"]`).value.trim();
        const sw = r.querySelectorAll('.switch__input');
        return { label_ar: get('label_ar'), label_en: get('label_en'), start: get('start'), end: get('end'), enabled: sw[0].checked, awards_green_point: sw[1].checked };
      });
      setLoading(saveBtn, true);
      try {
        await api('save_day', { day_of_week: dow, is_work_day: chk(fWork), check_in_enabled: chk(fCheck), points_enabled: chk(fPts), windows: ws });
        toast({ title: t('set.saved'), tone: 'success' }); await load();
      } catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(saveBtn, false); }
    } });
    const hasWin = windows.some((w) => w.day_of_week === dow && w.enabled);
    return h('details', { class: 'day-editor', open: dow === 0 ? true : null },
      h('summary', {}, h('strong', {}, t(`dow.${dow}`)), ' ',
        h('span', { class: 'text-sm text-muted' }, rule.is_work_day ? windows.filter((w) => w.day_of_week === dow && w.enabled).map((w) => `${getLang() === 'ar' ? w.label_ar : w.label_en} ${formatClock(w.start_time)}–${formatClock(w.end_time)}`).join(' · ') : t('home.dayOff'))),
      h('div', { class: 'stack' },
        h('div', { class: 'cluster' }, fWork, fCheck, fPts),
        rule.is_work_day && !hasWin ? alert(t('set.noWindows'), { tone: 'warning' }) : null,
        list,
        h('div', { class: 'cluster' }, button({ label: t('set.addWindow'), size: 'sm', icon: 'plus', onClick: () => addRow() }), saveBtn)));
  }

  load().catch((err) => fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true })));
}
