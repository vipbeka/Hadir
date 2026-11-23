// Leaderboard (staff + owner). Staff data comes from the safe RPC
// get_leaderboard(p_scope) (rank, name, job title, GREEN total, threshold
// only — never penalties). Tabs: this month / last month / all time.
// The owner additionally sees red/black counters from the dashboard data.
import { h, clear, add, fill } from '../core/dom.js';
import { t, setDocumentTitle, getLang } from '../core/i18n.js';
import { sb } from '../core/supabase.js';
import { api } from '../core/api.js';
import { errorMessage } from '../core/errors.js';
import { pageHeader } from '../shell/shell.js';
import { chip, progress, badge, emptyState, skeletonCard } from '../ui/display.js';
import { icon } from '../ui/icons.js';

const name = (r) => (getLang() === 'ar' ? r.full_name_ar : r.full_name_en);
const job = (r) => (getLang() === 'ar' ? r.job_title_ar || r.job_title_en : r.job_title_en || r.job_title_ar);

async function fetchBoard(scope) {
  const { data, error } = await sb.rpc('get_leaderboard', { p_scope: scope });
  if (!error) return data;
  // older database without the scoped function: the current month still works
  if (scope === 'month') { const r = await sb.rpc('get_leaderboard'); if (r.error) throw r.error; return r.data; }
  throw error;
}

export async function renderLeaderboard(main, { me }) {
  setDocumentTitle(t('lb.title'));
  add(main, pageHeader({ iconName: 'trophy', title: t('lb.title'), subtitle: t('lb.subtitle') }));
  let scope = 'month';
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('lb.title') },
    [['month', 'lb.tabMonth'], ['prev', 'lb.tabPrev'], ['all', 'lb.tabAll']].map(([k, label]) =>
      h('button', { type: 'button', role: 'tab', class: 'tabs__btn', 'data-scope': k, 'aria-selected': String(k === scope),
        onClick: () => { if (scope === k) return; scope = k; tabs.querySelectorAll('.tabs__btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.scope === k))); load(); } }, t(label))));
  const body = h('div', { class: 'stack', role: 'tabpanel' }, skeletonCard(t('common.loading')));
  add(main, tabs, body);

  let extra = null; let gen = 0;
  async function load() {
    const my = ++gen;
    fill(body, skeletonCard(t('common.loading')));
    try {
      const data = await fetchBoard(scope);
      if (me.role === 'owner' && scope === 'month' && !extra) {
        const d = await api('owner_dashboard');
        extra = Object.fromEntries(d.employees.map((e) => [e.full_name_en, e]));
      }
      if (my !== gen) return;
      render(Array.isArray(data) ? data : []);
    } catch (err) {
      if (my !== gen) return;
      fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true }));
    }
  }

  function render(rows) {
    clear(body);
    // One render decision: empty (no staff / hidden) → empty state ALONE;
    // otherwise the list, with a compact note when nobody has points yet.
    if (!rows.length) {
      add(body, me.role === 'owner' ? emptyState({ iconName: 'users', title: t('od.noStaff') })
                                    : emptyState({ iconName: 'trophy', title: t('lb.hidden') }));
      return;
    }
    if (!rows.some((r) => Number(r.green) > 0)) {
      // nobody has points yet: a dashed note above the (still visible) list
      add(body, h('section', { class: 'lb-empty', role: 'status' },
        h('span', { class: 'lb-empty__icon', 'aria-hidden': 'true' }, icon('trophy')),
        h('p', { class: 'lb-empty__title' }, scope === 'month' ? t('lb.empty') : t('lb.zeroPeriod')),
        h('p', { class: 'lb-empty__text' }, t('lb.emptyText'))));
    }
    const x = (r) => (me.role === 'owner' && scope === 'month' && extra ? extra[r.full_name_en] : null);
    add(body,
      h('ol', { class: 'leaderboard', role: 'list' }, rows.map((r) => {
        const top = r.rank === 1 && r.green > 0;
        const ex = x(r);
        return h('li', { class: ['lb-row', r.is_me && 'lb-row--me', top && 'lb-row--top'] },
          h('span', { class: 'lb-rank num', 'aria-label': `${t('lb.rank')} ${r.rank}` },
            top ? h('span', { class: 'lb-rank__crown', 'aria-hidden': 'true' }, '👑') : null, String(r.rank)),
          h('div', { class: 'lb-main' },
            h('div', { class: 'lb-name-row' },
              h('span', { class: 'lb-name' }, name(r)), r.is_me ? chip(t('lb.me'), { tone: 'accent' }) : null,
              ex ? h('span', { class: 'cluster cluster--sm' }, badge(String(ex.red), { tone: 'point-red', dot: true }), badge(String(ex.black), { tone: 'point-black', dot: true })) : null),
            job(r) ? h('span', { class: 'text-xs text-muted' }, job(r)) : null,
            h('div', { class: 'lb-score' },
              h('span', { class: 'lb-points' }, h('b', { class: 'num' }, String(r.green)), ` ${t('points.green')}`),
              scope === 'all' ? null : h('span', { class: 'lb-of num' }, `${Math.min(r.green, r.threshold)}/${r.threshold}`)),
            scope === 'all' ? null : progress({ label: t('lb.monthly'), value: Math.min(r.green, r.threshold), max: r.threshold, reward: true, valueText: `${r.green}/${r.threshold}` })));
      })));
  }
  load();
}
