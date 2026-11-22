// Navigation trees. Staff and owner are separate experiences with
// separate route prefixes (/staff/*, /owner/*); no shared role switch.
export const STAFF_NAV = [
  { path: '/staff/home', labelKey: 'nav.home', icon: 'home' },
  { path: '/staff/attendance', labelKey: 'nav.checkIn', icon: 'mapPin' },
  { path: '/staff/points', labelKey: 'nav.points', icon: 'star' },
  { path: '/staff/leaderboard', labelKey: 'nav.leaderboard', icon: 'trophy' },
  { path: '/staff/requests', labelKey: 'nav.requests', icon: 'inbox' },
  { path: '/staff/account', labelKey: 'nav.account', icon: 'user' },
];

export const OWNER_NAV = [
  { path: '/owner/dashboard', labelKey: 'nav.dashboard', icon: 'grid' },
  { path: '/owner/approvals', labelKey: 'nav.approvals', icon: 'checkCircle' },
  { path: '/owner/employees', labelKey: 'nav.employees', icon: 'users' },
  { path: '/owner/leaderboard', labelKey: 'nav.leaderboard', icon: 'trophy' },
  { path: '/owner/payroll', labelKey: 'nav.payroll', icon: 'fileText' },
  { path: '/owner/holidays', labelKey: 'nav.holidays', icon: 'calendar' },
  { path: '/owner/settings', labelKey: 'nav.settings', icon: 'settings' },
  { path: '/owner/account', labelKey: 'nav.account', icon: 'user' },
];

export const HOME = { staff: STAFF_NAV[0].path, owner: OWNER_NAV[0].path };
