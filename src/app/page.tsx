"use client";

import { useState, useMemo, useEffect } from "react";
import BookCard from "@/components/BookCard";
import GenreChips from "@/components/GenreChips";
import { getAllBooks, getAllRequests, getCurrentChildId, getCurrentUserSocietyId } from "@/lib/userStore";
import {
  fetchSocietyFeed,
  resolveCurrentSocietyId,
} from "@/lib/supabase/feed";
import { listChildrenForCurrentParent } from "@/lib/supabase/children";
import type { Genre, Book, BorrowRequest } from "@/lib/types";

export default function HomePage() {
  const [search, setSearch] = useState("");
  const [genreFilter, setGenreFilter] = useState<Genre | null>(null);
  const [allBooks, setAllBooks] = useState<Book[]>([]);
  const [allRequests, setAllRequests] = useState<BorrowRequest[]>([]);
  const [currentChildId, setCurrentChildId] = useState("c1");
  const [societyId, setSocietyId] = useState("s1");
  // Supabase-backed feed and "mine" filter. Kept separate from localStorage
  // books so a failed Supabase call never masks local/demo data.
  const [supabaseFeed, setSupabaseFeed] = useState<Book[]>([]);
  const [mySupabaseChildIds, setMySupabaseChildIds] = useState<Set<string>>(
    () => new Set()
  );

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
    const onChange = () => loadSupabase();
    window.addEventListener("bb_user_change", onChange);
    window.addEventListener("bb_books_change", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("bb_user_change", onChange);
      window.removeEventListener("bb_books_change", onChange);
    };
  }, []);

  const filteredBooks = useMemo(() => {
    // Books the current user is already interacting with (on their shelf)
    const myShelfBookIds = new Set(
      allRequests
        .filter(
          (r) =>
            r.borrower_child_id === currentChildId &&
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

    // Merge, deduping by id. Supabase wins on collisions: the dual-write
    // phase writes to both stores but only Supabase has the real joined
    // society_id / child name, so we prefer that copy.
    const byId = new Map<string, Book>();
    for (const b of localMatches) byId.set(b.id, b);
    for (const b of supabaseMatches) byId.set(b.id, b);
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
    currentChildId,
    societyId,
    mySupabaseChildIds,
  ]);

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
              BookBuddy
            </span>
          </div>
          <button className="p-2 text-on-surface-variant">
            <span className="material-symbols-outlined">notifications</span>
          </button>
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
    </main>
  );
}
