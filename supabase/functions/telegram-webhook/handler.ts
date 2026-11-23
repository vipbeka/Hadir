// Update routing for the owner admin bot (imported by index.ts and the tests).
import { Bot, type Deps } from "./bot.ts";

export async function handle(update: Record<string, unknown>, d: Deps): Promise<void> {
  const ctx = await d.rpc<{ chat_id: string; owner_id: string }>("svc_telegram_context");
  const owner = String(ctx.chat_id ?? "");
  const cq = update.callback_query as Record<string, any> | undefined;
  const msg = update.message as Record<string, any> | undefined;
  const chatId = String(cq ? (cq.message?.chat?.id ?? "") : (msg?.chat?.id ?? ""));
  const fromId = String(cq ? (cq.from?.id ?? "") : (msg?.from?.id ?? ""));
  // owner only: the chat must be the owner's, and in a private chat the sender too
  if (!owner || chatId !== owner) return;
  const chatType = cq ? cq.message?.chat?.type : msg?.chat?.type;
  if (chatType === "private" && fromId !== owner) return;
  if (typeof update.update_id === "number" && !(await d.rpc<boolean>("svc_bot_claim_update", { p_update_id: update.update_id }))) return;

  const bot = new Bot(d, { chatId: owner, ownerId: String(ctx.owner_id) });
  if (cq) {
    await d.tg("answerCallbackQuery", { callback_query_id: cq.id });
    if (cq.message) await bot.onCallback(String(cq.data ?? ""), cq.message);
  } else if (typeof msg?.text === "string") {
    await bot.onText(msg.text.slice(0, 2000), Number(msg.message_id));
  }
}

