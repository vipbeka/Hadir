// =====================================================================
// Zintra حاضر — owner-employees (OWNER ONLY)
// Actions: list | create | update | regenerate_code | set_active |
//          set_salary | list_sessions | revoke_session | revoke_all
// Auth users are created here with the service role; the browser never
// creates users and never sees the service-role key. A generated code is
// returned ONLY in the create / regenerate_code response, exactly once.
// =====================================================================
import { serve, json, str, fail, UUID_RE, PHONE_RE } from "../_shared/http.ts";
import { rpc } from "../_shared/clients.ts";
import { requireCaller } from "../_shared/auth.ts";
import { createEmployee, setActive, regenerateCode, EmployeeError } from "../_shared/employees.ts";

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

const STATUS: Record<string, number> = { not_found: 404, cannot_deactivate_self: 409, last_owner: 409, invalid_salary: 400, create_failed: 500 };
function mapPg(e: unknown): never {
  if (e instanceof EmployeeError) fail(STATUS[e.code] ?? 500, e.code);
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
      try {
        // The plaintext code appears in this single response only.
        return json(req, await createEmployee(owner.id, { nameAr, nameEn, phone, role: body.role === "owner" ? "owner" : "staff" }));
      } catch (e) { mapPg(e); }
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
      // Regenerating your own code keeps your current session alive.
      try { return json(req, await regenerateCode(owner.id, id, id === owner.id ? owner.sessionId : null)); } catch (e) { mapPg(e); }
      break;
    }

    case "set_active": {
      const id = target(body);
      try { return json(req, { employee: await setActive(owner.id, id, body.active === true, str(body.reason, { max: 300 })) }); } catch (e) { mapPg(e); }
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
