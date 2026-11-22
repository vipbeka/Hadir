// HTTP helpers shared by all Zintra حاضر Edge Functions.
// Responses are JSON, never cached, and errors carry a stable `code`
// (the UI maps codes to localized messages) — never stack traces.

const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED.includes("*") ? "*" : (ALLOWED.includes(origin) ? origin : ALLOWED[0] ?? "");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export const fail = (status: number, code: string): never => { throw new HttpError(status, code); };

/** Wrap a handler: CORS preflight, POST-only, JSON body parse, error mapping. */
export function serve(handler: (req: Request, body: Record<string, unknown>) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
    if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      if (text.length > 16_384) return json(req, { error: "payload_too_large" }, 413);
      body = text ? JSON.parse(text) : {};
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
    } catch {
      return json(req, { error: "invalid_json" }, 400);
    }
    try {
      return await handler(req, body);
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.code }, e.status);
      // Log only the error class/message — never request bodies (they may hold codes).
      console.error("unhandled", e instanceof Error ? `${e.name}: ${e.message}` : "unknown");
      return json(req, { error: "server_error" }, 500);
    }
  });
}

// ---------------------------------------------------------- validation
export function str(v: unknown, { min = 0, max = 200, pattern }: { min?: number; max?: number; pattern?: RegExp } = {}): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < min || s.length > max) return null;
  if (pattern && !pattern.test(s)) return null;
  return s;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PHONE_RE = /^\+?[0-9 ]{7,20}$/;
