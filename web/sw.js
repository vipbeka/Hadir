/*
 * حاضر (Hadir) — service worker
 * - Precaches the app shell so the installed app opens instantly.
 * - Static assets: stale-while-revalidate (fast, refreshed in background).
 * - Navigations: network-first, falling back to the cached shell, then
 *   to offline.html.
 * - NEVER touches Supabase/API requests (cross-origin): attendance,
 *   points and auth always go to the server live.
 * - Web Push handlers are added in Step 5 (shift reminders).
 * Bump VERSION on every deploy that changes shell files.
 */
const VERSION = 'zh-v16';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const PRECACHE = [
  './', './index.html', './offline.html', './manifest.webmanifest', './favicon.ico',
  './css/tokens.css', './css/base.css', './css/components.css', './css/shell.css', './css/pages.css', './css/watch.css',
  './js/boot.js', './js/app.js', './js/config.js',
  './js/core/api.js', './js/core/auth.js', './js/core/owner-live.js', './js/core/dom.js', './js/core/errors.js', './js/core/format.js',
  './js/core/i18n.js', './js/core/pwa.js', './js/core/push.js', './js/core/router.js', './js/core/storage.js', './js/core/supabase.js', './js/core/theme.js',
  './js/ui/brand.js', './js/ui/button.js', './js/ui/code-dialog.js', './js/ui/display.js', './js/ui/field.js',
  './js/ui/icons.js', './js/ui/install.js', './js/ui/modal.js', './js/ui/prefs.js', './js/ui/push-card.js', './js/ui/toast.js', './js/ui/watch.js',
  './js/shell/nav.js', './js/shell/shell.js',
  './js/pages/account.js', './js/pages/login.js', './js/pages/placeholder.js', './js/pages/leaderboard.js',
  './js/pages/staff/home.js', './js/pages/staff/attendance.js', './js/pages/staff/points.js', './js/pages/staff/requests.js', './js/pages/staff/statement.js', './js/ui/change-log.js',
  './js/pages/owner/employees.js', './js/pages/owner/dashboard.js', './js/pages/owner/approvals.js', './js/pages/owner/payroll.js', './js/pages/owner/payroll-export.js',
  './js/pages/owner/holidays.js', './js/pages/owner/settings.js', './js/pages/announcements.js',
  './js/pages/owner/docs.js', './js/pages/owner/payslip.js', './js/pages/owner/employee.js', './js/pages/owner/pay-actions.js', './js/pages/owner/delete-employee.js',
  './js/pages/owner/notifications.js', './js/pages/owner/owner-alerts.js', './js/pages/owner/employee-tools.js', './js/pages/owner/staff-tools.js',
  './vendor/leaflet-1.9.4/leaflet.js', './vendor/leaflet-1.9.4/leaflet.css',
  './i18n/ar.json', './i18n/en.json',
  './vendor/supabase-js-2.119.2/supabase.js',
  './assets/brand/logo-mark.png',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/apple-touch-icon.png',
  './assets/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2', './assets/fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2',
  './assets/fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2', './assets/fonts/ibm-plex-sans-arabic-latin-400-normal.woff2',
  './assets/fonts/ibm-plex-sans-arabic-latin-600-normal.woff2', './assets/fonts/ibm-plex-sans-arabic-latin-700-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)));
  // Do not skipWaiting automatically: the page shows "update available"
  // and activates the new version when the user agrees (no mid-task reload).
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ---------- Web Push: shift / missed check-in / decision notifications ----------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = (data.title || 'حاضر').replace(/^Zintra\s+/, '');
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    lang: data.lang || 'ar',
    dir: data.lang === 'en' ? 'ltr' : 'rtl',
    icon: './assets/icons/icon-192.png',
    badge: './assets/icons/favicon-32.png',
    tag: data.tag || data.kind || 'zintra',
    renotify: true,
    // owner notifications carry their own in-app link (same origin only)
    data: { url: typeof data.url === 'string' && data.url.startsWith('./index.html#/') ? data.url
      : data.kind === 'early_leave_decision' ? './index.html#/staff/requests' : './index.html#/staff/attendance' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './index.html', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.navigate(target).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(target);
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API/tiles: straight to network

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // only a real app-shell page refreshes the cached shell (never a 404 page)
        const p = url.pathname.replace(/\/+$/, '/');
        if (fresh.ok && (p.endsWith('/') || p.endsWith('/index.html'))) {
          (await caches.open(SHELL)).put('./index.html', fresh.clone());
        }
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./offline.html'));
      }
    })());
    return;
  }

  // static assets: stale-while-revalidate
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async (res) => {
      if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone());
      return res;
    }).catch(() => undefined);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});
