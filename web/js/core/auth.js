// Code-only sign-in, session state and sign-out.
// The code is sent once to the `login` Edge Function and never stored.
// The returned Supabase session is installed with setSession() and then
// persisted/refreshed by supabase-js.
import { sb } from './supabase.js';
import { callFunction } from './api.js';
import { store } from './storage.js';

function deviceId() {
  // Random per-browser identifier used only for brute-force rate limiting
  // (stored server-side as an HMAC). Not a secret, not a tracker.
  let id = store.get('zh.device');
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = crypto.randomUUID();
    store.set('zh.device', id);
  }
  return id;
}

export async function signInWithCode(code) {
  const res = await callFunction('login', { code, device_id: deviceId() }, { auth: false });
  const { error } = await sb.auth.setSession({ access_token: res.access_token, refresh_token: res.refresh_token });
  if (error) throw error;
  return res.role;
}

/** Current person, or null. Reads the profile through RLS, which also
 *  proves the session is still valid server-side (revoked/deactivated → null). */
export async function currentPerson() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  const uid = data.session.user.id;
  const { data: profile, error } = await sb.from('profiles')
    .select('id, full_name_ar, full_name_en, phone, role, active')
    .eq('id', uid).maybeSingle();
  if (error && (error.code === 'PGRST301' || /JWT|token/i.test(error.message))) return null;
  if (error) throw error;
  if (!profile) return null;
  return { ...profile, sessionUserId: uid };
}

export async function signOut() {
  // scope 'local': ends THIS device's session server-side and clears storage.
  try { await sb.auth.signOut({ scope: 'local' }); } catch { /* offline: still clear locally */ }
  try { localStorage.removeItem('zh.auth'); } catch { /* ignore */ }
}

export const onAuthChange = (fn) => sb.auth.onAuthStateChange((event, session) => fn(event, session));
