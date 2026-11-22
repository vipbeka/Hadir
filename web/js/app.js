// Zintra حاضر — app entry.
// Step 1: login screen + the two separate shells (staff, owner) with
// preview content. Step 2 adds the Supabase session, role routing and
// guards (staff can never land on /owner/*).
import { initI18n, onLangChange, t } from './core/i18n.js';
import { initTheme } from './core/theme.js';
import { route, fallback, startRouter, resolve, navigate, currentPath } from './core/router.js';
import { renderShell } from './shell/shell.js';
import { STAFF_NAV, OWNER_NAV } from './shell/nav.js';
import { renderLogin } from './pages/login.js';
import { renderPlaceholder } from './pages/placeholder.js';

const root = document.getElementById('app');

// Preview identities (illustrative only; replaced by the real profile in Step 2)
const PREVIEW_USERS = {
  staff: { name: 'Ahmed Ali', roleKey: 'role.staff' },
  owner: { name: 'Zintra Owner', roleKey: 'role.owner' },
};

function mountTree(nav, user) {
  nav.forEach((item, idx) => {
    route(item.path, (path) => {
      const { main } = renderShell(root, { nav, currentPath: path, user, onSignOut: () => navigate('/login') });
      renderPlaceholder(main, { item, user, isHome: idx === 0 });
      window.scrollTo(0, 0);
    });
  });
}

async function boot() {
  initTheme();
  await initI18n();
  route('/login', () => renderLogin(root));
  mountTree(STAFF_NAV, PREVIEW_USERS.staff);
  mountTree(OWNER_NAV, PREVIEW_USERS.owner);
  fallback(() => navigate('/login', { replace: true }));
  onLangChange(() => {
    const path = currentPath();
    resolve();
    // keep keyboard users on the language switcher after re-render
    const sw = document.querySelector(`.segmented__btn[lang="${document.documentElement.lang}"]`);
    if (sw && path) sw.focus({ preventScroll: true });
  });
  startRouter();
}

boot().catch((err) => {
  console.error(err);
  root.textContent = t?.('error.text') || 'Something went wrong.';
});
