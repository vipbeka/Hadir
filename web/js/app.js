// حاضر (Hadir) — app entry.
// Auth flow: persisted Supabase session → profile read through RLS →
// role-based routing into ONE of two separate experiences:
//   staff → /staff/* (staff shell),  owner → /owner/* (owner console).
// There is no role switch anywhere. The route guard only keeps people
// in their own tree; RLS and the Edge Functions are the real enforcers.
import { initI18n, onLangChange, t, setDocumentTitle } from './core/i18n.js';
import { h } from './core/dom.js';
import { button } from './ui/button.js';
import { emptyState } from './ui/display.js';
import { initTheme } from './core/theme.js';
import { route, fallback, startRouter, resolve, navigate, currentPath } from './core/router.js';
import { signInWithCode, currentPerson, signOut, onAuthChange } from './core/auth.js';
import { ApiError } from './core/api.js';
import { renderShell } from './shell/shell.js';
import { STAFF_NAV, OWNER_NAV, HOME } from './shell/nav.js';
import { renderLogin } from './pages/login.js';
import { renderPlaceholder } from './pages/placeholder.js';
import { renderAccount } from './pages/account.js';
import { renderEmployees } from './pages/owner/employees.js';
import { renderStaffHome } from './pages/staff/home.js';
import { renderAttendance } from './pages/staff/attendance.js';
import { renderStaffPoints } from './pages/staff/points.js';
import { renderStaffRequests } from './pages/staff/requests.js';
import { renderLeaderboard } from './pages/leaderboard.js';
import { renderOwnerDashboard } from './pages/owner/dashboard.js';
import { renderApprovals } from './pages/owner/approvals.js';
import { renderPayroll } from './pages/owner/payroll.js';
import { renderHolidays } from './pages/owner/holidays.js';
import { renderSettings } from './pages/owner/settings.js';
import { renderNotifications } from './pages/owner/notifications.js';
import { startOwnerLive, stopOwnerLive } from './core/owner-live.js';
import { renderStaffAnnouncements, renderOwnerAnnouncements } from './pages/announcements.js';
import { renderPayslip } from './pages/owner/payslip.js';
import { renderEmployee } from './pages/owner/employee.js';
import { displayName } from './core/format.js';
import { toast } from './ui/toast.js';
import { closeAllModals } from './ui/modal.js';
import { initPwa } from './core/pwa.js';
import { watchUpdates } from './ui/install.js';

const root = document.getElementById('app');
let me = null;          // current profile (null when signed out)
let loginNotice = null; // message to show on the login screen

const PAGES = {
  '/staff/home': renderStaffHome,
  '/staff/attendance': renderAttendance,
  '/staff/points': renderStaffPoints,
  '/staff/leaderboard': renderLeaderboard,
  '/staff/requests': renderStaffRequests,
  '/staff/announcements': renderStaffAnnouncements,
  '/staff/account': renderAccount,
  '/owner/dashboard': renderOwnerDashboard,
  '/owner/approvals': renderApprovals,
  '/owner/employees': renderEmployees,
  '/owner/leaderboard': renderLeaderboard,
  '/owner/announcements': renderOwnerAnnouncements,
  '/owner/payroll': renderPayroll,
  '/owner/holidays': renderHolidays,
  '/owner/settings': renderSettings,
  '/owner/notifications': renderNotifications,
  '/owner/account': renderAccount,
};

// Per-page cleanup (e.g. stop geolocation watching when leaving Attendance)
let cleanups = [];
const runCleanups = () => {
  closeAllModals();
  document.querySelectorAll('dialog.drawer[open]').forEach((d) => d.close());
  cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); cleanups = [];
};
const registerCleanup = (fn) => cleanups.push(fn);

async function doSignOut(notice = 'login.signedOut') {
  stopOwnerLive();
  await signOut();
  me = null;
  loginNotice = notice;
  navigate('/login', { replace: true });
}

function guard(path) {
  if (!me) return '/login';
  const tree = me.role === 'owner' ? '/owner/' : '/staff/';
  return path.split('?')[0].startsWith(tree) ? null : HOME[me.role];
}

function mountTree(nav) {
  nav.forEach((item, idx) => {
    route(item.path, (path) => {
      runCleanups();
      const redirect = guard(path);
      if (redirect) { navigate(redirect, { replace: true }); return; }
      const user = { name: displayName(me), roleKey: `role.${me.role}` };
      const { main } = renderShell(root, { nav, currentPath: path, user, onSignOut: () => doSignOut() });
      if (me.role === 'owner') startOwnerLive();
      const page = PAGES[path.split('?')[0]];
      if (page) page(main, { me, onSignOut: () => doSignOut(), registerCleanup });
      else renderPlaceholder(main, { item, user, isHome: idx === 0 });
      window.scrollTo(0, 0);
    });
  });
}

