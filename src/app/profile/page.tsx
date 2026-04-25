"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentChildId,
  getAllBooks,
  getAllRequests,
  DEMO_CHILDREN,
  clearLocalUserData,
  type DemoChildId,
} from "@/lib/userStore";
import { getSupabase } from "@/lib/supabase/client";
import { getCurrentParent } from "@/lib/supabase/parents";
import { isAloneInSociety } from "@/lib/supabase/children";
import Button from "@/components/ui/Button";
import ShareAppButton from "@/components/ShareAppButton";
import PushSettingsToggle from "@/components/PushSettingsToggle";

export default function ProfilePage() {
  const router = useRouter();
  const [childId, setChildId] = useState<DemoChildId>("c1");
  const [childName, setChildName] = useState("Reader");
  const [societyName, setSocietyName] = useState("Sunshine Residency");
  const [totalListed, setTotalListed] = useState(0);
  const [totalLent, setTotalLent] = useState(0);
  // Signing-out runs Supabase.signOut() + clears localStorage + navigates.
  // We track the in-flight state so the button shows a spinner + disables —
  // without it, double-taps could fire two signOut calls and the user has
  // no feedback that anything is happening.
  const [signingOut, setSigningOut] = useState(false);
  // `isAlone` drives the prominent share-card banner. Resolved async from
  // Supabase (parents.society_id + distinct-parent count in children), so
  // we start with null to avoid a flash of the banner for established users
  // while the query is in flight. null = unknown, true = show banner,
  // false = normal profile (default share button only).
  const [isAlone, setIsAlone] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    const id = getCurrentChildId();
    setChildId(id);

    const demoChild = DEMO_CHILDREN.find((c) => c.id === id);
    if (demoChild) setChildName(demoChild.name);

    // Prefer registration data if it matches
    const stored = localStorage.getItem("bb_child");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.name) setChildName(parsed.name);
      if (parsed.societyName) setSocietyName(parsed.societyName);
    }

    const books = getAllBooks().filter((b) => b.child_id === id);
    setTotalListed(books.length);

    const requests = getAllRequests();
    const lentCount = requests.filter(
      (r) =>
        r.lister_child_id === id &&
        (r.status === "approved" || r.status === "picked_up")
    ).length;
    setTotalLent(lentCount);
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("bb_user_change", refresh);
    window.addEventListener("bb_books_change", refresh);
    window.addEventListener("bb_requests_change", refresh);
    return () => {
      window.removeEventListener("bb_user_change", refresh);
      window.removeEventListener("bb_books_change", refresh);
      window.removeEventListener("bb_requests_change", refresh);
    };
  }, [refresh]);

  // Resolve first-in-society status from Supabase. We re-run when the user
  // identity or children set changes (bb_user_change fires after registration
  // and sign-out; bb_supabase_auth fires once bootstrap mints the session).
  // The helper returns `false` on any error, so a transient network glitch
  // won't pop the "you're first!" banner for a veteran user.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const parent = await getCurrentParent();
        if (cancelled) return;
        if (!parent?.society_id) {
          setIsAlone(false);
          return;
        }
        const alone = await isAloneInSociety(parent.society_id, parent.id);
        if (!cancelled) setIsAlone(alone);
      } catch (err) {
        console.error("[profile] isAloneInSociety check failed:", err);
        if (!cancelled) setIsAlone(false);
      }
    }
    check();
    const onChange = () => check();
    window.addEventListener("bb_user_change", onChange);
    window.addEventListener("bb_supabase_auth", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("bb_user_change", onChange);
      window.removeEventListener("bb_supabase_auth", onChange);
    };
  }, []);

  /**
   * Sign out: end the Supabase session AND blank this device's localStorage.
   *
   * Order matters: localStorage first so any race-y effect that re-reads
   * during the Supabase network round-trip sees an empty store. Then
   * supabase.auth.signOut() tears down the session. We navigate to
   * /auth/register because SupabaseAuthBootstrap will immediately mint a
   * fresh anonymous session on the next mount — without an explicit push
   * the user lands on /profile with mismatched identity.
   *
   * We do NOT await the supabase call blocking navigation: the
   * local wipe + router push is the user-visible action. A transient
   * network failure on signOut just leaves the stale session token on
   * disk, which the next auth check will reconcile.
   */
  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      clearLocalUserData();
      const supabase = getSupabase();
      await supabase.auth.signOut();
    } catch (err) {
      console.error("[profile] sign-out failed:", err);
    } finally {
      // Whether or not signOut succeeded, the local state is blanked.
      // Push to the register entry so the next screen is deterministic.
      router.push("/auth/register");
    }
  }

  return (
    <main className="flex-1 w-full max-w-2xl mx-auto px-5 pb-28">
      <header className="sticky top-0 z-40 bg-surface/80 backdrop-blur-md py-5">
        <h1 className="text-2xl font-headline font-extrabold text-on-surface">
          Profile
        </h1>
      </header>

      <div className="space-y-6">
        {/* Avatar + Name */}
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-full bg-primary-container flex items-center justify-center">
            <span className="material-symbols-outlined text-primary text-4xl">
              person
            </span>
          </div>
          <div>
            <h2 className="text-2xl font-headline font-extrabold text-on-surface">
              {childName}
            </h2>
            <p className="text-sm text-on-surface-variant flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">
                location_on
              </span>
              {societyName}
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-surface-container-lowest p-5 rounded-xl text-center shadow-sm">
            <p className="text-3xl font-headline font-extrabold text-primary">
              {totalListed}
            </p>
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mt-1">
              Books Listed
            </p>
          </div>
          <div className="bg-surface-container-lowest p-5 rounded-xl text-center shadow-sm">
            <p className="text-3xl font-headline font-extrabold text-secondary">
              {totalLent}
            </p>
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mt-1">
              Currently Lent
            </p>
          </div>
        </div>

        {/* First-in-society banner: prompts the newly registered user to
            invite neighbours so there are actually books to borrow. Hidden
            until the Supabase check resolves (isAlone === null), then only
            rendered when true. Once someone else joins the society, it
            quietly disappears on the next mount. */}
        {isAlone === true && (
          <ShareAppButton variant="prominent" />
        )}

        {/* Actions */}
        <div className="space-y-3">
          <Link href="/book/list" className="block">
            <Button variant="outline" fullWidth>
              <span className="material-symbols-outlined">add</span>
              List a new book
            </Button>
          </Link>
          {/* Always-on share CTA, regardless of society-alone status. */}
          <ShareAppButton variant="default" />
          {/* Push notification settings — full state machine inside
              (unsupported / iOS-needs-PWA / denied / off / on). */}
          <PushSettingsToggle />
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-full bg-surface-container-high text-on-surface-variant font-bold text-sm disabled:opacity-60"
          >
            {signingOut ? (
              <>
                <span className="w-4 h-4 border-2 border-on-surface-variant border-t-transparent rounded-full animate-spin" />
                Signing out...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-lg">logout</span>
                Sign out
              </>
            )}
          </button>
        </div>

        {/* Info */}
        <div className="bg-surface-container-low p-5 rounded-xl space-y-4">
          <h3 className="font-headline font-bold text-on-surface">
            About BookBuddy
          </h3>
          <p className="text-sm text-on-surface-variant leading-relaxed">
            BookBuddy is a peer-to-peer book sharing platform for kids in your
            housing society. List one book, borrow many. No money involved —
            just share the joy of reading!
          </p>
        </div>
      </div>
    </main>
  );
}
