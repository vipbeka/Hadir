// Map API / Supabase errors to localized, human messages. Never shows raw
// server text to the user.
import { t } from './i18n.js';

const MAP = {
  forbidden: 'error.forbidden',
  unauthorized: 'login.sessionEnded',
  network: 'error.network',
  offline: 'status.offline',
  invalid_name: 'emp.errName',
  invalid_phone: 'emp.errPhone',
  invalid_salary: 'emp.errSalary',
  cannot_deactivate_self: 'emp.errSelf',
  last_owner: 'emp.errLastOwner',
};

export function errorMessage(err) {
  const key = MAP[err?.code];
  return key ? t(key) : t('error.generic');
}
