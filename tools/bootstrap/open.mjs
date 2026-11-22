// Step 2: decrypt the bootstrap function's sealed reply into .secrets/.
// Writes the code(s) to a file only — NOTHING secret is printed.
// Usage: node tools/bootstrap/open.mjs <file-with-the-JSON-response>
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sealed = raw.sealed ?? raw;
const priv = JSON.parse(fs.readFileSync('.secrets/bootstrap-key.json', 'utf8'));
const myKey = await crypto.subtle.importKey('jwk', priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
const eph = await crypto.subtle.importKey('jwk', sealed.ephemeral_public_jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: eph }, myKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(sealed.iv, 'base64') }, key, Buffer.from(sealed.ciphertext, 'base64'));
const data = JSON.parse(Buffer.from(pt).toString('utf8'));
const file = data.purpose === 'owner' ? '.secrets/owner-code.txt' : '.secrets/dev-staff-codes.txt';
const lines = data.people.map((p) => `${p.name_en} (${p.role}): ${p.code}`);
fs.writeFileSync(file, `Zintra حاضر — login code(s). Shown once. Delete this file after use.\n\n${lines.join('\n')}\n`, { mode: 0o600 });
fs.rmSync('.secrets/bootstrap-key.json', { force: true });
fs.rmSync('.secrets/bootstrap-token.txt', { force: true });
console.log(`Decrypted ${data.people.length} account(s): ${data.people.map((p) => `${p.name_en} (${p.role})`).join(', ')}`);
console.log(`Code(s) written to ${file} (not printed). Bootstrap key and token deleted.`);
