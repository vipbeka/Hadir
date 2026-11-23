// Telegram Bot API helpers. The token is read ONLY from the Edge Function
// secret TELEGRAM_BOT_TOKEN (entered in the Supabase Dashboard); it is
// never logged, returned or stored in the database.
import { serviceKeyForHmac } from "./clients.ts";

export const APP = "Zintra حاضر";
const token = () => Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
export const hasToken = () => token().length > 20;

export async function tg(method: string, body: Record<string, unknown>) {
  if (!hasToken()) return { ok: false, description: "missing_token" } as Record<string, unknown>;
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, description: `http_${res.status}` })) as Record<string, unknown>;
  if (!json.ok && json.error_code === undefined) json.error_code = res.status;
  return json;
}

/** 400 (bad chat id / bad request) and 403 (bot blocked / not started) won't succeed on retry. */
export function isPermanentTelegramError(r: Record<string, unknown>): boolean {
  const c = Number(r.error_code ?? 0);
  return c === 400 || c === 401 || c === 403 || c === 404;
}

/** Secret the webhook URL is registered with (X-Telegram-Bot-Api-Secret-Token). */
export async function webhookSecret(): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`zh-tg-v1|${serviceKeyForHmac()}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("telegram-webhook"));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 64);
}

const egp = (p: number) => `${(Number(p) / 100).toLocaleString("en-US")} ج.م`;
const esc = (s: unknown) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

/** Owner messages (Arabic, with the product name). Never contains codes or salary. */
export function formatOwnerMessage(p: Record<string, unknown>): { text: string; reply_markup?: unknown } {
  const head = `<b>${APP}</b>\n`;
  const lines = (arr: unknown) => (Array.isArray(arr) ? arr.map((l: Record<string, unknown>) => `• ${esc(l.line)}`).join("\n") : "");
  switch (p.kind) {
    case "red_point":
      return { text: `${head}🔴 تأخير: ${esc(p.employee)}\nالتاريخ: ${esc(p.date)} — الساعة ${esc(p.time)}\n${p.warning_only ? "أول تأخير هذا الشهر: إنذار بدون خصم" : "نقطة حمراء بخصم"}` };
    case "black_pending":
      return { text: `${head}⚫ غياب بانتظار موافقتك: ${esc(p.employee)}\nالتاريخ: ${esc(p.date)}\nالخصم عند الموافقة: ${egp(Number(p.amount_piastres))}\nراجعها من شاشة «الموافقات».` };
    case "reward_request":
      return { text: `${head}🏆 طلب مكافأة: ${esc(p.employee)}\nالشهر: ${esc(p.period)} — ${esc(p.green)} نقطة خضراء\nالمبلغ: ${egp(Number(p.amount_piastres))} عبر ${p.method === "instapay" ? "InstaPay" : "Vodafone Cash"}` };
    case "early_leave_request":
      return {
        text: `${head}🕒 طلب انصراف مبكر #${esc(p.id)}\nالموظف: ${esc(p.employee)}\nالتاريخ: ${esc(p.date)} — الساعة ${esc(p.time)}\n${p.reason ? `السبب: ${esc(p.reason)}\n` : ""}\nيمكنك الرد بـ: موافق ${esc(p.id)} أو رفض ${esc(p.id)}`,
        reply_markup: { inline_keyboard: [[{ text: "✅ موافقة", callback_data: `el:a:${p.id}` }, { text: "❌ رفض", callback_data: `el:r:${p.id}` }]] },
      };
    case "leave_request": {
      const type = p.type === "sick" ? "مرضية" : "شخصية";
      const status = ({ pending: "بانتظار القرار", approved: "تمت الموافقة", rejected: "مرفوضة", cancelled: "ملغاة" } as Record<string, string>)[String(p.status)] ?? esc(p.status);
      const period = p.from === p.to ? esc(p.from) : `${esc(p.from)} ← ${esc(p.to)}`;
      return { text: `${head}🌴 طلب إجازة ${type}: ${esc(p.employee)}\nالفترة: ${period} (${esc(p.days)} يوم)\n${p.reason ? `السبب: ${esc(p.reason)}\n` : ""}الحالة: ${status}\nراجعه من شاشة «الموافقات» ← «الإجازات».` };
    }
    case "client_lockout":
    case "global_throttle":
    case "security":
      return { text: `${head}🔐 تنبيه أمني: ${p.kind === "global_throttle" ? "محاولات دخول فاشلة كثيرة من أجهزة متعددة" : "تم قفل الدخول من جهاز/شبكة"} لمدة ${esc(p.minutes)} دقيقة.\nعدد المحاولات الفاشلة: ${esc(p.failures ?? p.failures_last_hour)}\n(الرموز المُدخلة لا تُرسل ولا تُخزَّن أبدًا)` };
    case "digest":
      return { text: `${head}📋 ملخص يوم ${esc(p.date)}\n${lines(p.lines)}` };
    case "weekly_summary":
      return { text: `${head}📊 ملخص الأسبوع ${esc(p.week_start)} → ${esc(p.week_end)}\n${lines(p.lines)}` };
    case "test":
      return { text: `${head}✅ رسالة تجريبية — الإشعارات تعمل.` };
    default:
      return { text: `${head}${esc(JSON.stringify(p)).slice(0, 500)}` };
  }
}
