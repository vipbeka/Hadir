// Owner → Employees: list + search, add (code shown once), and a manage
// dialog for details, code regeneration, sessions, salary and status.
// All writes go through the owner-employees Edge Function.
import { h, clear } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { callFunction } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatDate, formatDateTime, formatEGP, displayName } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { button, setLoading } from '../../ui/button.js';
import { input, select, setFieldError } from '../../ui/field.js';
import { modal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { table, badge, emptyState, skeletonCard } from '../../ui/display.js';
import { showCodeOnce } from '../../ui/code-dialog.js';

const PHONE_RE = /^\+?[0-9 ]{7,20}$/;

export function renderEmployees(main, { me }) {
  setDocumentTitle(t('emp.title'));
  let employees = [];
  let query = '';
  const listHost = h('div', { class: 'stack' });

  const search = input({ label: t('common.search'), placeholder: t('emp.searchPlaceholder'), attrs: { type: 'search', autocomplete: 'off' } });
  search.classList.add('toolbar__search');
  search.querySelector('input').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderList(); });

  main.append(
    pageHeader({ title: t('emp.title'), subtitle: t('emp.subtitle'),
      actions: [button({ label: t('emp.add'), variant: 'primary', icon: 'plus', onClick: openAdd })] }),
    h('div', { class: 'toolbar' }, search),
    listHost);

  async function load() {
    clear(listHost).append(skeletonCard(t('common.loading')));
    try {
      const res = await callFunction('owner-employees', { action: 'list' });
      employees = res.employees || [];
      renderList();
    } catch (err) {
      clear(listHost).append(emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true,
        action: button({ label: t('common.retry'), onClick: load }) }));
    }
  }

  function renderList() {
    clear(listHost);
    if (!employees.length) {
      listHost.append(emptyState({ iconName: 'users', title: t('emp.empty'), text: t('emp.emptyText'),
        action: button({ label: t('emp.add'), variant: 'primary', icon: 'plus', onClick: openAdd }) }));
      return;
    }
    const rows = employees.filter((e) => !query
      || [e.full_name_ar, e.full_name_en, e.phone].some((v) => (v || '').toLowerCase().includes(query)));
    if (!rows.length) { listHost.append(emptyState({ iconName: 'search', title: t('emp.noResults') })); return; }
    listHost.append(table({
      caption: t('emp.title'), captionHidden: true,
      columns: [
        { key: 'name', label: t('emp.colName'), render: (e) => h('span', { class: 'name-cell' },
          h('strong', {}, displayName(e)),
          h('span', { class: 'name-cell__alt', lang: getLang() === 'ar' ? 'en' : 'ar' }, getLang() === 'ar' ? e.full_name_en : e.full_name_ar)) },
        { key: 'phone', label: t('emp.colPhone'), render: (e) => e.phone ? h('span', { class: 'num', dir: 'ltr' }, e.phone) : '—' },
        { key: 'role', label: t('emp.colRole'), render: (e) => badge(t(`role.${e.role}`), { tone: e.role === 'owner' ? 'accent' : 'neutral' }) },
        { key: 'status', label: t('emp.colStatus'), render: (e) => badge(e.active ? t('emp.active') : t('emp.inactive'), { tone: e.active ? 'success' : 'neutral', dot: true }) },
        { key: 'code', label: t('emp.colCode'), render: (e) => e.code_created_at ? t('emp.codeSet', { date: formatDate(e.code_created_at) }) : t('emp.codeNone') },
        { key: 'salary', label: t('emp.colSalary'), numeric: true, render: (e) => e.monthly_salary_piastres == null
          ? h('span', { class: 'text-muted' }, t('common.notSet')) : h('span', { class: 'num' }, formatEGP(e.monthly_salary_piastres)) },
        { key: 'act', label: '', render: (e) => button({ label: t('common.edit'), size: 'sm', icon: 'settings', onClick: () => openManage(e) }) },
      ],
      rows,
    }));
  }

  // ------------------------------------------------------------ add
  function openAdd() {
    const fAr = input({ label: t('emp.nameAr'), required: true, attrs: { lang: 'ar', dir: 'rtl', maxlength: '80', autocomplete: 'off' } });
    const fEn = input({ label: t('emp.nameEn'), required: true, attrs: { lang: 'en', dir: 'ltr', maxlength: '80', autocomplete: 'off' } });
    const fPhone = input({ label: t('emp.phone'), hint: t('emp.phoneHint'), attrs: { type: 'tel', dir: 'ltr', inputmode: 'tel', maxlength: '20', autocomplete: 'off' } });
    const fRole = select({ label: t('emp.role'), options: [{ value: 'staff', label: t('role.staff') }, { value: 'owner', label: t('role.owner') }], value: 'staff' });
    const submit = button({ label: t('emp.create'), variant: 'primary', type: 'submit', attrs: { form: 'add-emp' } });
    const form = h('form', { id: 'add-emp', class: 'stack', novalidate: true, onSubmit: async (ev) => {
      ev.preventDefault();
      const v = (f) => f.querySelector('input, select').value.trim();
      let bad = false;
      [[fAr, v(fAr).length >= 2], [fEn, v(fEn).length >= 2]].forEach(([f, ok]) => { setFieldError(f, ok ? null : t('emp.errName')); bad ||= !ok; });
      const phoneOk = !v(fPhone) || PHONE_RE.test(v(fPhone));
      setFieldError(fPhone, phoneOk ? null : t('emp.errPhone')); bad ||= !phoneOk;
      if (bad) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
      setLoading(submit, true, t('common.saving'));
      try {
        const res = await callFunction('owner-employees', { action: 'create', full_name_ar: v(fAr), full_name_en: v(fEn), phone: v(fPhone), role: v(fRole) });
        m.close('created');
        toast({ title: t('emp.created'), tone: 'success' });
        await showCodeOnce({ name: displayName(res.employee), code: res.code });
        load();
      } catch (err) {
        toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' });
      } finally { setLoading(submit, false); }
    } }, h('div', { class: 'form-grid' }, fAr, fEn), h('div', { class: 'form-grid' }, fPhone, fRole));
    const m = modal({ title: t('emp.add'), body: form,
      actions: [button({ label: t('common.cancel'), onClick: () => m.close('cancel') }), submit] });
    m.open();
    fAr.querySelector('input').focus();
  }

  // --------------------------------------------------------- manage
  function openManage(emp) {
    const isMe = emp.id === me.id;
    const body = h('div', { class: 'stack' });
    const m = modal({ title: displayName(emp), body, onClose: () => load() });

    // details
    const fAr = input({ label: t('emp.nameAr'), value: emp.full_name_ar, required: true, attrs: { lang: 'ar', dir: 'rtl', maxlength: '80' } });
    const fEn = input({ label: t('emp.nameEn'), value: emp.full_name_en, required: true, attrs: { lang: 'en', dir: 'ltr', maxlength: '80' } });
    const fPhone = input({ label: t('emp.phone'), value: emp.phone || '', hint: t('emp.phoneHint'), attrs: { type: 'tel', dir: 'ltr', inputmode: 'tel', maxlength: '20' } });
    const saveBtn = button({ label: t('emp.save'), variant: 'primary', type: 'submit' });
    const detailsForm = h('form', { class: 'stack', novalidate: true, onSubmit: async (ev) => {
      ev.preventDefault();
      const v = (f) => f.querySelector('input').value.trim();
      const okAr = v(fAr).length >= 2, okEn = v(fEn).length >= 2, okPh = !v(fPhone) || PHONE_RE.test(v(fPhone));
      setFieldError(fAr, okAr ? null : t('emp.errName')); setFieldError(fEn, okEn ? null : t('emp.errName')); setFieldError(fPhone, okPh ? null : t('emp.errPhone'));
      if (!okAr || !okEn || !okPh) return;
      setLoading(saveBtn, true, t('common.saving'));
      try {
        const res = await callFunction('owner-employees', { action: 'update', employee_id: emp.id, full_name_ar: v(fAr), full_name_en: v(fEn), phone: v(fPhone) });
        Object.assign(emp, res.employee);
        toast({ title: t('emp.saved'), tone: 'success' });
      } catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(saveBtn, false); }
    } }, h('div', { class: 'form-grid' }, fAr, fEn), fPhone, h('div', {}, saveBtn));

    // code
    const regen = button({ label: t('emp.regenerate'), variant: 'secondary', icon: 'lock', onClick: async () => {
      const ok = await confirmDialog({ title: t('emp.regenerate'), text: t(isMe ? 'emp.regenerateOwnConfirm' : 'emp.regenerateConfirm'), confirmLabel: t('emp.regenerate'), variant: 'danger' });
      if (!ok) return;
      setLoading(regen, true, t('common.saving'));
      try {
        const res = await callFunction('owner-employees', { action: 'regenerate_code', employee_id: emp.id });
        await showCodeOnce({ name: displayName(emp), code: res.code });
        loadSessions();
      } catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(regen, false); }
    } });

    // sessions
    const sessionsHost = h('div', { class: 'session-list', 'aria-live': 'polite' });
    async function loadSessions() {
      clear(sessionsHost).append(h('p', { class: 'text-sm text-muted' }, t('common.loading')));
      try {
        const { sessions } = await callFunction('owner-employees', { action: 'list_sessions', employee_id: emp.id });
        clear(sessionsHost);
        if (!sessions.length) { sessionsHost.append(h('p', { class: 'text-sm text-muted' }, t('emp.sessionsEmpty'))); return; }
        for (const s of sessions) {
          const revoke = s.current ? null : button({ label: t('emp.revoke'), size: 'sm', variant: 'secondary', onClick: async () => {
            if (!(await confirmDialog({ title: t('emp.revoke'), text: t('emp.revokeConfirm'), confirmLabel: t('emp.revoke'), variant: 'danger' }))) return;
            setLoading(revoke, true);
            try { await callFunction('owner-employees', { action: 'revoke_session', employee_id: emp.id, session_id: s.session_id }); toast({ title: t('emp.revoked'), tone: 'success' }); loadSessions(); }
            catch (err) { setLoading(revoke, false); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
          } });
          sessionsHost.append(h('div', { class: 'session-item' },
            h('div', { class: 'session-item__meta' },
              h('span', { class: 'session-item__title' }, s.user_agent_summary || '—', s.current ? [' ', badge(t('emp.thisDevice'), { tone: 'accent' })] : null),
              h('span', { class: 'text-muted' }, t('emp.signedIn', { date: formatDateTime(s.created_at) })),
              h('span', { class: 'text-muted' }, t('emp.lastActive', { date: formatDateTime(s.last_active_at) }))),
            revoke));
        }
        if (sessions.some((s) => !s.current)) {
          const all = button({ label: t('emp.revokeAll'), variant: 'danger', size: 'sm', onClick: async () => {
            if (!(await confirmDialog({ title: t('emp.revokeAll'), text: t('emp.revokeAllConfirm'), confirmLabel: t('emp.revokeAll'), variant: 'danger' }))) return;
            setLoading(all, true);
            try { await callFunction('owner-employees', { action: 'revoke_all', employee_id: emp.id }); toast({ title: t('emp.revoked'), tone: 'success' }); loadSessions(); }
            catch (err) { setLoading(all, false); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
          } });
          sessionsHost.append(h('div', {}, all));
        }
      } catch (err) {
        clear(sessionsHost).append(h('p', { class: 'field__error' }, errorMessage(err)));
      }
    }

    // salary (owner-only data)
    const fSalary = input({ label: t('emp.salary'), hint: t('emp.salaryHint'),
      value: emp.monthly_salary_piastres == null ? '' : String(emp.monthly_salary_piastres / 100),
      attrs: { inputmode: 'numeric', dir: 'ltr', maxlength: '9', autocomplete: 'off' } });
    const salaryBtn = button({ label: t('emp.salarySave'), variant: 'primary', type: 'submit' });
    const salaryForm = h('form', { class: 'stack', novalidate: true, onSubmit: async (ev) => {
      ev.preventDefault();
      const raw = fSalary.querySelector('input').value.trim().replace(/[,\s]/g, '');
      if (raw !== '' && !/^\d{1,8}$/.test(raw)) { setFieldError(fSalary, t('emp.errSalary')); return; }
      setFieldError(fSalary, null);
      setLoading(salaryBtn, true, t('common.saving'));
      try {
        const res = await callFunction('owner-employees', { action: 'set_salary', employee_id: emp.id, monthly_salary_egp: raw === '' ? null : Number(raw) });
        emp.monthly_salary_piastres = res.salary.monthly_salary_piastres;
        toast({ title: t('emp.salarySaved'), tone: 'success' });
      } catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(salaryBtn, false); }
    } }, fSalary, h('div', {}, salaryBtn));

    // status
    const statusBtn = isMe ? null : button({
      label: emp.active ? t('emp.deactivate') : t('emp.reactivate'),
      variant: emp.active ? 'danger' : 'primary',
      onClick: async () => {
        if (emp.active && !(await confirmDialog({ title: t('emp.deactivate'), text: t('emp.deactivateConfirm'), confirmLabel: t('emp.deactivate'), variant: 'danger' }))) return;
        setLoading(statusBtn, true);
        try {
          const res = await callFunction('owner-employees', { action: 'set_active', employee_id: emp.id, active: !emp.active });
          emp.active = res.employee.active;
          toast({ title: emp.active ? t('emp.reactivated') : t('emp.deactivated'), tone: 'success' });
          m.close('status');
        } catch (err) { setLoading(statusBtn, false); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      } });

    const section = (title, ...kids) => h('section', { class: 'detail-section' }, h('h3', { class: 'detail-section__title' }, title), ...kids);
    body.append(
      section(t('emp.details'), detailsForm),
      section(t('emp.codeSection'),
        h('p', { class: 'text-sm text-muted' }, emp.code_created_at ? t('emp.codeSet', { date: formatDate(emp.code_created_at) }) : t('emp.codeNone'),
          emp.code_last_used_at ? ` · ${t('emp.codeLastUsed', { date: formatDateTime(emp.code_last_used_at) })}` : ''),
        h('div', {}, regen)),
      section(t('emp.sessions'), sessionsHost),
      section(t('emp.salary'), salaryForm),
      statusBtn ? section(t('emp.statusSection'), h('p', { class: 'text-sm text-muted' }, emp.active ? t('emp.deactivateConfirm') : ''), h('div', {}, statusBtn)) : null);
    m.open();
    loadSessions();
  }

  load();
}
