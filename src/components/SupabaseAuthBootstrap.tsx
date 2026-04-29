/**
 * Mounts once at the root layout. Listens for Supabase auth state
 * changes and dispatches the `bb_supabase_auth` event so page-level
 * effects can re-fetch when a session arrives or disappears.
 *
 * Also guards against the "session-without-parent" desync state: a
 * persisted Supabase JWT whose `user.id` doesn't match any `parents`
 * row. This historically left users staring at an empty home with no
 * recovery path — every read keyed on `parent.society_id` silently
 * returned null and the feed query never even fired (see
 * src/app/page.tsx loadSupabase). The recovery is to force sign-out
 * and bounce to /auth/sign-in so the user re-establishes a fresh
 * session bound to their real identity. We deliberately skip the
 * recovery while the user is still on /auth/* (sign-in, callback,
 * child-setup, success) — that flow legitimately holds a session
 * without a parent row mid-registration.
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

    /**
     * Verify the persisted session is still consistent with the DB.
     * If a session uid exists but no parents row matches, force a
     * clean sign-out and redirect — that's the "ghost session" state
     * (e.g. user signed up on device A, signed out server-side, opened
     * device B which still had a stale token; or a legacy anon JWT
     * from before migration 0007). We swallow query errors silently:
     * a transient network glitch must not log users out.
     */
    async function verifyOrRecover() {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const session = sessionData.session;
        // No session at all → fresh visitor or signed-out user. Nothing
        // to verify; let pages render their unauthenticated state.
        if (!session?.user?.id) return;

        // Skip the recovery on the auth flow itself — child-setup
        // legitimately runs with a session and no parent row until the
        // user submits the form.
        const path =
          typeof window !== "undefined" ? window.location.pathname : "";
        if (path.startsWith("/auth/")) return;

        const { data: parent, error } = await supabase
          .from("parents")
          .select("id")
          .eq("id", session.user.id)
          .maybeSingle();

        // Only act on a definitive "no row" result. An error here is
        // ambiguous (network, RLS hiccup, transient 5xx) — leaving the
        // session in place is the safer default; pages can still render.
        if (error) {
          console.warn(
            "[auth-bootstrap] parents lookup errored, leaving session intact:",
            error
          );
          return;
        }
        if (parent) return;

        // Definitively no parents row for this uid → ghost session.
        console.warn(
          "[auth-bootstrap] session uid has no parents row; forcing sign-out + redirect to /auth/sign-in"
        );
        await supabase.auth.signOut();
        // Hard navigate so every in-memory effect tears down cleanly.
        // Router.push would keep the bad client state alive for one more tick.
        window.location.replace("/auth/sign-in");
      } catch (err) {
        console.warn("[auth-bootstrap] verifyOrRecover threw:", err);
      }
    }

    // Fire once on mount with whatever the persisted session looks
    // like (could be a fresh tab on a logged-in user, could be a
    // signed-out visitor — either way the rest of the app needs the
    // signal to know which feed to render). The verify pass runs in
    // parallel; the dispatch isn't gated on it because we don't want
    // to block legitimate sessions on a slow parents query.
    supabase.auth.getSession().then(() => {
      window.dispatchEvent(new Event("bb_supabase_auth"));
    });
    void verifyOrRecover();

    // Subscribe to subsequent auth changes: SIGNED_IN (Google redirect
    // back, OTP verify, refresh-token rotation), SIGNED_OUT, USER_UPDATED.
    // Page-level effects listen to bb_supabase_auth and re-fetch.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      window.dispatchEvent(new Event("bb_supabase_auth"));
      // Re-verify on SIGNED_IN as well — covers the case where a
      // stale token is replaced by a fresh sign-in but the new uid
      // happens to also lack a parent row (cross-device first-time
      // sign-in mid-registration). TOKEN_REFRESHED is a routine
      // rotation and doesn't need re-verification.
      if (event === "SIGNED_IN") void verifyOrRecover();
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  return null;
}
