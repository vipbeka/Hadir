// Owner live notifications (in-app): unread count for the header bell,
// Supabase Realtime subscription on owner_notifications (RLS: owner only)
// → a small toast + a soft sound + badge update without refreshing.
// A 60 s poll keeps the badge right if the live connection drops.
import { sb } from './supabase.js';
import { store } from './storage.js';
import { navigate } from './router.js';
import { t } from './i18n.js';
import { toast } from '../ui/toast.js';

let channel = null; let poll = 0; let unread = 0; let badgeEl = null;
const listeners = new Set();

export const soundOn = () => store.get('zh.notifySound', '1') === '1';
export const setSound = (on) => store.set('zh.notifySound', on ? '1' : '0');

function paintBadge() {
  if (!badgeEl) return;
  badgeEl.hidden = unread <= 0;
  badgeEl.textContent = unread > 99 ? '99+' : String(unread);
  badgeEl.closest('a')?.setAttribute('aria-label', unread > 0 ? t('notif.bellUnread', { n: unread }) : t('notif.bell'));
}
/** The header shell calls this every render with its badge element. */
export function bindBadge(el) { badgeEl = el; paintBadge(); }
export const unreadCount = () => unread;
export function setUnread(n) { unread = Math.max(0, n); paintBadge(); }
/** Pages listen for live rows (returns an unsubscribe). */
export function onLive(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function refreshUnread() {
  const { count, error } = await sb.from('owner_notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  if (!error && typeof count === 'number') setUnread(count);
}

// soft two-tone chime (Web Audio, no file); silently skipped if blocked
let audio;
export function chime() {
  if (!soundOn()) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    const now = audio.currentTime;
    [[880, 0], [1320, 0.12]].forEach(([f, at]) => {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + at); g.gain.exponentialRampToValueAtTime(0.08, now + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35);
      o.connect(g).connect(audio.destination); o.start(now + at); o.stop(now + at + 0.4);
    });
  } catch { /* no audio: fine */ }
}

function onInsert(row) {
  if (!row || row.read_at) return;
  setUnread(unread + 1);
  listeners.forEach((fn) => { try { fn(row); } catch { /* page gone */ } });
  if (!location.hash.startsWith('#/owner/notifications')) {
    toast({ title: row.title_ar, text: String(row.body_ar || '').split('\n')[0], tone: row.type === 'absence' ? 'warning' : 'info',
      duration: 7000, onOpen: () => navigate(`/owner/notifications?id=${row.id}`) });
  }
  chime();
}

export function startOwnerLive() {
  if (channel) return;
  refreshUnread().catch(() => {});
  try {
    channel = sb.channel('owner-notifications')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'owner_notifications' }, (p) => onInsert(p.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'owner_notifications' }, () => refreshUnread().catch(() => {}))
      .subscribe();
  } catch { channel = null; }
  poll = setInterval(() => refreshUnread().catch(() => {}), 60000);
}

export function stopOwnerLive() {
  clearInterval(poll); poll = 0;
  if (channel) { try { sb.removeChannel(channel); } catch { /* ignore */ } }
  channel = null; setUnread(0);
}
