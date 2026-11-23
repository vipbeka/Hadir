// «الإعلانات» — the same shared watch as the staff home hero, plus the list.
// Staff: read-only (RLS: what they may read). Owner: create + «حذف الإعلان»
// through the api function (owner-checked on the server). The Telegram bot
// acts on the same records; every change refreshes every watch and list.
import { h, add, fill } from '../core/dom.js';
import { t, setDocumentTitle } from '../core/i18n.js';
import { api } from '../core/api.js';
import { sb } from '../core/supabase.js';
import { errorMessage } from '../core/errors.js';
import { formatDateTime } from '../core/format.js';
import { pageHeader } from '../shell/shell.js';
import { card, alert, emptyState, skeletonCard } from '../ui/display.js';
import { button, setLoading } from '../ui/button.js';
import { input, textarea, setFieldError } from '../ui/field.js';
import { modal } from '../ui/modal.js';
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

  function compose() {
    const fTitle = input({ label: t('ann.fTitle'), hint: t('ann.fTitleHint'), attrs: { maxlength: '120', lang: 'ar', dir: 'auto' } });
    const fBody = textarea({ label: t('ann.fBody'), rows: 5, required: true, attrs: { maxlength: '1000', lang: 'ar', dir: 'auto' } });
    const send = button({ label: t('ann.send'), variant: 'primary', icon: 'bell', onClick: async () => {
      const title = fTitle.querySelector('input').value.trim(); const text = fBody.querySelector('textarea').value.trim();
      if (!text) { setFieldError(fBody, t('ann.bodyRequired')); return; }
      setFieldError(fBody, null); setLoading(send, true);
      try {
        const r = await api('broadcast', { title: title || undefined, text });
        m.close(); toast({ title: t('ann.sent', { n: r?.people ?? 0 }), tone: 'success' });
        invalidateAnnouncements(); load();
      } catch (e) { setLoading(send, false); setFieldError(fBody, errorMessage(e)); }
    } });
    const m = modal({ title: t('ann.new'), body: [fTitle, fBody, h('p', { class: 'text-sm text-muted' }, t('ann.sendNote'))],
      actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), send] });
    m.open();
  }

  autoReload(load, registerCleanup);
  load();
}
