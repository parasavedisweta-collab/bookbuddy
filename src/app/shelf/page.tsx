"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  getCurrentChildId,
  getAllRequests,
  getAllBooks,
  updateRequestStatus,
  removeListedBook,
  type DemoChildId,
} from "@/lib/userStore";
import { fetchMyShelfBooks } from "@/lib/supabase/feed";
import { updateBookStatus } from "@/lib/supabase/books";
import {
  fetchMyRequests,
  updateRequestStatus as updateSupabaseRequestStatus,
} from "@/lib/supabase/requests";
import { daysSince, relativeTime, whatsappLink, phoneLink } from "@/lib/helpers";
import type { BorrowRequest, Book, BorrowStatus } from "@/lib/types";

/** UUID regex — gates "also mirror this transition to Supabase" branches. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wrap a local updateRequestStatus with a mirrored Supabase update when the
 * request id looks like a UUID. Local fires first so the UI advances
 * immediately; the Supabase call runs async and the failure catch is
 * deliberately silent past the console log — a failed remote update isn't
 * worth bouncing the user out of an advanced state locally.
 */
async function transitionRequest(id: string, status: BorrowStatus) {
  updateRequestStatus(id, status);
  if (UUID_RE.test(id)) {
    try {
      await updateSupabaseRequestStatus(id, status);
    } catch (err) {
      console.error("[shelf] supabase request transition failed:", err);
    }
  }
}
import Button from "@/components/ui/Button";
import WhatsAppIcon from "@/components/ui/WhatsAppIcon";

