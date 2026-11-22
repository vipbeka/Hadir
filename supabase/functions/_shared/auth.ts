// Caller authentication for owner/staff Edge Functions.
// 1) the bearer token must be a valid Supabase access token (auth.getUser
//    asks the Auth server, which also rejects deleted sessions);
// 2) the profile must be ACTIVE and the token's session must still exist
//    (svc_caller) — so revocation/deactivation apply immediately;
// 3) optional role requirement (owner).
import { admin, rpc } from "./clients.ts";
import { fail } from "./http.ts";

export type Caller = { id: string; role: "owner" | "staff"; sessionId: string; full_name_ar: string; full_name_en: string };

export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  try { return JSON.parse(atob(b64)); } catch { return {}; }
}

export async function requireCaller(req: Request, role?: "owner"): Promise<Caller> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) fail(401, "unauthorized");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) fail(401, "unauthorized");
  const sessionId = String(jwtPayload(token).session_id ?? "");
  if (!sessionId) fail(401, "unauthorized");
  const c = await rpc<Record<string, unknown>>("svc_caller", { p_user: data!.user!.id, p_session: sessionId });
  if (!c?.active) fail(401, "unauthorized");
  if (role && c.role !== role) fail(403, "forbidden");
  return { id: String(c.id), role: c.role as Caller["role"], sessionId, full_name_ar: String(c.full_name_ar), full_name_en: String(c.full_name_en) };
}
