// Design-token lint: outside web/css/tokens.css, stylesheets and JS
// may not introduce raw colors, font sizes, or spacing values.
// Allowed literals: 0, 1px/2px hairlines, percentages, `auto`, and
// values inside var()/calc() that reference tokens.
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../web/', import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { if (!['assets', 'vendor'].includes(f.name)) walk(p); }
    else if (/\.(css|js)$/.test(f.name) && f.name !== 'tokens.css') files.push(p);
  }
})(root);

const rules = [
  [/#[0-9a-fA-F]{3,8}\b(?![\w-]*\()/, 'raw hex color'],
  [/\brgba?\(|\bhsla?\(/, 'raw rgb/hsl color'],
  [/font-size\s*:(?!\s*(?:var\(|inherit|100%|0\.92em|1em))/, 'font-size without token'],
  [/(?:^|[\s;{])(?:margin|padding|gap|row-gap|column-gap)(?:-[a-z-]+)?\s*:\s*[^;]*\b(?:[3-9]|\d{2,})px/, 'spacing in raw px'],
];
let problems = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/lint-ignore/.test(line)) return;
    const code = line.replace(/\/\/.*$|\/\*.*?\*\//g, '');
    for (const [re, msg] of rules) {
      // JS: only inspect style-ish strings
      if (f.endsWith('.js') && !/(style|background|color|font-size|#[0-9a-f]{6})/i.test(code)) continue;
      if (re.test(code)) { problems++; console.log(`${path.relative(root, f)}:${i + 1}  ${msg}: ${line.trim()}`); }
    }
  });
}
console.log(problems ? `${problems} token violations` : `Token lint clean (${files.length} files)`);
process.exit(problems ? 1 : 0);
