// /design — dev-only preview of the whole design system: every
// component in default, hover, focus, active, disabled and loading
// states. Static states use the `.is-*` mirror classes.
import { h, clear } from '../core/dom.js';
import { initI18n, onLangChange, t, setDocumentTitle } from '../core/i18n.js';
import { initTheme } from '../core/theme.js';
import { icon, ICON_NAMES } from '../ui/icons.js';
import { button, setLoading } from '../ui/button.js';
import { input, select, textarea, switchControl } from '../ui/field.js';
import { modal, confirmDialog } from '../ui/modal.js';
import { toast, toastEl } from '../ui/toast.js';
import { card, stat, badge, alert, table, progress, emptyState, skeleton, skeletonCard } from '../ui/display.js';
import { wordmark, brandName, MARK_SRC } from '../ui/brand.js';
import { langSwitcher, themeToggle } from '../ui/prefs.js';

const root = document.getElementById('app');
const STATES = ['default', 'hover', 'focus', 'active', 'disabled', 'loading'];

const cell = (cap, ...els) => h('div', { class: 'dz-state' }, h('span', { class: 'dz-cap' }, cap), ...els);
const cellStretch = (cap, ...els) => h('div', { class: 'dz-state dz-state--stretch' }, h('span', { class: 'dz-cap' }, cap), ...els);
const section = (id, titleKey, ...children) => h('section', { class: 'dz-section', id, 'aria-labelledby': `${id}-h` },
  h('h2', { id: `${id}-h` }, t(titleKey)), ...children);
const sub = (text) => h('h3', { class: 'dz-sub' }, text);

function applyState(el, state) {
  if (state === 'hover') el.classList.add('is-hover');
  if (state === 'focus') el.classList.add('is-focus');
  if (state === 'active') el.classList.add('is-active');
  if (state === 'disabled') el.disabled = true;
  if (state === 'loading') setLoading(el, true, t('common.loading'));
  return el;
}

function buttonsSection() {
  const variants = ['primary', 'secondary', 'ghost', 'danger', 'reward'];
  const rows = variants.map((v) => h('div', { class: 'stack stack--sm' },
    sub(t(`design.variant.${v}`)),
    h('div', { class: ['dz-states', v === 'reward' && 'dz-states--wide'] }, STATES.map((s) => cell(t(`design.state.${s}`),
      applyState(button({ label: v === 'reward' ? t('reward.request') : t('common.save'), variant: v, icon: v === 'reward' ? 'gift' : null }), s))))));
  const sizes = h('div', { class: 'cluster' },
    button({ label: 'sm', variant: 'primary', size: 'sm' }),
    button({ label: 'md', variant: 'primary' }),
    button({ label: 'lg', variant: 'primary', size: 'lg' }),
    button({ label: t('common.search'), variant: 'secondary', icon: 'search', iconOnly: true }),
    button({ label: t('common.menu'), variant: 'ghost', icon: 'menu', iconOnly: true }),
    button({ label: t('common.more'), variant: 'secondary', iconEnd: 'arrowRight' }));
  const live = button({ label: t('common.save'), variant: 'primary', icon: 'check', attrs: { id: 'live-save' }, onClick: () => {
    setLoading(live, true, t('common.saving'));
    setTimeout(() => { setLoading(live, false); toast({ title: t('design.toastTitle'), text: t('design.toastText'), tone: 'success' }); }, 1200);
  } });
  return section('buttons', 'design.buttons', ...rows, sub('Sizes · icon-only · live loading'), sizes, h('div', {}, live));
}

function inputsSection() {
  const mk = (state) => {
    const f = input({
      label: t('design.sampleLabel'), placeholder: t('design.samplePlaceholder'), hint: t('design.sampleHint'),
      required: true, disabled: state === 'disabled', loading: state === 'loading',
      error: state === 'error' ? t('design.sampleError') : null,
      value: state === 'active' ? 'Ahmed' : '',
    });
    const ctl = f.querySelector('.input');
    if (state === 'hover') ctl.classList.add('is-hover');
    if (state === 'focus' || state === 'active') ctl.classList.add('is-focus');
    return cellStretch(t(`design.state.${state}`), f);
  };
  const code = input({ label: t('login.codeLabel'), type: 'password', placeholder: t('login.codePlaceholder'), attrs: { class: 'input--code', inputmode: 'numeric', autocomplete: 'off' } });
  return section('inputs', 'design.inputs',
    h('div', { class: 'dz-states dz-states--wide' }, ['default', 'hover', 'focus', 'active', 'disabled', 'loading', 'error'].map(mk)),
    h('div', { class: 'dz-states dz-states--wide' },
      cellStretch('textarea', textarea({ label: t('design.sampleTextarea'), placeholder: t('common.optional') })),
      cellStretch('code', code)));
}

