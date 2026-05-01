/**
 * Supabase read-path helpers for the home feed and shelf.
 *
 * The app's domain `Book` type (see ../types.ts) predates the Supabase schema
 * and uses slightly different field names:
 *   - `genre` (Book) ↔ `category` (DbBook)
 *   - `summary` (Book) ↔ `description` (DbBook)
 *   - `age_range` (Book) ↔ `metadata.age_range` (DbBook jsonb)
 *   - `society_id` (Book) ↔ children.parent.society_id (nested join)
 *   - `cover_source: "user_photo"` (Book) ↔ `cover_source: "user"` (DbBook)
 *
 * This module centralises the mapping so pages don't each reinvent it, and
 * exposes higher-level read functions the home/shelf pages can call. It
 * INTENTIONALLY does not know about localStorage — callers merge the results
 * with `getAllBooks()` during the transition. Once the rest of the stack is
 * off localStorage we'll delete the merge step, not this file.
 */
"use client";

import { getSupabase } from "./client";
import {
  listBooksForSociety,
  type DbBook,
  type DbBookWithListerContext,
} from "./books";
import { getCurrentParent } from "./parents";
import { listChildrenForCurrentParent, type DbChild } from "./children";
import type { Book, BookStatus, Genre } from "../types";

function mapStatus(s: DbBook["status"]): BookStatus {
  // "removed" rows are filtered out by the underlying queries, so we should
  // never see them here — defensive fallback to "available" just in case.
  if (s === "borrowed") return "borrowed";
  if (s === "out_of_stock") return "available";
  return "available";
}

function mapCoverSource(s: DbBook["cover_source"]): Book["cover_source"] {
  if (s === "api") return "api";
  if (s === "user") return "user_photo";
  return null;
}

/**
 * Map a home-feed row (book + nested child) to app `Book`. society_id now
 * comes directly from children (denormalised in migration 0003); the old
 * books→children→parents join path was blocked by parents.RLS and is gone.
 */
export function mapFeedRowToBook(row: DbBookWithListerContext): Book {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const ageRange =
    typeof meta.age_range === "string" ? (meta.age_range as string) : null;

  return {
    id: row.id,
    child_id: row.child.id,
    society_id: row.child.society_id,
    title: row.title,
    author: row.author,
    // `category` is a free-text string in the DB; the app's Genre is a union.
    // We cast — unrecognised values fall through and BookCard handles nulls.
    genre: (row.category as Genre | null) ?? null,
    age_range: ageRange,
    summary: row.description,
    cover_url: row.cover_url,
    cover_source: mapCoverSource(row.cover_source),
    status: mapStatus(row.status),
    listed_at: row.listed_at,
    child: {
      id: row.child.id,
      parent_id: row.child.parent_id,
      name: row.child.name,
      bookbuddy_id: "",
      created_at: "",
    },
  };
}

/**
 * Map a plain book row (no lister context — used for shelf reads where the
 * caller already knows whose child it is) to app `Book`. society_id and the
 * embedded `child` summary come from caller-supplied metadata.
 */
export function mapPlainBookToBook(
  row: DbBook,
  opts: { societyId: string; child?: DbChild }
): Book {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const ageRange =
    typeof meta.age_range === "string" ? (meta.age_range as string) : null;

  return {
    id: row.id,
    child_id: row.child_id,
    society_id: opts.societyId,
    title: row.title,
    author: row.author,
    genre: (row.category as Genre | null) ?? null,
    age_range: ageRange,
    summary: row.description,
    cover_url: row.cover_url,
    cover_source: mapCoverSource(row.cover_source),
    status: mapStatus(row.status),
    listed_at: row.listed_at,
    child: opts.child
      ? {
          id: opts.child.id,
          parent_id: opts.child.parent_id,
          name: opts.child.name,
          bookbuddy_id: opts.child.bookbuddy_id,
          created_at: opts.child.created_at,
        }
      : undefined,
  };
}

/**
 * Resolve the society_id for the current Supabase-authenticated user.
 * Returns null if the user hasn't completed registration (i.e. no parent row
 * for auth.uid()), in which case the caller should fall back to the
 * localStorage-derived society.
 */
export async function resolveCurrentSocietyId(): Promise<string | null> {
  const parent = await getCurrentParent();
  return parent?.society_id ?? null;
}

/**
 * Fetch the home feed for a society as app `Book[]`. Returns [] on error or
 * for an empty society. Results are ordered newest-first by listed_at
 * (inherited from books.ts).
 */
export async function fetchSocietyFeed(societyId: string): Promise<Book[]> {
  if (!societyId) return [];
  const rows = await listBooksForSociety(societyId);
  return rows.map(mapFeedRowToBook);
}

/**
 * Fetch a single book by id with the lister-child context the book-detail
 * UI needs (name, emoji, society_id, etc.). Mirrors listBooksForSociety's
 * inner-join pattern so this doesn't cross the parents-RLS boundary.
 *
 * Used as a fallback when a user opens a book they see in the feed but
 * didn't list themselves — localStorage doesn't have it, so we resolve it
 * against Supabase. Returns null if not found or on error.
 */
export async function fetchBookById(id: string): Promise<Book | null> {
  if (!id) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("books")
    .select(
      `id, child_id, title, author, isbn, description, category,
       cover_url, cover_source, status, listed_at, metadata,
       child:children!inner(
         id, name, emoji, society_id, parent_id
       )`
    )
    .eq("id", id)
    .neq("status", "removed")
    .maybeSingle();

  if (error) {
    console.error("[feed] fetchBookById failed:", error);
    return null;
  }
  if (!data) return null;
  return mapFeedRowToBook(data as unknown as DbBookWithListerContext);
}

/**
 * Fetch every book listed by any of the current parent's children.
 * Used by the shelf page.
 *
 * On laptop wifi the previous implementation (sequential children →
 * parent → per-child books) was invisible. On mobile 4G with 300–500ms
 * RTT the three-stage chain stretched the shelf to 5–10s while older
 * books trickled in book-by-book. This collapses it to two parallel
 * roundtrips:
 *   1. children + parent fan out together.
 *   2. one books query with `.in('child_id', [...])` returns every
 *      book across every child of this parent.
 */
export async function fetchMyShelfBooks(): Promise<{
  books: Book[];
  childIds: string[];
}> {
  const [children, parent] = await Promise.all([
    listChildrenForCurrentParent(),
    getCurrentParent(),
  ]);
  if (children.length === 0) return { books: [], childIds: [] };

  const societyId = parent?.society_id ?? "";
  const childIds = children.map((c) => c.id);
  const childById = new Map(children.map((c) => [c.id, c]));

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("books")
    .select(
      "id, child_id, title, author, isbn, description, category, cover_url, cover_source, status, listed_at, metadata"
    )
    .in("child_id", childIds)
    .neq("status", "removed")
    .order("listed_at", { ascending: false });

  if (error) {
    console.error("[feed] fetchMyShelfBooks failed:", error);
    return { books: [], childIds };
  }

  const books = (data ?? []).map((row) =>
    mapPlainBookToBook(row as DbBook, {
      societyId,
      child: childById.get(row.child_id),
    })
  );
  return { books, childIds };
}
