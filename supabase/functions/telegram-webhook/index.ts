// =====================================================================
// Zintra حاضر — telegram-webhook
// Receives updates from Telegram (registered with setWebhook + a secret
// token). Accepts ONLY the configured owner chat. Inline buttons
// ("el:a:<id>" / "el:r:<id>") and reply commands ("approve 7",
// "reject 7", "موافق 7", "رفض 7") call the SAME decision function as the
// dashboard (svc_decide_early_leave). Replays / double taps are no-ops.
// =====================================================================
import { rpc } from "../_shared/clients.ts";
import { tg, webhookSecret, APP } from "../_shared/telegram.ts";

const ok = () => new Response("ok", { status: 200 });

async function decide(id: number, approve: boolean) {
  const ctx = await rpc<{ owner_id: string }>("svc_telegram_context");
  try {
    const r = await rpc<Record<string, unknown>>("svc_decide_early_leave", { p_actor: ctx.owner_id, p: { id, approve, channel: "telegram" } });
    if (r.result === "already_decided") return `ℹ️ الطلب #${id} تم البتّ فيه مسبقًا (${r.status === "approved" ? "موافَق" : r.status === "rejected" ? "مرفوض" : r.status}).`;
    return r.status === "approved" ? `✅ تمت الموافقة على طلب #${id} (${r.employee} — ${r.time}).` : `❌ تم رفض طلب #${id} (${r.employee}).`;
  } catch (e) {
    return /not_found/.test(e instanceof Error ? e.message : "") ? `لا يوجد طلب برقم #${id}.` : "تعذّر تنفيذ القرار، حاول من لوحة التحكم.";
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== await webhookSecret()) return new Response("forbidden", { status: 403 });
  const update = await req.json().catch(() => null);
  if (!update) return ok();
  const ctx = await rpc<{ chat_id: string }>("svc_telegram_context");

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message?.chat?.id ?? cq.from?.id ?? "");
    if (chatId !== String(ctx.chat_id)) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "غير مصرح" }); return ok(); }
    const m = /^el:(a|r):(\d{1,12})$/.exec(String(cq.data ?? ""));
    if (!m) { await tg("answerCallbackQuery", { callback_query_id: cq.id }); return ok(); }
    const text = await decide(Number(m[2]), m[1] === "a");
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: text.slice(0, 180) });
    if (cq.message) {
      await tg("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
      await tg("sendMessage", { chat_id: cq.message.chat.id, text: `<b>${APP}</b>\n${text}`, parse_mode: "HTML", reply_to_message_id: cq.message.message_id });
    }
    return ok();
  }

  const msg = update.message;
  if (msg?.text) {
    if (String(msg.chat?.id) !== String(ctx.chat_id)) return ok();   // ignore anyone else silently
    const m = /^\s*(approve|reject|موافق|موافقة|قبول|رفض)\s*#?\s*(\d{1,12})\s*$/i.exec(msg.text);
    if (m) {
      const approve = !/^(reject|رفض)$/i.test(m[1]);
      const text = await decide(Number(m[2]), approve);
      await tg("sendMessage", { chat_id: msg.chat.id, text: `<b>${APP}</b>\n${text}`, parse_mode: "HTML", reply_to_message_id: msg.message_id });
    } else if (/^\/start/.test(msg.text)) {
      await tg("sendMessage", { chat_id: msg.chat.id, text: `<b>${APP}</b>\nأهلًا! ستصلك هنا تنبيهات الحضور وطلبات الانصراف المبكر.`, parse_mode: "HTML" });
    }
  }
  return ok();
});