function selectionSection() {
  const opts = [{ value: 'personal', label: t('design.optPersonal') }, { value: 'sick', label: t('design.optSick') }];
  const mkSel = (state) => {
    const f = select({ label: t('design.sampleSelect'), options: opts, disabled: state === 'disabled', error: state === 'error' ? t('design.sampleError') : null });
    const c = f.querySelector('.select');
    if (state === 'hover') c.classList.add('is-hover');
    if (state === 'focus' || state === 'active') c.classList.add('is-focus');
    return cellStretch(t(`design.state.${state}`), f);
  };
  const seg = (state) => {
    const g = h('div', { class: 'segmented', role: 'group', 'aria-label': 'demo' },
      ...['A', 'B', 'C'].map((x, i) => h('button', { type: 'button', class: 'segmented__btn', 'aria-pressed': String(i === 0) }, x)));
    const b = g.children[1];
    if (state === 'hover') b.classList.add('is-hover');
    if (state === 'focus') b.classList.add('is-focus');
    if (state === 'active') b.classList.add('is-active');
    if (state === 'disabled') [...g.children].forEach((x) => { x.disabled = true; });
    if (state === 'loading') b.setAttribute('aria-busy', 'true');
    return cell(t(`design.state.${state}`), g);
  };
  return section('selection', 'design.selection',
    h('div', { class: 'dz-states dz-states--wide' }, ['default', 'hover', 'focus', 'disabled', 'error'].map(mkSel)),
    sub('Switch'),
    h('div', { class: 'dz-states' },
      cell(t('design.state.default'), switchControl({ label: t('design.sampleSwitch') })),
      cell('on', switchControl({ label: t('design.sampleSwitch'), checked: true })),
      cell(t('design.state.disabled'), switchControl({ label: t('design.sampleSwitch'), disabled: true })),
      cell(`${t('design.state.disabled')} · on`, switchControl({ label: t('design.sampleSwitch'), checked: true, disabled: true }))),
    sub('Segmented'),
    h('div', { class: 'dz-states' }, STATES.map(seg)));
}

function cardsSection() {
  const interactive = (state) => {
    const c = card({ interactive: true, title: t('design.interactiveCard'), subtitle: t('design.cardText') });
    if (state === 'hover') c.classList.add('is-hover');
    if (state === 'focus') c.classList.add('is-focus');
    if (state === 'active') c.classList.add('is-active');
    if (state === 'disabled') { c.setAttribute('aria-disabled', 'true'); c.disabled = true; }
    return cellStretch(t(`design.state.${state}`), state === 'loading' ? skeletonCard(t('common.loading')) : c);
  };
  return section('cards', 'design.cards',
    h('div', { class: 'grid-auto' },
      card({ title: t('design.cardTitle'), subtitle: t('design.sampleHint'), body: h('p', {}, t('design.cardText')),
        footer: [button({ label: t('common.cancel'), variant: 'ghost' }), button({ label: t('common.save'), variant: 'primary' })] }),
      card({ facet: true, body: stat({ label: t('design.statDays'), value: '14', meta: t('design.statMeta') }) }),
      card({ body: stat({ label: t('design.statHours'), value: '112.5', meta: t('design.statMeta') }) })),
    sub(t('design.interactiveCard')),
    h('div', { class: 'dz-states dz-states--wide' }, STATES.map(interactive)));
}

