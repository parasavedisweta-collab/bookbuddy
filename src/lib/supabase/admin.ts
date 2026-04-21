/**
 * Supabase admin client (service role).
 *
 * DO NOT import this from any client component or any file that
 * gets bundled for the browser. The service-role key bypasses
 * Row Level Security and has full admin access to the database.
 *
 * Use only in:
 *   - Route handlers (src/app/api/**\/route.ts)
 *   - Server actions ("use server")
 *   - Server components (no "use client")
 *   - Admin dashboard backend
 */

import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing Supabase admin env vars. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  _admin = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return _admin;
}
