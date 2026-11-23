// Simulated Telegram updates against the admin-bot logic with fake
// Telegram + database dependencies (no network, no real messages).
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import type { Deps } from "../telegram-webhook/bot.ts";
// the shared Supabase client module needs these at import time (never used: deps are faked)
Deno.env.set("SUPABASE_URL", "http://localhost:54321"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test"); Deno.env.set("SUPABASE_ANON_KEY", "test");
const { handle } = await import("../telegram-webhook/handler.ts");
const { parseClock, parseWhen, parseWindows, parseLatLng, resolveLocation } = await import("../telegram-webhook/bot.ts");

const OWNER = "1360140225";
const OWNER_ID = "00000000-0000-4000-b000-000000000001";
const EMP = "11111111-2222-4333-8444-555555555555";

function harness() {
  const sent: Array<{ method: string; body: Record<string, any> }> = [];
  const calls: Array<{ fn: string; args: Record<string, any> }> = [];
  const actions = new Map<string, { chat: string; action: unknown; used: boolean }>();
  const claimed = new Set<number>();
  let state: unknown = null;
  let n = 0;
  const created: Array<Record<string, unknown>> = [];
  const active: Array<{ id: string; active: boolean }> = [];
  const d: Deps = {
    tg: async (method, body) => { sent.push({ method, body: body as Record<string, any> }); return { ok: true, result: { message_id: 900 + sent.length } }; },
    rpc: (async (fn: string, args: Record<string, any> = {}) => {
      calls.push({ fn, args });
      switch (fn) {
        case "svc_telegram_context": return { chat_id: OWNER, owner_id: OWNER_ID };
        case "svc_bot_claim_update": if (claimed.has(args.p_update_id)) return false; claimed.add(args.p_update_id); return true;
        case "svc_bot_state": if (args.p_set) { state = args.p_state; return state; } return state;
        case "svc_bot_action_create": { const id = `aaaaaaaa-bbbb-4ccc-8ddd-${String(++n).padStart(12, "0")}`; actions.set(id, { chat: args.p_chat, action: args.p_action, used: false }); return id; }
        case "svc_bot_action_take": { const a = actions.get(args.p_id); if (!a || a.used || a.chat !== args.p_chat) return null; a.used = true; return a.action; }
        case "svc_list_employees": return [{ id: EMP, full_name_ar: "أحمد علي", full_name_en: "Ahmed Ali", role: "staff", active: true }, { id: OWNER_ID, full_name_ar: "المالك", full_name_en: "Owner", role: "owner", active: true }];
        case "svc_decide_early_leave": return { result: "decided", status: args.p.approve ? "approved" : "rejected", employee: "أحمد علي", time: "3:00 م" };
        case "svc_decide_leave": return { result: "decided", status: "approved", employee: "أحمد علي" };
        case "svc_manual_adjust": return { previous: 1, total: 2 };
        case "svc_manual_check_in": return { employee: "أحمد علي", date: "2026-11-23", time: "9:30 ص", outcome: "green" };
        case "svc_bot_settings": return { geofence_lat: 29.98, geofence_lng: 31.32, radius_m: 100, reward_piastres: 10000, threshold: 30, work_days: [0, 1, 2, 3, 4],
          notify_events: ["check_in", "digest"], windows: [{ label_ar: "مبكر", start: "07:00", end: "08:00" }] };
        case "svc_update_settings": case "svc_save_day": case "svc_set_job_title": return {};
        case "svc_broadcast": return { people: 3, devices: 2 };
        case "svc_bot_today": return { date: "2026-11-23", is_work_day: true, closed: true, closes_at: "11:00 ص", people: [
          { name: "أحمد", in: "9:12 ص", outcome: "green" }, { name: "سارة", in: "10:40 ص", outcome: "red" }, { name: "محمد" }, { name: "منى", leave: true }] };
        case "svc_bot_points": return { period: "2026-11-01", threshold: 30, rows: [{ rank: 1, name: "أحمد", green: 5, red: 1, black: 0, green_all: 12 }] };
        case "svc_pending": return { early_leave: [{ id: 7, status: "pending", name_ar: "أحمد", work_date: "2026-11-23", requested_leave_time: "15:00:00", reason: "دكتور" }], leave: [] };
        case "svc_payroll": return { rows: [{ id: "report-row-id", employee_id: EMP, full_name_ar: "أحمد علي", worked_minutes: 600, deductions_piastres: 5000,
          bonuses_earned_piastres: 0, bonuses_paid_piastres: 0, unresolved_flags: [], points_breakdown: { green_total: 3, green_attendance: 3, green_outcome: 0, red_warnings: 1, red_chargeable: 1, red_amount_piastres: 5000, black_approved: 0, black_amount_piastres: 0, black_pending: 0 } }] };
      }
      throw new Error(`unexpected rpc ${fn}`);
    }) as Deps["rpc"],
    employees: {
      create: async (_o, i) => { created.push(i); return { employee: { id: "new-id" }, code: "48213067" }; },
      setActive: async (_o, id, a) => { active.push({ id, active: a }); return {}; },
      regenerate: async () => ({ code: "11112222", sessions_revoked: 1 }),
    },
    fetchUrl: async () => new Response(null, { status: 302, headers: { location: "https://www.google.com/maps/place/Office/@29.9,31.3,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d29.9831944!4d31.3239444" } }),
  };
  let upd = 1;
  const msg = (text: string, chat = OWNER, from = chat) => handle({ update_id: upd++, message: { message_id: 50, text, chat: { id: Number(chat), type: "private" }, from: { id: Number(from) } } }, d);
  const tap = (data: string, extra: Record<string, unknown> = {}, chat = OWNER) => handle({ update_id: upd++, callback_query: { id: "cq", data, from: { id: Number(chat) },
    message: { message_id: 77, text: "Zintra حاضر\nطلب انصراف مبكر #7", entities: [{ type: "bold", offset: 0, length: 11 }], chat: { id: Number(chat), type: "private" }, ...extra } } }, d);
  const lastConfirmId = () => { const b = [...sent].reverse().find((s) => s.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("cf:")); return b!.body.reply_markup.inline_keyboard[0][0].callback_data.slice(3); };
  const texts = () => sent.map((s) => String(s.body.text ?? ""));
  return { d, sent, calls, msg, tap, lastConfirmId, texts, created, active, handle: (u: Record<string, unknown>) => handle(u, d) };
}

Deno.test("strangers get no response at all (messages and buttons)", async () => {
  const h = harness();
  await h.msg("/menu", "999999");
  await h.tap("el:a:7", {}, "999999");
  await h.msg("/menu", OWNER, "555");      // owner chat id but a different sender in a private chat
  assertEquals(h.sent.length, 0);
  assert(!h.calls.some((c) => c.fn === "svc_decide_early_leave"));
});

Deno.test("each update is processed once (Telegram redelivery)", async () => {
  const h = harness();
  const u = { update_id: 4242, message: { message_id: 1, text: "/menu", chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER) } } };
  await h.handle(u); await h.handle(u);
  assertEquals(h.sent.filter((s) => s.method === "sendMessage").length, 1);
});