function badgesSection() {
  const tones = [['neutral', 'neutral'], ['info', 'info'], ['success', 'success'], ['warning', 'warning'], ['danger', 'danger'], ['accent', 'accent']];
  return section('badges', 'design.badges',
    h('div', { class: 'cluster' }, tones.map(([tone, label]) => badge(label, { tone, dot: true }))),
    sub('Points'),
    h('div', { class: 'cluster' },
      badge(t('points.green'), { tone: 'point-green', dot: true, size: 'lg' }),
      badge(t('points.red'), { tone: 'point-red', dot: true, size: 'lg' }),
      badge(t('points.black'), { tone: 'point-black', dot: true, size: 'lg' }),
      badge(`${t('points.red')} · ${t('points.warning')}`, { tone: 'warning', size: 'lg' }),
      badge(`${t('points.black')} · ${t('points.pending')}`, { tone: 'neutral', size: 'lg' })),
    sub(t('design.variant.reward')),
    h('div', { class: 'cluster' }, badge('+1 · deal closed', { tone: 'reward', iconName: 'star', size: 'lg' }), badge('30/30', { tone: 'reward' })));
}

function tableSection() {
  const rows = [
    { name: 'أحمد علي · Ahmed Ali', days: 14, hours: '112.5', status: 'present' },
    { name: 'منى حسن · Mona Hassan', days: 13, hours: '101.0', status: 'late', _class: 'is-hover' },
    { name: 'كريم سعيد · Karim Saeed', days: 11, hours: '88.0', status: 'leave' },
  ];
  const tones = { present: 'success', late: 'point-red', leave: 'info' };
  const labels = { present: 'design.statusPresent', late: 'design.statusLate', leave: 'design.statusLeave' };
  return section('table', 'design.table',
    table({
      caption: t('design.tableCaption'),
      columns: [
        { key: 'name', label: t('design.colEmployee') },
        { key: 'days', label: t('design.colDays'), numeric: true, render: (r) => h('span', { class: 'num' }, String(r.days)) },
        { key: 'hours', label: t('design.colHours'), numeric: true, render: (r) => h('span', { class: 'num' }, r.hours) },
        { key: 'status', label: t('design.colStatus'), render: (r) => badge(t(labels[r.status]), { tone: tones[r.status], dot: true }) },
      ],
      rows,
    }),
    h('p', { class: 'text-xs text-muted' }, '2nd row shows the hover state.'),
    sub(t('design.state.loading')),
    h('div', { class: 'card stack stack--sm', role: 'status', 'aria-label': t('common.loading') },
      skeleton('text', { width: '40%' }), skeleton('text'), skeleton('text'), skeleton('text', { width: '70%' })),
    sub('Empty'),
    emptyState({ iconName: 'inbox', title: t('empty.title'), text: t('empty.text') }));
}

function progressSection() {
  return section('progress', 'design.progress',
    h('div', { class: 'grid-auto' },
      card({ body: progress({ label: t('reward.progress'), value: 0, max: 30, reward: true, hint: t('reward.remaining', { n: 30 }) }) }),
      card({ body: progress({ label: t('reward.progress'), value: 7, max: 30, reward: true, hint: t('reward.remaining', { n: 23 }) }) }),
      card({ body: [progress({ label: t('reward.progress'), value: 30, max: 30, reward: true, hint: t('reward.reached') }), button({ label: t('reward.request'), variant: 'reward', icon: 'gift', block: true })] }),
      card({ body: progress({ label: t('common.loading'), indeterminate: true }) })));
}

function feedbackSection() {
  return section('feedback', 'design.feedback',
    h('div', { class: 'stack stack--sm' },
      alert(t('design.alertInfo'), { tone: 'info' }),
      alert(t('design.alertSuccess'), { tone: 'success' }),
      alert(t('design.alertWarning'), { tone: 'warning' }),
      alert(t('design.alertDanger'), { tone: 'danger' })),
    sub('Toasts'),
    h('div', { class: 'stack stack--sm', style: { 'max-inline-size': '28rem' } },
      ...['info', 'success', 'warning', 'danger', 'reward'].map((tone) => toastEl({ title: t('design.toastTitle'), text: t('design.toastText'), tone, isStatic: true }))),
    h('div', { class: 'cluster' },
      ...['info', 'success', 'warning', 'danger', 'reward'].map((tone) => button({ label: `${t('design.showToast')} · ${tone}`, size: 'sm', onClick: () => toast({ title: t('design.toastTitle'), text: t('design.toastText'), tone }) }))));
}

