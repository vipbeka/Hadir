// =====================================================================
// حاضر (Hadir) — api (single entry point for staff + owner actions)
// The caller is authenticated (requireCaller); the action decides the
// required role; the SQL function (svc_*) enforces every business rule
// on the database clock. Errors 'ZH:<code>' map to { error: code }.
// =====================================================================
import { serve, json, str, fail } from "../_shared/http.ts";
import { admin } from "../_shared/clients.ts";
import { requireCaller } from "../_shared/auth.ts";
import { tg, webhookSecret, hasToken, formatOwnerMessage } from "../_shared/telegram.ts";

type Role = "staff" | "owner" | "any";
const ACTIONS: Record<string, [string, Role]> = {
  // staff (and any signed-in person for read-only)
  my_day: ["svc_my_day", "any"], my_summary: ["svc_my_summary", "any"],
  check_in: ["svc_check_in", "staff"], check_out: ["svc_check_out", "staff"],
  request_leave: ["svc_request_leave", "staff"], cancel_leave: ["svc_cancel_leave", "staff"],
  request_early_leave: ["svc_request_early_leave", "staff"], cancel_early_leave: ["svc_cancel_early_leave", "staff"],
  request_reward: ["svc_request_reward", "staff"], set_reminders: ["svc_set_reminders", "any"],
  // owner
  owner_dashboard: ["svc_owner_dashboard", "owner"], pending: ["svc_pending", "owner"],
  decide_black: ["svc_decide_black", "owner"], decide_leave: ["svc_decide_leave", "owner"], comment_leave: ["svc_comment_leave", "owner"],
  decide_early_leave: ["svc_decide_early_leave", "owner"], decide_reward: ["svc_decide_reward", "owner"],
  award_outcome: ["svc_award_outcome", "owner"], manual_adjust: ["svc_manual_adjust", "owner"],
  correct_attendance: ["svc_correct_attendance", "owner"], update_settings: ["svc_update_settings", "owner"],
  // save_day keeps working for older clients but goes through the atomic
  // multi-day save, so omitted point flags are inherited (never reset).
  save_day: ["svc_save_days", "owner"], save_days: ["svc_save_days", "owner"], save_holiday: ["svc_save_holiday", "owner"],
  payroll: ["svc_payroll", "owner"], export_raw: ["svc_export_raw", "owner"], employee_points: ["svc_employee_points", "owner"],
  run_job: ["svc_run_job", "owner"], set_job_title: ["svc_set_job_title", "owner"],
  broadcast: ["svc_broadcast", "owner"], list_announcements: ["svc_list_announcements", "owner"],
  delete_announcement: ["svc_delete_announcement", "owner"],
  // owner Telegram reports (features 5–8); every function re-checks the owner
  sched_ann_save: ["svc_sched_ann_save", "owner"], sched_ann_cancel: ["svc_sched_ann_cancel", "owner"],
  sched_ann_list: ["svc_sched_ann_list", "owner"], bot_reports_status: ["svc_bot_reports_status", "owner"],
  save_report_settings: ["svc_save_report_settings", "owner"], payroll_summary_resend: ["svc_payroll_summary_resend", "owner"],
};

serve(async (req, body) => {
  const caller = await requireCaller(req);
  const action = str(body.action, { max: 40 }) ?? "";
  const p = (typeof body.params === "object" && body.params !== null && !Array.isArray(body.params)) ? body.params as Record<string, unknown> : {};

  // Telegram setup actions (owner): register the webhook / send a test.
  if (action === "telegram_connect" || action === "telegram_test" || action === "telegram_status") {
    if (caller.role !== "owner") fail(403, "forbidden");
    if (action === "telegram_status" && !hasToken()) return json(req, { data: { connected: false, token_missing: true } });
    if (!hasToken()) return json(req, { error: "telegram_token_missing" }, 400);
    if (action === "telegram_status") {
      const info = await tg("getWebhookInfo", {});
      const r = (info.result ?? {}) as Record<string, unknown>;
      return json(req, { data: { connected: !!r.url, pending: r.pending_update_count ?? 0, last_error: r.last_error_message ?? null } });
    }
    if (action === "telegram_connect") {
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-webhook`;
      const r = await tg("setWebhook", { url, secret_token: await webhookSecret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
      return r.ok ? json(req, { data: { ok: true } }) : json(req, { error: "telegram_failed", detail: String(r.description ?? "") }, 400);
    }
    const { data } = await admin.from("settings").select("owner_telegram_chat_id").eq("id", true).single();
    const msg = formatOwnerMessage({ kind: "test" });
    const r = await tg("sendMessage", { chat_id: data?.owner_telegram_chat_id, text: msg.text, parse_mode: "HTML" });
    return r.ok ? json(req, { data: { ok: true } }) : json(req, { error: "telegram_failed", detail: String(r.description ?? "") }, 400);
  }

  const entry = ACTIONS[action];
  if (!entry) fail(400, "unknown_action");
  const [fn, role] = entry!;
  if (role === "owner" && caller.role !== "owner") fail(403, "forbidden");
  if (role === "staff" && caller.role !== "staff") fail(403, "staff_only");

  const params = action === "save_day" ? { days: [p] }
    : action === "delete_announcement" ? { id: p.id, via: "web" } : p;
  const { data, error } = await admin.rpc(fn, { p_actor: caller.id, p: params });
  if (error) {
    const m = /^ZH:([a-z_]+)$/.exec(error.message ?? "");
    if (m) {
      let detail: unknown = null;
      try { detail = error.details ? JSON.parse(error.details) : null; } catch { /* plain text */ }
      return json(req, { error: m[1], detail }, 400);
    }
    console.error("rpc failed", fn, error.code);
    fail(500, "server_error");
  }
  return json(req, { data });
});
