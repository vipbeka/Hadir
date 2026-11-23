// Owner settings: every business rule, saved through the api function
// (validated + audited server-side; financial/hours edits bump the rule
// version and apply to future events only).
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { sb } from '../../core/supabase.js';
import { errorMessage } from '../../core/errors.js';
import { formatDateTime, formatClock, formatTime, hhmm } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, switchControl, setFieldError } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { icon } from '../../ui/icons.js';

export async function renderSettings(main) {
  setDocumentTitle(t('set.title'));
  add(main, pageHeader({ iconName: 'settings', title: t('set.title'), subtitle: t('set.subtitle') }));
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

  // One section saves ONLY its own keys and then refreshes `s` from the
  // returned row — it never re-renders the page, so unsaved edits in other
  // sections (and in the day editor) are kept.
  let versionAlert;
  async function save(btn, patch, okMsg = t('set.saved')) {
    const status = btn.closest('.card')?.querySelector('.save-status');
    if (status) { status.className = 'save-status text-sm'; status.textContent = ''; }
    setLoading(btn, true);
    try {
      const row = await api('update_settings', patch);
      if (row && typeof row === 'object') s = row;
      fill(versionAlert, versionLine());
      toast({ title: okMsg, tone: 'success' });
      if (status) { status.classList.add('save-status--ok'); status.textContent = t('set.savedAt', { time: formatTime(new Date()) }); }
    } catch (err) {
      toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' });
      if (status) { status.classList.add('save-status--err'); status.setAttribute('role', 'alert'); status.textContent = `${t('set.notSaved')} ${errorMessage(err)}`; }
    } finally { setLoading(btn, false); }
  }
  const versionLine = () => alert(t('set.version', { v: s.rule_version, at: formatDateTime(s.updated_at) }), { tone: 'info' });
  const need = (f, ok, msg = t('err.invalid_settings')) => { setFieldError(f, ok ? null : msg); return ok; };

  function section(title, iconName, fields, onSave, extra) {
    const btn = button({ label: t('common.save'), variant: 'primary' });
    btn.addEventListener('click', () => onSave(btn));
    return card({ title: h('span', { class: 'cluster cluster--sm' }, icon(iconName), title), body: [h('div', { class: 'form-grid' }, fields), extra || null],
      footer: [btn, h('p', { class: 'save-status text-sm', 'aria-live': 'polite' })] });
  }
  /** "12:00 م (بتوقيت القاهرة)" under a time input, live as it changes. */
  function clockHint(f) {
    const hint = h('p', { class: 'field__hint', dir: 'rtl' });
    const inp = f.querySelector('input');
    const upd = () => { hint.textContent = inp.value ? t('set.clockHint', { time: formatClock(inp.value) }) : t('set.timeRequired'); };
    inp.addEventListener('input', upd); upd(); f.append(hint); return f;
  }

  function render() {
    clear(body);
    versionAlert = h('div', {}, versionLine());
    add(body, versionAlert);

    // ---- money & points
    const fRed = num(t('set.redPenalty'), s.red_penalty_piastres / 100), fBlack = num(t('set.blackPenalty'), s.black_penalty_piastres / 100);
    const fTh = num(t('set.threshold'), s.green_reward_threshold), fRw = num(t('set.rewardAmount'), s.reward_amount_piastres / 100);
    const fWarn = switchControl({ label: t('set.firstRed'), checked: s.first_red_warning });
    add(body, section(t('set.money'), 'gift', [fRed, fBlack, fTh, fRw, fWarn], (btn) => {
      const egp = (f) => { const v = val(f); return /^\d{1,7}$/.test(v) ? Number(v) * 100 : NaN; };
      const patch = { red_penalty_piastres: egp(fRed), black_penalty_piastres: egp(fBlack), reward_amount_piastres: egp(fRw), green_reward_threshold: Number(val(fTh)), first_red_warning: chk(fWarn) };
      let bad = false;
      [[fRed, patch.red_penalty_piastres], [fBlack, patch.black_penalty_piastres], [fRw, patch.reward_amount_piastres]].forEach(([f, v]) => { const ok = Number.isFinite(v); setFieldError(f, ok ? null : t('err.invalid_amount')); bad ||= !ok; });
      const thOk = /^\d{1,4}$/.test(val(fTh)) && patch.green_reward_threshold >= 1 && patch.green_reward_threshold <= 1000;
      setFieldError(fTh, thOk ? null : t('err.invalid_settings')); bad ||= !thOk;
      if (!bad) save(btn, patch);
    }));

    // ---- working hours
    const fStart = clockHint(time(t('set.workStart'), s.work_start_time)), fEnd = clockHint(time(t('set.workEnd'), s.work_end_time));
    const fCut = clockHint(time(t('set.cutoff'), s.absence_cutoff));
    add(body, section(t('set.hours'), 'clock', [fStart, fEnd, fCut], (btn) => {
      const ok = [need(fStart, !!val(fStart), t('set.timeRequired')), need(fCut, !!val(fCut), t('set.timeRequired')),
        need(fEnd, !!val(fEnd) && val(fStart) < val(fEnd))].every(Boolean);
      if (ok) save(btn, { work_start_time: val(fStart), work_end_time: val(fEnd), absence_cutoff: val(fCut) });
    }, h('p', { class: 'text-sm text-muted' }, t('set.hoursNote'))));

    // ---- office geofence
    const fLat = input({ label: t('set.lat'), value: String(s.geofence_lat), attrs: { inputmode: 'decimal', dir: 'ltr' } });
    const fLng = input({ label: t('set.lng'), value: String(s.geofence_lng), attrs: { inputmode: 'decimal', dir: 'ltr' } });
    const fRad = num(t('set.radius'), s.geofence_radius_m);
    add(body, section(t('set.office'), 'mapPin', [fLat, fLng, fRad], (btn) => {
      // a blank field is NOT zero (Number('') === 0 would move the office to 0,0)
      const n = (f) => (/^-?\d{1,3}(\.\d{1,10})?$/.test(val(f)) ? Number(val(f)) : NaN);
      const lat = n(fLat), lng = n(fLng), r = /^\d{1,4}$/.test(val(fRad)) ? Number(val(fRad)) : NaN;
      const ok = [need(fLat, lat >= -90 && lat <= 90 && lat !== 0), need(fLng, lng >= -180 && lng <= 180 && lng !== 0), need(fRad, r >= 10 && r <= 5000)].every(Boolean);
      if (ok) save(btn, { geofence_lat: lat, geofence_lng: lng, geofence_radius_m: Math.round(r) });
    }));

    // ---- days & windows
    windowsSlot = h('div', {});
    add(body, windowsSlot);
    renderWindows();

    // ---- notifications (Telegram)
    const fChat = input({ label: t('set.chatId'), value: s.owner_telegram_chat_id, attrs: { dir: 'ltr', inputmode: 'numeric' } });
    const fChan = select({ label: t('set.channel'), options: [{ value: 'telegram', label: 'Telegram' }, { value: 'off', label: t('common.disabled') }], value: s.owner_alert_channel });
    const fDig = switchControl({ label: t('set.digest'), checked: s.digest_enabled }), fDigT = clockHint(time(t('set.digestTime'), s.digest_time));
    const fWk = switchControl({ label: t('set.weekly'), checked: s.weekly_summary_enabled });
    // always a real day (0–6). An empty stored value falls back to the last
    // work day — the same day the scheduler uses — and is saved explicitly.
    const lastWork = Math.max(...rules.filter((r) => r.is_work_day).map((r) => r.day_of_week), 0);
    const wkDow = Number.isInteger(s.weekly_summary_dow) && s.weekly_summary_dow >= 0 && s.weekly_summary_dow <= 6 ? s.weekly_summary_dow : lastWork;
    const fWkD = select({ label: t('set.weeklyDay'), value: String(wkDow), hint: t('set.weeklyDayHint', { day: t(`dow.${lastWork}`) }),
      options: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: String(d), label: t(`dow.${d}`) + (d === lastWork ? ` (${t('set.lastWorkDay')})` : '') })) });
    const fWkT = clockHint(time(t('set.weeklyTime'), s.weekly_summary_time));
    const tgStatus = h('p', { class: 'text-sm text-muted', role: 'status' });
    const tgBtn = (label, action) => { const b = button({ label, size: 'sm', icon: 'bell', onClick: async () => {
      setLoading(b, true);
      try { await api(action); toast({ title: t('set.tgOk'), tone: 'success' }); refreshTg(); }
      catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(b, false); }
    } }); return b; };
    const refreshTg = async () => { try { const r = await api('telegram_status'); tgStatus.textContent = r.token_missing ? t('err.telegram_token_missing') : t('set.tgStatus', { s: r.connected ? '✅' : '—' }); } catch (err) { tgStatus.textContent = errorMessage(err); } };
    add(body, section(t('set.notify'), 'bell', [fChat, fChan, fDig, fDigT, fWk, fWkD, fWkT], (btn) => {
      const dow = Number(val(fWkD));
      const ok = [need(fChat, /^-?\d{3,20}$/.test(val(fChat))), need(fDigT, !!val(fDigT), t('set.timeRequired')),
        need(fWkT, !!val(fWkT), t('set.timeRequired')), need(fWkD, val(fWkD) !== '' && Number.isInteger(dow) && dow >= 0 && dow <= 6)].every(Boolean);
      if (ok) save(btn, { owner_telegram_chat_id: val(fChat), owner_alert_channel: val(fChan), digest_enabled: chk(fDig), digest_time: val(fDigT),
        weekly_summary_enabled: chk(fWk), weekly_summary_dow: dow, weekly_summary_time: val(fWkT) });
    }, h('div', { class: 'cluster' }, tgBtn(t('set.tgConnect'), 'telegram_connect'), tgBtn(t('set.tgTest'), 'telegram_test'), tgStatus)));
    refreshTg();
    // persist a missing weekly day once (old rows stored NULL = "last work day")
    if (s.weekly_summary_dow == null) api('update_settings', { weekly_summary_dow: wkDow }).then((row) => { if (row) s = row; }).catch(() => {});

    // ---- reminders
    const fSh = switchControl({ label: t('set.shiftDefault'), checked: s.shift_reminders_default }), fLead = num(t('set.lead'), s.shift_reminder_lead_min);
    const fMs = switchControl({ label: t('set.missed'), checked: s.missed_checkin_reminder_enabled }), fMsL = num(t('set.missedLead'), s.missed_checkin_lead_min);
    add(body, section(t('set.reminders'), 'clock', [fSh, fLead, fMs, fMsL], (btn) => {
      const a = /^\d{1,3}$/.test(val(fLead)) ? Number(val(fLead)) : NaN, b = /^\d{1,3}$/.test(val(fMsL)) ? Number(val(fMsL)) : NaN;
      if (![need(fLead, a >= 1 && a <= 120), need(fMsL, b >= 1 && b <= 120)].every(Boolean)) return;
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

  // ---- days & windows: ONE atomic save for every day (all or nothing),
  // then a fresh read from the database re-renders only this card.
  let windowsSlot; let dirty = false; let dirtyBadge; let editors = [];
  const markDirty = () => { dirty = true; dirtyBadge.hidden = false; };
  const onLeave = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onLeave);
  window.addEventListener('hashchange', () => window.removeEventListener('beforeunload', onLeave), { once: true });

  function renderWindows() {
    dirty = false;
    dirtyBadge = h('span', { class: 'chip chip--warning', hidden: true, role: 'status' }, t('set.unsaved'));
    editors = rules.map(dayEditor);
    const saveAll = button({ label: t('set.saveAllDays'), variant: 'primary', icon: 'check' });
    const status = h('p', { class: 'save-status text-sm', 'aria-live': 'polite' });
    saveAll.addEventListener('click', async () => {
      status.className = 'save-status text-sm'; status.textContent = '';
      const days = []; let bad = false;
      for (const ed of editors) { const d = ed.collect(); if (!d) bad = true; else days.push(d); }
      if (bad) { status.classList.add('save-status--err'); status.setAttribute('role', 'alert'); status.textContent = t('set.fixWindows'); return; }
      setLoading(saveAll, true);
      try {
        await api('save_days', { days });
        // fresh read: what is shown is what the database holds
        const [b, c] = await Promise.all([sb.from('day_rules').select('*').order('day_of_week'), sb.from('check_in_windows').select('*').order('start_time')]);
        if (b.error || c.error) throw b.error || c.error;
        rules = b.data; windows = c.data;
        renderWindows();
        toast({ title: t('set.daysSaved'), tone: 'success' });
        const st = windowsSlot.querySelector('.save-status');
        if (st) { st.classList.add('save-status--ok'); st.textContent = t('set.savedAt', { time: formatTime(new Date()) }); }
      } catch (err) {
        toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' });
        status.classList.add('save-status--err'); status.setAttribute('role', 'alert');
        status.textContent = `${t('set.notSavedAll')} ${errorMessage(err)}`;
      } finally { setLoading(saveAll, false); }
    });
    const c = card({ title: h('span', { class: 'cluster cluster--sm' }, icon('calendar'), t('set.windows'), dirtyBadge),
      body: h('div', { class: 'stack' }, h('p', { class: 'text-sm text-muted' }, t('set.windowsNote')), editors.map((e) => e.el)),
      footer: [saveAll, status] });
    c.addEventListener('input', markDirty); c.addEventListener('change', markDirty);
    fill(windowsSlot, c);
  }

  function dayEditor(rule) {
    const dow = rule.day_of_week;
    const fWork = switchControl({ label: t('set.workDay'), checked: rule.is_work_day });
    const fCheck = switchControl({ label: t('set.checkInEnabled'), checked: rule.check_in_enabled });
    const fPts = switchControl({ label: t('set.pointsEnabled'), checked: rule.points_enabled });
    const list = h('div', { class: 'stack stack--sm' });
    const addRow = (w = { label_ar: '', label_en: '', start_time: '', end_time: '', enabled: true, awards_green_point: true, awards_red_point: false }) => {
      // green and red are exclusive: turning one on turns the other off
      const green = switchControl({ label: t('set.greenAward'), checked: !!w.awards_green_point });
      const red = switchControl({ label: t('set.redAward'), checked: !!w.awards_red_point });
      green.dataset.k = 'green'; red.dataset.k = 'red';
      const gi = green.querySelector('input'), ri = red.querySelector('input');
      gi.addEventListener('change', () => { if (gi.checked) ri.checked = false; });
      ri.addEventListener('change', () => { if (ri.checked) gi.checked = false; });
      const en = switchControl({ label: t('common.enabled'), checked: w.enabled !== false }); en.dataset.k = 'enabled';
      const r = h('div', { class: 'window-row' },
        input({ label: t('hol.nameAr'), value: w.label_ar, attrs: { lang: 'ar', dir: 'rtl', maxlength: '40', 'data-k': 'label_ar' } }),
        input({ label: t('hol.nameEn'), value: w.label_en, attrs: { lang: 'en', dir: 'ltr', maxlength: '40', 'data-k': 'label_en' } }),
        input({ label: t('common.from'), type: 'time', value: hhmm(w.start_time), attrs: { dir: 'ltr', 'data-k': 'start' } }),
        input({ label: t('common.to'), type: 'time', value: hhmm(w.end_time), attrs: { dir: 'ltr', 'data-k': 'end' } }),
        en, green, red,
        button({ label: t('set.removeWindow'), variant: 'ghost', size: 'sm', icon: 'x', iconOnly: true, onClick: () => { r.remove(); markDirty(); } }));
      list.append(r);
    };
    windows.filter((w) => w.day_of_week === dow).forEach(addRow);
    const err = h('p', { class: 'field__error', role: 'alert', hidden: true });
    const collect = () => {
      err.hidden = true;
      const ws = [...list.querySelectorAll('.window-row')].map((r) => {
        const get = (k) => r.querySelector(`[data-k="${k}"]`).value.trim();
        const on = (k) => r.querySelector(`[data-k="${k}"] .switch__input`).checked;
        return { label_ar: get('label_ar'), label_en: get('label_en'), start: get('start'), end: get('end'),
          enabled: on('enabled'), awards_green_point: on('green'), awards_red_point: on('red') };
      });
      const bad = ws.find((w) => !w.label_ar || !w.label_en || !w.start || !w.end || w.start >= w.end);
      if (bad) { err.textContent = t('set.windowInvalid', { day: t(`dow.${dow}`) }); err.hidden = false; el.open = true; return null; }
      return { day_of_week: dow, is_work_day: chk(fWork), check_in_enabled: chk(fCheck), points_enabled: chk(fPts), windows: ws };
    };
    const hasWin = windows.some((w) => w.day_of_week === dow && w.enabled);
    const pointTag = (w) => (w.awards_green_point ? ` (${t('set.tagGreen')})` : w.awards_red_point ? ` (${t('set.tagRed')})` : '');
    const el = h('details', { class: 'day-editor', open: dow === 0 ? true : null },
      h('summary', {}, h('strong', {}, t(`dow.${dow}`)), ' ',
        h('span', { class: 'text-sm text-muted' }, rule.is_work_day ? windows.filter((w) => w.day_of_week === dow && w.enabled).map((w) => `${getLang() === 'ar' ? w.label_ar : w.label_en} ${formatClock(w.start_time)}–${formatClock(w.end_time)}${pointTag(w)}`).join(' · ') : t('home.dayOff'))),
      h('div', { class: 'stack' },
        h('div', { class: 'cluster' }, fWork, fCheck, fPts),
        rule.is_work_day && !hasWin ? alert(t('set.noWindows'), { tone: 'warning' }) : null,
        list, err,
        h('div', { class: 'cluster' }, button({ label: t('set.addWindow'), size: 'sm', icon: 'plus', onClick: () => { addRow(); markDirty(); } }))));
    return { el, collect };
  }

  load().catch((err) => fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true })));
}
