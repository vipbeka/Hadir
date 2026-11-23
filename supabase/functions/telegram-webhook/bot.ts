// =====================================================================
// Zintra حاضر — Telegram admin bot (owner only).
// Pure logic with injected dependencies (Telegram API, database RPCs,
// employee operations) so every flow can be tested with simulated
// updates. Security rules:
//   * the caller (index.ts) has already checked the webhook secret and
//     that the update comes from the owner's chat — others get nothing;
//   * every sensitive change is stored as a pending action and runs only
//     after a «✅ تأكيد» tap; the action id is single-use and expires;
//   * all writes go through the same SQL service functions as the web app.
// =====================================================================
import { esc, APP } from "../_shared/telegram.ts";

export type Tg = (method: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type Rpc = <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<T>;
export type Deps = {
  tg: Tg;
  rpc: Rpc;
  employees: {
    create: (ownerId: string, i: { nameAr: string; nameEn: string; phone: string | null }) => Promise<{ employee: Record<string, unknown>; code: string }>;
    setActive: (ownerId: string, id: string, active: boolean, reason: string | null) => Promise<unknown>;
    regenerate: (ownerId: string, id: string, keep: string | null) => Promise<{ code: string; sessions_revoked: number } | undefined>;
  };
  fetchUrl?: (url: string) => Promise<Response>;   // for maps short links (tests stub it)
};
export type Ctx = { chatId: string; ownerId: string };

type Btn = { text: string; callback_data: string };
type Kb = Btn[][];
type Emp = { id: string; full_name_ar: string; full_name_en: string; role: string; active: boolean; job_title_ar?: string | null };
type State = Record<string, unknown> & { flow: string };

const H = `<b>${APP}</b>\n`;
const kb = (rows: Kb) => ({ inline_keyboard: rows });
const back = (to = "m:main"): Btn[] => [{ text: "↩️ رجوع", callback_data: to }];
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NOTIFY: Array<[string, string]> = [["check_in", "تسجيل الحضور"], ["check_out", "تسجيل الانصراف"], ["red_point", "التأخير"],
  ["black_pending", "الغياب"], ["early_leave_request", "الانصراف المبكر"], ["leave_request", "الإجازات"], ["digest", "ملخص اليوم"],
  ["weekly_summary", "ملخص الأسبوع"], ["reward_request", "طلبات المكافأة"], ["security", "تنبيهات الأمان"]];

// ------------------------------------------------------------ parsing
/** Arabic-Indic / Persian digits → ASCII. */
export const asciiDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

/** "9:30", "09:30", "4:15 م", "4:15 pm", "16:15" → "HH:MM" (24h) or null. */
export function parseClock(input: string): string | null {
  const s = asciiDigits(input).trim().toLowerCase();
  const m = /^(\d{1,2})[:.](\d{2})\s*(ص|م|am|pm|صباحا|صباحًا|مساء|مساءً)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]); const ap = m[3];
  if (min > 59 || h > 23) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    const pm = /^(م|pm|مساء|مساءً)$/.test(ap);
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "9:30" or "2026-11-22 9:30" → { date?: "YYYY-MM-DD", time } */
export function parseWhen(input: string): { date: string | null; time: string } | null {
  const s = asciiDigits(input).trim();
  const m = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(s);
  const time = parseClock(m ? m[2] : s);
  if (!time) return null;
  if (m && Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) return null;
  return { date: m ? m[1] : null, time };
}

const EN_LABEL: Record<string, string> = { "مبكر": "Early", "عادي": "Normal", "متأخر": "Late", "صباحي": "Morning", "مسائي": "Evening" };
/** Lines like «مبكر 07:00-08:00» → windows, sorted and non-overlapping. */
export function parseWindows(input: string): Array<{ label_ar: string; label_en: string; start: string; end: string }> | null {
  const lines = asciiDigits(input).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 6) return null;
  const out = [];
  for (const line of lines) {
    const m = /^(.+?)\s+(\d{1,2}[:.]\d{2}(?:\s*(?:ص|م|am|pm))?)\s*[-–—]\s*(\d{1,2}[:.]\d{2}(?:\s*(?:ص|م|am|pm))?)$/i.exec(line);
    if (!m) return null;
    const start = parseClock(m[2]); const end = parseClock(m[3]);
    if (!start || !end || end <= start) return null;
    const label = m[1].trim().slice(0, 40);
    out.push({ label_ar: label, label_en: EN_LABEL[label] ?? label, start, end });
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) return null;
  return out;
}

/** "30.0444, 31.2357" or a Google Maps link → coordinates. */
export function parseLatLng(input: string): { lat: number; lng: number } | null {
  const s = asciiDigits(decodeURIComponent(input.trim()));
  const pats = [/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/, /[?&](?:q|query|ll|center|destination)=(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, /^(-?\d{1,3}\.\d+)\s*[,،\s]\s*(-?\d{1,3}\.\d+)$/];
  for (const p of pats) {
    const m = p.exec(s);
    if (m) {
      const lat = Number(m[1]); const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) return { lat, lng };
    }
  }
  return null;
}

