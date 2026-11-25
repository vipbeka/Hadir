/*
 * حاضر (Hadir) — boot (classic script, loaded synchronously in <head>).
 * Applies the stored language/direction and the resolved theme before
 * first paint so there is no flash of the wrong theme or direction.
 * Storage access is wrapped: private mode or blocked storage falls
 * back to the defaults (Arabic, follow the device theme).
 */
(function () {
  var root = document.documentElement;
  var lang = 'ar';
  var pref = 'system';
  try {
    var l = localStorage.getItem('zh.lang');
    if (l === 'ar' || l === 'en') lang = l;
    var t = localStorage.getItem('zh.theme');
    if (t === 'light' || t === 'dark' || t === 'system') pref = t;
  } catch (e) { /* storage unavailable: use defaults */ }
  root.lang = lang;
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
})();

/* Fixed scale like a native app. iOS Safari ignores user-scalable=no, so
 * its pinch gesture is blocked here; double-tap zoom is off via CSS
 * touch-action. The map is left alone: Leaflet zooms it itself. */
(function () {
  var onMap = function (e) { return e.target && e.target.closest && e.target.closest('.leaflet-container'); };
  var stop = function (e) { if (!onMap(e)) e.preventDefault(); };
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (n) { document.addEventListener(n, stop, { passive: false }); });
  document.addEventListener('touchmove', function (e) { if (e.touches && e.touches.length > 1 && !onMap(e)) e.preventDefault(); }, { passive: false });
})();