/** Arabic not-found state. Signed in: inside the shell (nav still works). */
function renderNotFound(path) {
  setDocumentTitle(t('nf.title'));
  const home = me ? HOME[me.role] : '/login';
  const action = h('div', { class: 'cluster' },
    button({ label: t(me ? 'nf.goHome' : 'nf.goLogin'), variant: 'primary', icon: me ? 'home' : 'logIn', onClick: () => navigate(home) }),
    history.length > 1 ? button({ label: t('nf.back'), variant: 'ghost', onClick: () => history.back() }) : null);
  const box = h('section', { class: 'card not-found', 'data-page': 'not-found' },
    emptyState({ iconName: 'compass', title: t('nf.title'),
      text: h('span', {}, t('nf.text'), ' ', h('bdi', { class: 'num', dir: 'ltr' }, `#${path}`.slice(0, 80))), action }));
  if (me) {
    const nav = me.role === 'owner' ? OWNER_NAV : STAFF_NAV;
    const { main } = renderShell(root, { nav, currentPath: path, user: { name: displayName(me), roleKey: `role.${me.role}` }, onSignOut: () => doSignOut() });
    main.append(box);
  } else {
    document.body.classList.remove('has-bottombar');
    root.replaceChildren(h('main', { id: 'main', class: 'standalone' }, box));
  }
  box.querySelector('.empty__title')?.setAttribute('tabindex', '-1');
  box.querySelector('.empty__title')?.focus({ preventScroll: true });
}

/** #/login while already signed in: say so, offer the dashboard (no silent redirect). */
function renderAlreadySignedIn() {
  setDocumentTitle(t('nf.signedInTitle'));
  const nav = me.role === 'owner' ? OWNER_NAV : STAFF_NAV;
  const { main } = renderShell(root, { nav, currentPath: '/login', user: { name: displayName(me), roleKey: `role.${me.role}` }, onSignOut: () => doSignOut() });
  main.append(h('section', { class: 'card not-found', 'data-page': 'already-signed-in' },
    emptyState({ iconName: 'checkCircle', title: t('nf.signedInTitle'), text: t('nf.signedInText', { name: displayName(me) }),
      action: h('div', { class: 'cluster' },
        button({ label: t(me.role === 'owner' ? 'nf.toDashboard' : 'nf.goHome'), variant: 'primary', icon: 'home', onClick: () => navigate(HOME[me.role]) }),
        button({ label: t('nf.signOut'), variant: 'ghost', onClick: () => doSignOut() })) })));
}

function loginErrorKey(err) {
  if (err instanceof ApiError) {
    if (err.code === 'locked_out') return ['login.errorLocked', { min: Math.max(1, Math.ceil((err.retry_after_s || 900) / 60)) }];
    if (err.code === 'network' || err.code === 'offline') return ['login.errorNetwork'];
  }
  return ['login.errorGeneric'];
}

async function boot() {
  initPwa();
  initTheme();
  await initI18n();

  route('/login', () => {
    runCleanups();
    if (me) { renderAlreadySignedIn(); return; }
    renderLogin(root, {
      notice: loginNotice ? t(loginNotice) : null,
      onSubmit: async (code) => {
        try {
          await signInWithCode(code);
          me = await currentPerson();
          if (!me) throw new ApiError('code_not_recognized', 401);
          loginNotice = null;
          navigate(HOME[me.role], { replace: true });
        } catch (err) {
          const [key, vars] = loginErrorKey(err);
          const e = new Error(key); e.messageKey = key; e.vars = vars; throw e;
        }
      },
    });
    loginNotice = null;
  });
  mountTree(STAFF_NAV);
  mountTree(OWNER_NAV);
  // owner detail pages (not in the menu; ?query = page state)
  for (const [path, page, parent] of [['/owner/payslip', renderPayslip, '/owner/payroll'], ['/owner/employee', renderEmployee, '/owner/employees']]) {
    route(path, (full) => {
      runCleanups();
      if (!me) { navigate('/login', { replace: true }); return; }
      if (me.role !== 'owner') { navigate(HOME[me.role], { replace: true }); return; }
      const { main } = renderShell(root, { nav: OWNER_NAV, currentPath: parent, user: { name: displayName(me), roleKey: `role.${me.role}` }, onSignOut: () => doSignOut() });
      page(main, { me, registerCleanup, path: full });
      window.scrollTo(0, 0);
    });
  }
  // Unknown hash routes show a real not-found state (with a way back),
  // never a silent redirect. "/" alone still opens the right home.
  fallback((path) => {
    runCleanups();
    if (path === '/' || path === '') { navigate(me ? HOME[me.role] : '/login', { replace: true }); return; }
    renderNotFound(path);
  });

  // Restore a persisted session (no code prompt on reopen).
  try { me = await currentPerson(); } catch { me = null; }
  if (!me) await signOut();

  // Server-side revocation/deactivation: refresh fails or RLS returns no
  // profile → back to the login screen with a calm message.
  onAuthChange(async (event) => {
    if (event === 'SIGNED_OUT' && me) { stopOwnerLive(); me = null; loginNotice = 'login.sessionEnded'; navigate('/login', { replace: true }); }
  });
  window.addEventListener('focus', async () => {
    if (!me) return;
    try {
      const still = await currentPerson();
      if (!still) await doSignOut('login.sessionEnded');
    } catch { /* offline: keep the UI, retry on next focus */ }
  });

  onLangChange(() => {
    resolve();
    document.querySelector(`.segmented__btn[lang="${document.documentElement.lang}"]`)?.focus({ preventScroll: true });
  });
  window.addEventListener('offline', () => toast({ title: t('status.offline'), tone: 'warning' }));
  if (!currentPath() || currentPath() === '/') navigate(me ? HOME[me.role] : '/login', { replace: true });
  watchUpdates();
  startRouter();
}

boot().catch((err) => {
  console.error(err);
  root.textContent = 'Something went wrong. / حدث خطأ.';
});
