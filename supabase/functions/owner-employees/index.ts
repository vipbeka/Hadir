// =====================================================================
// Zintra حاضر — owner-employees (OWNER ONLY)
// Actions: list | create | update | regenerate_code | set_active |
//          set_salary | list_sessions | revoke_session | revoke_all
// Auth users are created here with the service role; the browser never
// creates users and never sees the service-role key. A generated code is
// returned ONLY in the create / regenerate_code response, exactly once.
// =====================================================================
import { serve, json, str, fail, UUID_RE, PHONE_RE } from "../_shared/http.ts";
import { admin, rpc } from "../_shared/clients.ts";
import { requireCaller } from "../_shared/auth.ts";
import { newUniqueCode, codeLength } from "../_shared/codes.ts";

const syntheticEmail = (id: string) => `${id}@staff.invalid`;

function names(body: Record<string, unknown>) {
  const nameAr = str(body.full_name_ar, { min: 2, max: 80 });
  const nameEn = str(body.full_name_en, { min: 2, max: 80 });
  const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
  const phone = phoneRaw === "" ? null : str(phoneRaw, { pattern: PHONE_RE });
  if (!nameAr || !nameEn) fail(400, "invalid_name");
  if (phoneRaw !== "" && !phone) fail(400, "invalid_phone");
  return { nameAr: nameAr!, nameEn: nameEn!, phone };
}

function target(body: Record<string, unknown>): string {
  const id = str(body.employee_id, { pattern: UUID_RE });
  if (!id) fail(400, "invalid_employee");
  return id!;
}

function mapPg(e: unknown): never {
  const msg = e instanceof Error ? e.message : "";
  if (/profile not found/.test(msg)) fail(404, "not_found");
  if (/cannot deactivate yourself/.test(msg)) fail(409, "cannot_deactivate_self");
  if (/last owner/.test(msg)) fail(409, "last_owner");
  if (/salary must be/.test(msg)) fail(400, "invalid_salary");
  throw e;
}

serve(async (req, body) => {
  const owner = await requireCaller(req, "owner");
  const action = str(body.action, { max: 40 });

  switch (action) {
    case "list": {
      return json(req, { employees: await rpc("svc_list_employees") });
    }

    case "create": {
      const { nameAr, nameEn, phone } = names(body);
      const role = body.role === "owner" ? "owner" : "staff";
      const id = crypto.randomUUID();
      const { code, hash } = await newUniqueCode(await codeLength());
      // 1) auth user (synthetic internal email, no password, never emailed)
      const { error: cErr } = await admin.auth.admin.createUser({
        id, email: syntheticEmail(id), email_confirm: true, app_metadata: { role },
      });
      if (cErr) { console.error("createUser failed", cErr.status); fail(500, "create_failed"); }
      // 2) profile + salary placeholder + code hash in ONE transaction;
      //    on failure roll back the auth user — never a half-created account.
      try {
        const employee = await rpc("svc_create_employee", {
          p_actor: owner.id, p_user_id: id, p_name_ar: nameAr, p_name_en: nameEn, p_phone: phone, p_role: role, p_code_hash: hash,
        });
        // The plaintext code appears in this single response only.
        return json(req, { employee, code });
      } catch (e) {
        const { error: dErr } = await admin.auth.admin.deleteUser(id);
        if (dErr) console.error("rollback deleteUser failed — orphan auth user", id);
        console.error("create employee failed", e instanceof Error ? e.message : "");
        fail(500, "create_failed");
      }
      break;
    }

    case "update": {
      const id = target(body);
      const { nameAr, nameEn, phone } = names(body);
      try {
        return json(req, { employee: await rpc("svc_update_employee", { p_actor: owner.id, p_profile: id, p_name_ar: nameAr, p_name_en: nameEn, p_phone: phone }) });
      } catch (e) { mapPg(e); }
      break;
    }

    case "regenerate_code": {
      const id = target(body);
      const { code, hash } = await newUniqueCode(await codeLength());
      // Regenerating your own code keeps your current session alive.
      const keep = id === owner.id ? owner.sessionId : null;
      try {
        const revoked = await rpc<number>("svc_set_code", { p_actor: owner.id, p_profile: id, p_code_hash: hash, p_keep_session: keep });
        return json(req, { code, sessions_revoked: revoked });
      } catch (e) { mapPg(e); }
      break;
    }

    case "set_active": {
      const id = target(body);
      const active = body.active === true;
      try {
        const employee = await rpc("svc_set_active", { p_actor: owner.id, p_profile: id, p_active: active, p_reason: str(body.reason, { max: 300 }) });
        // Belt and braces: ban the Auth user too, so no new session can be minted.
        await admin.auth.admin.updateUserById(id, { ban_duration: active ? "none" : "876000h" });
        return json(req, { employee });
      } catch (e) { mapPg(e); }
      break;
    }

    case "set_salary": {
      const id = target(body);
      let piastres: number | null = null;
      if (body.monthly_salary_egp !== null && body.monthly_salary_egp !== "") {
        const egp = Number(body.monthly_salary_egp);
        if (!Number.isInteger(egp) || egp < 0 || egp > 10_000_000) fail(400, "invalid_salary");
        piastres = egp * 100;
      }
      try {
        return json(req, { salary: await rpc("svc_set_salary", { p_actor: owner.id, p_profile: id, p_piastres: piastres }) });
      } catch (e) { mapPg(e); }
      break;
    }

    case "list_sessions": {
      const id = target(body);
      const sessions = await rpc<Array<Record<string, unknown>>>("svc_list_sessions", { p_profile: id });
      return json(req, { sessions: sessions.map((s) => ({ ...s, current: s.session_id === owner.sessionId })) });
    }

    case "revoke_session": {
      const id = target(body);
      const sid = str(body.session_id, { pattern: UUID_RE });
      if (!sid) fail(400, "invalid_session");
      return json(req, { revoked: await rpc("svc_revoke_sessions", { p_actor: owner.id, p_profile: id, p_session: sid }) });
    }

    case "revoke_all": {
      const id = target(body);
      // Revoking all of your OWN sessions keeps the current one.
      const keep = id === owner.id ? owner.sessionId : null;
      return json(req, { revoked: await rpc("svc_revoke_sessions", { p_actor: owner.id, p_profile: id, p_session: null, p_reason: "owner revoke all", p_keep_session: keep }) });
    }

    default:
      fail(400, "unknown_action");
  }
  fail(500, "server_error");
  return json(req, {}); // unreachable
});
