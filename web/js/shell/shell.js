// App shell: sidebar (desktop) / top bar + bottom bar + drawer (mobile).
// Staff and owner each get their OWN nav tree and shell instance; there
// is no role switch anywhere. The shell renders chrome only — pages
// render into the returned `main` element.
import { h, clear } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { icon } from '../ui/icons.js';
import { button } from '../ui/button.js';
import { wordmark } from '../ui/brand.js';
import { langSwitcher, themeToggle } from '../ui/prefs.js';
import { installButton } from '../ui/install.js';
import { bindBadge } from '../core/owner-live.js';

function navLink(item, currentPath, cls, { labelKey, iconName } = {}) {
  const active = currentPath.split('?')[0] === item.path;
  return h('a', {
    class: cls,
    href: `#${item.path}`,
    'aria-current': active ? 'page' : null,
  }, h('span', { class: `${cls}-icon` }, icon(iconName || item.icon)), h('span', {}, t(labelKey || item.labelKey)),
  item.count ? h('span', { class: 'badge badge--accent nav__count num' }, String(item.count)) : null);
}

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

/**
 * renderShell(root, { nav: [{ path, labelKey, icon, bottom }], currentPath, user: { name, roleKey }, onSignOut })
 * One layout on every screen size (as in the reference design): a slim
 * top bar (logo + «حاضر», hamburger), a centred content column and a
 * floating bottom tab bar. The hamburger opens a side panel listing every
 * screen. Returns { main } — the element pages render into.
 */