function RequestCard({ req }: { req: BorrowRequest }) {
  const book = req.book;
  if (!book) return null;

  return (
    <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm flex gap-4">
      <div className="w-16 h-20 rounded-lg overflow-hidden bg-surface-container-high shrink-0">
        {book.cover_url ? (
          <img src={book.cover_url} alt={book.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="material-symbols-outlined text-outline-variant">menu_book</span>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="font-headline font-bold text-sm text-on-surface truncate">{book.title}</h4>
        <p className="text-xs text-on-surface-variant">{book.author}</p>
        {req.lister_child && (
          <p className="text-xs text-outline mt-0.5">
            Listed by <span className="font-semibold text-on-surface-variant">{req.lister_child.name}</span>
          </p>
        )}
        <div className="flex items-center gap-2 mt-2">
          <span
            className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
              req.status === "pending"
                ? "bg-secondary-container text-on-secondary-container"
                : req.status === "approved" || req.status === "picked_up"
                  ? "bg-primary-container text-on-primary-container"
                  : "bg-error-container text-on-error-container"
            }`}
          >
            {req.status.replace("_", " ")}
          </span>
          <span className="text-[10px] text-outline">{relativeTime(req.requested_at)}</span>
          {/* Disabled contact icons — active only once approved */}
          <div className="flex gap-1.5 ml-auto">
            <span title="Available after approval" className="w-7 h-7 rounded-full bg-outline-variant/40 text-outline flex items-center justify-center opacity-70 cursor-not-allowed">
              <WhatsAppIcon className="w-4 h-4" />
            </span>
            <span title="Available after approval" className="w-7 h-7 rounded-full bg-outline-variant/40 text-outline flex items-center justify-center opacity-70 cursor-not-allowed">
              <span className="material-symbols-outlined text-sm">call</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function BorrowedBookCard({ req }: { req: BorrowRequest }) {
  const book = req.book;
  if (!book) return null;
  const days = req.picked_up_at ? daysSince(req.picked_up_at) : 0;

  return (
    <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm flex gap-4">
      <div className="w-16 h-20 rounded-lg overflow-hidden bg-surface-container-high shrink-0">
        {book.cover_url && (
          <img src={book.cover_url} alt={book.title} className="w-full h-full object-cover" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="font-headline font-bold text-sm text-on-surface truncate">{book.title}</h4>
        {req.lister_child && (
          <p className="text-xs text-outline mt-0.5">
            From <span className="font-semibold text-on-surface-variant">{req.lister_child.name}</span>
          </p>
        )}
        <p className="text-xs text-on-surface-variant mt-0.5">
          {days} days borrowed
        </p>
        <div className="flex gap-2 mt-2">
          <a
            href={whatsappLink("9876543210")}
            target="_blank"
            rel="noopener noreferrer"
            className="w-8 h-8 rounded-full bg-[#25d366] text-white flex items-center justify-center"
          >
            <WhatsAppIcon className="w-4 h-4" />
          </a>
          <a
            href={phoneLink("9876543210")}
            className="w-8 h-8 rounded-full bg-tertiary text-on-tertiary flex items-center justify-center"
          >
            <span className="material-symbols-outlined text-base">call</span>
          </a>
        </div>
      </div>
    </div>
  );
}

function LendingCard({ req, onRefresh }: { req: BorrowRequest; onRefresh: () => void }) {
  const book = req.book;
  if (!book) return null;
  const isPending = req.status === "pending";

  async function approve() {
    await transitionRequest(req.id, "approved");
    onRefresh();
  }

  async function decline() {
    await transitionRequest(req.id, "declined");
    onRefresh();
  }

  async function markReturned() {
    await transitionRequest(req.id, "returned");
    onRefresh();
  }

  return (
    <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm flex gap-4">
      <div className="w-16 h-20 rounded-lg overflow-hidden bg-surface-container-high shrink-0">
        {book.cover_url && (
          <img src={book.cover_url} alt={book.title} className="w-full h-full object-cover" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="font-headline font-bold text-sm text-on-surface truncate">{book.title}</h4>
        <p className="text-xs text-on-surface-variant">
          {isPending
            ? `${req.borrower_child?.name} wants to borrow`
            : `Lent to ${req.borrower_child?.name}`}
        </p>
        {isPending ? (
          <div className="flex gap-2 mt-2">
            <button
              onClick={approve}
              className="px-3 py-1.5 bg-primary text-on-primary rounded-full text-xs font-bold"
            >
              Approve
            </button>
            <button
              onClick={decline}
              className="px-3 py-1.5 bg-surface-container-high text-on-surface-variant rounded-full text-xs font-bold"
            >
              Decline
            </button>
          </div>
        ) : (
          <button
            onClick={markReturned}
            className="mt-2 px-3 py-1.5 bg-secondary-container text-on-secondary-container rounded-full text-xs font-bold"
          >
            Mark as Returned
          </button>
        )}
      </div>
    </div>
  );
}

function ListedBookMini({ book, onRemove, isLast }: { book: Book; onRemove: (id: string) => void; isLast: boolean }) {
  const [showBlockedMsg, setShowBlockedMsg] = useState(false);

  function handleRemoveClick(e: React.MouseEvent) {
    e.preventDefault();
    if (isLast) {
      setShowBlockedMsg(true);
      setTimeout(() => setShowBlockedMsg(false), 3000);
    } else {
      onRemove(book.id);
    }
  }

  return (
    <div className="bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm relative group">
      <Link href={`/book/${book.id}`}>
        <div className="aspect-[3/4] bg-surface-container-high overflow-hidden">
          {book.cover_url ? (
            <img src={book.cover_url} alt={book.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-outline-variant">menu_book</span>
            </div>
          )}
        </div>
        <div className="p-2">
          <p className="text-xs font-bold text-on-surface truncate">{book.title}</p>
        </div>
      </Link>
      {/* Remove button */}
      <button
        onClick={handleRemoveClick}
        title={isLast ? "Can't remove last book" : "Remove listing"}
        className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow opacity-0 group-hover:opacity-100 transition-opacity ${
          isLast ? "bg-outline-variant text-on-surface-variant" : "bg-error text-on-error"
        }`}
      >
        <span className="material-symbols-outlined text-sm">{isLast ? "block" : "delete"}</span>
      </button>
      {/* Blocked tooltip */}
      {showBlockedMsg && (
        <div className="absolute inset-x-0 bottom-8 mx-1 bg-on-surface text-surface text-[10px] font-bold rounded-lg px-2 py-1.5 text-center leading-tight z-10 shadow-lg">
          You must keep at least 1 book listed to borrow from others
        </div>
      )}
    </div>
  );
}

export default function ShelfPage() {
  const [childId, setChildId] = useState<DemoChildId>("c1");
  const [requests, setRequests] = useState<BorrowRequest[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  // Supabase-backed copy of this parent's books + all Supabase child IDs they
  // own. Merged into `books` below so a registered user sees their real rows
  // even though the localStorage child id (c_<ts>) differs from the Supabase
  // UUID.
  const [supabaseBooks, setSupabaseBooks] = useState<Book[]>([]);
  const [mySupabaseChildIds, setMySupabaseChildIds] = useState<Set<string>>(
    () => new Set()
  );
  // Supabase-backed requests — both sides of the transaction, fetched via
  // RLS (caller is the borrower's or lister's parent). Merged with local
  // requests below so a request created on a different device still shows.
  const [supabaseRequests, setSupabaseRequests] = useState<BorrowRequest[]>([]);

  const refresh = useCallback(() => {
    setChildId(getCurrentChildId());
    setRequests(getAllRequests());
    setBooks(getAllBooks());
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("bb_user_change", refresh);
    window.addEventListener("bb_requests_change", refresh);
    window.addEventListener("bb_books_change", refresh);
    return () => {
      window.removeEventListener("bb_user_change", refresh);
      window.removeEventListener("bb_requests_change", refresh);
      window.removeEventListener("bb_books_change", refresh);
    };
  }, [refresh]);

  // Pull the Supabase shelf. Fires on mount + whenever local state says the
  // user changed or books changed (so a just-dual-written book appears here
  // without a hard reload).
  useEffect(() => {
    let cancelled = false;
    async function loadSupabase() {
      try {
        const { books: sbBooks, childIds } = await fetchMyShelfBooks();
        if (cancelled) return;
        setSupabaseBooks(sbBooks);
        setMySupabaseChildIds(new Set(childIds));
      } catch (err) {
        console.error("[shelf] supabase load failed:", err);
      }
    }
    loadSupabase();
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

  // Pull Supabase-backed requests (borrower or lister side). Runs parallel
  // to the books effect above. `bb_requests_change` fires on every local
  // transition so the remote copy stays fresh after the dual-write settles,
  // and `bb_supabase_auth` covers the first-mount race where the anon
  // session isn't ready yet.
  useEffect(() => {
    let cancelled = false;
    async function loadRequests() {
      try {
        const reqs = await fetchMyRequests();
        if (cancelled) return;
        setSupabaseRequests(reqs);
      } catch (err) {
        console.error("[shelf] supabase requests load failed:", err);
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

  // A book/request belongs to "me" if its child_id matches the localStorage
  // demo/registered child OR any of my Supabase children (the IDs differ
  // between stores during the dual-write migration).
  const isMyChild = (id: string) => id === childId || mySupabaseChildIds.has(id);

  // Merge local + Supabase requests, deduping by id. Supabase wins on a
  // collision because the dual-write re-keys the local row to the Supabase
  // UUID (see replaceLocalRequestId), so post-migration the same id carries
  // the authoritative joined book/child context from Supabase.
  const mergedRequests = (() => {
    const byId = new Map<string, BorrowRequest>();
    for (const r of requests) byId.set(r.id, r);
    for (const r of supabaseRequests) byId.set(r.id, r);
    return Array.from(byId.values());
  })();

  // Section 1: Books I requested (as borrower, pending/declined)
  const myRequests = mergedRequests.filter(
    (r) =>
      isMyChild(r.borrower_child_id) &&
      (r.status === "pending" || r.status === "declined")
  );

  // Section 2: Books I'm reading (as borrower, approved/picked_up)
  const myReading = mergedRequests.filter(
    (r) =>
      isMyChild(r.borrower_child_id) &&
      (r.status === "approved" || r.status === "picked_up")
  );

  // Section 3: Books I'm lending (as lister, active)
  const myLending = mergedRequests.filter(
    (r) =>
      isMyChild(r.lister_child_id) &&
      (r.status === "pending" || r.status === "approved" || r.status === "picked_up")
  );

  // Merge localStorage books with Supabase books (Supabase wins on dedup —
  // it has the real child name and survives localStorage wipes).
  const mergedBooks = (() => {
    const byId = new Map<string, Book>();
    for (const b of books) byId.set(b.id, b);
    for (const b of supabaseBooks) byId.set(b.id, b);
    return Array.from(byId.values());
  })();

  // Section 4: My available books not in active lending requests
  const activeLendingBookIds = new Set(myLending.map((r) => r.book_id));
  const myAvailableBooks = mergedBooks.filter(
    (b) =>
      isMyChild(b.child_id) &&
      b.status === "available" &&
      !activeLendingBookIds.has(b.id)
  );

  const isEmpty =
    myRequests.length === 0 &&
    myReading.length === 0 &&
    myLending.length === 0 &&
    myAvailableBooks.length === 0;

  return (
    <main className="flex-1 w-full max-w-2xl mx-auto px-5 pb-28">
      <header className="sticky top-0 z-40 bg-surface/80 backdrop-blur-md py-5">
        <h1 className="text-2xl font-headline font-extrabold text-on-surface">
          My Shelf
        </h1>
      </header>

      <div className="space-y-8">
        {/* Section 1: Requested */}
        {myRequests.length > 0 && (
          <section>
            <h2 className="text-sm font-bold text-secondary uppercase tracking-wider mb-3">
              Books Requested
            </h2>
            <div className="space-y-3">
              {myRequests.map((r) => (
                <RequestCard key={r.id} req={r} />
              ))}
            </div>
          </section>
        )}

        {/* Section 2: Reading */}
        {myReading.length > 0 && (
          <section>
            <h2 className="text-sm font-bold text-secondary uppercase tracking-wider mb-3">
              Books I&apos;m Reading
            </h2>
            <div className="space-y-3">
              {myReading.map((r) => (
                <BorrowedBookCard key={r.id} req={r} />
              ))}
            </div>
          </section>
        )}

        {/* Section 3: Lending */}
        {myLending.length > 0 && (
          <section>
            <h2 className="text-sm font-bold text-secondary uppercase tracking-wider mb-3">
              Books I&apos;m Lending
            </h2>
            <div className="space-y-3">
              {myLending.map((r) => (
                <LendingCard key={r.id} req={r} onRefresh={refresh} />
              ))}
            </div>
          </section>
        )}

        {/* Section 4: Other Listed Books */}
        <section>
          <h2 className="text-sm font-bold text-secondary uppercase tracking-wider mb-3">
            My Listed Books
          </h2>
          <div className="grid grid-cols-3 gap-3">
            <Link
              href="/book/list"
              className="bg-surface-container-low rounded-xl border-2 border-dashed border-outline-variant/40 flex flex-col items-center justify-center aspect-[3/4] hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-3xl text-primary mb-1">
                add_circle
              </span>
              <span className="text-xs font-bold text-primary">Add Book</span>
            </Link>
            {myAvailableBooks.map((book) => (
              <ListedBookMini
                key={book.id}
                book={book}
                isLast={myAvailableBooks.length <= 1}
                onRemove={async (id) => {
                  // Always clear the local copy so the UI updates instantly.
                  removeListedBook(id);
                  // If this row also lives in Supabase (id looks like a UUID),
                  // soft-delete it there too. Fail-open — the local remove
                  // has already happened and we don't want to block the UI.
                  if (/^[0-9a-f-]{36}$/i.test(id)) {
                    try {
                      await updateBookStatus(id, "removed");
                    } catch (err) {
                      console.error("[shelf] supabase remove failed:", err);
                    }
                  }
                  refresh();
                }}
              />
            ))}
          </div>
        </section>

        {isEmpty && (
          <div className="text-center py-12">
            <span className="material-symbols-outlined text-5xl text-outline-variant block mb-3">
              shelves
            </span>
            <p className="text-on-surface-variant font-medium mb-4">
              Your shelf is empty! List a book to get started.
            </p>
            <Link href="/book/list">
              <Button>
                List your first book
                <span className="material-symbols-outlined">add</span>
              </Button>
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
