// Web Push subscription (staff shift reminders, owner live alerts). The browser only
// registers ITS OWN device subscription (RLS: own rows). Sending happens
// server-side (dispatch Edge Function) so reminders arrive with the app
// and browser closed. Never prompts for permission on page load.
import { sb } from './supabase.js';

export const VAPID_PUBLIC_KEY = 'BJdxi4j88AWz8iLPe8B5nKb-hdS_JKx-0g18Ool3K9Xl6nWZLLf111k_eAaABlaVNrxvy-HnkKkr4TTBdIDczFo';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** Is this browser subscription saved for THIS person? (A browser shared by
 *  two accounts — e.g. the owner testing on a staff device — keeps one
 *  subscription; it only counts for the account it is registered to.) */
async function isMine(endpoint, employeeId) {
  if (!employeeId) return true;
  const { data, error } = await sb.from('push_subscriptions').select('id').eq('endpoint', endpoint).eq('employee_id', employeeId).eq('enabled', true).limit(1);
  return !error && !!data?.length;
}

/** 'unsupported' | 'denied' | 'enabled' | 'off' (for the signed-in person when employeeId is given) */
export async function pushStatus(employeeId) {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return 'off';
    return (await isMine(sub.endpoint, employeeId)) ? 'enabled' : 'off';
  } catch { return 'off'; }
}

export async function enablePush(employeeId) {
  if (!supported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // registered to another account on this browser → start a fresh one for this person
  if (sub && !(await isMine(sub.endpoint, employeeId))) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  const ua = navigator.userAgent;
  const label = `${/iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : 'Device'}`;
  const { error } = await sb.from('push_subscriptions').upsert({
    employee_id: employeeId, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth_key: j.keys.auth,
    device_label: label, enabled: true, disabled_at: null,
  }, { onConflict: 'endpoint' });
  if (error) throw error;
  return 'enabled';
}

/** Turn push off on THIS device only (browser subscription + its row). */
export async function disablePush() {
  if (!supported()) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return 'off';
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  const { error } = await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) throw error;
  return 'off';
}

/** iPhone/iPad Safari outside the installed Home Screen app (no Web Push there). */
export const iosNeedsInstall = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  && !(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);
