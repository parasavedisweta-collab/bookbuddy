"use client";

/**
 * OAuth callback handler.
 *
 * Google redirects here after the user grants consent. The Supabase
 * client (created with `detectSessionInUrl: true`) reads the access
 * token from the URL hash on first instantiation and writes a session
 * to localStorage. We then decide where to send the user:
 *
 *   - parent row exists (registration complete) → home
 *   - no parent row yet → /auth/child-setup to capture society +
 *     phone + child name
 *
 * Note: this page is a thin router. The session arrives "for free"
 * thanks to detectSessionInUrl — we just wait for it to settle and
 * then navigate. Showing a tiny "Signing you in…" while we wait is
 * better than a blank flash.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { getCurrentParent } from "@/lib/supabase/parents";
import { listChildrenForCurrentParent } from "@/lib/supabase/children";
import { getSocietyById } from "@/lib/supabase/societies";
import { hydrateLocalFromSupabase } from "@/lib/userStore";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabase();

    async function finalize() {
      try {
        // Give detectSessionInUrl a tick to consume the hash. On most
        // browsers it resolves synchronously inside getSession() the
        // first time it's called after the redirect.
        const { data: sessionData, error: sessErr } =
          await supabase.auth.getSession();
        if (sessErr) {
          setError(sessErr.message);
          return;
        }
        if (!sessionData.session?.user?.id) {
          // No session — usually means the redirect was opened in a
          // tab that hadn't yet bootstrapped, or the hash was stripped.
          // Send them back to sign-in to retry.
          router.replace("/auth/sign-in");
          return;
        }

        const parent = await getCurrentParent();
        if (parent && parent.society_id) {
          // Rehydrate localStorage from Supabase before routing home.
          // Without this, the legacy getCurrentChildId() in userStore.ts
          // falls back to demo "c1" (Jenny) and home paints the wrong
          // identity until/unless the user manually picks their real
          // child from the switcher. Two round-trips here (children +
          // society) but they parallelise; it's < 200ms in practice.
          try {
            const [children, society] = await Promise.all([
              listChildrenForCurrentParent(),
              getSocietyById(parent.society_id),
            ]);
            const firstChild = children[0];
            if (firstChild) {
              hydrateLocalFromSupabase({
                childId: firstChild.id,
                childName: firstChild.name,
                childEmoji: firstChild.emoji,
                parentPhone: parent.phone,
                societyId: parent.society_id,
                societyName: society?.name ?? null,
                societyCity: society?.city ?? null,
              });
            }
          } catch (hydrateErr) {
            // Hydration is best-effort — if it fails the home page will
            // still try its own Supabase fetches; user just sees a brief
            // demo-data flash. Logged so we notice in dev.
            console.warn("[auth/callback] hydrate failed:", hydrateErr);
          }
          router.replace("/");
        } else {
          router.replace("/auth/child-setup");
        }
      } catch (err) {
        console.error("[auth/callback] finalize failed:", err);
        setError(
          err instanceof Error
            ? err.message
            : "Sign-in failed — please try again."
        );
      }
    }

    finalize();
  }, [router]);

  return (
    <main className="flex-grow flex flex-col items-center justify-center px-6 max-w-lg mx-auto w-full py-12 text-center">
      {error ? (
        <>
          <div className="w-12 h-12 rounded-full bg-error-container flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-error">error</span>
          </div>
          <h1 className="font-headline font-bold text-xl text-on-surface mb-2">
            Sign-in didn&apos;t complete
          </h1>
          <p className="text-sm text-on-surface-variant mb-6 max-w-xs">
            {error}
          </p>
          <button
            onClick={() => router.replace("/auth/sign-in")}
            className="text-primary font-bold underline"
          >
            Try again
          </button>
        </>
      ) : (
        <>
          <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-on-surface-variant">Signing you in…</p>
        </>
      )}
    </main>
  );
}
