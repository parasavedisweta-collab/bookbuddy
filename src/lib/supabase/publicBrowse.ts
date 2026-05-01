/**
 * Public-browse RPC wrappers — callable by anonymous (unauthenticated)
 * visitors so they can pick a society and peek at books before signing
 * up. Backed by the SECURITY DEFINER functions in migration 0009.
 *
 * Distinct from src/lib/supabase/feed.ts (authenticated home feed) and
 * src/lib/supabase/societies.ts (registration picker, authed). Those
 * two paths require an `authenticated` JWT; this one works for `anon`.
 *
 * What's intentionally *not* exposed:
 *   - parents.* (PII)
 *   - children parent_id / bookbuddy_id
 *   - any borrow_requests data
 *
 * The visitor's selected society is persisted to localStorage as
 * `bb_pending_society` so child-setup can pre-fill on sign-up.
 */
"use client";

import { getSupabase } from "./client";

/* ── Society search ─────────────────────────────────────────────── */

export interface PublicSocietyRow {
  id: string;
  name: string;
  city: string;
  pincode: string | null;
  created_at: string;
  member_count: number;
}

/**
 * Search societies by name (ILIKE), optionally filtered by city. The
 * picker debounces input to ≥ 2 chars; calls below that return [].
 */
export async function publicSearchSocieties(
  query: string,
  cityFilter = ""
): Promise<PublicSocietyRow[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("public_search_societies", {
    query: q,
    city_filter: cityFilter.trim(),
  });
  if (error) {
    console.error("[publicBrowse] search RPC failed:", error);
    return [];
  }
  return (data ?? []) as PublicSocietyRow[];
}

/* ── Books in society ───────────────────────────────────────────── */

export interface PublicBookRow {
  id: string;
  child_id: string;
  child_name: string;
  child_emoji: string | null;
  title: string;
  author: string | null;
  category: string | null;
  cover_url: string | null;
  cover_source: string | null;
  status: string;
  listed_at: string;
  age_range: string | null;
}

/**
 * Every non-removed book listed by any child in the given society.
 * Status comes back as text ("available" | "borrowed" | "out_of_stock");
 * the public UI shows them as-is, no enum sync required.
 */
export async function publicListBooksForSociety(
  societyId: string
): Promise<PublicBookRow[]> {
  if (!societyId) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("public_list_books_for_society", {
    society_uuid: societyId,
  });
  if (error) {
    console.error("[publicBrowse] list-books RPC failed:", error);
    return [];
  }
  return (data ?? []) as PublicBookRow[];
}

/**
 * Single-book read for the unauthenticated /book/[id] route. Returns
 * the same lister-child summary the list endpoint exposes, plus
 * description (which the detail page renders below the title) and
 * the lister's society_id (used to verify the book belongs to the
 * society the visitor picked, so deep-links don't leak books from
 * other societies into a visitor's session).
 *
 * Backed by migration 0012's public_get_book_by_id SECURITY DEFINER
 * RPC. Returns null when not found, removed, or on RPC error.
 */
export interface PublicBookDetail extends PublicBookRow {
  child_society_id: string | null;
  description: string | null;
}

export async function publicGetBookById(
  bookId: string
): Promise<PublicBookDetail | null> {
  if (!bookId) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("public_get_book_by_id", {
    book_uuid: bookId,
  });
  if (error) {
    console.error("[publicBrowse] get-book RPC failed:", error);
    return null;
  }
  // RPC returns a setof — a single row arrives as a 1-element array.
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as PublicBookDetail | null;
}

/* ── Pending-society localStorage ───────────────────────────────── */

const PENDING_KEY = "bb_pending_society";

/**
 * Society the visitor picked while browsing anonymously. Read from
 * /library and from /auth/child-setup (which pre-fills its picker
 * from this value when set). Cleared on successful registration.
 *
 * Includes the optional GPS coords so the registration flow's "we
 * detected you near X" hint can survive the round-trip.
 */
export interface PendingSociety {
  id: string;
  name: string;
  city: string;
  lat?: number;
  lng?: number;
  source: "gps" | "search" | "manual";
}

export function getPendingSociety(): PendingSociety | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PendingSociety;
  } catch {
    return null;
  }
}

export function setPendingSociety(s: PendingSociety) {
  if (typeof window === "undefined") return;
  localStorage.setItem(PENDING_KEY, JSON.stringify(s));
  window.dispatchEvent(new Event("bb_pending_society_change"));
}

export function clearPendingSociety() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(PENDING_KEY);
  window.dispatchEvent(new Event("bb_pending_society_change"));
}
