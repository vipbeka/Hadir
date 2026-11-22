// Calls to Zintra حاضر Edge Functions. Errors come back as stable codes
// that the UI maps to localized messages (never raw server text).
import { FUNCTIONS_URL, SUPABASE_PUBLISHABLE_KEY } from '../config.js';
import { sb } from './supabase.js';

export class ApiError extends Error {
  constructor(code, status, extra = {}) { super(code); this.code = code; this.status = status; Object.assign(this, extra); }
}

export async function callFunction(name, body = {}, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY };
  if (auth) {
    const { data } = await sb.auth.getSession();
    if (!data.session) throw new ApiError('unauthorized', 401);
    headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${name}`, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new ApiError(navigator.onLine ? 'network' : 'offline', 0);
  }
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(json.error || 'server_error', res.status, json);
  return json;
}

/** Call the `api` Edge Function: api('check_in', { lat, lng, accuracy }) → data */
export async function api(action, params = {}) {
  const res = await callFunction('api', { action, params });
  return res.data;
}
