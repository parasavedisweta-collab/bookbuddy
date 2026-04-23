/**
 * Supabase-backed borrow-requests data layer.
 *
 * Shape and RLS (see 0001_init.sql + 0004_borrow_requests_status_alignment.sql):
 *   SELECT: involved parties only (borrower's parent OR lister's parent).
 *   INSERT: you must be the borrower_child's parent.
 *   UPDATE: either involved parent can progress the flow.
 *   DELETE: no policy → denied. We never hard-delete requests; the status
 *           enum carries "declined" / "auto_declined" / "confirmed_return"
 *           to keep full history for the admin view.
 *
 * Status vocabulary is aligned with the app's BorrowStatus TS type in
 * migration 0004. No translation at this layer.
 *
 * This module INTENTIONALLY does not know about localStorage — callers
 * merge with getAllRequests() during the transition. The same pattern as
 * feed.ts: supabase layer returns canonical data, pages dedup+merge.
 */
"use client";

import { getSupabase } from "./client";
import type { BorrowRequest, BorrowStatus, Book, Child } from "../types";
import { mapPlainBookToBook } from "./feed";
import type { DbBook } from "./books";

/**
 * Row shape matching public.borrow_requests. All fields as-stored; callers
 * map to the app's BorrowRequest when they need joined context.
 */
export interface DbBorrowRequest {
  id: string;
  book_id: string;
  borrower_child_id: string;
  lister_child_id: string;
  status: BorrowStatus;
  requested_at: string;
  responded_at: string | null;
  picked_up_at: string | null;
  due_date: string | null;
  returned_at: string | null;
  return_confirmed_at: string | null;
}

const COLUMNS =
  "id, book_id, borrower_child_id, lister_child_id, status, requested_at, responded_at, picked_up_at, due_date, returned_at, return_confirmed_at" as const;

/**
 * A request row plus the minimum joined context the shelf UI wants to
 * render: the book, and the two child summaries on either side of the
 * transaction. Nested children is safe here — children.RLS is "any
 * authenticated can SELECT" so we don't cross the parents RLS boundary.
 *
 * Note: we fetch two `children` relations via explicit FK disambiguation.
 * PostgREST requires the "rel:table!fk_column(cols)" syntax when the same
 * table is referenced twice from one parent.
 */
interface DbRequestWithContext extends DbBorrowRequest {
  book: DbBook | null;
  borrower_child: {
    id: string;
    parent_id: string;
    name: string;
    age_group: string;
    emoji: string | null;
    society_id: string;
    bookbuddy_id: string;
    created_at: string;
  } | null;
  lister_child: {
    id: string;
    parent_id: string;
    name: string;
    age_group: string;
    emoji: string | null;
    society_id: string;
    bookbuddy_id: string;
    created_at: string;
  } | null;
}

const CONTEXT_SELECT = `
  ${COLUMNS},
  book:books(
    id, child_id, title, author, isbn, description, category,
    cover_url, cover_source, status, listed_at, metadata
  ),
  borrower_child:children!borrow_requests_borrower_child_id_fkey(
    id, parent_id, name, age_group, emoji, society_id, bookbuddy_id, created_at
  ),
  lister_child:children!borrow_requests_lister_child_id_fkey(
    id, parent_id, name, age_group, emoji, society_id, bookbuddy_id, created_at
  )
`;

function mapChildSummary(
  c: DbRequestWithContext["borrower_child"]
): Child | undefined {
  if (!c) return undefined;
  return {
    id: c.id,
    parent_id: c.parent_id,
    name: c.name,
    age_group: c.age_group as Child["age_group"],
    bookbuddy_id: c.bookbuddy_id,
    created_at: c.created_at,
  };
}

/** Map a joined request row to the app's BorrowRequest domain type. */
export function mapRequestRow(row: DbRequestWithContext): BorrowRequest {
  const book: Book | undefined = row.book
    ? mapPlainBookToBook(row.book, {
        // We reuse the lister_child's society_id as the book's society_id.
        // children.society_id is denormalised (migration 0003) so this is
        // always present and consistent with the feed's mapping.
        societyId: row.lister_child?.society_id ?? "",
        child: row.lister_child
          ? {
              id: row.lister_child.id,
              parent_id: row.lister_child.parent_id,
              name: row.lister_child.name,
              emoji: row.lister_child.emoji,
              age_group: row.lister_child.age_group as Child["age_group"],
              bookbuddy_id: row.lister_child.bookbuddy_id,
              society_id: row.lister_child.society_id,
              created_at: row.lister_child.created_at,
            }
          : undefined,
      })
    : undefined;

  return {
    id: row.id,
    book_id: row.book_id,
    borrower_child_id: row.borrower_child_id,
    lister_child_id: row.lister_child_id,
    status: row.status,
    requested_at: row.requested_at,
    responded_at: row.responded_at,
    picked_up_at: row.picked_up_at,
    due_date: row.due_date,
    returned_at: row.returned_at,
    return_confirmed_at: row.return_confirmed_at,
    book,
    borrower_child: mapChildSummary(row.borrower_child),
    lister_child: mapChildSummary(row.lister_child),
  };
}

