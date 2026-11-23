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
