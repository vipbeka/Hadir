// Message-format SIMULATION (no network, nothing is sent to Telegram).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
const { formatOwnerMessage, isPermanentTelegramError } = await import("../_shared/telegram.ts");
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

Deno.test("leave request message has employee, type, period, reason, status", () => {
  const { text, reply_markup } = formatOwnerMessage({ kind: "leave_request", id: "x", employee: "أحمد علي (Ahmed Ali)",
    type: "sick", from: "2026-11-25", to: "2026-11-26", days: 2, reason: "<flu>", status: "pending" });
  assert(text.includes("Zintra حاضر"), "brand");
  assert(text.includes("أحمد علي") && text.includes("مرضية") && text.includes("2026-11-25") && text.includes("2026-11-26"), "fields");
  assert(text.includes("&lt;flu&gt;"), "reason escaped for HTML parse mode");
  assert(text.includes("بانتظار القرار"), "status");
  // pending leave now carries ✅ قبول / ❌ رفض buttons handled by the admin bot
  const kb = (reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard[0];
  assert(kb[0].text === "✅ قبول" && kb[0].callback_data === "lv:a:x" && kb[1].callback_data === "lv:r:x", "leave decision buttons");
});

Deno.test("single-day leave shows one date", () => {
  const { text } = formatOwnerMessage({ kind: "leave_request", employee: "x", type: "personal", from: "2026-11-25", to: "2026-11-25", days: 1, status: "pending" });
  assert(text.includes("الفترة: 2026-11-25 (1 يوم)") && text.includes("شخصية"), "single date");
});

Deno.test("permanent vs transient Telegram errors", () => {
  assert(isPermanentTelegramError({ ok: false, error_code: 400 }), "400 permanent");
  assert(isPermanentTelegramError({ ok: false, error_code: 403 }), "403 permanent");
  assert(!isPermanentTelegramError({ ok: false, error_code: 429 }), "429 transient");
  assert(!isPermanentTelegramError({ ok: false, error_code: 502 }), "5xx transient");
});
