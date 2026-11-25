// Map API / Supabase errors to localized, human messages. Never shows raw
// server text to the user. Server business errors arrive as { error: code,
// detail } and use the `err.<code>` messages (with detail placeholders).
import { t } from './i18n.js';
import { formatClock } from './format.js';

const MAP = {
  forbidden: 'error.forbidden',
  unauthorized: 'login.sessionEnded',
  network: 'error.network',
  timeout: 'error.timeout',
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
    time: d.closes_at ? formatClock(d.closes_at) : '',
    detail: typeof d === 'string' ? d : (err?.detail?.toString?.() ?? ''),
    max: d.max_minutes, available: d.available, requested: d.requested, start: d.start ? formatClock(d.start) : '',
    end: d.end ? formatClock(d.end) : '',
  });
  return msg === key ? t('error.generic') : msg;
}
