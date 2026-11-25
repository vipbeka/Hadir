// Navigation trees. Staff and owner are separate experiences with
// separate route prefixes (/staff/*, /owner/*); no shared role switch.
// `bottom` items appear in the floating bottom bar (staff 6, owner 3 + «المزيد»). Every item is
// listed in the side panel opened by the hamburger.
export const STAFF_NAV = [
  { path: '/staff/home', labelKey: 'nav.home', icon: 'home', bottom: true },
  { path: '/staff/attendance', labelKey: 'nav.checkIn', icon: 'mapPin', bottom: true },
  { path: '/staff/points', labelKey: 'nav.points', icon: 'star', bottom: true },
  { path: '/staff/requests', labelKey: 'nav.requests', icon: 'inbox', bottom: true },
  { path: '/staff/announcements', labelKey: 'nav.announcements', icon: 'bell', bottom: true },
  { path: '/staff/statement', labelKey: 'nav.myStatement', icon: 'fileText', bottom: true, bottomLabelKey: 'nav.statementShort' },
  { path: '/staff/leaderboard', labelKey: 'nav.leaderboard', icon: 'trophy' },
  { path: '/staff/account', labelKey: 'nav.account', icon: 'user' },
];

export const OWNER_NAV = [
  { path: '/owner/dashboard', labelKey: 'nav.dashboard', icon: 'grid', bottom: true },
  { path: '/owner/approvals', labelKey: 'nav.approvals', icon: 'checkCircle', bottom: true },
  { path: '/owner/employees', labelKey: 'nav.employees', icon: 'users', bottom: true },
  { path: '/owner/notifications', labelKey: 'nav.notifications', icon: 'inbox' },
  { path: '/owner/leaderboard', labelKey: 'nav.leaderboard', icon: 'trophy' },
  { path: '/owner/announcements', labelKey: 'nav.announcements', icon: 'bell' },
  { path: '/owner/payroll', labelKey: 'nav.payroll', icon: 'fileText' },
  { path: '/owner/holidays', labelKey: 'nav.holidays', icon: 'calendar' },
  { path: '/owner/settings', labelKey: 'nav.settings', icon: 'settings' },
  { path: '/owner/account', labelKey: 'nav.account', icon: 'user' },
];

export const HOME = { staff: STAFF_NAV[0].path, owner: OWNER_NAV[0].path };
