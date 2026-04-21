/**
 * Supabase browser client.
 *
 * Safe to import from client components. Uses the publishable (anon) key,
 * which has only the permissions granted to the `anon` Postgres role by
 * Row Level Security policies.
 *
 * Anonymous auth: on first load we sign the user in anonymously (Path A).
 * The session is persisted in localStorage so the same anonymous user
 * identity survives tab reloads and re-opens.
 */
"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase env vars. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  _client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  return _client;
}

/**
 * Ensures the current browser session is signed in (anonymously if needed).
 * Call this once on app start, e.g. from a top-level client component.
 */
export async function ensureAnonymousSession(): Promise<string | null> {
  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session?.user?.id) {
    return sessionData.session.user.id;
  }

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) {
    console.error("[supabase] anon sign-in failed:", error);
    return null;
  }
  return data.user?.id ?? null;
}
