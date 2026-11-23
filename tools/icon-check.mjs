// Verify the installed app icons through the local hosting preview.
//   node tools/icon-check.mjs http://127.0.0.1:8787 [--shots <dir>]
// Checks the SERVED manifest + icons (status, type, PNG signature, size,
// opacity, byte identity with assets/zintra-app-icons/v2), the HTML links,
// that missing paths are real 404s (no app-shell fallback), and that no
// retired icon reference is left. Optionally renders mask previews.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ICONS, RETIRED, pngInfo, sha256 } from './install-app-icons.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
let fails = 0; const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; };

const missingSrc = ICONS.filter(([f]) => !fs.existsSync(path.join(ROOT, 'assets/zintra-app-icons/v2', f))).map(([f]) => f);
if (missingSrc.length) { console.log(`FAIL supplied icons not uploaded yet: assets/zintra-app-icons/v2/{${missingSrc.join(', ')}}`); process.exit(2); }

const manUrl = `${base}/manifest.webmanifest`;
const manRes = await fetch(manUrl); const manText = await manRes.text(); let man = null;
try { man = JSON.parse(manText); } catch { /* reported below */ }
check(manRes.status === 200 && man, 'manifest is served and is valid JSON');
const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
check(JSON.stringify(fb.hosting.headers).includes('application/manifest+json'), 'hosting serves the manifest as application/manifest+json');
check(!fb.hosting.rewrites, 'no hosting rewrites (missing files cannot become the app shell)');
check(man?.id === './' && man?.start_url === './index.html' && man?.scope === './' && man?.display === 'standalone', 'manifest identity, start_url, scope, display unchanged');

const want = { 'zintra-icon-192.png': ['192x192', 'any'], 'zintra-icon-512.png': ['512x512', 'any'], 'zintra-icon-maskable-512.png': ['512x512', 'maskable'] };
for (const [f, [sizes, purpose]] of Object.entries(want)) {
  const e = (man?.icons || []).find((i) => i.src.endsWith(`/zintra-app-icons/v2/${f}`));
  check(e && e.sizes === sizes && e.type === 'image/png' && e.purpose === purpose, `manifest entry ${f} (${sizes}, ${purpose})`);
}
check((man?.icons || []).length === 3 && !(man?.icons || []).some((i) => i.purpose?.includes('any') && i.purpose?.includes('maskable')), 'regular and maskable icons kept separate');

for (const [f, size] of ICONS) {
  const url = new URL(`assets/zintra-app-icons/v2/${f}`, manUrl).href;
  const r = await fetch(url); const buf = Buffer.from(await r.arrayBuffer()); const info = pngInfo(buf);
  const src = fs.readFileSync(path.join(ROOT, 'assets/zintra-app-icons/v2', f));
  check(r.status === 200 && /^image\/png/.test(r.headers.get('content-type') || ''), `${f}: 200 image/png`);
  check(info.png && info.w === size && info.h === size, `${f}: PNG ${info.w}x${info.h}`);
  check(sha256(buf) === sha256(src), `${f}: byte-identical to the supplied file`);
  check(info.opaque === true || !f.startsWith('apple'), `${f}: opaque=${info.opaque}`);
}
const html = await (await fetch(`${base}/index.html`)).text();
check((html.match(/<link rel="manifest"/g) || []).length === 1, 'index.html: exactly one manifest link');
check(/<link rel="apple-touch-icon" sizes="180x180" href="assets\/zintra-app-icons\/v2\/apple-touch-icon-180\.png">/.test(html)
  && (html.match(/rel="apple-touch-icon"/g) || []).length === 1, 'index.html: one apple-touch-icon 180x180 → supplied PNG');
check(/apple-mobile-web-app-capable" content="yes"/.test(html) && /apple-mobile-web-app-title" content="حاضر"/.test(html), 'iOS standalone + title kept');
const miss = await fetch(`${base}/assets/zintra-app-icons/v2/does-not-exist.png`);
check(miss.status === 404 && !/js\/boot\.js|id="app"/.test(await miss.text()), 'a missing icon path is a real 404, not the app shell');

// no retired install-icon references in served source
const hits = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['vendor', 'design'].includes(e.name)) walk(p); }
    else if (/\.(html|js|json|webmanifest|css)$/.test(e.name)) {
      const s = fs.readFileSync(p, 'utf8');
      for (const r of RETIRED) if (s.includes(r)) hits.push(`${path.relative(ROOT, p)} → ${r}`);
    }
  }
})(path.join(ROOT, 'web'));
check(!hits.length, `no retired icon references${hits.length ? `: ${hits.join('; ')}` : ''}`);
for (const r of RETIRED) check(!fs.existsSync(path.join(ROOT, 'web', r)), `retired file removed: web/${r}`);

if (shotsDir) {   // visual: small home-screen sizes + maskable under masks
  const { chromium } = createRequire(import.meta.url)('playwright');
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2 });
  const u = (f) => `${base}/assets/zintra-app-icons/v2/${f}`;
  await page.setContent(`<body style="margin:0;padding:24px;background:#e9edf3;font:14px sans-serif;display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start">
    ${[['zintra-icon-192.png', 60, ''], ['zintra-icon-512.png', 48, ''], ['apple-touch-icon-180.png', 60, 'border-radius:22%'],
       ['zintra-icon-maskable-512.png', 96, 'border-radius:50%'], ['zintra-icon-maskable-512.png', 96, 'border-radius:22%'],
       ['zintra-icon-maskable-512.png', 96, 'clip-path:circle(40% at 50% 50%)']].map(([f, s, st]) =>
      `<figure style="margin:0;text-align:center"><img src="${u(f)}" width="${s}" height="${s}" style="${st};display:block;margin:auto"><figcaption>${f.replace('.png', '')}<br>${s}px ${st.split(':')[0] || 'square'}</figcaption></figure>`).join('')}</body>`);
  await page.waitForTimeout(500); fs.mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: path.join(shotsDir, 'icon-masks.png') }); await b.close();
  console.log(`mask preview: ${path.join(shotsDir, 'icon-masks.png')}`);
}
console.log(fails ? `${fails} icon check(s) FAILED` : 'All icon checks passed');
process.exit(fails ? 1 : 0);