function modalSection() {
  const inline = h('div', { class: 'modal modal--inline', role: 'presentation' },
    h('header', { class: 'modal__header' }, h('h3', { class: 'modal__title' }, t('design.modalTitle')),
      button({ label: t('common.close'), variant: 'ghost', icon: 'x', iconOnly: true, size: 'sm' })),
    h('div', { class: 'modal__body' }, h('p', {}, t('design.modalText')), input({ label: t('design.sampleTextarea'), required: true })),
    h('footer', { class: 'modal__footer' }, button({ label: t('common.cancel') }), button({ label: t('common.confirm'), variant: 'primary' })));
  const openForm = () => {
    const save = button({ label: t('common.save'), variant: 'primary', onClick: () => {
      setLoading(save, true, t('common.saving'));
      setTimeout(() => { setLoading(save, false); m.close('saved'); toast({ title: t('design.toastTitle'), tone: 'success' }); }, 900);
    } });
    const m = modal({
      title: t('design.modalTitle'),
      body: [h('p', {}, t('design.modalText')), select({ label: t('design.sampleSelect'), options: [{ value: 'personal', label: t('design.optPersonal') }, { value: 'sick', label: t('design.optSick') }] }), textarea({ label: t('design.sampleTextarea') })],
      actions: [button({ label: t('common.cancel'), onClick: () => m.close('cancel') }), save],
    });
    m.open();
  };
  return section('modal', 'design.modal',
    inline,
    h('div', { class: 'cluster' },
      button({ label: t('design.openModal'), variant: 'primary', onClick: openForm }),
      button({ label: t('design.modalTitle'), variant: 'danger', onClick: async () => {
        const ok = await confirmDialog({ title: t('design.modalTitle'), text: t('design.modalText'), variant: 'danger' });
        toast({ title: ok ? t('common.confirm') : t('common.cancel'), tone: ok ? 'success' : 'info' });
      } })));
}

function emptySection() {
  return section('empty', 'design.empty',
    h('div', { class: 'grid-auto' },
      emptyState({ iconName: 'trophy', title: t('empty.title'), text: t('empty.text') }),
      emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: t('error.text'), error: true, action: button({ label: t('common.retry'), variant: 'secondary', icon: 'arrowRight' }) })));
}

function skeletonSection() {
  return section('skeleton', 'design.skeleton',
    h('div', { class: 'grid-auto' },
      skeletonCard(t('common.loading')),
      h('div', { class: 'card', role: 'status', 'aria-label': t('common.loading') },
        h('div', { class: 'cluster' }, skeleton('circle'), h('div', { class: 'stack stack--sm', style: { flex: '1' } }, skeleton('text', { width: '60%' }), skeleton('text', { width: '40%' }))),
        skeleton('text'), skeleton('text', { width: '90%' }))));
}

function navSection() {
  const mk = (state, i) => {
    const a = h('a', { class: 'nav__link', href: '#nav', onClick: (e) => e.preventDefault() }, icon(['home', 'mapPin', 'star', 'trophy', 'inbox'][i]), h('span', {}, t(`design.state.${state}`)));
    if (state === 'hover') a.classList.add('is-hover');
    if (state === 'focus') a.classList.add('is-focus');
    if (state === 'active') a.setAttribute('aria-current', 'page');
    if (state === 'disabled') a.setAttribute('aria-disabled', 'true');
    return a;
  };
  return section('nav', 'design.nav',
    h('div', { class: 'dz-states dz-states--wide' },
      cellStretch('sidebar', h('div', { class: 'dz-navdemo' }, ['default', 'hover', 'focus', 'active', 'disabled'].map(mk))),
      cellStretch('bottom bar', h('nav', { class: 'bottombar dz-bottomdemo', 'aria-label': 'demo' },
        h('a', { class: 'bottombar__link', href: '#nav', 'aria-current': 'page' }, icon('home'), h('span', {}, t('nav.home'))),
        h('a', { class: 'bottombar__link is-hover', href: '#nav' }, icon('mapPin'), h('span', {}, t('nav.checkIn'))),
        h('a', { class: 'bottombar__link', href: '#nav' }, icon('star'), h('span', {}, t('nav.points'))),
        h('button', { class: 'bottombar__link', type: 'button' }, icon('moreHorizontal'), h('span', {}, t('common.more')))))),
    sub('Shells (preview routes)'),
    h('div', { class: 'dz-shells' },
      h('a', { class: 'btn btn--secondary', href: '../index.html#/login' }, t('login.title')),
      h('a', { class: 'btn btn--secondary', href: '../index.html#/staff/home' }, `${t('role.staff')} · ${t('nav.home')}`),
      h('a', { class: 'btn btn--secondary', href: '../index.html#/owner/dashboard' }, `${t('role.owner')} · ${t('nav.dashboard')}`)));
}

