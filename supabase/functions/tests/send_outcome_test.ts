// Fake-transport checks for the owner-report delivery rules (no network).
import { assertEquals } from "jsr:@std/assert@1";
Deno.env.set("SUPABASE_URL", "http://localhost:54321"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test"); Deno.env.set("SUPABASE_ANON_KEY", "test");
const { classifySend } = await import("../_shared/telegram.ts");

Deno.test("accepted → ok with the Telegram message id", () => {
  assertEquals(classifySend({ ok: true, result: { message_id: 4242 } }), { kind: "ok", ref: "4242" });
});
Deno.test("429 → retry after Telegram's retry_after", () => {
  const o = classifySend({ ok: false, error_code: 429, description: "Too Many Requests: retry after 17", parameters: { retry_after: 17 } });
  assertEquals(o.kind, "retry"); assertEquals((o as { retryAfter: number }).retryAfter, 17);
});
Deno.test("blocked bot / bad chat / cannot delete → permanent", () => {
  for (const [code, d] of [[403, "Forbidden: bot was blocked by the user"], [400, "Bad Request: chat not found"], [400, "Bad Request: message can't be deleted"]] as const) {
    assertEquals(classifySend({ ok: false, error_code: code, description: d }).kind, "gone");
  }
});
Deno.test("lost reply or 5xx → uncertain (never auto-resent)", () => {
  assertEquals(classifySend(null, new TypeError("connection reset")).kind, "uncertain");
  assertEquals(classifySend({ ok: false, error_code: 502, description: "http_502" }).kind, "uncertain");
});
