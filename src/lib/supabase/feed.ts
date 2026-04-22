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

import {
  listBooksForSociety,
  listBooksForChild,
  type DbBook,
  type DbBookWithListerContext,
} from "./books";
import { getCurrentParent } from "./parents";
import { listChildrenForCurrentParent, type DbChild } from "./children";
import type { Book, BookStatus, Child, Genre } from "../types";

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
 * Map a home-feed row (book + nested child + nested parent) to app `Book`.
 * society_id is lifted from the nested join; callers that only need a society
 * sanity-check can compare against the input societyId.
 */
export function mapFeedRowToBook(row: DbBookWithListerContext): Book {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const ageRange =
    typeof meta.age_range === "string" ? (meta.age_range as string) : null;

  return {
    id: row.id,
    child_id: row.child.id,
    society_id: row.child.parent.society_id ?? "",
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
      parent_id: row.child.parent.id,
      name: row.child.name,
      age_group: row.child.age_group as Child["age_group"],
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
          age_group: opts.child.age_group,
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
 * Fetch every book listed by any of the current parent's children.
 * Used by the shelf page. Walks children sequentially — we typically only
 * have one child per parent today, so a Promise.all fan-out isn't worth the
 * extra complexity.
 */
export async function fetchMyShelfBooks(): Promise<{
  books: Book[];
  childIds: string[];
}> {
  const children = await listChildrenForCurrentParent();
  if (children.length === 0) return { books: [], childIds: [] };

  const parent = await getCurrentParent();
  const societyId = parent?.society_id ?? "";

  const books: Book[] = [];
  for (const child of children) {
    const rows = await listBooksForChild(child.id);
    for (const row of rows) {
      books.push(mapPlainBookToBook(row, { societyId, child }));
    }
  }
  return { books, childIds: children.map((c) => c.id) };
}