const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);
const GOOGLE_HOST = /(^|\.)google\.[a-z.]+$|^maps\.app\.goo\.gl$|^goo\.gl$/;
/** Follow a maps short link (Google hosts only, ≤4 hops) and parse it. */
export async function resolveLocation(input: string, fetchUrl: (u: string) => Promise<Response>): Promise<{ lat: number; lng: number } | null> {
  const direct = parseLatLng(input);
  if (direct) return direct;
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (!SHORT_HOSTS.has(url.hostname)) return null;
  for (let i = 0; i < 4; i++) {
    if (url.protocol !== "https:" || !GOOGLE_HOST.test(url.hostname)) return null;
    const res = await fetchUrl(url.href).catch(() => null);
    const loc = res?.headers.get("location");
    if (!loc) return null;
    url = new URL(loc, url);
    const got = parseLatLng(url.href);
    if (got) return got;
  }
  return null;
}

// ------------------------------------------------------------ errors
const ERR: Record<string, string> = {
  reason_required: "لازم سبب من 3 حروف على الأقل.", negative_total: "مينفعش الرصيد يبقى بالسالب.", nothing_to_remove: "مفيش نقاط تتشال.",
  no_change: "مفيش تغيير.", invalid_employee: "الموظف ده مش موجود أو موقوف.", already_checked_in: "الموظف ده مسجّل حضور في اليوم ده بالفعل.",
  invalid_time: "الوقت أو التاريخ مش صحيح (ومينفعش يكون في المستقبل).", invalid_settings: "القيمة دي مش مقبولة.", windows_overlap: "النوافذ متداخلة.",
  invalid_window: "صيغة النوافذ مش صحيحة.", not_found: "مش لاقي الطلب ده.", invalid_transition: "مينفعش تغيّر الطلب ده.",
  invalid_text: "النص فاضي أو طويل جدًا.", cannot_deactivate_self: "مينفعش توقف حسابك.", last_owner: "لازم يفضل مالك واحد على الأقل.",
  create_failed: "حصلت مشكلة وإحنا بنضيف الموظف — مفيش حاجة اتعملت، جرّب تاني.", invalid_amount: "المبلغ لازم يكون جنيهات صحيحة.",
};
export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const code = /ZH:([a-z_]+)/.exec(msg)?.[1] ?? (e as { code?: string })?.code ?? "";
  return `⚠️ ${ERR[code] ?? "حصلت مشكلة، جرّب تاني."}`;
}

// ------------------------------------------------------------ formatting
const egp = (p: unknown) => `${(Number(p ?? 0) / 100).toLocaleString("en-US")} ج.م`;
const mins = (m: unknown) => { const n = Number(m ?? 0); return `${Math.floor(n / 60)} س ${n % 60} د`; };
const statusAr: Record<string, string> = { pending: "⏳ بانتظار القرار", approved: "✅ مقبول", rejected: "❌ مرفوض", cancelled: "🚫 ملغي" };
const mapsLink = (lat: number, lng: number) => `https://maps.google.com/?q=${lat},${lng}`;

export const MAIN_MENU: Kb = [
  [{ text: "✅ الموافقات", callback_data: "m:appr" }, { text: "👥 الموظفين", callback_data: "m:emp" }],
  [{ text: "⭐ النقاط", callback_data: "m:pts" }, { text: "🕘 حضور استثنائي", callback_data: "m:att" }],
  [{ text: "📊 التقارير", callback_data: "m:rep" }, { text: "⚙️ الإعدادات", callback_data: "m:set" }],
  [{ text: "📢 إعلان للموظفين", callback_data: "m:bc" }],
];

// ------------------------------------------------------------ the bot
export class Bot {
  constructor(private d: Deps, private c: Ctx) {}

  private send(text: string, markup?: unknown, extra: Record<string, unknown> = {}) {
    return this.d.tg("sendMessage", { chat_id: this.c.chatId, text: H + text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: markup, ...extra });
  }
  private edit(messageId: number, text: string, markup?: unknown) {
    return this.d.tg("editMessageText", { chat_id: this.c.chatId, message_id: messageId, text: H + text, parse_mode: "HTML",
      disable_web_page_preview: true, reply_markup: markup ?? { inline_keyboard: [] } });
  }
  private state(): Promise<State | null> { return this.d.rpc<State | null>("svc_bot_state", { p_chat: this.c.chatId }); }
  private setState(st: State | null) { return this.d.rpc("svc_bot_state", { p_chat: this.c.chatId, p_set: true, p_state: st }); }
  private staff(): Promise<Emp[]> { return this.d.rpc<Emp[]>("svc_list_employees").then((l) => (l || []).filter((e) => e.role === "staff")); }

  /** Store an action and ask «تأكيد / إلغاء». */
  private async confirm(summary: string, action: Record<string, unknown>) {
    const id = await this.d.rpc<string>("svc_bot_action_create", { p_chat: this.c.chatId, p_action: action });
    await this.setState(null);
    return this.send(`${summary}\n\nمتأكد؟`, kb([[{ text: "✅ تأكيد", callback_data: `cf:${id}` }, { text: "✖️ إلغاء", callback_data: `cx:${id}` }]]));
  }

