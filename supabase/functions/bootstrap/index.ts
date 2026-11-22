// =====================================================================
// Zintra حاضر — bootstrap (developer-only, one-time)
// ---------------------------------------------------------------------
// Creates the initial owner (purpose "owner", only while no owner exists)
// or three dev/test staff accounts (purpose "seed_staff"). Requires a
// one-time token whose SHA-256 a developer inserted into
// private.bootstrap_tokens (see README → "Initial owner code").
//
// The generated codes are NEVER returned in clear text: the response is
// encrypted (ECDH P-256 + AES-GCM) to the public key sent by the
// developer's local tool, which decrypts it into a git-ignored file
// (.secrets/). So codes don't appear in logs, network captures or chat.
// =====================================================================
import { serve, json, str, fail } from "../_shared/http.ts";
import { admin, rpc } from "../_shared/clients.ts";
import { newUniqueCode, codeLength } from "../_shared/codes.ts";

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));

async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sealFor(pubJwk: JsonWebKey, data: unknown) {
  const recipient = await crypto.subtle.importKey("jwk", pubJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: recipient }, eph.privateKey,
    { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return { ephemeral_public_jwk: await crypto.subtle.exportKey("jwk", eph.publicKey), iv: b64(iv), ciphertext: b64(ct) };
}

async function createPerson(actor: string | null, p: { ar: string; en: string; role: "owner" | "staff" }) {
  const id = crypto.randomUUID();
  const { code, hash } = await newUniqueCode(await codeLength());
  const { error } = await admin.auth.admin.createUser({ id, email: `${id}@staff.invalid`, email_confirm: true, app_metadata: { role: p.role } });
  if (error) fail(500, "create_failed");
  try {
    await rpc("svc_create_employee", { p_actor: actor ?? id, p_user_id: id, p_name_ar: p.ar, p_name_en: p.en, p_phone: null, p_role: p.role, p_code_hash: hash });
  } catch {
    await admin.auth.admin.deleteUser(id);
    fail(500, "create_failed");
  }
  return { id, name_en: p.en, role: p.role, code };
}

serve(async (req, body) => {
  const token = str(body.token, { min: 32, max: 128 });
  const purpose = body.purpose === "owner" ? "owner" : body.purpose === "seed_staff" ? "seed_staff" : null;
  const pub = body.public_key_jwk as JsonWebKey | undefined;
  if (!token || !purpose || !pub || pub.kty !== "EC" || pub.crv !== "P-256") fail(400, "invalid_request");
  const ok = await rpc<boolean>("svc_bootstrap_consume", { p_token_hash: await sha256hex(token!), p_purpose: purpose });
  if (!ok) fail(403, "forbidden");

  const people = [];
  if (purpose === "owner") {
    const ar = str(body.owner_name_ar, { min: 2, max: 80 }) ?? "مالك زينترا";
    const en = str(body.owner_name_en, { min: 2, max: 80 }) ?? "Zintra Owner";
    people.push(await createPerson(null, { ar, en, role: "owner" }));
  } else {
    const { data: o } = await admin.from("profiles").select("id").eq("role", "owner").eq("active", true).limit(1).single();
    if (!o) fail(409, "owner_missing");
    for (const [i, ar] of ["موظف تجريبي 1", "موظف تجريبي 2", "موظف تجريبي 3"].entries()) {
      people.push(await createPerson(o!.id, { ar, en: `Demo Staff ${i + 1}`, role: "staff" }));
    }
  }
  return json(req, { sealed: await sealFor(pub!, { purpose, people }) });
});
