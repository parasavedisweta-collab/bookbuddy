"use client";

import { use, useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getCurrentChildId, createBorrowRequest, getAllRequests, getAllBooks, removeListedBook, replaceLocalRequestId, type DemoChildId } from "@/lib/userStore";
import {
  createBorrowRequest as createSupabaseBorrowRequest,
  findActiveRequest,
} from "@/lib/supabase/requests";
import { listChildrenForCurrentParent } from "@/lib/supabase/children";
import { fetchBookById } from "@/lib/supabase/feed";
import type { Book } from "@/lib/types";
import Link from "next/link";
import Button from "@/components/ui/Button";
import WhatsAppIcon from "@/components/ui/WhatsAppIcon";
import { whatsappLink, phoneLink } from "@/lib/helpers";

/**
 * Books and children created through the Supabase write path use UUIDs
 * (gen_random_uuid()). Local-only/demo rows use "book_…" / "c1". This
 * regex gates the dual-write: if the book id isn't a UUID there's no
 * matching Supabase row to request against, and RLS would reject.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function BookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [currentChildId, setCurrentChildId] = useState<DemoChildId>("c1");

  useEffect(() => {
    setCurrentChildId(getCurrentChildId());
    const handler = () => setCurrentChildId(getCurrentChildId());
    window.addEventListener("bb_user_change", handler);
    return () => window.removeEventListener("bb_user_change", handler);
  }, []);

  // Book resolution is a 3-state lifecycle: "loading" (we haven't decided
  // yet) → "found" (book is populated) → "not-found" (both sources checked,
  // nothing matches). The loading state matters because localStorage resolves
  // synchronously but the Supabase fallback is async — without it we'd flash
  // "Book not found" for every book that lives only in Supabase.
  const [book, setBook] = useState<Book | null>(null);
  const [lookupState, setLookupState] =
    useState<"loading" | "found" | "not-found">("loading");

  useEffect(() => {
    let cancelled = false;

    // Try localStorage first (synchronous, covers demo data and books this
    // user listed on this device).
    const local = getAllBooks().find((b) => b.id === id);
    if (local) {
      setBook(local);
      setLookupState("found");
      return;
    }

    // Fall back to Supabase. The home feed merges Supabase books into the
    // grid via society_id, so any id the user can click from there either
    // exists in Supabase or is stale — we should find it almost always.
    // Only UUIDs warrant the remote lookup; anything else is a dead demo id.
    if (!UUID_RE.test(id)) {
      setLookupState("not-found");
      return;
    }
    setLookupState("loading");
    fetchBookById(id)
      .then((found) => {
        if (cancelled) return;
        if (found) {
          setBook(found);
          setLookupState("found");
        } else {
          setLookupState("not-found");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[book-detail] supabase lookup failed:", err);
        setLookupState("not-found");
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Check if current user already has a pending/approved request for this book
  const existingRequest = useMemo(() => {
    return getAllRequests().find(
      (r) =>
        r.book_id === id &&
        r.borrower_child_id === currentChildId &&
        (r.status === "pending" || r.status === "approved" || r.status === "picked_up")
    );
  }, [id, currentChildId]);

  const [requestSent, setRequestSent] = useState(false);

  // Sync requestSent with existing requests on mount / user change
  useEffect(() => {
    setRequestSent(!!existingRequest);
  }, [existingRequest]);

  // Supabase-side gate: a user who requested this book from another device
  // shouldn't be offered the Request button again. Runs in addition to the
  // localStorage check — either source flips the button off.
  useEffect(() => {
    let cancelled = false;
    if (!book || !UUID_RE.test(book.id)) return;
    (async () => {
      try {
        const myChildren = await listChildrenForCurrentParent();
        if (cancelled || myChildren.length === 0) return;
        const active = await findActiveRequest({
          bookId: book.id,
          borrowerChildId: myChildren[0].id,
        });
        if (!cancelled && active) setRequestSent(true);
      } catch (err) {
        console.error("[book-detail] supabase active-request lookup failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book]);

  if (lookupState === "loading") {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-on-surface-variant">
          <span className="material-symbols-outlined text-4xl animate-pulse">
            menu_book
          </span>
          <p className="text-sm">Loading…</p>
        </div>
      </main>
    );
  }

  if (!book || lookupState === "not-found") {
    return (
      <main className="flex-1 flex items-center justify-center">
        <p className="text-on-surface-variant">Book not found</p>
      </main>
    );
  }

  const isAvailable = book.status === "available";
  const isOwnBook = book.child_id === currentChildId;
  const isLastBook = useMemo(
    () => getAllBooks().filter((b) => b.child_id === currentChildId && b.status === "available").length <= 1,
    [currentChildId]
  );

  // True if the current user has at least one book listed (available or borrowed out)
  const hasListedBook = useMemo(
    () => getAllBooks().some((b) => b.child_id === currentChildId),
    [currentChildId]
  );

  async function handleRequest() {
    // 1. Local write first: keeps demo/unregistered users on the shelf
    //    immediately, and guarantees we have a row to re-key if the
    //    Supabase write succeeds.
    const localReq = createBorrowRequest(id, currentChildId);
    setRequestSent(true);

    // 2. Attempt the Supabase dual-write. Only runs if both the book
    //    and the current parent have real Supabase identities — i.e.
    //    the book id is a UUID AND the caller has a Supabase child row.
    //    Registered users usually have exactly one child; we pick the
    //    first. If multiple children are ever supported, this needs to
    //    track which child the user has currently selected.
    if (!book || !UUID_RE.test(book.id) || !UUID_RE.test(book.child_id)) return;
    try {
      const myChildren = await listChildrenForCurrentParent();
      if (myChildren.length === 0) return;
      const borrowerChildId = myChildren[0].id;
      const dbReq = await createSupabaseBorrowRequest({
        bookId: book.id,
        borrowerChildId,
        listerChildId: book.child_id,
      });
      if (dbReq && localReq) {
        // Align ids so the shelf/home merge dedups the two copies.
        replaceLocalRequestId(localReq.id, dbReq.id);
      }
    } catch (err) {
      console.error("[book-detail] supabase request insert failed:", err);
    }
  }

  return (
    <main className="flex-1 w-full max-w-2xl mx-auto px-5 pb-28">
      {/* Nav */}
      <nav className="sticky top-0 z-40 py-4 bg-surface/80 backdrop-blur-md">
        <button
          onClick={() => router.back()}
          className="text-primary hover:scale-95 transition-transform"
        >
          <span className="material-symbols-outlined text-3xl">
            arrow_back
          </span>
        </button>
      </nav>

      <div className="space-y-8">
        {/* Cover */}
        <div className="relative w-full max-w-xs mx-auto aspect-[3/4] bg-surface-container-low rounded-xl shadow-2xl overflow-hidden">
          {book.cover_url ? (
            <img
              src={book.cover_url}
              alt={book.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="material-symbols-outlined text-7xl text-outline-variant">
                menu_book
              </span>
            </div>
          )}
          {!isAvailable && (
            <div className="absolute top-3 left-3 bg-error text-on-error text-xs font-bold uppercase px-3 py-1 rounded-full">
              Out of Stock
            </div>
          )}
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-2">
          {book.genre && (
            <span className="bg-tertiary-container/20 text-on-tertiary-container px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest">
              {book.genre}
            </span>
          )}
          {book.age_range && (
            <span className="bg-secondary-container/30 text-on-secondary-container px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest">
              Age {book.age_range}
            </span>
          )}
        </div>

        {/* Title / Author */}
        <div>
          <h1 className="text-3xl font-headline font-black text-on-surface leading-tight tracking-tight">
            {book.title}
          </h1>
          {book.author && (
            <p className="text-lg font-headline font-semibold text-outline mt-2">
              by {book.author}
            </p>
          )}
        </div>

        {/* AI Summary */}
        {book.summary && (
          <div className="bg-surface-container-lowest p-6 rounded-lg shadow-sm border-l-4 border-primary">
            <h3 className="flex items-center gap-2 text-primary font-headline font-extrabold text-xs uppercase tracking-widest mb-2">
              <span className="material-symbols-outlined text-lg">
                auto_awesome
              </span>
              Buddy&apos;s Quick Summary
            </h3>
            <p className="text-base text-on-surface-variant leading-relaxed">
              {book.summary}
            </p>
          </div>
        )}

        {/* Lister Info */}
        {book.child && (
          <div className="bg-surface-container-low p-5 rounded-lg flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-primary-container flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-2xl">
                person
              </span>
            </div>
            <div className="flex-1">
              <p className="text-xs font-bold text-outline uppercase tracking-wider">
                Listed by
              </p>
              <h4 className="text-lg font-headline font-bold text-on-surface">
                {book.child.name}
                {isOwnBook && (
                  <span className="ml-2 text-xs font-medium text-primary bg-primary-container/40 px-2 py-0.5 rounded-full">
                    You
                  </span>
                )}
              </h4>
            </div>
            {/* Contact links — only shown for others' books */}
            {!isOwnBook && (
              <div className="flex gap-2">
                <a
                  href={whatsappLink("9876543210", `Hi! I'd like to borrow "${book.title}"`)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-10 h-10 rounded-full bg-[#25d366] text-white flex items-center justify-center"
                >
                  <WhatsAppIcon className="w-5 h-5" />
                </a>
                <a
                  href={phoneLink("9876543210")}
                  className="w-10 h-10 rounded-full bg-tertiary text-on-tertiary flex items-center justify-center"
                >
                  <span className="material-symbols-outlined text-xl">call</span>
                </a>
              </div>
            )}
          </div>
        )}

        {/* CTA */}
        {isOwnBook ? (
          <div className="space-y-3">
            <div className="bg-surface-container-high p-5 rounded-xl text-center">
              <p className="font-headline font-bold text-on-surface-variant">
                This is your book
              </p>
              <p className="text-sm text-outline mt-1">
                Other kids in your society can request to borrow it.
              </p>
            </div>
            {isLastBook ? (
              <div className="flex items-start gap-3 bg-secondary-container/30 border border-secondary/20 rounded-xl p-4">
                <span className="material-symbols-outlined text-secondary shrink-0 mt-0.5">info</span>
                <p className="text-sm text-on-surface-variant leading-snug">
                  You need at least <span className="font-bold text-on-surface">1 book listed</span> to borrow from others. List another book before removing this one.
                </p>
              </div>
            ) : (
              <button
                onClick={() => { removeListedBook(id); router.push("/shelf"); }}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-error/40 text-error font-bold text-sm hover:bg-error/10 transition-colors"
              >
                <span className="material-symbols-outlined text-lg">delete</span>
                Remove from library
              </button>
            )}
          </div>
        ) : !hasListedBook ? (
          /* Gate: user must list at least one book before borrowing */
          <div className="space-y-4">
            <div className="bg-secondary-container/30 border border-secondary/20 rounded-xl p-5 flex items-start gap-3">
              <span className="material-symbols-outlined text-secondary shrink-0 mt-0.5 text-2xl">lock</span>
              <div>
                <p className="font-headline font-bold text-on-surface leading-snug">
                  List a book first to borrow
                </p>
                <p className="text-sm text-on-surface-variant mt-1 leading-snug">
                  BookBuddy is a give-and-take library. Share a book from your shelf to unlock borrowing from others.
                </p>
              </div>
            </div>
            <Link href="/book/list" className="block">
              <Button fullWidth>
                <span className="material-symbols-outlined">add_circle</span>
                List your first book
              </Button>
            </Link>
          </div>
        ) : isAvailable && !requestSent ? (
          <Button fullWidth onClick={handleRequest}>
            <span className="material-symbols-outlined">local_library</span>
            Request book
          </Button>
        ) : requestSent ? (
          <div className="bg-primary-container p-5 rounded-xl text-center">
            <span
              className="material-symbols-outlined text-primary text-4xl mb-2 block"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              check_circle
            </span>
            <p className="font-headline font-bold text-on-primary-container">
              Request sent!
            </p>
            <p className="text-sm text-on-primary-container/70 mt-1">
              The lister will be notified. You&apos;ll hear back within 7 days.
            </p>
          </div>
        ) : (
          <div className="bg-surface-container-high p-5 rounded-xl text-center">
            <p className="font-headline font-bold text-on-surface-variant">
              This book is currently borrowed
            </p>
            <p className="text-sm text-outline mt-1">
              Check back later or browse other books.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