  private async pickEmployee(prompt: string, op: string, { includeInactive = false } = {}) {
    const list = (await this.staff()).filter((e) => includeInactive || e.active);
    if (!list.length) return this.send("مفيش موظفين.", kb([back()]));
    const rows: Kb = list.map((e) => [{ text: `${e.active ? "" : "⛔ "}${e.full_name_ar}`, callback_data: `e:${op}:${e.id}` }]);
    return this.send(prompt, kb([...rows, back()]));
  }

  // ---------------------------------------------------------- messages
  async onText(text: string, messageId: number) {
    const t = text.trim();
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(t);
    if (cmd) {
      await this.setState(null);
      switch (cmd[1].toLowerCase()) {
        case "start": case "menu": case "help": return this.mainMenu();
        case "today": return this.today();
        case "points": return this.points();
        case "report": return this.pickEmployee("📊 تقرير الشهر لمين؟", "r");
        case "pending": return this.approvals();
        case "broadcast": return this.startBroadcast();
        case "cancel": return this.send("تمام، اتلغى. ابعت /menu للقائمة.");
        default: return this.send("أمر مش معروف. ابعت /menu.");
      }
    }
    // legacy text replies: «موافق 7» / «رفض 7»
    const legacy = /^\s*(approve|reject|موافق|موافقة|قبول|رفض)\s*#?\s*(\d{1,12})\s*$/i.exec(asciiDigits(t));
    if (legacy) return this.decideEarly(Number(legacy[2]), !/^(reject|رفض)$/i.test(legacy[1]), null, messageId);

    const st = await this.state();
    if (!st) return this.send("ابعت /menu علشان تفتح القائمة.");
    return this.onFlowText(st, t);
  }

  private async onFlowText(st: State, t: string) {
    switch (st.flow) {
      case "emp_new": {
        const data = (st.data as Record<string, string>) ?? {};
        if (st.step === "name_ar") {
          if (t.length < 2 || t.length > 80) return this.send("الاسم لازم يكون من 2 لـ 80 حرف. ابعت الاسم بالعربي:");
          await this.setState({ flow: "emp_new", step: "name_en", data: { ...data, nameAr: t } });
          return this.send("تمام. ابعت الاسم بالإنجليزي (Latin):");
        }
        if (st.step === "name_en") {
          if (t.length < 2 || t.length > 80) return this.send("الاسم لازم يكون من 2 لـ 80 حرف. ابعت الاسم بالإنجليزي:");
          await this.setState({ flow: "emp_new", step: "job", data: { ...data, nameEn: t } });
          return this.send("ابعت المسمى الوظيفي (أو «-» لو مفيش):");
        }
        const job = t === "-" ? "" : t.slice(0, 60);
        return this.confirm(`➕ إضافة موظف جديد:\n• الاسم: <b>${esc(data.nameAr)}</b> / ${esc(data.nameEn)}${job ? `\n• الوظيفة: ${esc(job)}` : ""}\n\nهيتعمله كود دخول من 8 أرقام ويظهرلك مرة واحدة بس.`,
          { t: "emp_new", nameAr: data.nameAr, nameEn: data.nameEn, job });
      }
      case "pts": {
        if (t.length < 3) return this.send("السبب لازم يكون 3 حروف على الأقل. ابعت السبب:");
        const kind = String(st.kind);
        return this.confirm(`${POINT_KINDS[kind]?.label ?? "تعديل نقاط"} لـ <b>${esc(st.name)}</b>\n• السبب: ${esc(t.slice(0, 300))}`,
          { t: "pts", emp: st.emp, name: st.name, kind, reason: t.slice(0, 300) });
      }
      case "att": {
        const w = parseWhen(t);
        if (!w) return this.send("مش فاهم الوقت 🙏 ابعته كده: <code>9:30</code> أو <code>4:15 م</code> أو <code>2026-11-22 9:30</code>");
        return this.confirm(`🕘 تسجيل حضور استثنائي لـ <b>${esc(st.name)}</b>\n• اليوم: ${w.date ?? "النهارده"}\n• الساعة: ${w.time}\n\nالنقاط هتتحسب حسب نافذة الوقت ده.`,
          { t: "att", emp: st.emp, name: st.name, date: w.date, time: w.time });
      }
      case "set_win": {
        const wins = parseWindows(t);
        if (!wins) return this.send("الصيغة مش مظبوطة. كل نافذة في سطر:\n<code>مبكر 07:00-08:00\nعادي 09:00-10:00\nمتأخر 10:00-11:00</code>");
        return this.confirm(`🕘 مواعيد النوافذ الجديدة (لكل أيام العمل):\n${wins.map((w) => `• ${esc(w.label_ar)}: ${w.start} – ${w.end}`).join("\n")}\n\n⚠️ آخر نافذة بتحدد آخر موعد لتسجيل الحضور.`,
          { t: "set_win", windows: wins });
      }
      case "set_loc": {
        const loc = await resolveLocation(t, this.d.fetchUrl ?? ((u) => fetch(u, { redirect: "manual" })));
        if (!loc) return this.send("مش قادر أقرا الموقع. ابعت لينك جوجل ماب أو الإحداثيات كده: <code>29.98319, 31.32394</code>");
        return this.confirm(`📍 موقع المكتب الجديد:\n<code>${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}</code>\n${mapsLink(loc.lat, loc.lng)}`,
          { t: "set", patch: { geofence_lat: Number(loc.lat.toFixed(7)), geofence_lng: Number(loc.lng.toFixed(7)) }, what: "موقع المكتب" });
      }
      case "set_rad": {
        const n = Number(asciiDigits(t));
        if (!Number.isInteger(n) || n < 20 || n > 2000) return this.send("ابعت رقم صحيح بالمتر بين 20 و 2000:");
        return this.confirm(`📏 نطاق الحضور الجديد: <b>${n} متر</b>`, { t: "set", patch: { geofence_radius_m: n }, what: "نطاق الحضور" });
      }
      case "set_rew": {
        const n = Number(asciiDigits(t));
        if (!Number.isInteger(n) || n < 0 || n > 100000) return this.send("ابعت المبلغ بالجنيه (رقم صحيح):");
        return this.confirm(`💰 قيمة المكافأة الشهرية الجديدة: <b>${n} ج.م</b>`, { t: "set", patch: { reward_amount_piastres: n * 100 }, what: "قيمة المكافأة" });
      }
      case "bc": {
        if (t.length > 1000) return this.send("الإعلان طويل جدًا (أقصى حاجة 1000 حرف).");
        return this.confirm(`📢 الإعلان ده هيوصل لكل الموظفين (إشعار + يظهر في التطبيق):\n\n«${esc(t)}»`, { t: "bc", text: t });
      }
    }
    await this.setState(null);
    return this.send("ابعت /menu علشان تفتح القائمة.");
  }

