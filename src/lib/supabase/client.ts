/**
 * Supabase browser client.
 *
 * Safe to import from client components. Uses the publishable (anon)
 * key, which has only the permissions granted to the `anon` Postgres
 * role by Row Level Security policies.
 *
 * Auth model: Google OAuth + email OTP (see lib/supabase/auth.ts).
 * The previous anonymous-auth bootstrap is gone — pages that need an
 * authenticated user check `getSession()` and redirect to /auth/sign-in
 * if missing.
 *
 * `detectSessionInUrl: true` is critical here: after Google redirects
 * back to /auth/callback with an access_token in the URL hash, the
 * client picks it up automatically on first instantiation. Without
 * this, the redirect lands on a page with no visible session change.
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
      // Pick the OAuth session up from the redirect-back URL hash.
      // Set to false in the previous anon-auth model because we never
      // had OAuth callbacks; with Google sign-in, this MUST be true.
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });

  return _client;
}

/**
 * Returns the current authenticated user's id, or null if there is
 * no live session. Pages that require auth should redirect to
 * /auth/sign-in when this returns null.
 *
 * (Previously this file exported `ensureAnonymousSession`, which
 * minted an anonymous session on demand. That's gone — auth is now
 * an explicit user action via Google or email OTP.)
 */
export async function getCurrentUserId(): Promise<string | null> {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}
