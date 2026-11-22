// Safe localStorage wrapper: per-device conveniences only (language,
// theme, dismissed banners). Never store codes, tokens or user data here
// — the Supabase session is managed by supabase-js itself.
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};
