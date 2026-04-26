/**
 * Mounts once at the root layout. Listens for Supabase auth state
 * changes and dispatches the `bb_supabase_auth` event so page-level
 * effects can re-fetch when a session arrives or disappears.
 *
 * No longer creates anonymous sessions on demand. The new auth model
 * (Google OAuth + email OTP) requires an explicit user action — pages
 * that need auth check `getSession()` and route to /auth/sign-in
 * themselves. This component just keeps the rest of the app in sync
 * with whatever the auth state currently is.
 *
 * Renders nothing.
 */
"use client";

import { useEffect } from "react";
import { getSupabase } from "@/lib/supabase/client";

export default function SupabaseAuthBootstrap() {
  useEffect(() => {
    const supabase = getSupabase();

    // Fire once on mount with whatever the persisted session looks
    // like (could be a fresh tab on a logged-in user, could be a
    // signed-out visitor — either way the rest of the app needs the
    // signal to know which feed to render).
    supabase.auth.getSession().then(() => {
      window.dispatchEvent(new Event("bb_supabase_auth"));
    });

    // Subscribe to subsequent auth changes: SIGNED_IN (Google redirect
    // back, OTP verify, refresh-token rotation), SIGNED_OUT, USER_UPDATED.
    // Page-level effects listen to bb_supabase_auth and re-fetch.
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      window.dispatchEvent(new Event("bb_supabase_auth"));
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  return null;
}