function switcherSection() {
  return section('switchers', 'design.switcher', h('div', { class: 'cluster' }, langSwitcher(), themeToggle(), themeToggle({ compact: true })));
}

function brandSection() {
  return section('brand', 'design.brand',
    h('div', { class: 'dz-brand' },
      h('div', { class: 'dz-brand__panel dz-brand__panel--light' }, wordmark()),
      h('div', { class: 'dz-brand__panel dz-brand__panel--black' }, wordmark(), h('span', { class: 'text-sm' }, h('span', {}, t('company.name')), ' / ', h('bdi', { dir: 'ltr' }, t('company.nameLatin')))),
      h('div', { class: 'dz-brand__panel dz-brand__panel--gradient', 'aria-label': 'Brand gradient (login hero / page header only)', role: 'img' })),
    sub('Favicon · touch · PWA'),
    h('div', { class: 'dz-icons' },
      ...[['favicon-16.png', 16], ['favicon-32.png', 32], ['apple-touch-icon.png', 60], ['icon-192.png', 64], ['icon-maskable-512.png', 64]].map(([f, s]) =>
        h('img', { src: `../assets/icons/${f}`, width: String(s), height: String(s), alt: f, title: f })),
      h('img', { src: MARK_SRC, width: '64', height: '62', alt: 'logo-mark.png' })),
    sub('Icons'),
    h('div', { class: 'dz-icons' }, ICON_NAMES.map((n) => h('span', { title: n }, icon(n, { label: n })))),
    h('p', { class: 'text-sm text-muted' }, 'Name rendering: ', h('strong', {}, brandName()), ' — ', t('app.tagline')));
}

function colorsSection() {
  const groups = {
    'Brand': ['--brand-blue', '--brand-blue-hover', '--brand-blue-pressed', '--brand-navy', '--brand-cyan', '--brand-cyan-bright', '--brand-gold', '--brand-gold-dark', '--brand-gold-shine', '--brand-black', '--brand-night'],
    'Surface & text': ['--color-bg', '--color-surface', '--color-surface-sunken', '--color-surface-raised', '--color-border', '--color-border-strong', '--color-text', '--color-text-muted', '--color-text-subtle'],
    'Action & accent': ['--color-primary', '--color-primary-hover', '--color-primary-pressed', '--color-primary-subtle', '--color-link', '--color-accent', '--color-accent-text', '--color-accent-subtle', '--color-reward', '--color-reward-text', '--color-reward-subtle'],
    'Status': ['--color-success', '--color-success-subtle', '--color-warning', '--color-warning-subtle', '--color-danger', '--color-danger-subtle', '--color-info', '--color-info-subtle'],
    'Points': ['--color-point-green', '--color-point-green-subtle', '--color-point-red', '--color-point-red-subtle', '--color-point-black-fill', '--color-point-black-subtle'],
  };
  const cs = getComputedStyle(document.documentElement);
  return section('colors', 'design.colors',
    h('p', { class: 'text-sm text-muted' }, t('design.contrast')),
    ...Object.entries(groups).flatMap(([name, vars]) => [sub(name), h('div', { class: 'dz-swatches' },
      vars.map((v) => h('div', { class: 'dz-swatch' },
        h('div', { class: 'dz-swatch__chip', style: { background: `var(${v})` } }),
        h('div', { class: 'dz-swatch__meta' }, h('span', { class: 'dz-swatch__name' }, v), h('span', { class: 'dz-swatch__val' }, cs.getPropertyValue(v).trim())))))]));
}