  // ---------------------------------------------------------- buttons
  async onCallback(data: string, message: { message_id: number; text?: string; entities?: unknown[] }) {
    const messageId = message.message_id;
    if (data === "del") return this.d.tg("deleteMessage", { chat_id: this.c.chatId, message_id: messageId });
    let m: RegExpExecArray | null;
    if ((m = /^m:(\w+)$/.exec(data))) {
      await this.setState(null);
      switch (m[1]) {
        case "main": return this.mainMenu();
        case "appr": return this.approvals();
        case "emp": return this.employeesMenu();
        case "pts": return this.pickEmployee("⭐ تعديل نقاط مين؟", "p");
        case "att": return this.pickEmployee("🕘 تسجيل حضور استثنائي لمين؟", "c");
        case "rep": return this.send("📊 التقارير:", kb([[{ text: "📅 النهارده", callback_data: "r:today" }, { text: "🏆 ترتيب النقاط", callback_data: "r:points" }],
          [{ text: "👤 تقرير موظف (الشهر)", callback_data: "m:repemp" }], back()]));
        case "repemp": return this.pickEmployee("📊 تقرير الشهر لمين؟", "r");
        case "set": return this.settingsMenu();
        case "bc": return this.startBroadcast();
        case "newemp":
          await this.setState({ flow: "emp_new", step: "name_ar", data: {} });
          return this.send("➕ موظف جديد — ابعت الاسم بالعربي:\n(ابعت /cancel للإلغاء)");
      }
    }
    if (data === "r:today") return this.today();
    if (data === "r:points") return this.points();
    if ((m = /^el:(a|r):(\d{1,12})$/.exec(data))) return this.decideEarly(Number(m[2]), m[1] === "a", message, null);
    if ((m = new RegExp(`^lv:(a|r):(${UUID})$`).exec(data))) return this.decideLeave(m[2], m[1] === "a", message);
    if ((m = new RegExp(`^e:(v|p|c|r):(${UUID})$`).exec(data))) return this.onEmployee(m[1], m[2]);
    if ((m = new RegExp(`^p:(g\\+|g-|r\\+|r-):(${UUID})$`).exec(data))) {
      const emp = (await this.staff()).find((e) => e.id === m![2]);
      if (!emp) return this.send(ERR.invalid_employee);
      await this.setState({ flow: "pts", emp: emp.id, name: emp.full_name_ar, kind: m[1] });
      return this.send(`${POINT_KINDS[m[1]].label} لـ <b>${esc(emp.full_name_ar)}</b>\nابعت السبب (هيتسجّل):\n(ابعت /cancel للإلغاء)`);
    }
    if ((m = new RegExp(`^ea:(on|off|code):(${UUID})$`).exec(data))) {
      const emp = (await this.staff()).find((e) => e.id === m![2]);
      if (!emp) return this.send(ERR.invalid_employee);
      const what = m[1] === "on" ? "▶️ إعادة تفعيل" : m[1] === "off" ? "⛔ إيقاف" : "🔑 عمل كود دخول جديد لـ";
      const note = m[1] === "off" ? "\nهيتقفل دخوله فورًا ومش هيقدر يسجّل حضور." : m[1] === "code" ? "\nالكود القديم هيبطل وكل أجهزته هتخرج." : "";
      return this.confirm(`${what} <b>${esc(emp.full_name_ar)}</b>${note}`, { t: "emp_" + m[1], emp: emp.id, name: emp.full_name_ar });
    }
    if ((m = new RegExp(`^rp:(${UUID}):(0|1)$`).exec(data))) return this.report(m[1], m[2] === "1");
    if ((m = /^s:(win|loc|rad|rew|ntf)$/.exec(data))) return this.onSetting(m[1]);
    if ((m = /^nt:([a-z_]{3,30})$/.exec(data))) {
      const st = await this.d.rpc<Record<string, unknown>>("svc_bot_settings");
      const cur = new Set((st.notify_events as string[]) ?? []);
      const on = !cur.has(m[1]);
      if (on) cur.add(m[1]); else cur.delete(m[1]);
      const label = NOTIFY.find(([k]) => k === m![1])?.[1] ?? m[1];
      return this.confirm(`🔔 ${on ? "تشغيل" : "إيقاف"} تنبيه «${esc(label)}»`, { t: "set", patch: { notify_events: [...cur] }, what: "التنبيهات" });
    }
    if ((m = new RegExp(`^(cf|cx):(${UUID})$`).exec(data))) {
      const action = await this.d.rpc<Record<string, unknown> | null>("svc_bot_action_take", { p_chat: this.c.chatId, p_id: m[2] });
      if (!action) return this.edit(messageId, "ℹ️ الطلب ده اتنفّذ أو اتلغى أو انتهت صلاحيته.");
      if (m[1] === "cx") return this.edit(messageId, "✖️ اتلغى، محدش اتغيّر.");
      return this.execute(action, m[2], messageId);
    }
    return null;
  }

