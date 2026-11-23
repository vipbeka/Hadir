// Employee account operations shared by the owner dashboard
// (owner-employees) and the Telegram admin bot. A generated code is
// returned to the caller ONCE and never stored in plaintext.
import { admin, rpc } from "./clients.ts";
import { newUniqueCode, codeLength } from "./codes.ts";

const syntheticEmail = (id: string) => `${id}@staff.invalid`;

export class EmployeeError extends Error {
  constructor(public code: string) { super(code); }
}

export function mapEmployeeError(e: unknown): never {
  const msg = e instanceof Error ? e.message : "";
  if (/profile not found/.test(msg)) throw new EmployeeError("not_found");
  if (/cannot deactivate yourself/.test(msg)) throw new EmployeeError("cannot_deactivate_self");
  if (/last owner/.test(msg)) throw new EmployeeError("last_owner");
  if (/salary must be/.test(msg)) throw new EmployeeError("invalid_salary");
  throw e;
}

/** Create Auth user + profile + code hash; never leaves a half-created account. */
export async function createEmployee(ownerId: string, input: { nameAr: string; nameEn: string; phone: string | null; role?: "staff" | "owner" }) {
  const role = input.role === "owner" ? "owner" : "staff";
  const id = crypto.randomUUID();
  const { code, hash } = await newUniqueCode(await codeLength());
  const { error: cErr } = await admin.auth.admin.createUser({ id, email: syntheticEmail(id), email_confirm: true, app_metadata: { role } });
  if (cErr) { console.error("createUser failed", cErr.status); throw new EmployeeError("create_failed"); }
  try {
    const employee = await rpc<Record<string, unknown>>("svc_create_employee", {
      p_actor: ownerId, p_user_id: id, p_name_ar: input.nameAr, p_name_en: input.nameEn, p_phone: input.phone, p_role: role, p_code_hash: hash,
    });
    return { employee, code };
  } catch (e) {
    const { error: dErr } = await admin.auth.admin.deleteUser(id);
    if (dErr) console.error("rollback deleteUser failed — orphan auth user", id);
    console.error("create employee failed", e instanceof Error ? e.message : "");
    throw new EmployeeError("create_failed");
  }
}

export async function setActive(ownerId: string, id: string, active: boolean, reason: string | null) {
  try {
    const employee = await rpc<Record<string, unknown>>("svc_set_active", { p_actor: ownerId, p_profile: id, p_active: active, p_reason: reason });
    // Belt and braces: ban the Auth user too, so no new session can be minted.
    await admin.auth.admin.updateUserById(id, { ban_duration: active ? "none" : "876000h" });
    return employee;
  } catch (e) { mapEmployeeError(e); }
}

export async function regenerateCode(ownerId: string, id: string, keepSession: string | null) {
  const { code, hash } = await newUniqueCode(await codeLength());
  try {
    const revoked = await rpc<number>("svc_set_code", { p_actor: ownerId, p_profile: id, p_code_hash: hash, p_keep_session: keepSession });
    return { code, sessions_revoked: revoked };
  } catch (e) { mapEmployeeError(e); }
}
