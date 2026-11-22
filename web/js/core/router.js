// Minimal hash router. Routes map a path ("/staff/home") to a render
// function. Role guards are added in Step 2 (the database stays the
// enforcer; the guard only keeps people on their own route tree).
const routes = new Map();
let notFound = null;
let current = null;
const listeners = new Set();

export function route(path, handler) { routes.set(path, handler); }
export function fallback(handler) { notFound = handler; }
export const currentPath = () => (location.hash.replace(/^#/, '') || '/');
export function navigate(path, { replace = false } = {}) {
  const url = `#${path}`;
  if (replace) history.replaceState(null, '', url); else location.hash = path;
  if (replace) resolve();
}
export const onRoute = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function resolve() {
  const path = currentPath();
  const handler = routes.get(path) || notFound;
  current = path;
  listeners.forEach((fn) => fn(path));
  handler?.(path);
}

export function startRouter() {
  window.addEventListener('hashchange', resolve);
  resolve();
}

export const getCurrent = () => current;
