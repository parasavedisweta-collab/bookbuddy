"use client";

import { use, useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getCurrentChildId, createBorrowRequest, getAllRequests, getAllBooks, removeListedBook, replaceLocalRequestId } from "@/lib/userStore";
import {
  createBorrowRequest as createSupabaseBorrowRequest,
  findActiveRequest,
} from "@/lib/supabase/requests";
import { listChildrenForCurrentParent } from "@/lib/supabase/children";
import { listBooksForChild, updateBookStatus } from "@/lib/supabase/books";
import { getListerContactForBook } from "@/lib/supabase/parents";
import { fetchBookById } from "@/lib/supabase/feed";
import { publicGetBookById, type PublicBookDetail } from "@/lib/supabase/publicBrowse";
import { getSupabase } from "@/lib/supabase/client";
import type { Book, BookStatus, Genre } from "@/lib/types";
import Link from "next/link";
import Button from "@/components/ui/Button";
import WhatsAppIcon from "@/components/ui/WhatsAppIcon";
import PushPermissionNudge from "@/components/PushPermissionNudge";
import { whatsappLink, phoneLink } from "@/lib/helpers";

/**
 * Books and children created through the Supabase write path use UUIDs
 * (gen_random_uuid()). Local-only rows use timestamp-based ids like
 * "book_<ts>". This regex gates the dual-write: if the book id isn't a
 * UUID there's no matching Supabase row to request against, and RLS
 * would reject.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a public-browse detail row to the app's Book shape so the same
 * detail UI can render whether the visitor is authenticated or not.
 * Loses parent_id on the joined child (anon-callable RPC doesn't
 * expose it) and uses the lister-child's society_id as the book's
 * society_id (denormalised in migration 0003).
 */
function mapPublicDetailToBook(row: PublicBookDetail): Book {
  return {
    id: row.id,
    child_id: row.child_id,
    society_id: row.child_society_id ?? "",
    title: row.title,
    author: row.author,
    genre: (row.category as Genre | null) ?? null,
    age_range: row.age_range,
    summary: row.description,
    cover_url: row.cover_url,
    cover_source:
      row.cover_source === "user"
        ? "user_photo"
        : row.cover_source === "api"
          ? "api"
          : null,
    status: ((row.status === "borrowed" ? "borrowed" : "available") as BookStatus),
    listed_at: row.listed_at,
    child: row.child_id
      ? {
          id: row.child_id,
          parent_id: "",
          name: row.child_name,
          bookbuddy_id: "",
          created_at: "",
        }
      : undefined,
  };
}

