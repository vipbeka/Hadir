/*
 * Zintra حاضر — service worker
 * - Precaches the app shell so the installed app opens instantly.
 * - Static assets: stale-while-revalidate (fast, refreshed in background).
 * - Navigations: network-first, falling back to the cached shell, then
 *   to offline.html.
 * - NEVER touches Supabase/API requests (cross-origin): attendance,
 *   points and auth always go to the server live.
 * - Web Push handlers are added in Step 5 (shift reminders).
 * Bump VERSION on every deploy that changes shell files.
 */
const VERSION = 'zh-v1';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const PRECACHE = [
  './', './index.html', './offline.html', './manifest.webmanifest', './favicon.ico',
  './css/tokens.css', './css/base.css', './css/components.css', './css/shell.css',
  './js/boot.js', './js/app.js', './js/config.js',
  './js/core/api.js', './js/core/auth.js', './js/core/dom.js', './js/core/errors.js', './js/core/format.js',
  './js/core/i18n.js', './js/core/pwa.js', './js/core/router.js', './js/core/storage.js', './js/core/supabase.js', './js/core/theme.js',
  './js/ui/brand.js', './js/ui/button.js', './js/ui/code-dialog.js', './js/ui/display.js', './js/ui/field.js',
  './js/ui/icons.js', './js/ui/install.js', './js/ui/modal.js', './js/ui/prefs.js', './js/ui/toast.js',
  './js/shell/nav.js', './js/shell/shell.js',
  './js/pages/account.js', './js/pages/login.js', './js/pages/placeholder.js', './js/pages/owner/employees.js',
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API/tiles: straight to network

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put('./index.html', fresh.clone());
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
