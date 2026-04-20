"use client";

import { useState, useMemo, useEffect } from "react";
import BookCard from "@/components/BookCard";
import GenreChips from "@/components/GenreChips";
import { getAllBooks, getAllRequests, getCurrentChildId, getCurrentUserSocietyId } from "@/lib/userStore";
import type { Genre, Book, BorrowRequest } from "@/lib/types";

export default function HomePage() {
  const [search, setSearch] = useState("");
  const [genreFilter, setGenreFilter] = useState<Genre | null>(null);
  const [allBooks, setAllBooks] = useState<Book[]>([]);
  const [allRequests, setAllRequests] = useState<BorrowRequest[]>([]);
  const [currentChildId, setCurrentChildId] = useState("c1");
  const [societyId, setSocietyId] = useState("s1");

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

    // Show books from the same society, not owned by current user, not already on their shelf
    let books = allBooks.filter(
      (b) =>
        b.society_id === societyId &&
        b.child_id !== currentChildId &&
        !myShelfBookIds.has(b.id)
    );

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
  }, [search, genreFilter, allBooks, allRequests, currentChildId, societyId]);

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