export default function BookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [currentChildId, setCurrentChildId] = useState<string>("");
  // Tri-state auth probe. null while we check the session — important
  // because the book lookup picks between fetchBookById (authed RLS
  // path) and publicGetBookById (anon RPC). Probing first avoids a
  // failed authed query when the visitor is unauth, and skips the
  // RPC round-trip when they are signed in.
  const [isAuthed, setIsAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setCurrentChildId(getCurrentChildId());
    const handler = () => setCurrentChildId(getCurrentChildId());
    window.addEventListener("bb_user_change", handler);
    return () => window.removeEventListener("bb_user_change", handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const supabase = getSupabase();
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        setIsAuthed(Boolean(data.session?.user?.id));
      } catch (err) {
        console.warn("[book-detail] auth probe failed:", err);
        if (!cancelled) setIsAuthed(false);
      }
    }
    probe();
    const onAuth = () => probe();
    window.addEventListener("bb_supabase_auth", onAuth);
    return () => {
      cancelled = true;
      window.removeEventListener("bb_supabase_auth", onAuth);
    };
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
    // Wait for the auth probe so we route the lookup to the right
    // path. Without this, an unauth visitor would hit fetchBookById
    // (which requires auth via RLS) and get a "not found" flash.
    if (isAuthed === null) return;

    let cancelled = false;

    // Try localStorage first (synchronous, covers demo data and books this
    // user listed on this device).
    const local = getAllBooks().find((b) => b.id === id);
    if (local) {
      setBook(local);
      setLookupState("found");
      return;
    }

    // Only UUIDs warrant a remote lookup; legacy demo ids (e.g.
    // "book_172...") have no Supabase row.
    if (!UUID_RE.test(id)) {
      setLookupState("not-found");
      return;
    }
    setLookupState("loading");

    // Authed → RLS-protected join via fetchBookById. Unauth → public
    // RPC that returns the same lister-child summary minus PII.
    const fetcher: Promise<Book | null> = isAuthed
      ? fetchBookById(id)
      : publicGetBookById(id).then((row) =>
          row ? mapPublicDetailToBook(row) : null
        );

    fetcher
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
        console.error("[book-detail] lookup failed:", err);
        setLookupState("not-found");
      });

    return () => {
      cancelled = true;
    };
  }, [id, isAuthed]);

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
  // localStorage check — either source flips the button off. Also captures
  // the request's *status* so the contact-reveal section below knows whether
  // the lister has approved (and we should fetch the real phone) or is still
  // pending (in which case we hide contact entirely).
  const [supabaseRequestStatus, setSupabaseRequestStatus] =
    useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Skip for unauth — there's no parent to look up requests against.
    if (!isAuthed) return;
    if (!book || !UUID_RE.test(book.id)) return;
    (async () => {
      try {
        const myChildren = await listChildrenForCurrentParent();
        if (cancelled || myChildren.length === 0) return;
        const active = await findActiveRequest({
          bookId: book.id,
          borrowerChildId: myChildren[0].id,
        });
        if (cancelled) return;
        if (active) {
          setRequestSent(true);
          setSupabaseRequestStatus(active.status);
        }
      } catch (err) {
        console.error("[book-detail] supabase active-request lookup failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book, isAuthed]);

  // Lister contact reveal — only populated when the user has an approved
  // (or further-along) borrow request. Backed by `get_lister_contact` RPC
  // (migration 0005) which double-checks server-side that the caller has
  // a qualifying request before returning anything.
  //
  // Bug being fixed: previously the WhatsApp + call buttons rendered
  // unconditionally for any non-own book, with a hardcoded placeholder
  // phone number ("9876543210"). That implied the lister's contact was
  // always-public and would have dialled a stranger.
  const [listerContact, setListerContact] =
    useState<{ phone: string; childName: string | null } | null>(null);
  // Source-of-truth for "is this request approved enough to reveal contact?"
  // Prefer the Supabase status (it's the server-authoritative one); fall back
  // to the local existingRequest for unregistered/demo flows. "approved" and
  // beyond all qualify — once a book is picked up or returned, we still want
  // the borrower to be able to coordinate the next step.
  const effectiveStatus =
    supabaseRequestStatus ?? existingRequest?.status ?? null;
  const contactRevealable =
    effectiveStatus === "approved" ||
    effectiveStatus === "picked_up" ||
    effectiveStatus === "returned" ||
    effectiveStatus === "confirmed_return";

  useEffect(() => {
    let cancelled = false;
    if (!book || !contactRevealable || !UUID_RE.test(book.id)) {
      setListerContact(null);
      return;
    }
    (async () => {
      try {
        const contact = await getListerContactForBook(book.id);
        if (!cancelled) setListerContact(contact);
      } catch (err) {
        console.error("[book-detail] lister contact fetch failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book, contactRevealable]);

  // Hooks must run on every render — keep them above the early returns,
  // otherwise the render-loading-early-then-render-page sequence trips
  // React's "rendered more hooks than during the previous render" check
  // (React error #310).

  // isLastBook drives the "list another book before removing this one"
  // gate that hides the delete button when the user has only one
  // available book. Read from Supabase (not just localStorage) — a user
  // who signed in via email-OTP on a fresh device has bb_books empty
  // even though their library lives in Supabase, which used to make
  // the local count read 0 and hide the button on every owned book.
  // Default to true (button hidden) while we're resolving so we don't
  // briefly show the button on a single-book user before the count
  // comes back.
  const localAvailableCount = useMemo(
    () =>
      getAllBooks().filter(
        (b) => b.child_id === currentChildId && b.status === "available"
      ).length,
    [currentChildId]
  );
  const [isLastBook, setIsLastBook] = useState<boolean>(
    localAvailableCount === 0 ? true : localAvailableCount <= 1
  );
  useEffect(() => {
    let cancelled = false;
    // Skip for unauth — they don't own books, so the gate has no
    // role to play and the listChildren call would 401 against RLS.
    if (!isAuthed) return;
    (async () => {
      try {
        const myChildren = await listChildrenForCurrentParent();
        if (cancelled) return;
        if (myChildren.length === 0) {
          setIsLastBook(true);
          return;
        }
        const perChild = await Promise.all(
          myChildren.map((c) => listBooksForChild(c.id))
        );
        if (cancelled) return;
        const total = perChild.reduce(
          (sum, books) =>
            sum + books.filter((b) => b.status === "available").length,
          0
        );
        setIsLastBook(total <= 1);
      } catch (err) {
        console.error("[book-detail] isLastBook lookup failed:", err);
        // Fail-open — better to show the delete button than to lock
        // the user out of removing their book on a transient error.
        if (!cancelled) setIsLastBook(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentChildId, isAuthed]);
  // Borrow gate: "you must list at least one book before borrowing".
  //
  // Synchronous localStorage check is the fast path (covers demo data and
  // books listed on this device pre-Supabase). For real users the books
  // live in Supabase and the localStorage cache is empty, so we ALSO
  // resolve async by listing the current parent's children + their books.
  // Either source flips the gate off — null while we wait, true once we
  // know they have at least one book, false only after both sources have
  // come back empty.
  //
  // We default the initial state to `true` (no gate) on the synchronous
  // localStorage hit; for users without any local books we start `null`
  // and the JSX below renders a small placeholder until the Supabase
  // round-trip resolves. That avoids flashing the gate at users who do
  // have books listed in Supabase only.
  const localHasListedBook = useMemo(
    () => getAllBooks().some((b) => b.child_id === currentChildId),
    [currentChildId]
  );
  const [hasListedBook, setHasListedBook] = useState<boolean | null>(
    localHasListedBook ? true : null
  );
  useEffect(() => {
    // Unauth visitors take a different CTA path (sign-in redirect)
    // and don't need this gate at all. Set false so we never render
    // the gate placeholder for them.
    if (!isAuthed) {
      setHasListedBook(false);
      return;
    }
    if (localHasListedBook) {
      setHasListedBook(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const myChildren = await listChildrenForCurrentParent();
        if (cancelled) return;
        if (myChildren.length === 0) {
          setHasListedBook(false);
          return;
        }
        // Parallel: any child with at least one book unlocks borrowing.
        const perChild = await Promise.all(
          myChildren.map((c) => listBooksForChild(c.id))
        );
        if (cancelled) return;
        setHasListedBook(perChild.some((books) => books.length > 0));
      } catch (err) {
        console.error("[book-detail] hasListedBook lookup failed:", err);
        if (!cancelled) setHasListedBook(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localHasListedBook, isAuthed]);

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
  // Unauth visitors are never the owner — currentChildId is "" and
  // the book.child_id is a UUID. Force `isOwnBook` false so the
  // "this is your book" branch can never render for an anon viewer.
  const isOwnBook = isAuthed && book.child_id === currentChildId;
  const isUnauth = isAuthed === false;

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
      if (dbReq) {
        setSupabaseRequestStatus(dbReq.status);
        if (localReq) {
          // Align ids so the shelf/home merge dedups the two copies.
          replaceLocalRequestId(localReq.id, dbReq.id);
        }
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
            {/* Contact links — privacy-gated. The lister's phone is only
                rendered after they've approved the borrow request (or further
                along the flow). Before approval we show a small lock chip so
                the user understands contact is intentionally withheld, not
                missing. The actual number comes from the get_lister_contact
                RPC, which double-checks server-side that the caller has a
                qualifying request. */}
            {!isOwnBook && contactRevealable && listerContact?.phone && (
              <div className="flex gap-2">
                <a
                  href={whatsappLink(
                    listerContact.phone,
                    `Hi! I'd like to borrow "${book.title}"`
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-10 h-10 rounded-full bg-[#25d366] text-white flex items-center justify-center"
                  aria-label={`WhatsApp ${book.child.name}'s parent`}
                >
                  <WhatsAppIcon className="w-5 h-5" />
                </a>
                <a
                  href={phoneLink(listerContact.phone)}
                  className="w-10 h-10 rounded-full bg-tertiary text-on-tertiary flex items-center justify-center"
                  aria-label={`Call ${book.child.name}'s parent`}
                >
                  <span className="material-symbols-outlined text-xl">call</span>
                </a>
              </div>
            )}
            {!isOwnBook && !contactRevealable && (
              <div
                className="flex items-center gap-1.5 bg-surface-container-high text-outline px-3 py-1.5 rounded-full text-[11px] font-medium"
                title="Contact is shared once the lister approves your request"
              >
                <span className="material-symbols-outlined text-sm">lock</span>
                Shared on approval
              </div>
            )}
          </div>
        )}

        {/* CTA */}
        {isUnauth ? (
          /* Unauth visitors see the same book detail but the request
             action requires an account — push them to sign-in. They
             come back to the same /book/[id] URL after registering, so
             the action they were about to take resumes naturally. */
          <div className="space-y-3">
            {isAvailable ? (
              <Link
                href={`/auth/sign-in?next=${encodeURIComponent(`/book/${id}`)}`}
                className="block"
              >
                <Button fullWidth>
                  <span className="material-symbols-outlined">local_library</span>
                  Sign up to request
                </Button>
              </Link>
            ) : (
              <div className="bg-surface-container-low p-5 rounded-xl text-center">
                <p className="font-headline font-bold text-on-surface-variant">
                  Currently borrowed
                </p>
                <p className="text-sm text-outline mt-1">
                  Sign up to request the next time it&apos;s available.
                </p>
              </div>
            )}
            <p className="text-xs text-center text-on-surface-variant px-4 leading-snug">
              BookBuds is a give-and-take library — list one of your
              kid&apos;s books to start borrowing.
            </p>
          </div>
        ) : isOwnBook ? (
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
                onClick={async () => {
                  // Mirror /shelf's onRemove: clear locally for instant UI
                  // feedback, then soft-delete on Supabase so the row no
                  // longer surfaces in any feed (home, library browse,
                  // other-device shelves). Without the Supabase update the
                  // tap looked like a no-op everywhere except this device.
                  removeListedBook(id);
                  if (/^[0-9a-f-]{36}$/i.test(id)) {
                    try {
                      await updateBookStatus(id, "removed");
                    } catch (err) {
                      console.error("[book-detail] supabase remove failed:", err);
                    }
                  }
                  router.push("/shelf");
                }}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-error/40 text-error font-bold text-sm hover:bg-error/10 transition-colors"
              >
                <span className="material-symbols-outlined text-lg">delete</span>
                Remove from library
              </button>
            )}
          </div>
        ) : hasListedBook === null ? (
          /* Resolving Supabase round-trip — show a neutral placeholder
             rather than flashing the gate or the request button. */
          <div className="bg-surface-container-low p-5 rounded-xl text-center text-on-surface-variant text-sm">
            <span className="material-symbols-outlined animate-pulse">
              hourglass_empty
            </span>
          </div>
        ) : hasListedBook === false ? (
          /* Gate: user must list at least one book before borrowing */
          <div className="space-y-4">
            <div className="bg-secondary-container/30 border border-secondary/20 rounded-xl p-5 flex items-start gap-3">
              <span className="material-symbols-outlined text-secondary shrink-0 mt-0.5 text-2xl">lock</span>
              <div>
                <p className="font-headline font-bold text-on-surface leading-snug">
                  List a book first to borrow
                </p>
                <p className="text-sm text-on-surface-variant mt-1 leading-snug">
                  BookBuds is a give-and-take library. Share a book from your shelf to unlock borrowing from others.
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
          <div className="space-y-3">
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
            {/* Highest-intent moment to ask for push: the user just took
                the action that creates an asynchronous wait, so they
                actively want to know when it resolves. */}
            <PushPermissionNudge
              headline="Get notified when the lister replies"
              subhead={`We'll buzz you the moment ${book.child?.name ?? "they"} approve or decline.`}
            />
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
