// «الإعلانات» — the same shared watch as the staff home hero, plus the list.
// Staff: read-only (RLS: what they may read). Owner: create + «حذف الإعلان»
// through the api function (owner-checked on the server). The Telegram bot
// acts on the same records; every change refreshes every watch and list.
import { h, add, fill } from '../core/dom.js';
import { t, setDocumentTitle } from '../core/i18n.js';
import { api } from '../core/api.js';
import { sb } from '../core/supabase.js';
import { errorMessage } from '../core/errors.js';
import { formatDateTime, formatClock } from '../core/format.js';
import { pageHeader } from '../shell/shell.js';
import { card, alert, badge, emptyState, skeletonCard } from '../ui/display.js';
import { button, setLoading } from '../ui/button.js';
import { input, select, textarea, setFieldError } from '../ui/field.js';
import { modal, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { announcementWatch, invalidateAnnouncements, showAnnouncement } from '../ui/watch.js';

const preview = (a, n = 160) => { const s = a.body.replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

function item(a, actions) {
  return h('li', { class: 'ann-item', 'data-id': a.id },
    h('div', { class: 'ann-item__main' },
      a.title ? h('p', { class: 'ann-item__title' }, a.title) : null,
      h('p', { class: 'ann-item__body' }, preview(a)),
      h('p', { class: 'text-xs text-muted' }, formatDateTime(a.created_at))),
    h('div', { class: 'cluster cluster--sm ann-item__actions' },
      button({ label: t('ann.view'), size: 'sm', variant: 'ghost', onClick: () => showAnnouncement(a) }), actions || null));
}

function watchCard(registerCleanup) {
  return h('section', { class: 'card ann-watch' }, announcementWatch({ size: 'large', onSurface: true, registerCleanup }),
    h('p', { class: 'text-sm text-muted ann-watch__note' }, t('ann.watchNote')));
}

/** Re-load a list on focus and whenever announcements change (any tab / the bot via polling). */
function autoReload(load, registerCleanup) {
  const on = () => load();
  window.addEventListener('hadir:announcements-changed', on);
  window.addEventListener('focus', on);
  let bc = null; try { bc = new BroadcastChannel('hadir-announcements'); bc.onmessage = on; } catch { /* ignore */ }
  const poll = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
  registerCleanup?.(() => { window.removeEventListener('hadir:announcements-changed', on); window.removeEventListener('focus', on); clearInterval(poll); try { bc?.close(); } catch { /* ignore */ } });
}

// ------------------------------------------------------------------ staff
export async function renderStaffAnnouncements(main, { registerCleanup } = {}) {
  setDocumentTitle(t('ann.title'));
  add(main, pageHeader({ iconName: 'bell', title: t('ann.title'), subtitle: t('ann.subtitleStaff') }), watchCard(registerCleanup));
  const list = h('div', {}, skeletonCard(t('common.loading')));
  add(main, card({ title: t('ann.recent'), body: list }));
  async function load() {
    const { data, error } = await sb.from('announcements').select('id,title,body,created_at')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50);
    if (error) { fill(list, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(error), error: true, action: button({ label: t('common.retry'), onClick: load }) })); return; }
    fill(list, data.length ? h('ul', { class: 'ann-list', role: 'list' }, data.map((a) => item(a))) : emptyState({ iconName: 'bell', title: t('ann.none') }));
  }
  autoReload(load, registerCleanup);
  load();
}

