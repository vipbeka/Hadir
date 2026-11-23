// Install the supplied Zintra app icons (v2) into the PWA — byte-for-byte.
//   node tools/install-app-icons.mjs          → validate + install + rewire
//   node tools/install-app-icons.mjs --check  → validate only
// Input: assets/zintra-app-icons/v2/{zintra-icon-192.png, zintra-icon-512.png,
//        zintra-icon-maskable-512.png, apple-touch-icon-180.png} (repo root).
// If GitHub nested them, they are found by exact name and moved (bytes unchanged).
// Nothing is redrawn, resized or recoloured. Fails loudly if a file is missing.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SRC_DIR = path.join(ROOT, 'assets/zintra-app-icons/v2');
const WEB = path.join(ROOT, 'web');
const DEST_REL = 'assets/zintra-app-icons/v2';
export const ICONS = [
  ['zintra-icon-192.png', 192], ['zintra-icon-512.png', 512], ['zintra-icon-maskable-512.png', 512], ['apple-touch-icon-180.png', 180],
];
export const RETIRED = ['assets/icons/icon-192.png', 'assets/icons/icon-512.png', 'assets/icons/icon-maskable-512.png',
  'assets/icons/apple-touch-icon.png', 'assets/icons/favicon-32.png', 'assets/icons/favicon-16.png', 'favicon.ico'];

/** PNG facts: signature, size, and whether every pixel is opaque. */
export function pngInfo(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { png: false };
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), depth = buf[24], ct = buf[25], interlace = buf[28];
  const idat = []; let off = 8; let trns = false;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'tRNS') trns = true;
    off += 12 + len;
  }
  let opaque = null;
  if (ct === 2 || ct === 0) opaque = !trns;                         // RGB / grey without tRNS: opaque by definition
  else if ((ct === 6 || ct === 4) && depth === 8 && interlace === 0) {  // RGBA / grey+alpha: decode and check alpha
    const bpp = ct === 6 ? 4 : 2; const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * bpp;
    let prev = Buffer.alloc(stride); opaque = true;
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)]; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
      }
      for (let x = bpp - 1; x < stride; x += bpp) if (line[x] !== 255) { opaque = false; break; }
      if (!opaque) break;
      prev = line;
    }
  }
  return { png: true, w, h, colorType: ct, opaque };
}
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function locate() {
  const found = {}; const missing = [];
  for (const [name] of ICONS) {
    const want = path.join(SRC_DIR, name);
    if (fs.existsSync(want)) { found[name] = want; continue; }
    const hits = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'web'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (e.name === name) hits.push(p);
      }
    })(ROOT);
    if (hits.length === 1) {                       // normalise a nested upload, bytes unchanged
      fs.mkdirSync(SRC_DIR, { recursive: true });
      const before = sha256(fs.readFileSync(hits[0]));
      fs.renameSync(hits[0], want);
      if (sha256(fs.readFileSync(want)) !== before) throw new Error(`moving ${name} changed its bytes`);
      console.log(`moved ${path.relative(ROOT, hits[0])} → ${path.relative(ROOT, want)}`);
      found[name] = want;
    } else missing.push(hits.length > 1 ? `${name} (found ${hits.length} copies: ${hits.map((h) => path.relative(ROOT, h)).join(', ')})` : name);
  }
  return { found, missing };
}

function validate(found) {
  const problems = [];
  for (const [name, size] of ICONS) {
    const info = pngInfo(fs.readFileSync(found[name]));
    if (!info.png) problems.push(`${name}: not a PNG`);
    else if (info.w !== size || info.h !== size) problems.push(`${name}: ${info.w}x${info.h}, expected ${size}x${size}`);
    else if (name.startsWith('apple') && info.opaque !== true) problems.push(`${name}: must be opaque for iOS`);
  }
  return problems;
}

