// Owner holidays: seeded Egyptian holidays + company days off.
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { sb } from '../../core/supabase.js';
import { errorMessage } from '../../core/errors.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, switchControl, setFieldError } from '../../ui/field.js';
import { modal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';

// "2027-03-10" → "10/03/2027" straight from the string: a calendar day is
// never parsed as a timestamp, so no timezone can shift it by a day.
const dmy = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const weekday = (iso) => new Intl.DateTimeFormat(getLang() === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`));

export async function renderHolidays(main) {
  setDocumentTitle(t('hol.title'));
  add(main, pageHeader({ iconName: 'calendar', title: t('hol.title'), subtitle: t('hol.subtitle'), actions: [button({ label: t('hol.add'), variant: 'primary', icon: 'plus', onClick: () => edit(null) })] }));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);

  async function load() {
    const { data, error } = await sb.from('public_holidays').select('*').order('holiday_date');
    if (error) { fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(error), error: true })); return; }
    const years = [...new Set(data.map((d) => d.holiday_date.slice(0, 4)))].sort();
    const nav = years.length > 1 ? h('nav', { class: 'cluster cluster--sm', 'aria-label': t('hol.years') }, years.map((y) => h('a', { class: 'chip chip--neutral', href: `#/owner/holidays`, onClick: (e) => {
      e.preventDefault(); const el = document.getElementById(`hol-${y}`); el?.scrollIntoView({ behavior: 'smooth', block: 'start' }); el?.querySelector('h3')?.focus?.();
    } }, h('bdi', { class: 'num' }, y)))) : null;
    fill(body, nav, ...years.map((y) => card({ className: 'hol-year', title: h('span', { id: `hol-${y}`, tabindex: '-1' }, h('bdi', { class: 'num' }, y)), body: h('ul', { class: 'event-list', role: 'list' }, data.filter((d) => d.holiday_date.startsWith(y)).map((d) => {
      const sw = switchControl({ label: d.enabled ? t('common.enabled') : t('common.disabled'), checked: d.enabled, onChange: async (e) => {
        try { await api('save_holiday', { id: d.id, enabled: e.target.checked }); toast({ title: t('hol.saved'), tone: 'success' }); load(); }
        catch (err) { e.target.checked = !e.target.checked; toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      } });
      const confirmBtn = d.provisional ? button({ label: t('hol.confirm'), size: 'sm', icon: 'check', onClick: async () => {
        setLoading(confirmBtn, true);
        try { await api('save_holiday', { id: d.id, provisional: false }); toast({ title: t('hol.saved'), tone: 'success' }); load(); }
        catch (err) { setLoading(confirmBtn, false); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      } }) : null;
      return h('li', { class: ['event-row', !d.enabled && 'is-muted'] },
        // the date is an isolated LTR island inside the RTL row (no reordering)
        h('span', { class: 'hol-date' }, h('bdi', { class: 'num', dir: 'ltr' }, dmy(d.holiday_date)),
          h('span', { class: 'hol-date__dow' }, weekday(d.holiday_date))),
        h('div', { class: 'event-row__main' }, h('span', {}, getLang() === 'ar' ? d.name_ar : d.name_en),
          h('span', { class: 'cluster cluster--sm' }, badge(t(d.kind === 'official' ? 'hol.official' : 'hol.company'), { tone: d.kind === 'official' ? 'info' : 'accent' }),
            d.provisional ? badge(t('hol.provisional'), { tone: 'warning' }) : null)),
        h('div', { class: 'cluster cluster--sm' }, sw, confirmBtn, button({ label: t('common.edit'), size: 'sm', variant: 'ghost', onClick: () => edit(d) })));
    })) })));
  }

  function edit(d) {
    const fDate = input({ label: t('common.date'), type: 'date', value: d?.holiday_date || '', required: true, attrs: { dir: 'ltr' } });
    const fAr = input({ label: t('hol.nameAr'), value: d?.name_ar || '', required: true, attrs: { lang: 'ar', dir: 'rtl' } });
    const fEn = input({ label: t('hol.nameEn'), value: d?.name_en || '', required: true, attrs: { lang: 'en', dir: 'ltr' } });
    const fKind = d ? null : select({ label: t('common.status'), options: [{ value: 'company', label: t('hol.company') }, { value: 'official', label: t('hol.official') }] });
    const save = button({ label: t('common.save'), variant: 'primary', onClick: async () => {
      const v = (f) => f.querySelector('input,select').value.trim();
      if (!v(fDate)) { setFieldError(fDate, t('err.invalid_holiday')); return; }
      if (v(fAr).length < 2 || v(fEn).length < 2) { setFieldError(fEn, t('emp.errName')); return; }
      setLoading(save, true);
      try {
        await api('save_holiday', { id: d?.id, holiday_date: v(fDate), name_ar: v(fAr), name_en: v(fEn), kind: fKind ? v(fKind) : undefined });
        m.close(); toast({ title: t('hol.saved'), tone: 'success' }); load();
      } catch (err) { setLoading(save, false); setFieldError(fDate, errorMessage(err)); }
    } });
    const m = modal({ title: d ? t('common.edit') : t('hol.add'), size: 'sm', body: [fDate, fAr, fEn, fKind], actions: [button({ label: t('common.cancel'), onClick: () => m.close() }), save] });
    m.open();
  }
  load();
}