  // ---------------------------------------------------------- screens
  mainMenu() { return this.send("أهلًا 👋 اختار من القائمة:", kb(MAIN_MENU)); }

  async approvals() {
    const p = await this.d.rpc<Record<string, Array<Record<string, unknown>>>>("svc_pending", { p_actor: this.c.ownerId, p: {} });
    const early = (p.early_leave || []).filter((r) => r.status === "pending");
    const leave = (p.leave || []).filter((r) => r.status === "pending");
    if (!early.length && !leave.length) return this.send("✅ مفيش طلبات مستنية قرار.", kb([back()]));
    for (const r of early) {
      await this.send(`🕒 طلب انصراف مبكر #${r.id}\n• الموظف: <b>${esc(r.name_ar)}</b>\n• اليوم: ${esc(r.work_date)} — الساعة ${esc(String(r.requested_leave_time).slice(0, 5))}${r.reason ? `\n• السبب: ${esc(r.reason)}` : ""}`,
        kb([[{ text: "✅ قبول", callback_data: `el:a:${r.id}` }, { text: "❌ رفض", callback_data: `el:r:${r.id}` }]]));
    }
    for (const r of leave) {
      await this.send(`🌴 طلب إجازة ${r.type === "sick" ? "مرضية" : "شخصية"}\n• الموظف: <b>${esc(r.name_ar)}</b>\n• من ${esc(r.from_date)} لـ ${esc(r.to_date)}${r.reason ? `\n• السبب: ${esc(r.reason)}` : ""}`,
        kb([[{ text: "✅ قبول", callback_data: `lv:a:${r.id}` }, { text: "❌ رفض", callback_data: `lv:r:${r.id}` }]]));
    }
    return null;
  }

