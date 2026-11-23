// =====================================================================
// Zintra حاضر — dispatch (called every minute by pg_cron via pg_net)
// Sends due outbox messages: Telegram (owner) and Web Push (staff).
// Authorised by a random token kept in Supabase Vault (x-zh-cron).
// A failure is recorded and retried with backoff; it never blocks the
// attendance/point writes that queued the message. 404/410 from a push
// service disables that subscription only.
// =====================================================================
import webpush from "web-push";
import { serve, json, fail } from "../_shared/http.ts";
import { rpc } from "../_shared/clients.ts";
import { tg, formatOwnerMessage, isPermanentTelegramError, hasToken, webhookSecret } from "../_shared/telegram.ts";

// PUBLIC key (also shipped to the browser). The private key is the
// Edge Function secret VAPID_PRIVATE_KEY.
export const VAPID_PUBLIC_KEY = "BJdxi4j88AWz8iLPe8B5nKb-hdS_JKx-0g18Ool3K9Xl6nWZLLf111k_eAaABlaVNrxvy-HnkKkr4TTBdIDczFo";

// One-time Telegram setup (re-run by bumping the key): register the webhook
// with its secret and publish the owner's command menu. The result is
// recorded in job_runs (telegram_setup) — never the token.
const TELEGRAM_SETUP_KEY = "admin-bot-v1";
const COMMANDS = [
  { command: "menu", description: "القائمة الرئيسية" },
  { command: "today", description: "ملخص النهارده" },
  { command: "pending", description: "الطلبات المستنية قرار" },
  { command: "points", description: "ترتيب النقاط" },
  { command: "report", description: "تقرير شهري لموظف" },
  { command: "broadcast", description: "إعلان لكل الموظفين" },
  { command: "cancel", description: "إلغاء العملية الحالية" },
];
async function telegramSetup() {
  if (!hasToken() || !(await rpc<boolean>("svc_bot_setup_needed", { p_key: TELEGRAM_SETUP_KEY }).catch(() => false))) return;
  const ctx = await rpc<{ chat_id: string }>("svc_telegram_context");
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-webhook`;
  const hook = await tg("setWebhook", { url, secret_token: await webhookSecret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  const cmds = await tg("setMyCommands", { commands: COMMANDS, scope: { type: "chat", chat_id: Number(ctx.chat_id) } });
  await tg("setMyCommands", { commands: [], scope: { type: "default" } });   // nothing advertised to strangers
  const info = await tg("getWebhookInfo", {});
  const r = (info.result ?? {}) as Record<string, unknown>;
  await rpc("svc_bot_setup_done", { p_key: TELEGRAM_SETUP_KEY, p_ok: !!hook.ok && !!cmds.ok && r.url === url,
    p_detail: { webhook_ok: !!hook.ok, commands_ok: !!cmds.ok, url_matches: r.url === url, pending: r.pending_update_count ?? null,
      last_error: r.last_error_message ?? null, error: hook.ok ? null : String(hook.description ?? "").slice(0, 120) } });
}

type Row = { id: string; channel: string; recipient: string; event_type: string; payload: Record<string, unknown>;
  push?: { endpoint: string; p256dh: string; auth: string } | null };

serve(async (req) => {
  const ok = await rpc<boolean>("svc_verify_cron", { p_token: req.headers.get("x-zh-cron") ?? "" }).catch(() => false);
  if (!ok) fail(401, "unauthorized");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  if (vapidPrivate) webpush.setVapidDetails("https://hadar-ee191.web.app", VAPID_PUBLIC_KEY, vapidPrivate);

  await telegramSetup().catch((e) => console.error("telegram setup failed", e instanceof Error ? e.message : ""));
  let sent = 0, failed = 0;
  for (let round = 0; round < 4; round++) {
    const rows = await rpc<Row[]>("svc_claim_outbox", { p_limit: 25 });
    if (!rows.length) break;
    for (const r of rows) {
      try {
        if (r.channel === "telegram") {
          const msg = formatOwnerMessage(r.payload);
          const res = await tg("sendMessage", { chat_id: r.recipient, text: msg.text, parse_mode: "HTML", reply_markup: msg.reply_markup });
          if (res.ok) { sent++; await rpc("svc_outbox_result", { p_id: r.id, p_ok: true, p_ref: String((res.result as Record<string, unknown>)?.message_id ?? ""), p_error: null }); }
          else {
            // transient (429/5xx/network) → retried with backoff; permanent (400/403…) → stop now.
            // Note: if Telegram accepted a message but the reply was lost, a retry can duplicate it;
            // dedupe is per event (dedupe_key), not an absolute exactly-once guarantee.
            failed++;
            await rpc("svc_outbox_result", { p_id: r.id, p_ok: false, p_ref: null,
              p_error: `telegram ${res.error_code ?? ""}: ${String(res.description ?? "error").slice(0, 150)}`, p_gone: isPermanentTelegramError(res) });
          }
        } else if (r.channel === "web_push") {
          if (!vapidPrivate || !r.push) {
            failed++; await rpc("svc_outbox_result", { p_id: r.id, p_ok: false, p_ref: null, p_error: vapidPrivate ? "no subscription" : "missing VAPID_PRIVATE_KEY" });
            continue;
          }
          try {
            const res = await webpush.sendNotification({ endpoint: r.push.endpoint, keys: { p256dh: r.push.p256dh, auth: r.push.auth } },
              JSON.stringify(r.payload), { TTL: 3600, urgency: "high" });
            sent++; await rpc("svc_outbox_result", { p_id: r.id, p_ok: true, p_ref: String(res.statusCode), p_error: null });
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode ?? 0;
            failed++;
            await rpc("svc_outbox_result", { p_id: r.id, p_ok: false, p_ref: null, p_error: `push ${code}`, p_gone: code === 404 || code === 410 });
          }
        }
      } catch (e) {
        failed++;
        await rpc("svc_outbox_result", { p_id: r.id, p_ok: false, p_ref: null, p_error: e instanceof Error ? e.message.slice(0, 200) : "error" }).catch(() => {});
      }
    }
  }
  return json(req, { sent, failed });
});