/**
 * Create a pending borrow request from the current user for someone else's
 * book. Caller must have already resolved `lister_child_id` from the book.
 *
 * RLS will reject the insert unless `borrowerChildId` belongs to the
 * current parent (auth.uid()) — so this function implicitly assumes the UI
 * only calls it for the active child in the user's own session.
 */
export async function createBorrowRequest(params: {
  bookId: string;
  borrowerChildId: string;
  listerChildId: string;
}): Promise<DbBorrowRequest | null> {
  const { bookId, borrowerChildId, listerChildId } = params;
  if (!bookId || !borrowerChildId || !listerChildId) {
    console.error("[requests] createBorrowRequest: missing ids");
    return null;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("borrow_requests")
    .insert({
      book_id: bookId,
      borrower_child_id: borrowerChildId,
      lister_child_id: listerChildId,
      // status defaults to 'pending', requested_at defaults to now()
    })
    .select(COLUMNS)
    .single();

  if (error) {
    console.error("[requests] createBorrowRequest failed:", error);
    return null;
  }
  return data as DbBorrowRequest;
}

/**
 * Transition a request's status. Stamps the matching timestamp column
 * server-side? No — the CHECK constraint doesn't touch timestamps and
 * we don't want a trigger stack; the client supplies the timestamp in
 * the same UPDATE so there's exactly one round-trip.
 *
 * Which timestamp gets set:
 *   approved / declined / auto_declined → responded_at
 *   picked_up                            → picked_up_at
 *   returned                             → returned_at
 *   confirmed_return                     → return_confirmed_at
 *   pending                              → (no timestamp; used for undo)
 *
 * RLS enforces that the caller is the borrower or lister parent. We do
 * not re-check owner-vs-borrower on the transition direction — the UI
 * only surfaces valid buttons to each side, and mis-use is caught by
 * either RLS (wrong parent) or the CHECK (unknown status).
 */
export async function updateRequestStatus(
  id: string,
  status: BorrowStatus
): Promise<DbBorrowRequest | null> {
  if (!id) return null;

  const now = new Date().toISOString();
  const patch: Partial<DbBorrowRequest> = { status };
  if (status === "approved" || status === "declined" || status === "auto_declined") {
    patch.responded_at = now;
  } else if (status === "picked_up") {
    patch.picked_up_at = now;
  } else if (status === "returned") {
    patch.returned_at = now;
  } else if (status === "confirmed_return") {
    patch.return_confirmed_at = now;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("borrow_requests")
    .update(patch)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    console.error("[requests] updateStatus failed:", error);
    return null;
  }
  return data as DbBorrowRequest;
}

/**
 * Fetch every request the current parent is involved in — as borrower
 * OR lister, across all their children. Returns app-domain BorrowRequest
 * with joined book + child summaries.
 *
 * Implementation: RLS on borrow_requests already restricts the result
 * set to rows where the caller is one of the parties, so we can just
 * `SELECT *` with the context joins and trust the policy. No additional
 * parent_id filter needed client-side.
 */
export async function fetchMyRequests(): Promise<BorrowRequest[]> {
  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session?.user?.id) return [];

  const { data, error } = await supabase
    .from("borrow_requests")
    .select(CONTEXT_SELECT)
    .order("requested_at", { ascending: false });

  if (error) {
    console.error("[requests] fetchMyRequests failed:", error);
    return [];
  }
  return ((data ?? []) as unknown as DbRequestWithContext[]).map(mapRequestRow);
}

/**
 * Look up an existing active request from `borrowerChildId` for `bookId`.
 * "Active" = pending / approved / picked_up — the three states that should
 * block the borrower from creating a duplicate request. Returns null if
 * there's no active request (fresh or finished states are ignored).
 */
export async function findActiveRequest(params: {
  bookId: string;
  borrowerChildId: string;
}): Promise<DbBorrowRequest | null> {
  const { bookId, borrowerChildId } = params;
  if (!bookId || !borrowerChildId) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("borrow_requests")
    .select(COLUMNS)
    .eq("book_id", bookId)
    .eq("borrower_child_id", borrowerChildId)
    .in("status", ["pending", "approved", "picked_up"])
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[requests] findActiveRequest failed:", error);
    return null;
  }
  return (data ?? null) as DbBorrowRequest | null;
}