function typeSection() {
  const sizes = ['5xl', '4xl', '3xl', '2xl', 'xl', 'lg', 'md', 'sm', 'xs'];
  return section('type', 'design.typography',
    h('p', { class: 'text-sm text-muted' }, 'IBM Plex Sans Arabic — one family for Arabic and Latin (400/500/600/700).'),
    h('div', { class: 'dz-type' }, sizes.map((s) => h('div', { class: 'dz-type__row' },
      h('span', { class: 'dz-cap' }, `--font-size-${s}`),
      h('span', { style: { 'font-size': `var(--font-size-${s})`, 'font-weight': ['5xl', '4xl', '3xl', '2xl'].includes(s) ? 'var(--font-weight-bold)' : 'var(--font-weight-regular)', 'line-height': 'var(--line-height-tight)' } },
        s === 'md' ? t('login.heroText') : t('login.heroTitle'))))),
    h('div', { class: 'cluster' }, ['regular', 'medium', 'semibold', 'bold'].map((w) => h('span', { style: { 'font-weight': `var(--font-weight-${w})` } }, `${w} · حاضر · Zintra`))));
}

function spacingSection() {
  const spaces = ['1', '2', '3', '4', '5', '6', '8', '10', '12', '16', '20'];
  return section('spacing', 'design.spacing',
    h('div', { class: 'dz-space' }, spaces.map((s) => h('div', { class: 'dz-type__row' }, h('span', { class: 'dz-cap' }, `--space-${s}`), h('span', { class: 'dz-space__bar', style: { 'inline-size': `var(--space-${s})` } })))),
    h('div', { class: 'dz-tiles' },
      ...['xs', 'sm', 'md', 'lg'].map((r) => h('div', { class: 'dz-tile', style: { 'border-radius': `var(--radius-${r})` } }, `--radius-${r}`)),
      ...['xs', 'sm', 'md', 'lg', 'reward'].map((s) => h('div', { class: 'dz-tile', style: { 'box-shadow': `var(--shadow-${s})`, 'border-radius': 'var(--radius-md)' } }, `--shadow-${s}`))));
}

function render() {
  clear(root);
  setDocumentTitle(t('design.title'));
  const toc = [['brand', 'design.brand'], ['colors', 'design.colors'], ['type', 'design.typography'], ['buttons', 'design.buttons'], ['inputs', 'design.inputs'], ['selection', 'design.selection'], ['cards', 'design.cards'], ['badges', 'design.badges'], ['table', 'design.table'], ['progress', 'design.progress'], ['feedback', 'design.feedback'], ['modal', 'design.modal'], ['empty', 'design.empty'], ['skeleton', 'design.skeleton'], ['nav', 'design.nav'], ['switchers', 'design.switcher'], ['spacing', 'design.spacing']];
  root.append(
    h('header', { class: 'dz-top' }, wordmark(), h('div', { class: 'dz-top__prefs' }, langSwitcher(), themeToggle({ compact: true }))),
    h('main', { class: 'dz', id: 'main' },
      h('header', { class: 'page-header' }, h('div', { class: 'stack stack--sm' },
        h('p', { class: 'page-header__eyebrow' }, brandName()),
        h('h1', { class: 'page-header__title' }, t('design.title')),
        h('p', { class: 'page-header__subtitle' }, t('design.subtitle')))),
      h('nav', { class: 'dz-toc', 'aria-label': t('design.title') }, toc.map(([id, k]) => h('a', { class: 'btn btn--ghost btn--sm', href: `#${id}` }, t(k)))),
      brandSection(), colorsSection(), typeSection(), buttonsSection(), inputsSection(), selectionSection(), cardsSection(),
      badgesSection(), tableSection(), progressSection(), feedbackSection(), modalSection(), emptySection(), skeletonSection(),
      navSection(), switcherSection(), spacingSection()));
}

(async () => {
  initTheme();
  await initI18n();
  render();
  onLangChange(() => {
    render();
    document.querySelector(`.dz-top .segmented__btn[lang="${document.documentElement.lang}"]`)?.focus({ preventScroll: true });
  });
  // swatch values depend on the theme
  new MutationObserver(() => {
    const cs = getComputedStyle(document.documentElement);
    document.querySelectorAll('.dz-swatch').forEach((s) => {
      s.querySelector('.dz-swatch__val').textContent = cs.getPropertyValue(s.querySelector('.dz-swatch__name').textContent).trim();
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
