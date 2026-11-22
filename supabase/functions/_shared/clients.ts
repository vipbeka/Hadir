import { createClient, SupabaseClient } from "@supabase/supabase-js";

const URL = Deno.env.get("SUPABASE_URL")!;
// The service-role key is injected by the platform into Edge Functions.
// It never leaves the server and is never sent to the browser.
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** Service-role client: bypasses RLS. Use only after authorising the caller. */
export const admin: SupabaseClient = createClient(URL, SERVICE_KEY, opts);

/** Fresh anon client (used to complete the server-side OTP verification). */
export const anonClient = (): SupabaseClient => createClient(URL, ANON_KEY, opts);

/** Call a service-only SQL function; throws on error. */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    const err = new Error(`${fn}: ${error.code ?? ""} ${error.message}`);
    (err as Error & { pg?: string }).pg = error.code ?? undefined;
    throw err;
  }
  return data as T;
}

export const serviceKeyForHmac = () => Deno.env.get("LOGIN_HASH_PEPPER") || SERVICE_KEY;