  /** Rewrite the request message with the decision and no buttons (can't be tapped twice). */
  private stamp(message: { message_id: number; text?: string; entities?: unknown[] }, line: string) {
    const plain = line.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    if (!message.text) return this.d.tg("editMessageReplyMarkup", { chat_id: this.c.chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } });
    return this.d.tg("editMessageText", { chat_id: this.c.chatId, message_id: message.message_id, text: `${message.text}\n\n— ${plain}`,
      entities: message.entities ?? [], reply_markup: { inline_keyboard: [] } });
  }

  async decideEarly(id: number, approve: boolean, message: { message_id: number; text?: string; entities?: unknown[] } | null, replyTo: number | null) {
    let line: string;
    try {
      const r = await this.d.rpc<Record<string, unknown>>("svc_decide_early_leave", { p_actor: this.c.ownerId, p: { id, approve, channel: "telegram" } });
      line = r.result === "already_decided"
        ? `ℹ️ الطلب #${id} (${esc(r.employee)}) اتحسم قبل كده: ${statusAr[String(r.status)] ?? esc(r.status)}`
        : r.status === "approved" ? `✅ اتقبل انصراف <b>${esc(r.employee)}</b> بدري الساعة ${esc(r.time)} — اتبعتله إشعار.`
        : `❌ اترفض طلب انصراف <b>${esc(r.employee)}</b> — اتبعتله إشعار.`;
    } catch (e) { line = errText(e); }
    if (message) return this.stamp(message, line);
    return this.send(line, undefined, replyTo ? { reply_to_message_id: replyTo } : {});
  }

  async decideLeave(id: string, approve: boolean, message: { message_id: number; text?: string; entities?: unknown[] }) {
    let line: string;
    try {
      const r = await this.d.rpc<Record<string, unknown>>("svc_decide_leave", { p_actor: this.c.ownerId, p: { id, approve } });
      line = r.result === "already_decided" ? `ℹ️ الطلب ده اتحسم قبل كده: ${statusAr[String(r.status)] ?? esc(r.status)}`
        : r.status === "approved" ? `✅ اتقبلت إجازة <b>${esc(r.employee)}</b> — اتبعتله إشعار.` : `❌ اترفضت إجازة <b>${esc(r.employee)}</b> — اتبعتله إشعار.`;
    } catch (e) { line = errText(e); }
    return this.stamp(message, line);
  }

  async employeesMenu() {
    const list = await this.staff();
    const lines = list.map((e) => `${e.active ? "🟢" : "⛔"} ${esc(e.full_name_ar)}${e.job_title_ar ? ` — ${esc(e.job_title_ar)}` : ""}`);
    return this.send(`👥 الموظفين (${list.length}):\n${lines.join("\n") || "مفيش موظفين لسه."}`,
      kb([...list.map((e) => [{ text: `${e.active ? "" : "⛔ "}${e.full_name_ar}`, callback_data: `e:v:${e.id}` }]),
        [{ text: "➕ موظف جديد", callback_data: "m:newemp" }], back()]));
  }

  async onEmployee(op: string, id: string) {
    const emp = (await this.staff()).find((e) => e.id === id);
    if (!emp) return this.send(ERR.invalid_employee);
    const name = esc(emp.full_name_ar);
    if (op === "v") {
      return this.send(`👤 <b>${name}</b> (${esc(emp.full_name_en)})\nالحالة: ${emp.active ? "🟢 شغّال" : "⛔ موقوف"}`,
        kb([[emp.active ? { text: "⛔ إيقاف", callback_data: `ea:off:${id}` } : { text: "▶️ إعادة تفعيل", callback_data: `ea:on:${id}` },
          { text: "🔑 كود جديد", callback_data: `ea:code:${id}` }],
          [{ text: "⭐ نقاط", callback_data: `e:p:${id}` }, { text: "📊 تقرير", callback_data: `e:r:${id}` }], back("m:emp")]));
    }
    if (op === "p") {
      if (!emp.active) return this.send(ERR.invalid_employee);
      return this.send(`⭐ نقاط <b>${name}</b> — اختار:`, kb([
        [{ text: POINT_KINDS["g+"].label, callback_data: `p:g+:${id}` }, { text: POINT_KINDS["g-"].label, callback_data: `p:g-:${id}` }],
        [{ text: POINT_KINDS["r+"].label, callback_data: `p:r+:${id}` }, { text: POINT_KINDS["r-"].label, callback_data: `p:r-:${id}` }], back("m:pts")]));
    }
    if (op === "c") {
      if (!emp.active) return this.send(ERR.invalid_employee);
      await this.setState({ flow: "att", emp: id, name: emp.full_name_ar });
      return this.send(`🕘 حضور استثنائي لـ <b>${name}</b>\nابعت وقت الحضور الفعلي النهارده (مثلًا <code>9:30</code> أو <code>9:30 ص</code>)،\nأو يوم سابق: <code>2026-11-22 9:30</code>\n(ابعت /cancel للإلغاء)`);
    }
    return this.report(id, false);
  }

  async report(id: string, prev: boolean) {
    const now = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).format(new Date());
    const [y, mo] = now.split("-").map(Number);
    const d = prev ? new Date(Date.UTC(y, mo - 2, 1)) : new Date(Date.UTC(y, mo - 1, 1));
    const month = d.toISOString().slice(0, 10);
    const rep = await this.d.rpc<Record<string, unknown>>("svc_payroll", { p_actor: this.c.ownerId, p: { month } });
    const r = ((rep.rows as Array<Record<string, unknown>>) || []).find((x) => x.employee_id === id);
    const nav = kb([[prev ? { text: "📅 الشهر الحالي", callback_data: `rp:${id}:0` } : { text: "📅 الشهر اللي فات", callback_data: `rp:${id}:1` }], back("m:rep")]);
    if (!r) return this.send(`مفيش بيانات للموظف ده في ${month.slice(0, 7)}.`, nav);
    const b = (r.points_breakdown as Record<string, number>) || {};
    return this.send([`📊 تقرير <b>${esc(r.full_name_ar)}</b> — ${month.slice(0, 7)}`,
      `• ساعات العمل: ${mins(r.worked_minutes)}`,
      `• 🟢 خضراء: ${b.green_total ?? 0} (حضور ${b.green_attendance ?? 0} · إنجاز ${b.green_outcome ?? 0})`,
      `• 🔴 حمراء: ${(b.red_warnings ?? 0) + (b.red_chargeable ?? 0)} (إنذار ${b.red_warnings ?? 0} · بخصم ${b.red_chargeable ?? 0} = ${egp(b.red_amount_piastres)})`,
      `• ⚫ سوداء معتمدة: ${b.black_approved ?? 0} = ${egp(b.black_amount_piastres)} · بانتظار: ${b.black_pending ?? 0}`,
      `• إجمالي الخصومات: <b>${egp(r.deductions_piastres)}</b>`,
      `• مكافأة مستحقة: ${egp(r.bonuses_earned_piastres)} · مدفوع: ${egp(r.bonuses_paid_piastres)}`,
      ...(((r.unresolved_flags as unknown[]) || []).length ? [`• ⚠️ أيام بدون انصراف: ${(r.unresolved_flags as Array<{ date: string }>).map((f) => f.date).join("، ")}`] : []),
    ].join("\n"), nav);
  }

  async today() {
    const t = await this.d.rpc<Record<string, unknown>>("svc_bot_today", { p_actor: this.c.ownerId, p: {} });
    if (t.holiday) return this.send(`📅 النهارده (${esc(t.date)}) إجازة رسمية: ${esc(t.holiday)} 🎉`);
    if (!t.is_work_day) return this.send(`📅 النهارده (${esc(t.date)}) يوم راحة.`);
    const people = (t.people as Array<Record<string, unknown>>) || [];
    const lines = people.map((p) => {
      const n = `<b>${esc(p.name)}</b>`;
      if (p.leave) return `🌴 ${n} — في إجازة`;
      if (p.in) {
        const tag = p.outcome === "red" ? "🟥 متأخر" : p.outcome === "green" ? "🟢 في الميعاد" : "✅ حاضر";
        return `${tag} ${n} — حضر ${esc(p.in)}${p.manual ? " (يدوي)" : ""}${p.out ? ` · انصرف ${esc(p.out)}` : ""}${p.early_leave ? ` · انصراف مبكر ${esc(p.early_leave)}` : ""}`;
      }
      return t.closed || p.absence_pending ? `❌ ${n} — غايب` : `⏳ ${n} — لسه مسجّلش`;
    });
    const count = (f: (p: Record<string, unknown>) => boolean) => people.filter(f).length;
    return this.send([`📅 النهارده ${esc(t.date)}${t.closes_at ? ` — آخر تسجيل ${esc(t.closes_at)}` : ""}`,
      `حاضر ${count((p) => !!p.in)} · متأخر ${count((p) => p.outcome === "red")} · غايب ${count((p) => !p.in && !p.leave && (!!t.closed || !!p.absence_pending))} · إجازة ${count((p) => !!p.leave)}`,
      "", ...lines].join("\n"));
  }

  async points() {
    const r = await this.d.rpc<Record<string, unknown>>("svc_bot_points", { p_actor: this.c.ownerId, p: {} });
    const rows = (r.rows as Array<Record<string, unknown>>) || [];
    const medal = (n: number) => (n === 1 ? "🥇" : n === 2 ? "🥈" : n === 3 ? "🥉" : `${n}.`);
    return this.send([`🏆 ترتيب النقاط — ${esc(String(r.period).slice(0, 7))} (الهدف ${r.threshold} نقطة)`,
      ...rows.map((x) => `${medal(Number(x.rank))} <b>${esc(x.name)}</b> — 🟢 ${x.green} · 🔴 ${x.red} · ⚫ ${x.black} (من البداية: 🟢 ${x.green_all})`)].join("\n") || "مفيش موظفين.");
  }

  async settingsMenu() {
    const s = await this.d.rpc<Record<string, unknown>>("svc_bot_settings");
    const wins = (s.windows as Array<Record<string, string>>) || [];
    return this.send([`⚙️ الإعدادات الحالية:`,
      `🕘 النوافذ: ${wins.map((w) => `${esc(w.label_ar)} ${w.start}–${w.end}`).join(" · ") || "—"}`,
      `📍 المكتب: <code>${s.geofence_lat}, ${s.geofence_lng}</code>`,
      `📏 النطاق: ${s.radius_m} متر`,
      `💰 المكافأة: ${egp(s.reward_piastres)} عند ${s.threshold} نقطة`].join("\n"),
    kb([[{ text: "🕘 مواعيد النوافذ", callback_data: "s:win" }, { text: "📍 موقع المكتب", callback_data: "s:loc" }],
      [{ text: "📏 نطاق الحضور", callback_data: "s:rad" }, { text: "💰 قيمة المكافأة", callback_data: "s:rew" }],
      [{ text: "🔔 التنبيهات", callback_data: "s:ntf" }], back()]));
  }

  async onSetting(k: string) {
    if (k === "ntf") {
      const s = await this.d.rpc<Record<string, unknown>>("svc_bot_settings");
      const on = new Set((s.notify_events as string[]) ?? []);
      return this.send("🔔 التنبيهات اللي بتوصلك (دوس علشان تشغّل/توقف):",
        kb([...NOTIFY.map(([k2, label]) => [{ text: `${on.has(k2) ? "✅" : "⬜"} ${label}`, callback_data: `nt:${k2}` }]), back("m:set")]));
    }
    const prompts: Record<string, string> = {
      win: "🕘 ابعت النوافذ الجديدة، كل نافذة في سطر:\n<code>مبكر 07:00-08:00\nعادي 09:00-10:00\nمتأخر 10:00-11:00</code>",
      loc: "📍 ابعت لينك موقع المكتب من جوجل ماب، أو الإحداثيات كده: <code>29.98319, 31.32394</code>",
      rad: "📏 ابعت نطاق الحضور بالمتر (مثلًا 100):",
      rew: "💰 ابعت قيمة المكافأة الشهرية بالجنيه (مثلًا 100):",
    };
    await this.setState({ flow: `set_${k}` });
    return this.send(`${prompts[k]}\n(ابعت /cancel للإلغاء)`);
  }

  async startBroadcast() {
    await this.setState({ flow: "bc" });
    return this.send("📢 اكتب الإعلان اللي عايز توصّله لكل الموظفين:\n(ابعت /cancel للإلغاء)");
  }

  // ---------------------------------------------------------- confirmed actions
  async execute(a: Record<string, unknown>, actionId: string, messageId: number) {
    try {
      switch (a.t) {
        case "pts": {
          const k = POINT_KINDS[String(a.kind)];
          const r = await this.d.rpc<Record<string, unknown>>("svc_manual_adjust", { p_actor: this.c.ownerId,
            p: { employee_id: a.emp, color: k.color, action: k.action, reason: a.reason, request_id: actionId } });
          return this.edit(messageId, `✅ تم: ${k.label} لـ <b>${esc(a.name)}</b>\nرصيد ${k.color === "green" ? "الأخضر" : "الأحمر"} الشهر ده: ${r.previous} ← <b>${r.total}</b>\nالسبب: ${esc(a.reason)}`);
        }
        case "att": {
          const r = await this.d.rpc<Record<string, unknown>>("svc_manual_check_in", { p_actor: this.c.ownerId,
            p: { employee_id: a.emp, date: a.date ?? undefined, time: a.time, reason: "تسجيل استثنائي من تيليجرام" } });
          const o = r.outcome === "green" ? "🟢 نقطة خضراء" : r.outcome === "red" ? "🔴 تأخير" : "بدون نقاط";
          return this.edit(messageId, `✅ اتسجّل حضور <b>${esc(r.employee)}</b> يوم ${esc(r.date)} الساعة ${esc(r.time)} — ${o}`);
        }
        case "emp_new": {
          const { employee, code } = await this.d.employees.create(this.c.ownerId, { nameAr: String(a.nameAr), nameEn: String(a.nameEn), phone: null });
          if (a.job) await this.d.rpc("svc_set_job_title", { p_actor: this.c.ownerId, p: { employee_id: employee.id, job_title_ar: a.job, job_title_en: a.job } }).catch(() => null);
          await this.edit(messageId, `✅ اتضاف <b>${esc(a.nameAr)}</b>.`);
          return this.send(`🔑 كود دخول <b>${esc(a.nameAr)}</b>:\n\n<code>${code}</code>\n\nابعته للموظف وامسح الرسالة دي. الكود مش هيظهر تاني.`,
            kb([[{ text: "🗑️ امسح الرسالة دي", callback_data: "del" }]]), { protect_content: true });
        }
        case "emp_off": case "emp_on": {
          await this.d.employees.setActive(this.c.ownerId, String(a.emp), a.t === "emp_on", "telegram");
          return this.edit(messageId, a.t === "emp_on" ? `▶️ اتفعّل <b>${esc(a.name)}</b> تاني.` : `⛔ اتوقف <b>${esc(a.name)}</b> وخرج من كل أجهزته.`);
        }
        case "emp_code": {
          const r = await this.d.employees.regenerate(this.c.ownerId, String(a.emp), null);
          await this.edit(messageId, `✅ اتعمل كود جديد لـ <b>${esc(a.name)}</b> (خرج من ${r?.sessions_revoked ?? 0} جهاز).`);
          return this.send(`🔑 الكود الجديد لـ <b>${esc(a.name)}</b>:\n\n<code>${r?.code}</code>\n\nابعته للموظف وامسح الرسالة دي.`,
            kb([[{ text: "🗑️ امسح الرسالة دي", callback_data: "del" }]]), { protect_content: true });
        }
        case "set_win": {
          const s = await this.d.rpc<Record<string, unknown>>("svc_bot_settings");
          const days = (s.work_days as number[]) || [];
          for (const dow of days) {
            await this.d.rpc("svc_save_day", { p_actor: this.c.ownerId, p: { day_of_week: dow, windows: (a.windows as Array<Record<string, string>>).map((w) => ({ ...w, enabled: true, awards_green_point: true })) } });
          }
          return this.edit(messageId, `✅ اتغيّرت مواعيد النوافذ لـ ${days.length} أيام عمل.`);
        }
        case "set": {
          await this.d.rpc("svc_update_settings", { p_actor: this.c.ownerId, p: a.patch });
          return this.edit(messageId, `✅ اتحفظ: ${esc(a.what)}.`);
        }
        case "bc": {
          const r = await this.d.rpc<Record<string, unknown>>("svc_broadcast", { p_actor: this.c.ownerId, p: { text: a.text } });
          return this.edit(messageId, `📢 الإعلان اتبعت لـ ${r.people} موظف (${r.devices} جهاز عليه إشعارات)، وظاهر في التطبيق.`);
        }
      }
      return this.edit(messageId, "⚠️ أمر مش معروف.");
    } catch (e) {
      return this.edit(messageId, errText(e));
    }
  }
}

export const POINT_KINDS: Record<string, { label: string; color: "green" | "red"; action: "add" | "remove" }> = {
  "g+": { label: "🟢 إضافة نقطة خضراء (مكافأة)", color: "green", action: "add" },
  "g-": { label: "➖ خصم نقطة خضراء", color: "green", action: "remove" },
  "r+": { label: "🔴 إضافة نقطة حمراء (خصم)", color: "red", action: "add" },
  "r-": { label: "↩️ شيل نقطة حمراء", color: "red", action: "remove" },
};
