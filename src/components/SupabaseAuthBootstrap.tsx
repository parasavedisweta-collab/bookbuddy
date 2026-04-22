/**
 * Mounts once at the root layout. Ensures every visitor has an
 * anonymous Supabase session before any page does a write operation.
 *
 * Renders nothing — it's purely a side-effect hook.
 *
 * Flow:
 *   1. On mount, check if a Supabase session already exists (persisted in localStorage).
 *   2. If not, call supabase.auth.signInAnonymously() to create one.
 *   3. The resulting JWT lives in localStorage and is sent automatically with
 *      every Supabase client request, so RLS policies see auth.uid().
 *
 * Failure modes:
 *   - Supabase env vars missing → throws in getSupabase(), logged but app continues.
 *   - Anonymous sign-ins disabled server-side → logs a clear error.
 *   - Network offline → logs error, will retry on next mount.
 */
"use client";

import { useEffect } from "react";
import { ensureAnonymousSession } from "@/lib/supabase/client";

export default function SupabaseAuthBootstrap() {
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const uid = await ensureAnonymousSession();
        if (cancelled) return;
        if (uid) {
          console.debug("[supabase] anon session ready, uid =", uid);
          // Let page-level effects (home feed, shelf) know a session is
          // now available. Without this, effects that ran before the
          // session existed stay with an empty feed until the next
          // user-driven state change.
          window.dispatchEvent(new Event("bb_supabase_auth"));
        } else {
          console.warn(
            "[supabase] anon sign-in returned no uid; check that Anonymous Sign-ins is enabled in Supabase → Authentication → Sign In / Up."
          );
        }
      } catch (err) {
        console.error("[supabase] bootstrap failed:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
