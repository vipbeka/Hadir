// Leaderboard (staff + owner). Staff data comes from the safe RPC
// get_leaderboard (rank, name, job title, green total, threshold only).
// The owner additionally sees red/black counters from the dashboard data.
import { h, clear, add, fill } from '../core/dom.js';
import { t, setDocumentTitle, getLang } from '../core/i18n.js';
import { sb } from '../core/supabase.js';
import { api } from '../core/api.js';
import { errorMessage } from '../core/errors.js';
import { pageHeader } from '../shell/shell.js';
import { progress, badge, alert, emptyState, skeletonCard } from '../ui/display.js';
import { icon } from '../ui/icons.js';

const name = (r) => (getLang() === 'ar' ? r.full_name_ar : r.full_name_en);
const job = (r) => (getLang() === 'ar' ? r.job_title_ar || r.job_title_en : r.job_title_en || r.job_title_ar);

export async function renderLeaderboard(main, { me }) {
  setDocumentTitle(t('lb.title'));
  add(main, pageHeader({ title: t('lb.title'), subtitle: t('lb.subtitle') }));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);
  try {
    const { data, error } = await sb.rpc('get_leaderboard');
    if (error) throw error;
    let extra = {};
    if (me.role === 'owner') {
      const d = await api('owner_dashboard');
      extra = Object.fromEntries(d.employees.map((e) => [e.full_name_en, e]));
    }
    clear(body);
    // One render decision: error (catch) / empty / list (+ an accurate note when nobody has points yet)
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      add(body, me.role === 'owner' ? emptyState({ iconName: 'users', title: t('od.noStaff') })
                                    : emptyState({ iconName: 'trophy', title: t('lb.hidden') }));
      return;
    }
    if (!rows.some((r) => Number(r.green) > 0)) add(body, alert(t('lb.zeroNote'), { tone: 'info' }));
    add(body, h('ol', { class: 'leaderboard', role: 'list' }, rows.map((r) => {
      const x = extra[r.full_name_en];
      return h('li', { class: ['lb-row', r.is_me && 'lb-row--me', r.rank === 1 && r.green > 0 && 'lb-row--top'] },
        h('span', { class: 'lb-rank num', 'aria-label': `${t('lb.rank')} ${r.rank}` }, r.rank === 1 && r.green > 0 ? icon('trophy') : String(r.rank)),
        h('div', { class: 'lb-main' },
          h('div', { class: 'cluster cluster--between' },
            h('span', { class: 'lb-name' }, name(r), r.is_me ? [' ', badge(t('lb.me'), { tone: 'accent' })] : null),
            x ? h('span', { class: 'cluster cluster--sm' }, badge(String(x.red), { tone: 'point-red', dot: true }), badge(String(x.black), { tone: 'point-black', dot: true })) : null),
          job(r) ? h('span', { class: 'text-xs text-muted' }, job(r)) : null,
          progress({ label: t('points.green'), value: Math.min(r.green, r.threshold), max: r.threshold, reward: true, valueText: `${r.green}/${r.threshold}` })));
    })));
  } catch (err) {
    fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true }));
  }
}
