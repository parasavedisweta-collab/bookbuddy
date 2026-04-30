"use client";

import { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import BookCard from "@/components/BookCard";
import GenreChips from "@/components/GenreChips";
import { getAllBooks, getAllRequests, getCurrentChildId, getCurrentUserSocietyId } from "@/lib/userStore";
import {
  fetchSocietyFeed,
  resolveCurrentSocietyId,
} from "@/lib/supabase/feed";
import { listChildrenForCurrentParent, isAloneInSociety } from "@/lib/supabase/children";
import { getCurrentParent } from "@/lib/supabase/parents";
import { fetchMyRequests } from "@/lib/supabase/requests";
import { getSupabase } from "@/lib/supabase/client";
import ShareAppButton from "@/components/ShareAppButton";
import NotificationBell from "@/components/NotificationBell";
import HelpButton from "@/components/HelpButton";
import ListBookFab from "@/components/ListBookFab";
import type { Genre, Book, BorrowRequest } from "@/lib/types";

/**
 * Auth-state values for the home page's render gate.
 *   - "unknown"       : initial / probe in flight, render placeholder.
 *   - "authenticated" : session live, render the feed.
 *   - "redirecting"   : no session, redirect to /auth/sign-in scheduled.
 *
 * The gate exists because the legacy localStorage helpers (getAllBooks,
 * getCurrentChildId) silently fall back to demo data + child id "c1"
 * (Jenny). Rendering the home page without a session therefore shows a
 * fake-populated grid as Jenny — which is what every WhatsApp-link
 * recipient saw before this gate landed.
 */
type AuthGate = "unknown" | "authenticated" | "redirecting";

export default function HomePage() {
  const router = useRouter();
  // Gate the entire feed render on whether we have a session. Default
  // "unknown" shows a placeholder; we resolve to "authenticated" once a
  // Supabase session is confirmed, or "redirecting" when there's none
  // (and immediately router.replace to /auth/sign-in). Without this,
  // a fresh visitor with empty localStorage falls through the legacy
  // helpers and sees a demo-populated home as Jenny.
  const [authGate, setAuthGate] = useState<AuthGate>("unknown");
  const [search, setSearch] = useState("");
  const [genreFilter, setGenreFilter] = useState<Genre | null>(null);
  const [allBooks, setAllBooks] = useState<Book[]>([]);
  const [allRequests, setAllRequests] = useState<BorrowRequest[]>([]);
  const [currentChildId, setCurrentChildId] = useState("");
  const [societyId, setSocietyId] = useState("");
  // Supabase-backed feed and "mine" filter. Kept separate from localStorage
  // books so a failed Supabase call never masks local/demo data.
  const [supabaseFeed, setSupabaseFeed] = useState<Book[]>([]);
  const [mySupabaseChildIds, setMySupabaseChildIds] = useState<Set<string>>(
    () => new Set()
  );
  // Supabase-backed requests (both borrower + lister side via RLS). Used
  // ONLY to extend myShelfBookIds so a book already requested on another
  // device disappears from this device's feed. The home feed never renders
  // request cards itself — that's the shelf's job.
  const [supabaseRequests, setSupabaseRequests] = useState<BorrowRequest[]>([]);
  // First-in-society signal drives the "invite your neighbours" banner above
  // the feed. null while the Supabase query is in flight so we don't flash
  // the banner for an established society on first paint.
  const [isAlone, setIsAlone] = useState<boolean | null>(null);
  // Registered = parent row exists with a society_id. Drives the floating
  // "List a book" FAB — for unregistered visitors /book/list bounces them
  // through registration, so the CTA is misleading rather than helpful.
  const [isRegistered, setIsRegistered] = useState(false);

  // Auth gate. Probes the persisted Supabase session on mount and on
  // bb_supabase_auth (fired by SupabaseAuthBootstrap on SIGNED_IN /
  // SIGNED_OUT / TOKEN_REFRESHED). No session → router.replace to
  // /auth/sign-in so a stranger who clicked the WhatsApp link lands on
  // the sign-in CTA instead of a demo-populated grid pretending to be
  // Jenny. We deliberately do NOT block the other effects below on
  // this — they run in parallel; the render gate at the bottom is what
  // hides the feed until auth resolves.
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const supabase = getSupabase();
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        if (data.session?.user?.id) {
          setAuthGate("authenticated");
        } else {
          setAuthGate("redirecting");
          router.replace("/auth/sign-in");
        }
      } catch (err) {
        // Network glitch / Supabase outage: treat as no-session and
        // redirect. Better to over-redirect than to flash demo data.
        console.warn("[home] auth probe failed, redirecting to sign-in:", err);
        if (!cancelled) {
          setAuthGate("redirecting");
          router.replace("/auth/sign-in");
        }
      }
    }
    probe();
    const onAuth = () => probe();
    window.addEventListener("bb_supabase_auth", onAuth);
    return () => {
      cancelled = true;
      window.removeEventListener("bb_supabase_auth", onAuth);
    };
  }, [router]);

  useEffect(() => {
    const refresh = () => {
      setCurrentChildId(getCurrentChildId());
      setSocietyId(getCurrentUserSocietyId());
      setAllBooks(getAllBooks());
      setAllRequests(getAllRequests());
    };
    refresh();
    window.addEventListener("bb_books_change", refresh);
    window.addEventListener("bb_user_change", refresh);
    window.addEventListener("bb_requests_change", refresh);
    return () => {
      window.removeEventListener("bb_books_change", refresh);
      window.removeEventListener("bb_user_change", refresh);
      window.removeEventListener("bb_requests_change", refresh);
    };
  }, []);

  // Pull the Supabase-backed feed. Runs in parallel with the localStorage
  // hydration above; either source can populate the grid. The `cancelled`
  // flag guards against a late resolve on an unmounted component.
  useEffect(() => {
    let cancelled = false;
    async function loadSupabase() {
      try {
        const [sid, myChildren] = await Promise.all([
          resolveCurrentSocietyId(),
          listChildrenForCurrentParent(),
        ]);
        if (cancelled) return;
        setMySupabaseChildIds(new Set(myChildren.map((c) => c.id)));
        if (!sid) {
          // Unregistered session — no society to scope to. Feed stays
          // whatever localStorage hands us (demo data for dev users,
          // nothing for a fresh anon).
          setSupabaseFeed([]);
          return;
        }
        const books = await fetchSocietyFeed(sid);
        if (!cancelled) setSupabaseFeed(books);
      } catch (err) {
        console.error("[home] supabase feed load failed:", err);
      }
    }
    loadSupabase();
    // Reload when the user or their local book state changes — covers
    // registration completing mid-session and new dual-written books.
    // bb_supabase_auth fires from SupabaseAuthBootstrap once the anon
    // session is ready, so pages that rendered pre-session refill.
    const onChange = () => loadSupabase();
    window.addEventListener("bb_user_change", onChange);
    window.addEventListener("bb_books_change", onChange);
    window.addEventListener("bb_supabase_auth", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("bb_user_change", onChange);
      window.removeEventListener("bb_books_change", onChange);
      window.removeEventListener("bb_supabase_auth", onChange);
    };
  }, []);

  // First-in-society check — shows an invite banner when the user is the
  // only registered parent in their society. Uses the Supabase helper
  // (counts distinct parent_ids in children, since parents RLS hides
  // everyone else). Re-runs on user change so the banner disappears as
  // soon as a neighbour joins. bb_books_change catches the case where
  // someone else's first book listing implicitly proves they've joined.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const parent = await getCurrentParent();
        if (cancelled) return;
        if (!parent?.society_id) {
          setIsAlone(false);
          setIsRegistered(false);
          return;
        }
        setIsRegistered(true);
        const alone = await isAloneInSociety(parent.society_id, parent.id);
        if (!cancelled) setIsAlone(alone);
      } catch (err) {
        console.error("[home] isAloneInSociety check failed:", err);
        if (!cancelled) {
          setIsAlone(false);
          setIsRegistered(false);
        }
      }
    }
    check();
    const onChange = () => check();
    window.addEventListener("bb_user_change", onChange);
    window.addEventListener("bb_books_change", onChange);
    window.addEventListener("bb_supabase_auth", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("bb_user_change", onChange);
      window.removeEventListener("bb_books_change", onChange);
      window.removeEventListener("bb_supabase_auth", onChange);
    };
  }, []);

  // Pull Supabase-backed requests so a book requested on another device
  // stays hidden from this device's feed. Separate effect from the feed
  // load above so a transient requests-fetch error doesn't blank the grid.
  useEffect(() => {
    let cancelled = false;
    async function loadRequests() {
      try {
        const reqs = await fetchMyRequests();
        if (!cancelled) setSupabaseRequests(reqs);
      } catch (err) {
        console.error("[home] supabase requests load failed:", err);
      }
    }
    loadRequests();
    const onChange = () => loadRequests();
    window.addEventListener("bb_user_change", onChange);
    window.addEventListener("bb_requests_change", onChange);
    window.addEventListener("bb_supabase_auth", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("bb_user_change", onChange);
      window.removeEventListener("bb_requests_change", onChange);
      window.removeEventListener("bb_supabase_auth", onChange);
    };
  }, []);

  const filteredBooks = useMemo(() => {
    // Books the current user is already interacting with (on their shelf).
    // We merge local + Supabase requests, deduped by id, so a cross-device
    // borrower's pending request (which only lives in Supabase) still hides
    // the book here. "Mine" covers either the localStorage/demo child id or
    // any Supabase child this parent owns.
    const isMyBorrower = (id: string) =>
      id === currentChildId || mySupabaseChildIds.has(id);
    const mergedRequests = new Map<string, BorrowRequest>();
    for (const r of allRequests) mergedRequests.set(r.id, r);
    for (const r of supabaseRequests) mergedRequests.set(r.id, r);
    const myShelfBookIds = new Set(
      Array.from(mergedRequests.values())
        .filter(
          (r) =>
            isMyBorrower(r.borrower_child_id) &&
            (r.status === "pending" || r.status === "approved" || r.status === "picked_up")
        )
        .map((r) => r.book_id)
    );

    // A book is "mine" if its child_id matches either the localStorage
    // demo/registered childId or any Supabase child owned by this parent.
    const isMine = (childId: string) =>
      childId === currentChildId || mySupabaseChildIds.has(childId);

    // localStorage books use slug society IDs (e.g. "s_green_meadows_mumbai");
    // Supabase books use UUIDs. They never collide, so society filtering has
    // to be source-aware: apply `societyId === ...` only to local books, and
    // trust that `fetchSocietyFeed(sid)` already scoped the Supabase set
    // server-side.
    const localMatches = allBooks.filter(
      (b) => b.society_id === societyId && !isMine(b.child_id) && !myShelfBookIds.has(b.id)
    );
    const supabaseMatches = supabaseFeed.filter(
      (b) => !isMine(b.child_id) && !myShelfBookIds.has(b.id)
    );

    // Merge, deduping by id. Supabase wins on collisions for most fields
    // (it has the real joined society_id / child name), EXCEPT cover_url:
    // user-photo covers live as base64 in localStorage and as cover_url=null
    // in Supabase (Storage upload isn't wired yet). A blanket overwrite here
    // would strip the cover from every freshly-listed user-photo book, which
    // the user perceives as a failed upload. So when Supabase's cover is
    // null but we have a local cover for the same id, keep the local one.
    // Look up against the full allBooks, not the filtered localMatches —
    // filtering can't move a book between "mine" and "theirs" for the same
    // id, but the guard is cheap and future-proofs the merge.
    const localById = new Map<string, Book>();
    for (const b of allBooks) localById.set(b.id, b);
    const byId = new Map<string, Book>();
    for (const b of localMatches) byId.set(b.id, b);
    for (const b of supabaseMatches) {
      const local = localById.get(b.id);
      if (local && !b.cover_url && local.cover_url) {
        byId.set(b.id, {
          ...b,
          cover_url: local.cover_url,
          cover_source: local.cover_source,
        });
      } else {
        byId.set(b.id, b);
      }
    }
    let books = Array.from(byId.values());

    if (genreFilter) {
      books = books.filter((b) => b.genre === genreFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      books = books.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.author?.toLowerCase().includes(q) ||
          b.child?.name.toLowerCase().includes(q)
      );
    }

    // Sort: available first, then by listed_at descending
    books.sort((a, b) => {
      if (a.status === "available" && b.status !== "available") return -1;
      if (a.status !== "available" && b.status === "available") return 1;
      return new Date(b.listed_at).getTime() - new Date(a.listed_at).getTime();
    });

    return books;
  }, [
    search,
    genreFilter,
    allBooks,
    supabaseFeed,
    allRequests,
    supabaseRequests,
    currentChildId,
    societyId,
    mySupabaseChildIds,
  ]);

  // Render gate: until we've confirmed a session, show a thin neutral
  // placeholder. Without this, the legacy localStorage fallbacks (Jenny
  // as default child id, demo books) would paint for one tick before
  // the redirect lands — strangers from the WhatsApp link saw exactly
  // that. Plain spinner, no logo / nav, so unauth visitors never glimpse
  // the signed-in chrome.
  if (authGate !== "authenticated") {
    return (
      <main className="flex-1 w-full flex items-center justify-center">
        <div
          className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin"
          aria-label="Loading"
        />
      </main>
    );
  }

  return (
    <main className="flex-1 w-full max-w-2xl mx-auto">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-surface/80 backdrop-blur-md px-5 pt-5 pb-2">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-secondary-container flex items-center justify-center">
              <span className="material-symbols-outlined text-on-secondary-container text-lg">
                auto_stories
              </span>
            </div>
            <span className="text-primary font-headline font-extrabold text-xl">
              BookBuds
            </span>
          </div>
          {/* Right-side icon group: help + notifications. HelpButton on
              the left so the popover (anchored to its right edge) doesn't
              collide with the bell's tap target. */}
          <div className="flex items-center gap-2">
            <HelpButton />
            <NotificationBell />
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-2">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">
            search
          </span>
          <input
            type="text"
            placeholder="Search by title, author, or lister..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-surface-container-high border-none rounded-full pl-10 pr-4 py-3 text-sm text-on-surface placeholder:text-outline-variant focus:ring-2 focus:ring-primary-container outline-none"
          />
        </div>

        {/* Genre chips */}
        <GenreChips selected={genreFilter} onSelect={setGenreFilter} />
      </header>

      {/* First-in-society invite banner. Renders above the feed so it's
          the first thing the user sees when the grid is empty (their only
          child has no listings yet), and rides along at the top otherwise.
          Hidden entirely while the Supabase check is in flight (isAlone
          === null) and once a neighbour joins (false). */}
      {isAlone === true && (
        <section className="px-5 pt-2 pb-4">
          <ShareAppButton variant="prominent" />
        </section>
      )}

      {/* Book Grid */}
      <section className="px-5 pb-8">
        {filteredBooks.length > 0 ? (
          <div className="grid grid-cols-2 gap-4">
            {filteredBooks.map((book) => (
              <BookCard key={book.id} book={book} />
            ))}
          </div>
        ) : (
          <div className="text-center py-16">
            <span className="material-symbols-outlined text-5xl text-outline-variant mb-3 block">
              search_off
            </span>
            <p className="text-on-surface-variant font-medium">
              No books found. Try a different search or filter.
            </p>
          </div>
        )}
      </section>

      {/* Floating "List a book" CTA. Hidden for unregistered visitors —
          /book/list bounces them through registration, so dangling the
          shortcut would be misleading. */}
      {isRegistered && <ListBookFab />}
    </main>
  );
}