export function renderShell(root, { nav, currentPath, user, onSignOut, role }) {
  clear(root);
  document.body.classList.add('has-bottombar');
  document.body.dataset.role = role || (nav[0].path.startsWith('/owner') ? 'owner' : 'staff');

  const userChip = user ? h('div', { class: 'user-chip' },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(user.name)),
    h('div', { style: { 'min-inline-size': '0' } },
      h('p', { class: 'user-chip__name' }, user.name),
      h('p', { class: 'user-chip__role' }, t(user.roleKey)))) : null;

  // ----- side panel (hamburger): every screen + preferences -----
  const drawerSignOut = button({ label: t('common.signOut'), variant: 'secondary', icon: 'logOut', block: true, onClick: onSignOut });
  drawerSignOut.querySelector('.icon')?.classList.add('icon--flip');
  const drawer = h('dialog', { class: 'drawer', 'aria-label': t('common.menu') },
    h('div', { class: 'drawer__header' }, wordmark(),
      button({ label: t('common.close'), variant: 'ghost', icon: 'x', iconOnly: true, onClick: () => closeDrawer() })),
    h('div', { class: 'drawer__body' },
      userChip,
      h('nav', { class: 'nav', 'aria-label': t('nav.primary') }, nav.map((i) => navLink(i, currentPath, 'nav__link'))),
      h('div', { class: 'drawer__group' }, h('span', { class: 'drawer__label' }, t('lang.label')), langSwitcher()),
      h('div', { class: 'drawer__group' }, h('span', { class: 'drawer__label' }, t('theme.label')), themeToggle()),
      installButton({ variant: 'primary', block: true }),
      drawerSignOut));
  drawer.addEventListener('click', (e) => { if (e.target === drawer || e.target.closest('a')) closeDrawer(); });
  drawer.addEventListener('cancel', (e) => { e.preventDefault(); closeDrawer(); });
  function openDrawer() { drawer.showModal(); }
  function closeDrawer() {
    if (!drawer.open) return;
    drawer.classList.add('is-closing');
    let finished = false;
    const done = () => { if (finished) return; finished = true; drawer.classList.remove('is-closing'); if (drawer.open) drawer.close(); };
    const dur = (parseFloat(getComputedStyle(drawer).animationDuration) || 0) * 1000;
    if (dur > 0) { drawer.addEventListener('animationend', done, { once: true }); setTimeout(done, dur + 120); } else done();
  }

  // ----- top bar: logo + «حاضر» at the start, connection state, hamburger at the end -----
  const online = h('span', { class: 'conn', role: 'status' });
  const setOnline = () => {
    const on = navigator.onLine !== false;
    online.classList.toggle('conn--off', !on);
    online.replaceChildren(h('span', { class: 'conn__dot', 'aria-hidden': 'true' }), t(on ? 'shell.online' : 'shell.offline'));
  };
  setOnline();
  window.addEventListener('online', setOnline);
  window.addEventListener('offline', setOnline);
  // owner: notifications bell with the unread count (live, see owner-live.js)
  const isOwner = document.body.dataset.role === 'owner';
  const badge = isOwner ? h('span', { class: 'bell__badge num', 'aria-hidden': 'true', hidden: true }) : null;
  const bell = isOwner ? h('a', { class: 'btn btn--secondary btn--icon topbar__bell', href: '#/owner/notifications', 'aria-label': t('notif.bell'),
    'aria-current': currentPath.split('?')[0] === '/owner/notifications' ? 'page' : null }, icon('bell'), badge) : null;
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar__inner' },
      wordmark({ href: `#${nav[0].path}` }),
      online,
      h('div', { class: 'topbar__actions' }, bell,
        button({ label: t('common.menu'), variant: 'secondary', icon: 'menu', iconOnly: true, attrs: { class: 'topbar__menu' }, onClick: openDrawer }))));
  if (badge) bindBadge(badge);

  // ----- floating bottom bar (4 tabs; «المزيد» opens the panel if no 4th tab) -----
  const bottomItems = nav.filter((i) => i.bottom).slice(0, 4);
  const bottomPaths = new Set(bottomItems.map((i) => i.path));
  const here = currentPath.split('?')[0];
  const bottombar = h('nav', { class: 'bottombar', 'aria-label': t('nav.primary') },
    h('div', { class: 'bottombar__inner' },
      bottomItems.map((i) => navLink(i, currentPath, 'bottombar__link', { labelKey: i.bottomLabelKey, iconName: i.bottomIcon })),
      bottomItems.length < 4 ? h('button', {
        type: 'button', class: 'bottombar__link', onClick: openDrawer,
        'aria-current': !bottomPaths.has(here) ? 'page' : null, 'aria-haspopup': 'dialog',
      }, h('span', { class: 'bottombar__link-icon' }, icon('moreHorizontal')), h('span', {}, t('common.more'))) : null));

  const main = h('main', { class: 'main__inner', id: 'main', tabindex: '-1' });

  root.append(
    h('a', { class: 'skip-link', href: '#main', onClick: (e) => { e.preventDefault(); main.focus(); } }, t('common.skipToContent')),
    h('div', { class: 'app' }, topbar, h('div', { class: 'main' }, main), bottombar),
    drawer,
  );
  return { main };
}

/**
 * pageHeader({ eyebrow, chips, title, subtitle, actions, aside, iconName })
 * Gradient hero card. `chips` sit above the title; `aside` (or a frosted
 * `iconName` circle) sits at the inline end; `actions` wrap below.
 */
export function pageHeader({ eyebrow, chips, title, subtitle, actions, aside, iconName }) {
  const side = aside || (iconName ? h('span', { class: 'page-header__icon', 'aria-hidden': 'true' }, icon(iconName)) : null);
  return h('header', { class: ['page-header', actions && 'page-header--wrap'] },
    h('div', { class: 'page-header__main' },
      chips ? h('div', { class: 'page-header__chips' }, chips) : null,
      eyebrow ? h('p', { class: 'page-header__eyebrow' }, eyebrow) : null,
      h('h1', { class: 'page-header__title' }, title),
      subtitle ? h('p', { class: 'page-header__subtitle' }, subtitle) : null),
    side ? h('div', { class: 'page-header__aside' }, side) : null,
    actions ? h('div', { class: 'page-header__actions' }, actions) : null);
}
