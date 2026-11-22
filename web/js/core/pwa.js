// PWA plumbing: service-worker registration, update flow, and install
// state (Chrome/Edge/Android `beforeinstallprompt`; iOS manual steps).
const listeners = new Set();
let deferredPrompt = null;
let waitingWorker = null;

const emit = () => listeners.forEach((fn) => fn(state()));
export const onPwaChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
export function isIos() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
export function state() {
  return {
    installed: isStandalone(),
    canPrompt: !!deferredPrompt,
    iosManual: isIos() && !isStandalone(),
    updateReady: !!waitingWorker,
  };
}

export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  emit();
  return outcome;
}

export function applyUpdate() {
  if (!waitingWorker) return;
  waitingWorker.postMessage('SKIP_WAITING');
}

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();          // we show our own, calmer install UI
    deferredPrompt = e;
    emit();
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; emit(); });

  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url), { scope: new URL('../../', import.meta.url).pathname });
      const track = (w) => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) { waitingWorker = w; emit(); }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) { waitingWorker = reg.waiting; emit(); }
      track(reg.installing);
      reg.addEventListener('updatefound', () => track(reg.installing));
      // look for a new version when the app comes back to the foreground
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    } catch { /* SW unsupported or blocked: the app still works online */ }
  });
}
