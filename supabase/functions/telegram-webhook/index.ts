// =====================================================================
// Zintra حاضر — telegram-webhook (owner admin bot)
// 1. Verifies Telegram's secret header (constant-time) on EVERY update.
// 2. Processes each update_id once (Telegram redelivers on slow replies).
// 3. Answers ONLY the owner's chat id (from settings, not code); any other
//    chat or user gets no response at all.
// 4. Always returns 200 after authentication, so a failure never makes
//    Telegram retry the same update in a loop; errors are logged.
// =====================================================================
import { rpc } from "../_shared/clients.ts";
import { tg, webhookSecret } from "../_shared/telegram.ts";
import { createEmployee, setActive, regenerateCode } from "../_shared/employees.ts";
import { type Deps } from "./bot.ts";
import { handle } from "./handler.ts";

const ok = () => new Response("ok", { status: 200 });

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a); const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const deps: Deps = {
  tg, rpc,
  employees: { create: createEmployee, setActive, regenerate: regenerateCode },
  fetchUrl: (u) => fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) }),
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", await webhookSecret())) return new Response("forbidden", { status: 403 });
  const update = await req.json().catch(() => null);
  if (!update || typeof update !== "object") return ok();
  try { await handle(update, deps); }
  catch (e) { console.error("telegram update failed", e instanceof Error ? `${e.name}: ${e.message}` : "unknown"); }
  return ok();
});
