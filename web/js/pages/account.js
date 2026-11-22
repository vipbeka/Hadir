// My account — staff and owner. Shows only the person's own profile
// fields. There is NO salary field here for anyone (salary is owner-only
// data shown only in the owner's employee management).
import { h } from '../core/dom.js';
import { t, setDocumentTitle } from '../core/i18n.js';
import { callFunction } from '../core/api.js';
import { errorMessage } from '../core/errors.js';
import { displayName } from '../core/format.js';
import { pageHeader } from '../shell/shell.js';
import { card } from '../ui/display.js';
import { button, setLoading } from '../ui/button.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { showCodeOnce } from '../ui/code-dialog.js';

export function renderAccount(main, { me, onSignOut }) {
  setDocumentTitle(t('account.title'));
  const dl = h('dl', { class: 'kv' },
    h('dt', {}, t('account.name')), h('dd', {}, displayName(me)),
    h('dt', {}, t('account.phone')), h('dd', { dir: 'ltr', class: 'num' }, me.phone || '—'),
    h('dt', {}, t('account.role')), h('dd', {}, t(`role.${me.role}`)));
  const signOut = button({ label: t('common.signOut'), variant: 'secondary', icon: 'logOut', onClick: onSignOut });
  signOut.querySelector('.icon')?.classList.add('icon--flip');

  main.append(pageHeader({ title: t('account.title'), subtitle: t('account.subtitle') }),
    card({ title: displayName(me), body: dl }));

  if (me.role === 'owner') {
    const regen = button({ label: t('emp.regenerate'), variant: 'secondary', icon: 'lock', onClick: async () => {
      if (!(await confirmDialog({ title: t('emp.regenerate'), text: t('emp.regenerateOwnConfirm'), confirmLabel: t('emp.regenerate'), variant: 'danger' }))) return;
      setLoading(regen, true, t('common.saving'));
      try {
        const res = await callFunction('owner-employees', { action: 'regenerate_code', employee_id: me.id });
        await showCodeOnce({ name: displayName(me), code: res.code });
      } catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { setLoading(regen, false); }
    } });
    main.append(card({ title: t('account.myCode'), body: h('p', { class: 'text-sm text-muted' }, t('account.myCodeHint')), footer: [regen] }));
  }
  main.append(card({ title: t('common.signOut'), body: h('p', { class: 'text-sm text-muted' }, t('account.signOutHint')), footer: [signOut] }));
}
