// Simulated-update tests for the announcement deletion flow and the
// window editor (no network, no real chat). Run: deno test -A tests/
// the shared Supabase client module needs these at import time (never used: deps are faked)
Deno.env.set("SUPABASE_URL", "http://localhost:54321"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test"); Deno.env.set("SUPABASE_ANON_KEY", "test");
const { Bot } = await import("../telegram-webhook/bot.ts");

const UID = "11111111-1111-4111-8111-111111111111";
const OWNER = "00000000-0000-4000-8000-000000000001";
function harness(anns: Array<Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = []; const calls: Array<[string, Record<string, unknown>]> = [];
  const actions = new Map<string, Record<string, unknown>>(); let n = 0; let state: Record<string, unknown> | null = null;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push([fn, args]);
    const p = (args.p ?? {}) as Record<string, number | string>;
    switch (fn) {
      case "svc_list_announcements": {
        const off = Number(p.offset ?? 0), lim = Number(p.limit ?? 50);
        return { total: anns.length, rows: anns.slice(off, off + lim) };
      }
      case "svc_bot_action_create": { const id = `22222222-2222-4222-8222-${String(++n).padStart(12, "0")}`; actions.set(id, args.p_action as Record<string, unknown>); return id; }
      case "svc_bot_action_take": { const a = actions.get(String(args.p_id)) ?? null; actions.delete(String(args.p_id)); return a; }
      case "svc_delete_announcement": { const i = anns.findIndex((a) => a.id === p.id); if (i < 0) return { deleted: false }; anns.splice(i, 1); return { deleted: true }; }
      case "svc_bot_settings": return { work_days: [0, 1, 2, 3, 4] };
      case "svc_bot_state": if (args.p_set) { state = args.p_state as Record<string, unknown> | null; return null; } return state;
      default: return null;
    }
  };
  const tg = async (method: string, body: Record<string, unknown>) => { sent.push({ method, ...body }); return { ok: true, result: { message_id: 9 } }; };
  const bot = new Bot({ tg, rpc: rpc as never, employees: {} as never }, { chatId: "42", ownerId: OWNER });
  return { bot, sent, calls };
}
const last = (s: Array<Record<string, unknown>>) => s[s.length - 1];
const buttons = (m: Record<string, unknown>) => ((m.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
const assert = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };

Deno.test("delete announcement: list → preview → confirm → deleted; double tap is safe", async () => {
  const anns = [{ id: UID, title: "اجتماع", body: "اجتماع الساعة 10", created_at: "2026-11-23T08:00:00Z" }];
  const { bot, sent, calls } = harness(anns);
  await bot.onCallback("m:ad", { message_id: 1 });
  assert(buttons(last(sent)).includes(`ad:v:0:${UID}`), "list shows the announcement");
  await bot.onCallback(`ad:v:0:${UID}`, { message_id: 2 });
  const cf = buttons(last(sent)).find((b) => b.startsWith("cf:"))!;
  assert(String(last(sent).text).includes("اجتماع الساعة 10"), "preview shows the body");
  await bot.onCallback(cf, { message_id: 3 });
  assert(String(last(sent).text).includes("اتحذف الإعلان"), "success message");
  assert(calls.some(([f, a]) => f === "svc_delete_announcement" && (a.p as Record<string, string>).via === "telegram" && a.p_actor === OWNER), "server delete with owner actor");
  assert(anns.length === 0, "record removed");
  await bot.onCallback(cf, { message_id: 3 });
  assert(String(last(sent).text).includes("اتنفّذ أو اتلغى"), "second tap is a no-op");
});

Deno.test("delete announcement: stale / tampered callbacks", async () => {
  const { bot, sent, calls } = harness([]);
  await bot.onCallback(`ad:v:0:${UID}`, { message_id: 1 });
  assert(String(last(sent).text).includes("اتحذف قبل كده"), "stale id handled");
  await bot.onCallback("ad:v:0:not-a-uuid'; drop", { message_id: 1 });
  assert(String(last(sent).text).includes("الزرار ده قديم"), "tampered callback rejected");
  assert(!calls.some(([f]) => f === "svc_delete_announcement"), "nothing deleted");
  await bot.onCallback("m:ad", { message_id: 1 });
  assert(String(last(sent).text).includes("مفيش إعلانات"), "empty list message");
});

Deno.test("delete announcement: pagination", async () => {
  const anns = Array.from({ length: 12 }, (_, i) => ({ id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`, title: null, body: `إعلان ${i}`, created_at: "2026-11-23T08:00:00Z" }));
  const { bot, sent } = harness(anns);
  await bot.onCallback("m:ad", { message_id: 1 });
  assert(buttons(last(sent)).includes("ad:p:1") && !buttons(last(sent)).includes("ad:p:-1"), "next page button");
  await bot.onCallback("ad:p:2", { message_id: 1 });
  assert(String(last(sent).text).includes("صفحة 3 من 3"), "last page");
});

Deno.test("window editor never sends point flags (keeps Late red)", async () => {
  const { bot, sent, calls } = harness([]);
  await bot.onCallback("s:win", { message_id: 1 });
  await bot.onText("مبكر 07:00-08:00\nعادي 09:00-10:00\nمتأخر 10:00-11:00", 2);
  const cf = buttons(last(sent)).find((b) => b.startsWith("cf:"))!;
  await bot.onCallback(cf, { message_id: 3 });
  const save = calls.find(([f]) => f === "svc_save_days");
  assert(save, "atomic save used");
  const days = (save![1].p as { days: Array<{ windows: Array<Record<string, unknown>> }> }).days;
  assert(days.length === 5, "all work days in one call");
  assert(days.every((d) => d.windows.every((w) => !("awards_green_point" in w) && !("awards_red_point" in w))), "no flags sent");
});