// ------------------------------------------------------------------ owner
export async function renderOwnerAnnouncements(main, { registerCleanup } = {}) {
  setDocumentTitle(t('ann.title'));
  add(main, pageHeader({ iconName: 'bell', title: t('ann.title'), subtitle: t('ann.subtitleOwner'),
    actions: [button({ label: t('ann.new'), variant: 'primary', icon: 'plus', onClick: () => compose() })] }), watchCard(registerCleanup));
  const list = h('div', {}, skeletonCard(t('common.loading')));
  add(main, card({ title: t('ann.all'), body: list }));

  let loading = null;
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const r = await api('list_announcements', { limit: 100 });
        const rows = r?.rows || [];
        fill(list, rows.length ? h('ul', { class: 'ann-list', role: 'list' }, rows.map((a) => item(a,
          button({ label: t('ann.delete'), size: 'sm', variant: 'danger', icon: 'trash', onClick: () => confirmDelete(a) }))))
          : emptyState({ iconName: 'bell', title: t('ann.none') }));
      } catch (err) {
        fill(list, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true, action: button({ label: t('common.retry'), onClick: load }) }));
      } finally { loading = null; }
    })();
    return loading;
  }

  function confirmDelete(a) {
    let busy = false;
    const err = h('div', {});
    const del = button({ label: t('ann.delete'), variant: 'danger', icon: 'trash', onClick: async () => {
      if (busy) return;                   // double tap: one request only
      busy = true; setLoading(del, true); fill(err);
      try {
        const r = await api('delete_announcement', { id: a.id });
        m.close();
        toast({ title: r?.deleted ? t('ann.deleted') : t('ann.alreadyDeleted'), tone: r?.deleted ? 'success' : 'info' });
        invalidateAnnouncements(); await load();
      } catch (e) {
        busy = false; setLoading(del, false);
        fill(err, alert(errorMessage(e), { tone: 'danger' }));
      }
    } });
    const m = modal({ title: t('ann.deleteTitle'), size: 'sm',
      body: [h('blockquote', { class: 'ann-quote' }, a.title ? h('strong', {}, a.title, h('br')) : null, preview(a, 240)),
        h('p', { class: 'text-sm text-muted' }, t('ann.deleteNote')), err],
      actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), del] });
    m.open();
    // focus the safe action first; Escape / «إلغاء» close and return focus to the opener
    requestAnimationFrame(() => m.el?.querySelector('.modal__footer .btn')?.focus());
  }

  // ---- scheduled announcements (feature 5)
  const sched = h('div', {}, skeletonCard(t('common.loading')));
  add(main, card({ title: t('sa.title'), subtitle: t('sa.subtitle'), body: sched }));
  let status = null;
  const cairoNowPlus = (min) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + min * 60000)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  const localLabel = (v) => { if (!v) return ''; const [d, tm] = v.split('T'); const [y, mo, da] = d.split('-');
    return t('sa.whenLabel', { date: `${da}/${mo}/${y}`, time: formatClock(tm) }); };
  const delLabel = (m) => (m == null ? t('sa.delNone') : (DELS.find(([v]) => v === m)?.[1] || t('sa.delMin', { n: m })));
  const DELS = [[null, t('sa.delNone')], [60, t('sa.del1h')], [360, t('sa.del6h')], [1440, t('sa.del24h')], [2820, t('sa.del47h')], [4320, t('sa.del3d')], [10080, t('sa.del7d')]];
  const STATUS_TONE = { scheduled: 'info', sending: 'warning', published: 'success', failed: 'danger', canceled: 'neutral', uncertain: 'warning' };

  async function loadSched() {
    try {
      const [rows, st] = await Promise.all([api('sched_ann_list'), api('bot_reports_status').catch(() => null)]);
      status = st;
      fill(sched, rows.length ? h('ul', { class: 'ann-list', role: 'list' }, rows.map((x) => h('li', { class: 'ann-item', 'data-id': x.id },
        h('div', { class: 'ann-item__main' },
          h('div', { class: 'cluster cluster--sm' }, badge(t(`sa.st.${x.status}`), { tone: STATUS_TONE[x.status] || 'neutral', dot: true }),
            badge(t(x.destination === 'owner_telegram' ? 'sa.destTg' : 'sa.destApp'), { tone: 'accent' }),
            x.delete_status !== 'none' ? badge(t(`sa.del.${x.delete_status}`), { tone: x.delete_status === 'failed' ? 'danger' : 'neutral' }) : null),
          x.title ? h('p', { class: 'ann-item__title' }, x.title) : null,
          h('p', { class: 'ann-item__body' }, preview(x, 140)),
          h('p', { class: 'text-xs text-muted' }, localLabel(x.publish_local), ' · ', delLabel(x.delete_after_minutes),
            x.messages > 1 ? ` · ${t('sa.parts', { n: x.messages })}` : ''),
          x.last_error && ['failed', 'uncertain'].includes(x.status) || x.delete_status === 'failed'
            ? h('p', { class: 'text-xs save-status--err' }, t(x.status === 'uncertain' ? 'sa.uncertainNote' : 'sa.failNote'), ' ', h('bdi', { dir: 'ltr' }, x.last_error || '')) : null),
        x.status === 'scheduled' ? h('div', { class: 'cluster cluster--sm ann-item__actions' },
          button({ label: t('common.edit'), size: 'sm', variant: 'ghost', onClick: () => compose(x) }),
          button({ label: t('sa.cancel'), size: 'sm', variant: 'danger', onClick: () => cancelSched(x) })) : null)))
        : emptyState({ iconName: 'calendar', title: t('sa.none') }));
    } catch (err) {
      fill(sched, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true, action: button({ label: t('common.retry'), onClick: loadSched }) }));
    }
  }

  async function cancelSched(x) {
    const ok = await confirmDialog({ title: t('sa.cancelTitle'), text: t('sa.cancelText'), confirmLabel: t('sa.cancel'), variant: 'danger' });
    if (!ok) return;
    try { await api('sched_ann_cancel', { id: x.id }); toast({ title: t('sa.canceled'), tone: 'success' }); }
    catch (e) { toast({ title: t('error.title'), text: errorMessage(e), tone: 'danger' }); }
    loadSched();
  }

  function compose(edit = null) {
    const tgOk = !!status?.owner_chat_verified;
    const fTitle = input({ label: t('ann.fTitle'), hint: t('ann.fTitleHint'), value: edit?.title || '', attrs: { maxlength: '120', lang: 'ar', dir: 'auto' } });
    const fBody = textarea({ label: t('ann.fBody'), rows: 5, required: true, value: edit?.body || '', attrs: { maxlength: '4000', lang: 'ar', dir: 'auto' } });
    const fDest = select({ label: t('sa.dest'), value: edit?.destination || 'staff_app', options: [
      { value: 'staff_app', label: t('sa.destApp') },
      { value: 'owner_telegram', label: t('sa.destTg') + (tgOk ? '' : ` — ${t('sa.tgUnverified')}`) }] });
    if (!tgOk) fDest.querySelector('option[value="owner_telegram"]').disabled = true;
    const fWhen = select({ label: t('sa.when'), value: edit ? 'later' : 'now', options: [{ value: 'now', label: t('sa.now') }, { value: 'later', label: t('sa.later') }] });
    const fAt = input({ label: t('sa.at'), type: 'datetime-local', value: edit?.publish_local || cairoNowPlus(60), hint: t('sa.atHint'), attrs: { dir: 'ltr', min: cairoNowPlus(2) } });
    const fDel = select({ label: t('sa.delete'), value: edit?.delete_after_minutes == null ? '' : String(edit.delete_after_minutes),
      options: DELS.map(([v, l]) => ({ value: v == null ? '' : String(v), label: l })) });
    const prev = h('div', { class: 'ann-preview', 'aria-live': 'polite' });
    const v = (f) => f.querySelector('input,select,textarea').value.trim();
    const sync = () => {
      const tg = v(fDest) === 'owner_telegram'; const later = v(fWhen) === 'later';
      fAt.hidden = !later;
      fBody.querySelector('textarea').maxLength = tg ? 4000 : 1000;
      // Telegram: bots may delete their messages only within 48 h
      fDel.querySelectorAll('option').forEach((o) => { o.disabled = tg && Number(o.value) > 2820; });
      if (tg && Number(v(fDel)) > 2820) fDel.querySelector('select').value = '2820';
      const body = v(fBody); const n = tg ? Math.max(1, Math.ceil(body.length / 3400)) : 1;
      fill(prev, h('p', { class: 'text-xs text-muted' }, t('sa.preview')),
        h('blockquote', { class: 'ann-quote' }, v(fTitle) ? h('strong', {}, v(fTitle), h('br')) : null, body || '…'),
        h('p', { class: 'text-xs text-muted' }, later ? localLabel(v(fAt)) : t('sa.nowNote'), ' · ',
          t(tg ? 'sa.destTg' : 'sa.destApp'), ' · ', delLabel(v(fDel) === '' ? null : Number(v(fDel))), tg && n > 1 ? ` · ${t('sa.parts', { n })}` : ''));
    };
    [fTitle, fBody, fDest, fWhen, fAt, fDel].forEach((f) => { f.addEventListener('input', sync); f.addEventListener('change', sync); });
    sync();
    let send;
    const send0 = button({ label: edit ? t('common.save') : t('ann.send'), variant: 'primary', icon: 'bell', onClick: async () => {
      const title = v(fTitle); const text = v(fBody); const dest = v(fDest); const later = v(fWhen) === 'later'; const del = v(fDel);
      if (!text) { setFieldError(fBody, t('ann.bodyRequired')); return; }
      if (later && !v(fAt)) { setFieldError(fAt, t('set.timeRequired')); return; }
      setFieldError(fBody, null); setFieldError(fAt, null); setLoading(send, true);
      try {
        if (!edit && !later && dest === 'staff_app' && del === '') {
          const r = await api('broadcast', { title: title || undefined, text });
          toast({ title: t('ann.sent', { n: r?.people ?? 0 }), tone: 'success' });
          invalidateAnnouncements(); load();
        } else {
          await api('sched_ann_save', { id: edit?.id, title: title || undefined, body: text, destination: dest,
            publish_local: later ? v(fAt) : cairoNowPlus(2), delete_after_minutes: del === '' ? null : Number(del) });
          toast({ title: t(later ? 'sa.saved' : 'sa.savedSoon'), tone: 'success' });
          loadSched();
        }
        m.close();
      } catch (e) { setLoading(send, false); setFieldError(later ? fAt : fBody, errorMessage(e)); }
    } });
    send = send0;
    const relabel = () => { const l = send.querySelector('.btn__label'); if (l && !edit) l.textContent = t(v(fWhen) === 'later' || v(fDest) === 'owner_telegram' || v(fDel) !== '' ? 'sa.schedule' : 'ann.send'); };
    [fDest, fWhen, fDel].forEach((f) => f.addEventListener('change', relabel)); relabel();
    const m = modal({ title: edit ? t('sa.edit') : t('ann.new'), body: [fTitle, fBody, fDest, fWhen, fAt, fDel, prev, h('p', { class: 'text-sm text-muted' }, t('ann.sendNote'))],
      actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), send] });
    m.open();
  }

  loadSched();
  autoReload(() => { load(); loadSched(); }, registerCleanup);
  load();
}
