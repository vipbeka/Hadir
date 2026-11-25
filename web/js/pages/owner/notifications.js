// Owner notifications (#/owner/notifications[?id=N]): newest first, read /
// unread, filters by type, "mark all as read", live rows (Realtime). The
// rows are written server-side by the same code that sends the Telegram
// message and the device push (owner only, RLS). Opening one marks it read
// and goes to the employee record or to the approvals screen.
import { h, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { sb } from '../../core/supabase.js';
import { navigate } from '../../core/router.js';
import { errorMessage } from '../../core/errors.js';
import { formatDateTime } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { toast } from '../../ui/toast.js';
import { icon } from '../../ui/icons.js';
import { onLive, refreshUnread, setUnread, unreadCount } from '../../core/owner-live.js';

const TYPES = ['all', 'unread', 'check_in', 'check_out', 'absence', 'request'];
const ICONS = { check_in: 'logIn', check_out: 'logOut', absence: 'alertTriangle', request: 'inbox', test: 'bell' };

export function relTime(iso, now = Date.now(), lang = getLang()) {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en', { numeric: 'auto' });
  const a = Math.abs(s);
  if (a < 45) return t('notif.justNow');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

export async function renderNotifications(main, { registerCleanup } = {}) {
  setDocumentTitle(t('notif.title'));
  const highlight = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('id')) || null;
  let filter = 'all'; let rows = [];
  const markAll = button({ label: t('notif.markAll'), size: 'sm', variant: 'secondary', icon: 'check', onClick: async () => {
    setLoading(markAll, true);
    const { error } = await sb.from('owner_notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
    setLoading(markAll, false);
    if (error) { toast({ title: t('error.title'), text: errorMessage(error), tone: 'danger' }); return; }
    rows.forEach((r) => { r.read_at ??= new Date().toISOString(); });
    setUnread(0); render();
  } });
  add(main, pageHeader({ iconName: 'bell', title: t('notif.title'), subtitle: t('notif.subtitle'), actions: markAll }));
  const filters = h('div', { class: 'segmented notif-filters', role: 'group', 'aria-label': t('notif.filter') });
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, filters, body);

  const paintFilters = () => fill(filters, ...TYPES.map((k) => h('button', { type: 'button', class: 'segmented__btn', 'aria-pressed': String(filter === k),
    onClick: () => { filter = k; paintFilters(); load(); } }, t(`notif.f.${k}`))));
  paintFilters();

  async function markRead(r) {
    if (r.read_at) return;
    r.read_at = new Date().toISOString();
    setUnread(unreadCount() - 1);
    const { error } = await sb.from('owner_notifications').update({ read_at: r.read_at }).eq('id', r.id);
    if (error) refreshUnread().catch(() => {});
  }

  function item(r) {
    const el = h('button', { type: 'button', class: ['notif', !r.read_at && 'notif--unread', r.id === highlight && 'notif--hl'], 'data-id': String(r.id),
      onClick: async () => { await markRead(r); if (r.link && r.link.startsWith('#/owner/')) navigate(r.link.slice(1)); else render(); } },
      h('span', { class: `notif__icon notif__icon--${r.type}`, 'aria-hidden': 'true' }, icon(ICONS[r.type] || 'bell')),
      h('span', { class: 'notif__main' },
        h('span', { class: 'notif__head' },
          h('span', { class: 'notif__title' }, r.title_ar),
          h('span', { class: 'notif__time', title: formatDateTime(r.event_at) },
            relTime(r.created_at), ' · ', h('bdi', {}, formatDateTime(r.event_at)))),
        h('span', { class: 'notif__body', lang: 'ar', dir: 'rtl' }, r.body_ar),
        !r.read_at ? h('span', { class: 'visually-hidden' }, t('notif.unread')) : null),
      !r.read_at ? h('span', { class: 'notif__dot', 'aria-hidden': 'true' }) : null);
    return h('li', {}, el);
  }

  function render() {
    const shown = rows.filter((r) => (filter === 'all' ? true : filter === 'unread' ? !r.read_at : r.type === filter));
    if (!shown.length) { fill(body, emptyState({ iconName: 'bell', title: t('notif.empty'), text: t('notif.emptyText') })); return; }
    fill(body, h('ul', { class: 'notif-list' }, shown.map(item)));
  }

  async function load() {
    let q = sb.from('owner_notifications').select('id,type,event,employee_id,title_ar,body_ar,link,flags,event_at,created_at,read_at')
      .order('created_at', { ascending: false }).limit(200);
    if (filter === 'unread') q = q.is('read_at', null);
    else if (filter !== 'all') q = q.eq('type', filter);
    const { data, error } = await q;
    if (error) { fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(error), error: true })); return; }
    rows = data || [];
    render();
    // opened from a push / toast: that one is read now
    const hl = highlight && rows.find((r) => r.id === highlight);
    if (hl && !hl.read_at) { await markRead(hl); render(); }
    if (hl) body.querySelector(`[data-id="${highlight}"]`)?.scrollIntoView({ block: 'center' });
  }
  await load();
  refreshUnread().catch(() => {});
  const off = onLive((row) => {
    if (filter !== 'all' && filter !== 'unread' && filter !== row.type) return;
    if (rows.some((r) => r.id === row.id)) return;
    rows.unshift(row); render();
  });
  registerCleanup?.(off);
}
