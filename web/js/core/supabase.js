// Single supabase-js client for the browser (publishable key only).
// The vendored UMD bundle (vendor/supabase-js-2.119.2) exposes `window.supabase`.
// Sessions persist (refresh token stored by supabase-js) and access
// tokens refresh silently, so reopening the app skips the code screen.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../config.js';

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'zh.auth',
  },
});