function rewire() {
  const rel = (f) => `${DEST_REL}/${f}`;
  // manifest: separate any / maskable entries; everything else unchanged
  const mPath = path.join(WEB, 'manifest.webmanifest'); const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  m.icons = [
    { src: rel('zintra-icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: rel('zintra-icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: rel('zintra-icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  for (const s of m.shortcuts || []) s.icons = [{ src: rel('zintra-icon-192.png'), sizes: '192x192', type: 'image/png' }];
  fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');

  // index.html: one icon link, one apple-touch-icon (180), one manifest link; apple meta kept
  const iPath = path.join(WEB, 'index.html'); let html = fs.readFileSync(iPath, 'utf8');
  html = html.replace(/\s*<link rel="icon"[^>]*>/g, '').replace(/\s*<link rel="apple-touch-icon"[^>]*>/g, '');
  html = html.replace(/(\s*)<link rel="manifest"[^>]*>/, `$1<link rel="icon" type="image/png" sizes="192x192" href="${rel('zintra-icon-192.png')}">` +
    `$1<link rel="apple-touch-icon" sizes="180x180" href="${rel('apple-touch-icon-180.png')}">$1<link rel="manifest" href="manifest.webmanifest">`);
  fs.writeFileSync(iPath, html);
  for (const [f, prefix] of [['offline.html', ''], ['404.html', '/']]) {
    const p = path.join(WEB, f); let x = fs.readFileSync(p, 'utf8');
    x = x.replace(/\s*<link rel="icon"[^>]*>/g, '').replace('<meta name="theme-color"', `<link rel="icon" type="image/png" sizes="192x192" href="${prefix}${rel('zintra-icon-192.png')}">\n  <meta name="theme-color"`);
    fs.writeFileSync(p, x);
  }
  // service worker: precache the new icons, notification icon, cache version bump
  const swPath = path.join(WEB, 'sw.js'); let sw = fs.readFileSync(swPath, 'utf8');
  sw = sw.replace(`'./manifest.webmanifest', './favicon.ico',`, `'./manifest.webmanifest',`)
    .replace(/'\.\/assets\/icons\/icon-192\.png', '\.\/assets\/icons\/icon-512\.png', '\.\/assets\/icons\/apple-touch-icon\.png',/,
      `'./${rel('zintra-icon-192.png')}', './${rel('zintra-icon-512.png')}', './${rel('zintra-icon-maskable-512.png')}', './${rel('apple-touch-icon-180.png')}',`)
    .replace(`icon: './assets/icons/icon-192.png',`, `icon: './${rel('zintra-icon-192.png')}',`)
    .replace(`badge: './assets/icons/favicon-32.png',`, `badge: './${rel('zintra-icon-192.png')}',`)
    .replace(/const VERSION = 'zh-v(\d+)';/, (_, n) => `const VERSION = 'zh-v${Number(n) + 1}';`);
  fs.writeFileSync(swPath, sw);
  // in-app install card + the design reference page
  for (const [f, from, to] of [['js/ui/install.js', '../../assets/icons/icon-192.png', `../../${rel('zintra-icon-192.png')}`]]) {
    const p = path.join(WEB, f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(from, to));
  }
  const dPath = path.join(WEB, 'js/pages/design.js');
  if (fs.existsSync(dPath)) {
    fs.writeFileSync(dPath, fs.readFileSync(dPath, 'utf8').replace(
      /\[\['favicon-16\.png', 16\], \['favicon-32\.png', 32\], \['apple-touch-icon\.png', 60\], \['icon-192\.png', 64\], \['icon-maskable-512\.png', 64\]\]\.map\(\(\[f, s\]\) =>\n\s*h\('img', \{ src: `\.\.\/assets\/icons\/\$\{f\}`/,
      "[['zintra-icon-192.png', 64], ['apple-touch-icon-180.png', 60], ['zintra-icon-maskable-512.png', 64]].map(([f, s]) =>\n        h('img', { src: `../assets/zintra-app-icons/v2/${f}`"));
  }
  // retire the superseded icon files (no other use: checked by tools/icon-check.mjs)
  for (const r of RETIRED) { const p = path.join(WEB, r); if (fs.existsSync(p)) fs.rmSync(p); }
  const old = path.join(WEB, 'assets/icons'); if (fs.existsSync(old) && !fs.readdirSync(old).length) fs.rmdirSync(old);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { found, missing } = locate();
  if (missing.length) {
    console.error(`MISSING icon upload — put these exact files in ${path.relative(ROOT, SRC_DIR)}/ :\n  ${missing.join('\n  ')}`);
    process.exit(2);
  }
  const problems = validate(found);
  if (problems.length) { console.error(`Icon files rejected:\n  ${problems.join('\n  ')}`); process.exit(3); }
  if (process.argv.includes('--check')) { console.log('Icons valid.'); process.exit(0); }
  fs.mkdirSync(path.join(WEB, DEST_REL), { recursive: true });
  for (const [name] of ICONS) fs.copyFileSync(found[name], path.join(WEB, DEST_REL, name));
  rewire();
  console.log(`Installed ${ICONS.length} icons into web/${DEST_REL} and rewired manifest, HTML, service worker and install card.`);
}
