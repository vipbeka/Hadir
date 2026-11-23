// =====================================================================
// Zintra حاضر — login (code-only)
// Codes are random 8-digit, stored only as bcrypt hashes and verified here.
// Lockout: the pre-check reserves an attempt row per request under a
// per-client advisory lock, so parallel requests cannot exceed the
// failure allowance; svc_login_record_v2 completes that row.
// Session: a real Supabase Auth session minted server-side (magiclink
// hashed token -> verifyOtp; no email is ever sent).
// =====================================================================
import { serve, json, str, fail } from "../_shared/http.ts";
import { admin, anonClient, rpc, serviceKeyForHmac } from "../_shared/clients.ts";
import { loadCandidates, matchCode } from "../_shared/codes.ts";
import { jwtPayload } from "../_shared/auth.ts";

const MIN_RESPONSE_MS = 1200; // uniform floor so success/failure/lockout timing look alike

async function hmac(value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`zh-login-v1|${serviceKeyForHmac()}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return (xff.split(",")[0] || req.headers.get("cf-connecting-ip") || "unknown").trim();
}

function approxIp(ip: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::/48";
  return "unknown";
}

function uaSummary(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Other";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} · ${os}`;
}

async function padTo(start: number) {
  const wait = MIN_RESPONSE_MS + Math.floor(Math.random() * 150) - (Date.now() - start);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

serve(async (req, body) => {
  const started = Date.now();
  // Never log `body`: it contains the submitted code.
  const code = str(body.code, { min: 6, max: 12, pattern: /^\d+$/ });
  const deviceId = str(body.device_id, { min: 8, max: 64, pattern: /^[A-Za-z0-9-]+$/ }) ?? "no-device";
  const ipHash = await hmac(`ip:${clientIp(req)}`);
  const devHash = await hmac(`dev:${deviceId}`);

  const pre = await rpc<{ allowed: boolean; retry_after_s?: number; attempt_id?: number }>("svc_login_precheck", { p_ip_hash: ipHash, p_device_hash: devHash });
  if (!pre.allowed) {
    // A correct code is refused too while locked out (we don't even check it).
    await rpc("svc_login_record_v2", { p_ip_hash: ipHash, p_device_hash: devHash, p_success: false, p_profile: null, p_refused_locked: true });
    await padTo(started);
    return json(req, { error: "locked_out", retry_after_s: pre.retry_after_s ?? 900 }, 429);
  }

  const candidates = await loadCandidates();
  const match = code ? matchCode(code, candidates) : (matchCode("000000000000", candidates), null);

  if (!match || !match.active) {
    const rec = await rpc<{ locked: boolean }>("svc_login_record_v2", { p_ip_hash: ipHash, p_device_hash: devHash, p_success: false, p_profile: null, p_attempt: pre.attempt_id ?? null });
    await padTo(started);
    // Same message whether the code is malformed, unknown, or belongs to a
    // deactivated person. If this failure tripped the lockout, say so.
    return rec.locked ? json(req, { error: "locked_out", retry_after_s: 900 }, 429) : json(req, { error: "code_not_recognized" }, 401);
  }

  // ---- mint a real Supabase session for this profile's Auth user ----
  const { data: userRes, error: userErr } = await admin.auth.admin.getUserById(match.profile_id);
  if (userErr || !userRes?.user?.email) fail(500, "server_error");
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: userRes!.user!.email! });
  if (linkErr || !link?.properties?.hashed_token) fail(500, "server_error");
  const { data: verified, error: vErr } = await anonClient().auth.verifyOtp({ token_hash: link!.properties!.hashed_token, type: "magiclink" });
  if (vErr || !verified?.session) fail(500, "server_error");

  const session = verified!.session!;
  const sessionId = String(jwtPayload(session.access_token).session_id ?? "");
  await rpc("svc_login_record_v2", { p_ip_hash: ipHash, p_device_hash: devHash, p_success: true, p_profile: match.profile_id, p_attempt: pre.attempt_id ?? null });
  await rpc("svc_login_success", {
    p_profile: match.profile_id, p_session: sessionId,
    p_user_agent: uaSummary(req.headers.get("user-agent") ?? ""), p_approx_ip: approxIp(clientIp(req)),
  });
  const { data: profile } = await admin.from("profiles").select("role").eq("id", match.profile_id).single();

  await padTo(started);
  return json(req, {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    role: profile?.role ?? "staff",
  });
});
