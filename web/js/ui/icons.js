// Inline SVG icon set (24×24, 2px stroke, round joins). Shapes follow
// the Lucide icon style (ISC licence). Icons are decorative
// (aria-hidden) unless a label is supplied.
const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  building: ['M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16', 'M16 9h2a2 2 0 0 1 2 2v10', 'M3 21h18', 'M8 7h4', 'M8 11h4', 'M8 15h4'],
  calendarCheck: ['M4 6h16v15H4Z', 'M4 10h16', 'M8 3v4', 'M16 3v4', 'M9 15.5l2 2 4-4'],
  clockOff: ['M5.2 5.2A9 9 0 0 0 18.8 18.8', 'M8.5 3.7A9 9 0 0 1 20.3 15.5', 'M12 7v3', 'M3 3l18 18'],
  shield: ['M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6Z', 'M9 12l2 2 4-4'],
  target: ['circle:12,12,8', 'circle:12,12,3', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3'],
  mapPinOff: ['M12 21s-7-6.2-7-11.5c0-1.3.3-2.5.9-3.5', 'M8.3 3.9A7 7 0 0 1 19 9.5c0 2-1 4-2.3 5.8', 'M3 3l18 18'],
  send: ['M21 3 3 10.5l7 3 3 7.5Z', 'M10 13.5 21 3'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'circle:4.5,6,1', 'circle:4.5,12,1', 'circle:4.5,18,1'],
  bulb: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z'],
  wallet: ['M4 7h15a1 1 0 0 1 1 1v11H5a1 1 0 0 1-1-1Z', 'M4 7l11-3v3', 'M16 13h1'],
  hand: ['M8 13V5.5a1.5 1.5 0 0 1 3 0V11', 'M11 10V4.5a1.5 1.5 0 0 1 3 0V11', 'M14 10.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 4 16.4L2.8 12a1.5 1.5 0 0 1 2.7-1.2L8 14'],
  sparkle: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M12 8l1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5Z'],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 2'],
  wifi: ['M2 8.8a15 15 0 0 1 20 0', 'M5 12.5a10 10 0 0 1 14 0', 'M8.5 16a5 5 0 0 1 7 0', 'circle:12,19.5,1'],
  crosshair: ['circle:12,12,7', 'M12 2v4', 'M12 18v4', 'M2 12h4', 'M18 12h4', 'circle:12,12,1.5'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  logIn: ['M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5', 'M10 17l5-5-5-5', 'M15 12H3'],
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5', 'M9.5 21v-6h5v6'],
  clock: ['circle:12,12,9', 'M12 7v5l3 2'],
  mapPin: ['M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z', 'circle:12,9.5,2.5'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9Z'],
  trophy: ['M8 21h8', 'M12 17v4', 'M7 4h10v5a5 5 0 0 1-10 0Z', 'M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5', 'M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11'],
  inbox: ['M3 13h5l1.5 3h5L16 13h5', 'M5.5 5h13L21 13v6H3v-6Z'],
  user: ['circle:12,8,4', 'M4 21a8 8 0 0 1 16 0'],
  users: ['circle:9,8,3.5', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M18 14a6 6 0 0 1 3.5 6'],
  grid: ['rect:3,3,7,7', 'rect:14,3,7,7', 'rect:3,14,7,7', 'rect:14,14,7,7'],
  checkCircle: ['circle:12,12,9', 'M8 12.5l2.5 2.5L16 9.5'],
  fileText: ['M14 3H6v18h12V7Z', 'M14 3v4h4', 'M9 13h6', 'M9 17h6'],
  calendar: ['rect:3,5,18,16', 'M3 10h18', 'M8 3v4', 'M16 3v4'],
  settings: ['circle:12,12,3', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
  logOut: ['M9 21H5V3h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  sun: ['circle:12,12,4', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z'],
  monitor: ['rect:3,4,18,12', 'M8 20h8', 'M12 16v4'],
  globe: ['circle:12,12,9', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  moreHorizontal: ['circle:5,12,1.2', 'circle:12,12,1.2', 'circle:19,12,1.2'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronRight: ['M9 6l6 6-6 6'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  info: ['circle:12,12,9', 'M12 11v5', 'M12 7.5v.5'],
  alertTriangle: ['M12 3.5 2.5 20h19Z', 'M12 10v4', 'M12 17v.5'],
  alertCircle: ['circle:12,12,9', 'M12 7.5v5', 'M12 16v.5'],
  gift: ['rect:3,8,18,4', 'M5 12v9h14v-9', 'M12 8v13', 'M12 8H8a2.5 2.5 0 1 1 0-5c2.5 0 4 5 4 5Z', 'M12 8h4a2.5 2.5 0 1 0 0-5c-2.5 0-4 5-4 5Z'],
  search: ['circle:11,11,7', 'M20 20l-3.5-3.5'],
  plus: ['M12 5v14', 'M5 12h14'],
  lock: ['rect:4,11,16,10', 'M8 11V7a4 4 0 0 1 8 0v4'],
  copy: ['rect:8,8,13,13', 'M16 8V4H3v13h5'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4Z', 'M10 21h4'],
  briefcase: ['rect:3,7,18,13', 'M8 7V4h8v3', 'M3 13h18'],
  share: ['M12 3v12', 'M8 7l4-4 4 4', 'M5 11v9h14v-9'],
  plusSquare: ['rect:3,3,18,18', 'M12 8v8', 'M8 12h8'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
};

function build(spec) {
  const [kind, rest] = spec.includes(':') ? spec.split(':') : ['path', spec];
  if (kind === 'circle') {
    const [cx, cy, r] = rest.split(',');
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
    return c;
  }
  if (kind === 'rect') {
    const [x, y, w, hh] = rest.split(',');
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', hh); r.setAttribute('rx', '1.5');
    return r;
  }
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', rest);
  return p;
}

/**
 * icon('clock', { size: 'sm'|'md'|'lg', flip: true, label: 'Time' })
 * `flip` mirrors directional icons in RTL.
 */
export function icon(name, { size = 'md', flip = false, label } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', ['icon', size !== 'md' && `icon--${size}`, flip && 'icon--flip'].filter(Boolean).join(' '));
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  else svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  (PATHS[name] || PATHS.info).forEach((spec) => svg.append(build(spec)));
  return svg;
}

export const ICON_NAMES = Object.keys(PATHS);
