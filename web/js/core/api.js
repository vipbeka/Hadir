// Calls to Zintra حاضر Edge Functions. Errors come back as stable codes
// that the UI maps to localized messages (never raw server text).
import { FUNCTIONS_URL, SUPABASE_PUBLISHABLE_KEY } from '../config.js';
import { sb } from './supabase.js';

export class ApiError extends Error {
  constructor(code, status, extra = {}) { super(code); this.code = code; this.status = status; Object.assign(this, extra); }
}

// Every call is bounded: a hung connection must never leave the UI waiting
// forever. On timeout the caller gets ApiError('timeout') and decides how to
// recover (e.g. read the record back before retrying).
export const API_TIMEOUT_MS = 15000;

export async function callFunction(name, body = {}, { auth = true, timeoutMs = API_TIMEOUT_MS } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY };
  if (auth) {
    const { data } = await sb.auth.getSession();
    if (!data.session) throw new ApiError('unauthorized', 401);
    headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res; let json = {};
  try {
    res = await fetch(`${FUNCTIONS_URL}/${name}`, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store', signal: ctrl.signal });
    try { json = await res.json(); } catch { /* non-JSON */ }
  } catch (e) {
    if (e?.name === 'AbortError') throw new ApiError('timeout', 0);
    throw new ApiError(navigator.onLine ? 'network' : 'offline', 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ApiError(json.error || 'server_error', res.status, json);
  return json;
}

/** Call the `api` Edge Function: api('check_in', { lat, lng, accuracy }) → data */
export async function api(action, params = {}, opts = {}) {
  const res = await callFunction('api', { action, params }, opts);
  return res.data;
}
