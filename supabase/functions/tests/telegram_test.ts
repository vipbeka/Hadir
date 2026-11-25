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

Deno.test("live owner events use the database text, keep request buttons, add an app link", () => {
  const ci = formatOwnerMessage({ kind: "check_in", text_ar: "حضور متأخر\nمحمد حضر الساعة 9:04 ص\n⏰ متأخر 4 دقيقة", link: "#/owner/employee?id=1" });
  assert(ci.text.includes("<b>حضور متأخر</b>") && ci.text.includes("محمد حضر الساعة 9:04 ص") && ci.text.includes("متأخر 4 دقيقة"), "check-in text");
  const kb = (ci.reply_markup as { inline_keyboard: { url?: string }[][] }).inline_keyboard;
  assert(kb.length === 1 && kb[0][0].url === "https://hadar-ee191.web.app/#/owner/employee?id=1", "open-in-app link");
  const el = formatOwnerMessage({ kind: "early_leave_request", id: 7, text_ar: "طلب انصراف مبكر\nسارة <x>", link: "#/owner/approvals" });
  const rows = (el.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
  assert(rows[0][0].callback_data === "el:a:7" && rows[0][1].callback_data === "el:r:7" && rows.length === 2, "approve/reject kept");
  assert(el.text.includes("سارة &lt;x&gt;"), "escaped");
  const bad = formatOwnerMessage({ kind: "check_out", text_ar: "انصراف\nx", link: "https://evil.example" });
  assert(bad.reply_markup === undefined, "only in-app links");
});

Deno.test("live permission / correction messages: same text + approve/reject (+deduction when over the limit) + open in app", () => {
  const pm = formatOwnerMessage({ kind: "permission_request", id: 12, over_limit: true, text_ar: "طلب إذن\nسارة طلب إذن اليوم من 10:00 ص إلى 11:00 ص", link: "#/owner/approvals" });
  const rows = (pm.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> }).inline_keyboard;
  assert(pm.text.includes("🚪 <b>طلب إذن</b>") && pm.text.includes("سارة طلب إذن"), "permission text");
  assert(rows[0][0].callback_data === "pm:a:12" && rows[0][1].callback_data === "pm:r:12" && rows[1][0].callback_data === "pm:d:12", "permission buttons");
  assert(rows[2][0].url === "https://hadar-ee191.web.app/#/owner/approvals", "open in app");
  const pm2 = formatOwnerMessage({ kind: "permission_request", id: 13, text_ar: "طلب إذن\nx", link: "#/owner/approvals" });
  assert((pm2.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard.length === 2, "no deduction button within the limit");
  const cr = formatOwnerMessage({ kind: "correction_request", id: 5, text_ar: "طلب تصحيح حضور\n<b>x</b>", link: "#/owner/approvals" });
  const r2 = (cr.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string }>> }).inline_keyboard;
  assert(r2[0][0].callback_data === "cr:a:5" && r2[0][1].callback_data === "cr:r:5", "correction buttons");
  assert(cr.text.includes("&lt;b&gt;x&lt;/b&gt;"), "escaped");
});
