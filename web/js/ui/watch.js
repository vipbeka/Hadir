/*
 * From Uiverse.io by chase2k25 - https://uiverse.io/chase2k25/warm-chicken-23
 * MIT License, Copyright (c) chase2k25 (chandu.exe)
 *
 * حاضر (Hadir) watch: ONE component, two exclusive faces —
 *   • live Cairo time (12-hour, ص/م) with the Arabic weekday and date, or
 *   • the eligible announcement(s), which replace the large time.
 * Every watch on the page shares ONE ticker and ONE announcement state
 * (so the hero watch and the «الإعلانات» watch always agree). The state
 * refreshes every minute while visible, on focus/visibility, and at once
 * when this or another tab creates/deletes an announcement.
 * Eligibility (unchanged from the staff home): announcements from the last
 * 7 days the signed-in person may read (RLS). Order: newest first, id as
 * the tie-break. Text is always inserted as text (never as HTML).
 */
import { h } from '../core/dom.js';
import { t, getLang } from '../core/i18n.js';
import { sb } from '../core/supabase.js';
import { formatDateTime } from '../core/format.js';
import { icon } from './icons.js';
import { modal } from './modal.js';
import { button } from './button.js';

const TZ = 'Africa/Cairo';
const ELIGIBLE_DAYS = 7;
const POLL_MS = 60_000;
const CHANNEL = 'hadir-announcements';

// ------------------------------------------------------------ shared state
const S = { list: [], idx: 0, status: 'idle', fetchedAt: 0 };
const subs = new Set();
let tickTimer = null; let pollTimer = null; let lastMinute = ''; let inflight = null; let bc = null;

const emit = (kind) => subs.forEach((fn) => { try { fn(kind); } catch { /* one watch never breaks another */ } });

/** Cairo wall-clock parts for `d` (never a fixed offset; DST via Intl). */
export function cairoParts(d = new Date(), lang = getLang()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true, hourCycle: 'h12' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const ar = lang === 'ar';
  const loc = ar ? 'ar-EG-u-nu-latn' : 'en-GB';
  return {
    hm: `${Number(p.hour) || 12}:${p.minute}`,
    ampm: ar ? (p.dayPeriod === 'PM' ? 'م' : 'ص') : p.dayPeriod,
    weekday: new Intl.DateTimeFormat(ar ? 'ar-EG' : 'en-GB', { timeZone: TZ, weekday: 'long' }).format(d),
    date: new Intl.DateTimeFormat(loc, { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(d),
    key: `${p.hour}:${p.minute}${p.dayPeriod}`,
  };
}

function scheduleTick() {
  clearTimeout(tickTimer);
  if (!subs.size) return;
  const now = Date.now();
  tickTimer = setTimeout(() => {
    const k = cairoParts().key;
    if (k !== lastMinute) { lastMinute = k; emit('time'); }
    scheduleTick();
  }, 1000 - (now % 1000) + 5);   // align to the second; re-render only when the minute changes
}

/** Fetch the eligible announcements (shared by every watch). */
export function refreshAnnouncements() {
  if (inflight) return inflight;
  if (!S.list.length && S.status !== 'ok') { S.status = 'loading'; emit('data'); }
  const since = new Date(Date.now() - ELIGIBLE_DAYS * 864e5).toISOString();
  inflight = sb.from('announcements').select('id,title,body,created_at').gte('created_at', since)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(20)
    .then(({ data, error }) => {
      if (error) throw error;
      const keep = S.list[S.idx]?.id;
      S.list = (data || []).filter((a) => a && typeof a.body === 'string' && a.body.trim());
      const i = S.list.findIndex((a) => a.id === keep);
      S.idx = i >= 0 ? i : Math.min(S.idx, Math.max(0, S.list.length - 1));
      S.status = 'ok'; S.fetchedAt = Date.now();
    })
    .catch(() => { S.status = 'error'; })
    .finally(() => { inflight = null; emit('data'); });
  return inflight;
}

/** Call after creating/deleting an announcement: every watch + other tabs refresh. */
export function invalidateAnnouncements() {
  refreshAnnouncements();
  try { bc?.postMessage('changed'); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('hadir:announcements-changed'));
}

const onFocus = () => { lastMinute = ''; emit('time'); refreshAnnouncements(); };
const onVisible = () => { if (document.visibilityState === 'visible') onFocus(); };

function start() {
  lastMinute = cairoParts().key;
  scheduleTick();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshAnnouncements(); }, POLL_MS);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisible);
  try { bc = new BroadcastChannel(CHANNEL); bc.onmessage = () => refreshAnnouncements(); } catch { bc = null; }
  if (!S.fetchedAt || Date.now() - S.fetchedAt > 15_000) refreshAnnouncements();
}
function stop() {
  clearTimeout(tickTimer); clearInterval(pollTimer); tickTimer = null; pollTimer = null;
  window.removeEventListener('focus', onFocus);
  document.removeEventListener('visibilitychange', onVisible);
  try { bc?.close(); } catch { /* ignore */ } bc = null;
}
function subscribe(fn) { subs.add(fn); if (subs.size === 1) start(); return () => { subs.delete(fn); if (!subs.size) stop(); }; }

export const announcementState = () => ({ list: S.list.slice(), idx: S.idx, status: S.status });
function go(delta) {
  if (S.list.length < 2) return;
  S.idx = (S.idx + delta + S.list.length) % S.list.length;
  emit('nav');
}

