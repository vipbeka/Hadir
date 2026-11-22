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

const BOTTOM_MAX = 4; // first 4 items in the bottom bar; the rest go to "More"

function navLink(item, currentPath, cls) {
  const active = currentPath === item.path;
  return h('a', {
    class: cls,
    href: `#${item.path}`,
    'aria-current': active ? 'page' : null,
  }, icon(item.icon), h('span', {}, t(item.labelKey)),
  item.count ? h('span', { class: 'badge badge--accent nav__count num' }, String(item.count)) : null);
}

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

/**
 * renderShell(root, { nav: [{ path, labelKey, icon }], currentPath, user: { name, roleKey }, onSignOut })
 * returns { main } — the element pages render into.
 */
export function renderShell(root, { nav, currentPath, user, onSignOut }) {
  clear(root);
  document.body.classList.add('has-bottombar');

  const userChip = user ? h('div', { class: 'user-chip' },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(user.name)),
    h('div', { style: { 'min-inline-size': '0' } },
      h('p', { class: 'user-chip__name' }, user.name),
      h('p', { class: 'user-chip__role' }, t(user.roleKey)))) : null;

  const signOut = button({ label: t('common.signOut'), variant: 'ghost', icon: 'logOut', block: true, onClick: onSignOut });
  signOut.querySelector('.icon')?.classList.add('icon--flip');

  const sidebar = h('aside', { class: 'sidebar', 'aria-label': t('nav.primary') },
    h('div', { class: 'sidebar__brand' }, wordmark({ href: `#${nav[0].path}` })),
    h('nav', { class: 'nav', 'aria-label': t('nav.primary') }, nav.map((i) => navLink(i, currentPath, 'nav__link'))),
    h('div', { class: 'sidebar__footer' },
      h('div', { class: 'sidebar__prefs' }, langSwitcher(), themeToggle({ compact: true })),
      userChip, signOut));

  // ----- mobile drawer ("More") -----
  const overflow = nav.slice(BOTTOM_MAX - (nav.length > BOTTOM_MAX ? 1 : 0));
  const drawerSignOut = button({ label: t('common.signOut'), variant: 'secondary', icon: 'logOut', block: true, onClick: onSignOut });
  const drawer = h('dialog', { class: 'drawer', 'aria-label': t('common.menu') },
    h('div', { class: 'drawer__header' }, wordmark(),
      button({ label: t('common.close'), variant: 'ghost', icon: 'x', iconOnly: true, onClick: () => closeDrawer() })),
    h('div', { class: 'drawer__body' },
      nav.length > BOTTOM_MAX ? h('nav', { class: 'nav', 'aria-label': t('common.more') }, overflow.map((i) => navLink(i, currentPath, 'nav__link'))) : null,
      h('div', { class: 'drawer__group' }, h('span', { class: 'drawer__label' }, t('lang.label')), langSwitcher()),
      h('div', { class: 'drawer__group' }, h('span', { class: 'drawer__label' }, t('theme.label')), themeToggle()),
      userChip ? userChip.cloneNode(true) : null,
      drawerSignOut));
  drawer.addEventListener('click', (e) => { if (e.target === drawer || e.target.closest('a')) closeDrawer(); });
  drawer.addEventListener('cancel', (e) => { e.preventDefault(); closeDrawer(); });
  function openDrawer() { drawer.showModal(); }
  function closeDrawer() {
    if (!drawer.open) return;
    drawer.classList.add('is-closing');
    const done = () => { drawer.classList.remove('is-closing'); drawer.close(); };
    const dur = parseFloat(getComputedStyle(drawer).animationDuration) || 0;
    if (dur > 0) drawer.addEventListener('animationend', done, { once: true }); else done();
  }

  const topbar = h('header', { class: 'topbar' },
    wordmark({ href: `#${nav[0].path}` }),
    h('div', { class: 'topbar__actions' },
      button({ label: t('common.menu'), variant: 'ghost', icon: 'menu', iconOnly: true, onClick: openDrawer })));

  // ----- bottom bar -----
  const bottomItems = nav.length > BOTTOM_MAX ? nav.slice(0, BOTTOM_MAX - 1) : nav;
  const overflowActive = nav.length > BOTTOM_MAX && overflow.some((i) => i.path === currentPath);
  const bottombar = h('nav', { class: 'bottombar', 'aria-label': t('nav.primary') },
    bottomItems.map((i) => navLink(i, currentPath, 'bottombar__link')),
    nav.length > BOTTOM_MAX ? h('button', {
      type: 'button', class: 'bottombar__link', onClick: openDrawer,
      'aria-current': overflowActive ? 'page' : null, 'aria-haspopup': 'dialog',
    }, icon('moreHorizontal'), h('span', {}, t('common.more'))) : null);

  const main = h('main', { class: 'main__inner', id: 'main', tabindex: '-1' });

  root.append(
    h('a', { class: 'skip-link', href: '#main', onClick: (e) => { e.preventDefault(); main.focus(); } }, t('common.skipToContent')),
    h('div', { class: 'app' }, sidebar, topbar, h('div', { class: 'main' }, main), bottombar),
    drawer,
  );
  return { main };
}

/** pageHeader({ eyebrow, title, subtitle, actions }) */
export function pageHeader({ eyebrow, title, subtitle, actions }) {
  return h('header', { class: 'page-header' },
    h('div', { class: 'stack stack--sm' },
      eyebrow ? h('p', { class: 'page-header__eyebrow' }, eyebrow) : null,
      h('h1', { class: 'page-header__title' }, title),
      subtitle ? h('p', { class: 'page-header__subtitle' }, subtitle) : null),
    actions ? h('div', { class: 'page-header__actions' }, actions) : null);
}
