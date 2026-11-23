// Bot scheduling flow (feature 5) with fake Telegram + database (no network).
import { assert, assertEquals } from "jsr:@std/assert@1";
Deno.env.set("SUPABASE_URL", "http://localhost:54321"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test"); Deno.env.set("SUPABASE_ANON_KEY", "test");
const { Bot, parseScheduleWhen } = await import("../telegram-webhook/bot.ts");

Deno.test("parseScheduleWhen: Cairo local, today/tomorrow, year end, leap day", () => {
  const now = { date: "2026-11-23", time: "09:00" };
  assertEquals(parseScheduleWhen("10:30 م", now), "2026-11-23T22:30");
  assertEquals(parseScheduleWhen("8:00", now), "2026-11-24T08:00");          // already passed today → tomorrow
  assertEquals(parseScheduleWhen("بكرة 9:00", now), "2026-11-24T09:00");
  assertEquals(parseScheduleWhen("2026-11-30 10:00", now), "2026-11-30T10:00");
  assertEquals(parseScheduleWhen("بكرة ٩:٠٠ ص", { date: "2026-12-31", time: "23:50" }), "2027-01-01T09:00");
  assertEquals(parseScheduleWhen("بكرة 9:00", { date: "2028-02-28", time: "10:00" }), "2028-02-29T09:00");
  assertEquals(parseScheduleWhen("قريب", now), null);
});

function harness(rows: Array<Record<string, unknown>> = []) {
  const sent: Array<Record<string, unknown>> = []; const calls: Array<[string, Record<string, unknown>]> = [];
  const actions = new Map<string, Record<string, unknown>>(); let n = 0; let state: Record<string, unknown> | null = null;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push([fn, args]);
    switch (fn) {
      case "svc_bot_state": if (args.p_set) { state = args.p_state as Record<string, unknown> | null; return null; } return state;
      case "svc_bot_action_create": { const id = `33333333-3333-4333-8333-${String(++n).padStart(12, "0")}`; actions.set(id, args.p_action as Record<string, unknown>); return id; }
      case "svc_bot_action_take": { const a = actions.get(String(args.p_id)) ?? null; actions.delete(String(args.p_id)); return a; }
      case "svc_sched_ann_list": return rows;
      case "svc_sched_ann_save": return { id: "x", status: "scheduled" };
      case "svc_sched_ann_cancel": { const r = rows.find((x) => x.id === (args.p as Record<string, unknown>).id); if (r) r.status = "canceled"; return { status: "canceled" }; }
      default: return null;
    }
  };
  const tg = async (method: string, body: Record<string, unknown>) => { sent.push({ method, ...body }); return { ok: true, result: { message_id: 9 } }; };
  const bot = new Bot({ tg, rpc: rpc as never, employees: {} as never }, { chatId: "42", ownerId: "00000000-0000-4000-8000-000000000001" });
  const last = () => sent[sent.length - 1];
  const btns = () => ((last().reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
  return { bot, sent, calls, last, btns };
}

Deno.test("schedule from the bot: text → destination → typed time → auto-delete → confirm", async () => {
  const h = harness();
  await h.bot.onCallback("m:sa", { message_id: 1 });
  await h.bot.onText("اجتماع الفريق يوم الأحد", 2);
  assert(h.btns().includes("sa:d:tg") && h.btns().includes("sa:d:app"));
  await h.bot.onCallback("sa:d:tg", { message_id: 3 });
  await h.bot.onText("2026-11-30 10:00", 4);
  assert(!h.btns().includes("sa:x:4320") && h.btns().includes("sa:x:2820"), "Telegram: no deletion beyond 47 h offered");
  await h.bot.onCallback("sa:x:60", { message_id: 5 });
  assert(String(h.last().text).includes("30/11/2026 الساعة 10:00 ص"));
  const cf = h.btns().find((b) => b.startsWith("cf:"))!;
  await h.bot.onCallback(cf, { message_id: 6 });
  const save = h.calls.find(([f]) => f === "svc_sched_ann_save")!;
  assertEquals(save[1].p, { body: "اجتماع الفريق يوم الأحد", destination: "owner_telegram", publish_local: "2026-11-30T10:00", delete_after_minutes: 60 });
  assert(String(h.last().text).includes("اتجدول الإعلان"));
  await h.bot.onCallback(cf, { message_id: 6 });   // double tap
  assertEquals(h.calls.filter(([f]) => f === "svc_sched_ann_save").length, 1);
});

Deno.test("app destination refuses text over 1000 chars; forged/stale buttons do nothing", async () => {
  const h = harness();
  await h.bot.onCallback("m:sa", { message_id: 1 });
  await h.bot.onText("x".repeat(1500), 2);
  await h.bot.onCallback("sa:d:app", { message_id: 3 });
  assert(String(h.last().text).includes("1000"));
  const h2 = harness();
  await h2.bot.onCallback("sa:x:60", { message_id: 1 });        // no flow in progress
  assert(String(h2.last().text).includes("قديم"));
  await h2.bot.onCallback("sa:x:99999", { message_id: 1 });
  assert(!h2.calls.some(([f]) => f === "svc_sched_ann_save"));
});

Deno.test("list + cancel a scheduled announcement", async () => {
  const rows = [{ id: "44444444-4444-4444-8444-444444444444", status: "scheduled", publish_local: "2026-11-30T10:00", destination: "staff_app", body: "نص", delete_status: "none" }];
  const h = harness(rows);
  await h.bot.onCallback("m:sal", { message_id: 1 });
  assert(h.btns().includes(`sa:c:${rows[0].id}`));
  await h.bot.onCallback(`sa:c:${rows[0].id}`, { message_id: 2 });
  await h.bot.onCallback(h.btns().find((b) => b.startsWith("cf:"))!, { message_id: 3 });
  assert(h.calls.some(([f, a]) => f === "svc_sched_ann_cancel" && (a.p as Record<string, unknown>).id === rows[0].id));
  await h.bot.onCallback(`sa:c:${rows[0].id}`, { message_id: 4 });   // already cancelled
  assert(String(h.last().text).includes("مش مجدول دلوقتي"));
});
