// Map API / Supabase errors to localized, human messages. Never shows raw
// server text to the user. Server business errors arrive as { error: code,
// detail } and use the `err.<code>` messages (with detail placeholders).
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
  const code = err?.code;
  if (MAP[code]) return t(MAP[code]);
  const key = `err.${code}`;
  const d = err?.detail || {};
  const msg = t(key, {
    distance: d.distance_m, radius: d.radius_m, accuracy: d.accuracy_m,
    detail: typeof d === 'string' ? d : (err?.detail?.toString?.() ?? ''),
  });
  return msg === key ? t('error.generic') : msg;
}