Deno.test("early-leave ✅ قبول updates the DB and edits the original message (no buttons left)", async () => {
  const h = harness();
  await h.tap("el:a:7");
  const call = h.calls.find((c) => c.fn === "svc_decide_early_leave")!;
  assertEquals(call.args.p, { id: 7, approve: true, channel: "telegram" });
  assertEquals(call.args.p_actor, OWNER_ID);
  const edit = h.sent.find((s) => s.method === "editMessageText")!;
  assertEquals(edit.body.message_id, 77);
  assertMatch(edit.body.text, /طلب انصراف مبكر #7\n\n— ✅ اتقبل انصراف أحمد علي/);
  assertEquals(edit.body.reply_markup.inline_keyboard.length, 0);
  assertEquals(edit.body.entities.length, 1);       // original formatting kept
});

Deno.test("early-leave ❌ رفض", async () => {
  const h = harness();
  await h.tap("el:r:7");
  assertEquals(h.calls.find((c) => c.fn === "svc_decide_early_leave")!.args.p.approve, false);
  assertMatch(h.sent.find((s) => s.method === "editMessageText")!.body.text, /اترفض/);
});

Deno.test("points: deduct needs a reason and a confirmation; double tap is a no-op; cancel does nothing", async () => {
  const h = harness();
  await h.tap(`p:r+:${EMP}`);
  await h.msg("اتأخر من غير إذن");
  const id = h.lastConfirmId();
  assert(!h.calls.some((c) => c.fn === "svc_manual_adjust"), "nothing changes before confirmation");
  await h.tap(`cf:${id}`);
  const adj = h.calls.filter((c) => c.fn === "svc_manual_adjust");
  assertEquals(adj.length, 1);
  assertEquals(adj[0].args.p, { employee_id: EMP, color: "red", action: "add", reason: "اتأخر من غير إذن", request_id: id });
  await h.tap(`cf:${id}`);                                // second tap
  assertEquals(h.calls.filter((c) => c.fn === "svc_manual_adjust").length, 1);
  assertMatch(h.texts().at(-1)!, /اتنفّذ أو اتلغى/);
  await h.tap(`p:g+:${EMP}`); await h.msg("صفقة ممتازة");
  await h.tap(`cx:${h.lastConfirmId()}`);
  assertEquals(h.calls.filter((c) => c.fn === "svc_manual_adjust").length, 1);
});

Deno.test("add employee: 3 steps → confirm → code shown once, protected, with a delete button", async () => {
  const h = harness();
  await h.tap("m:newemp");
  await h.msg("سارة محمد"); await h.msg("Sara Mohamed"); await h.msg("محاسبة");
  assertEquals(h.created.length, 0);
  await h.tap(`cf:${h.lastConfirmId()}`);
  assertEquals(h.created, [{ nameAr: "سارة محمد", nameEn: "Sara Mohamed", phone: null }]);
  const codeMsg = h.sent.find((s) => String(s.body.text).includes("48213067"))!;
  assertEquals(codeMsg.body.protect_content, true);
  assertEquals(codeMsg.body.reply_markup.inline_keyboard[0][0].callback_data, "del");
  assert(h.calls.some((c) => c.fn === "svc_set_job_title" && c.args.p.job_title_ar === "محاسبة"));
});

Deno.test("deactivate requires confirmation", async () => {
  const h = harness();
  await h.tap(`ea:off:${EMP}`);
  assertEquals(h.active.length, 0);
  await h.tap(`cf:${h.lastConfirmId()}`);
  assertEquals(h.active, [{ id: EMP, active: false }]);
});

Deno.test("manual check-in: time parsing + confirmation", async () => {
  const h = harness();
  await h.tap(`e:c:${EMP}`);
  await h.msg("بكرة");                                   // not a time → asks again
  assertMatch(h.texts().at(-1)!, /مش فاهم الوقت/);
  await h.msg("9:30 ص");
  await h.tap(`cf:${h.lastConfirmId()}`);
  const c = h.calls.find((x) => x.fn === "svc_manual_check_in")!;
  assertEquals(c.args.p.time, "09:30");
  assertEquals(c.args.p.employee_id, EMP);
});

Deno.test("settings: radius validation, windows, location from a maps short link, notification toggle", async () => {
  const h = harness();
  await h.tap("s:rad"); await h.msg("5"); assertMatch(h.texts().at(-1)!, /بين 20 و 2000/);
  await h.msg("150"); await h.tap(`cf:${h.lastConfirmId()}`);
  assert(h.calls.some((c) => c.fn === "svc_update_settings" && c.args.p.geofence_radius_m === 150));
  await h.tap("s:win"); await h.msg("مبكر 07:00-08:00\nعادي 09:00-10:00\nمتأخر 10:00-11:00"); await h.tap(`cf:${h.lastConfirmId()}`);
  assertEquals(h.calls.filter((c) => c.fn === "svc_save_day").length, 5);
  await h.tap("s:loc"); await h.msg("https://maps.app.goo.gl/AbCdEf123"); await h.tap(`cf:${h.lastConfirmId()}`);
  const loc = h.calls.filter((c) => c.fn === "svc_update_settings").at(-1)!;
  assertEquals(loc.args.p, { geofence_lat: 29.9831944, geofence_lng: 31.3239444 });
  await h.tap("s:rew"); await h.msg("150"); await h.tap(`cf:${h.lastConfirmId()}`);
  assertEquals(h.calls.filter((c) => c.fn === "svc_update_settings").at(-1)!.args.p, { reward_amount_piastres: 15000 });
  await h.tap("nt:check_in"); await h.tap(`cf:${h.lastConfirmId()}`);
  assertEquals(h.calls.filter((c) => c.fn === "svc_update_settings").at(-1)!.args.p, { notify_events: ["digest"] });
});

Deno.test("reports and broadcast", async () => {
  const h = harness();
  await h.msg("/today");
  assertMatch(h.texts().at(-1)!, /حاضر 2 · متأخر 1 · غايب 1 · إجازة 1/);
  assertMatch(h.texts().at(-1)!, /❌ <b>محمد<\/b> — غايب/);
  await h.msg("/points"); assertMatch(h.texts().at(-1)!, /🥇 <b>أحمد<\/b> — 🟢 5/);
  await h.tap(`rp:${EMP}:0`); assertMatch(h.texts().at(-1)!, /تقرير <b>أحمد علي<\/b>[\s\S]*إجمالي الخصومات: <b>50 ج.م<\/b>/);
  await h.msg("/pending"); assertMatch(h.texts().at(-1)!, /طلب انصراف مبكر #7/);
  await h.msg("/broadcast"); await h.msg("بكرة إجازة رسمية 🎉");
  assert(!h.calls.some((c) => c.fn === "svc_broadcast"));
  await h.tap(`cf:${h.lastConfirmId()}`);
  assertEquals(h.calls.find((c) => c.fn === "svc_broadcast")!.args.p, { text: "بكرة إجازة رسمية 🎉" });
});

Deno.test("parsers", async () => {
  assertEquals(parseClock("9:30"), "09:30"); assertEquals(parseClock("4:15 م"), "16:15"); assertEquals(parseClock("12:05 ص"), "00:05");
  assertEquals(parseClock("١٠:٤٥"), "10:45"); assertEquals(parseClock("13:00 م"), null); assertEquals(parseClock("25:00"), null);
  assertEquals(parseWhen("2026-11-22 9:30"), { date: "2026-11-22", time: "09:30" });
  assertEquals(parseWindows("عادي 09:00-10:00\nمبكر 7:00-8:00")!.map((w) => w.start), ["07:00", "09:00"]);
  assertEquals(parseWindows("أ 09:00-10:00\nب 09:30-11:00"), null);   // overlap
  assertEquals(parseLatLng("29.9831944, 31.3239444"), { lat: 29.9831944, lng: 31.3239444 });
  assertEquals(parseLatLng("https://maps.google.com/?q=29.98,31.32"), { lat: 29.98, lng: 31.32 });
  assertEquals(parseLatLng("https://www.google.com/maps/@29.5,31.1,17z"), { lat: 29.5, lng: 31.1 });
  assertEquals(await resolveLocation("https://evil.example/@1.5,2.5", async () => { throw new Error("must not fetch"); }), { lat: 1.5, lng: 2.5 });
  assertEquals(await resolveLocation("https://evil.example/x", async () => { throw new Error("must not fetch"); }), null);  // only Google short hosts are fetched
});
