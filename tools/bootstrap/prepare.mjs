// Step 1 of the initial-owner (or dev seed) bootstrap.
// Creates, in the git-ignored .secrets/ folder:
//   bootstrap-key.json   ECDH P-256 private key (decrypts the sealed reply)
//   bootstrap-token.txt  one-time token for the bootstrap Edge Function
// Prints ONLY the public key and the token's SHA-256 (safe to share):
// insert that hash into private.bootstrap_tokens, then call the function.
// Usage: node tools/bootstrap/prepare.mjs owner|seed_staff
import { webcrypto as crypto, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
const purpose = process.argv[2];
if (!['owner', 'seed_staff'].includes(purpose)) { console.error('usage: prepare.mjs owner|seed_staff'); process.exit(1); }
fs.mkdirSync('.secrets', { recursive: true, mode: 0o700 });
const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
const token = randomBytes(32).toString('base64url');
fs.writeFileSync('.secrets/bootstrap-key.json', JSON.stringify(priv), { mode: 0o600 });
fs.writeFileSync('.secrets/bootstrap-token.txt', token, { mode: 0o600 });
const hash = createHash('sha256').update(token).digest('hex');
console.log(JSON.stringify({ purpose, public_key_jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, token_sha256: hash }, null, 2));
console.log(`\nSQL (run once, expires in 15 min):\ninsert into private.bootstrap_tokens (token_hash, purpose, expires_at) values ('${hash}', '${purpose}', now() + interval '15 minutes');`);