/** Full announcement in a dialog («عرض الإعلان»). Escape closes; focus returns. */
export function showAnnouncement(a) {
  const m = modal({ title: a.title || t('ann.label'), size: 'sm',
    body: [h('p', { class: 'ann-full' }, a.body), h('p', { class: 'text-xs text-muted' }, formatDateTime(a.created_at))],
    actions: [button({ label: t('common.close'), variant: 'primary', onClick: () => m.close() })] });
  m.open();
}

// ------------------------------------------------------------ the component
/**
 * announcementWatch({ size: 'compact'|'large', onSurface, registerCleanup })
 * Returns the element. It unsubscribes itself when removed from the page.
 */
export function announcementWatch({ size = 'compact', onSurface = false, registerCleanup } = {}) {
  const compact = size === 'compact';
  const longAt = compact ? 70 : 260;

  const status = h('div', { class: 'hw__status', 'aria-hidden': 'true' });
  const wd = h('span', { class: 'hw__weekday' });
  const hm = h('span', { class: 'hw__hm' });
  const ap = h('span', { class: 'hw__ampm' });
  const dt = h('span', { class: 'hw__date' });
  const clockFace = h('div', { class: 'hw__face hw__face--clock' }, wd, h('bdi', { class: 'hw__time', dir: 'ltr' }, hm, ap), dt);

  const lbl = h('span', { class: 'hw__label' }, icon('bell', { size: 'sm' }), h('span', {}, t('ann.label')));
  const ttl = h('p', { class: 'hw__title' });
  const txt = h('p', { class: 'hw__text' });
  const more = h('button', { type: 'button', class: 'hw__more', onClick: () => { const a = S.list[S.idx]; if (a) showAnnouncement(a); } }, t('ann.view'));
  const annFace = h('div', { class: 'hw__face hw__face--ann', hidden: true }, lbl, ttl, txt, more);

  const prev = h('button', { type: 'button', class: 'hw__nav-btn hw__prev', 'aria-label': t('ann.prev'), onClick: () => go(-1) }, icon('chevronRight'));
  const next = h('button', { type: 'button', class: 'hw__nav-btn hw__next', 'aria-label': t('ann.next'), onClick: () => go(1) }, icon('chevronRight'));
  const count = h('span', { class: 'hw__count num', 'aria-live': 'polite' });
  const pager = h('div', { class: 'hw__pager', hidden: true }, prev, count, next);
  const retry = h('button', { type: 'button', class: 'hw__retry', hidden: true, onClick: () => refreshAnnouncements() }, t('ann.retry'));
  const live = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });

  const screen = h('div', { class: 'hw__screen' }, status, clockFace, annFace);
  const el = h('div', { class: ['hw', `hw--${size}`, onSurface && 'hw--on-surface'], role: 'group', 'aria-label': t('ann.watchLabel'), 'data-mode': 'clock' },
    h('div', { class: 'hw__body' },
      h('div', { class: 'hw__strap hw__strap--top', 'aria-hidden': 'true' }),
      h('div', { class: 'hw__strap hw__strap--bottom', 'aria-hidden': 'true' }),
      h('div', { class: 'hw__case' },
        h('div', { class: 'hw__crown-well', 'aria-hidden': 'true' }), h('div', { class: 'hw__crown', 'aria-hidden': 'true' }),
        h('div', { class: 'hw__side-well', 'aria-hidden': 'true' }), h('div', { class: 'hw__side', 'aria-hidden': 'true' }),
        h('div', { class: 'hw__action-well', 'aria-hidden': 'true' }), h('div', { class: 'hw__action', 'aria-hidden': 'true' }),
        screen)),
    pager, retry, live);

  let shownId = null; let mode = 'clock';
  function render(kind) {
    if (kind && !el.isConnected && mounted) { unsub(); return; }
    const c = cairoParts();
    const a = S.list[S.idx] || null;
    // clock face (also feeds the small status time while an announcement shows)
    wd.textContent = c.weekday; hm.textContent = c.hm; ap.textContent = c.ampm; dt.textContent = c.date;
    clockFace.setAttribute('aria-label', `${c.weekday} ${c.hm} ${c.ampm} ${c.date}`);
    const nextMode = a ? 'ann' : 'clock';
    status.textContent = a ? `${c.hm} ${c.ampm}` : '';
    if (a) {
      if (a.id !== shownId) {
        ttl.textContent = a.title || ''; ttl.hidden = !a.title;
        txt.textContent = a.body;
        more.hidden = (a.body.length + (a.title || '').length) <= longAt && !a.body.includes('\n');
        shownId = a.id;
        annFace.style.animation = 'none'; void annFace.offsetWidth; annFace.style.animation = '';
        live.textContent = `${t('ann.label')}: ${a.title ? `${a.title} — ` : ''}${a.body.slice(0, 140)}`;
      }
      count.textContent = t('ann.count', { i: S.idx + 1, n: S.list.length });
    } else shownId = null;
    if (nextMode !== mode) { mode = nextMode; el.dataset.mode = mode; }
    clockFace.hidden = mode !== 'clock'; annFace.hidden = mode !== 'ann';
    pager.hidden = S.list.length < 2;
    retry.hidden = S.status !== 'error';
  }
  let mounted = false;
  const unsub = subscribe(render);
  registerCleanup?.(unsub);
  render();
  queueMicrotask(() => { mounted = el.isConnected; });
  requestAnimationFrame(() => { mounted = true; if (!el.isConnected) unsub(); });
  return el;
}
