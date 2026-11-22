// Login codes: generation (CSPRNG + rejection sampling), bcrypt hashing,
// uniqueness against all current codes. Plaintext codes exist only in
// memory for the single response that hands them to the owner.
import bcrypt from "bcryptjs";
import { rpc } from "./clients.ts";

const BCRYPT_COST = 10;

/** Uniform random numeric code: bytes ≥ 250 are rejected to avoid modulo bias. */
export function generateCode(length: number): string {
  if (!Number.isInteger(length) || length < 6 || length > 12) throw new Error("bad code length");
  let out = "";
  const buf = new Uint8Array(32);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 250) out += String(b % 10);
      if (out.length === length) break;
    }
  }
  return out;
}

export const hashCode = (code: string): string => bcrypt.hashSync(code, BCRYPT_COST);

export type Candidate = { profile_id: string; code_hash: string; active: boolean };

export const loadCandidates = () => rpc<Candidate[]>("svc_login_candidates");

// A fixed dummy hash so a database with zero codes costs the same time.
const DUMMY = bcrypt.hashSync("000000000000", BCRYPT_COST);

/**
 * Compare a code against EVERY current hash (no early exit), so timing
 * does not reveal whether or where a match occurred. bcrypt's compare is
 * itself constant-time over the hash.
 */
export function matchCode(code: string, candidates: Candidate[]): Candidate | null {
  let found: Candidate | null = null;
  const list = candidates.length ? candidates : [{ profile_id: "", code_hash: DUMMY, active: false }];
  for (const c of list) {
    const ok = bcrypt.compareSync(code, c.code_hash);
    if (ok && c.profile_id && !found) found = c;
  }
  return found;
}

/** New code unique across all current codes (checked against their hashes). */
export async function newUniqueCode(length: number): Promise<{ code: string; hash: string }> {
  const candidates = await loadCandidates();
  for (let i = 0; i < 6; i++) {
    const code = generateCode(length);
    if (!matchCode(code, candidates)) return { code, hash: hashCode(code) };
  }
  throw new Error("could not generate a unique code");
}

export async function codeLength(): Promise<number> {
  const { admin } = await import("./clients.ts");
  const { data } = await admin.from("settings").select("code_length").eq("id", true).single();
  return Math.max(6, Number(data?.code_length ?? 8));
}
