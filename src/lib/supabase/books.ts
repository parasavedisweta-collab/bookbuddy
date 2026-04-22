/**
 * Supabase-backed books data layer.
 *
 * Books are owned by a child (books.child_id → children.id). RLS:
 *   SELECT: any authenticated user can read any book row.
 *   INSERT / UPDATE / DELETE: only the child's parent (via
 *                             is_parent_of(child_id) SECURITY DEFINER).
 *
 * Schema flexibility:
 *   - Age range and series don't have dedicated columns — they live
 *     in `metadata` jsonb. Add real columns if/when we need to filter
 *     by them.
 *   - `cover_url` is intended to hold the API cover URL or a
 *     Supabase-Storage public URL for user photos. Base64 data URLs
 *     should NOT be persisted here — the Storage upload path is a
 *     separate migration. For now, user-photo books write cover_url=null
 *     to Supabase while keeping the photo in localStorage.
 *
 * The app's domain types (types.ts `Book`) and the Supabase row shape
 * differ by history; this module exposes DbBook as the source of truth
 * for anything that goes through Supabase, and leaves mapping to
 * types.Book as the caller's responsibility.
 */
"use client";

import { getSupabase } from "./client";

export type DbBookStatus = "available" | "borrowed" | "out_of_stock" | "removed";
export type DbBookCoverSource = "api" | "user" | null;

/** Row shape matching public.books. */
export interface DbBook {
  id: string;
  child_id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  description: string | null;
  category: string | null;
  cover_url: string | null;
  cover_source: DbBookCoverSource;
  status: DbBookStatus;
  listed_at: string;
  metadata: Record<string, unknown> | null;
}

const COLUMNS =
  "id, child_id, title, author, isbn, description, category, cover_url, cover_source, status, listed_at, metadata" as const;

/**
 * Input shape for createBook. We accept the app's richer fields and fold
 * the overflow (series, age_range) into metadata jsonb.
 */
export interface CreateBookInput {
  child_id: string;
  title: string;
  author?: string | null;
  description?: string | null;
  category?: string | null;
  cover_url?: string | null;
  cover_source?: DbBookCoverSource;
  isbn?: string | null;
  /** Arbitrary extra fields — merged into books.metadata. */
  metadata?: Record<string, unknown> | null;
}

/** Create a new book for a child you own. Returns null on error. */
export async function createBook(input: CreateBookInput): Promise<DbBook | null> {
  const title = input.title.trim();
  if (!title || !input.child_id) {
    console.error("[books] createBook: missing title or child_id");
    return null;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("books")
    .insert({
      child_id: input.child_id,
      title,
      author: input.author?.trim() || null,
      description: input.description?.trim() || null,
      category: input.category?.trim() || null,
      cover_url: input.cover_url?.trim() || null,
      cover_source: input.cover_source ?? null,
      isbn: input.isbn?.trim() || null,
      metadata: input.metadata ?? null,
      // status defaults to 'available', listed_at defaults to now()
    })
    .select(COLUMNS)
    .single();

  if (error) {
    console.error("[books] createBook failed:", error);
    return null;
  }
  return data as DbBook;
}

/** Fetch all non-removed books for a given child. Sorted newest-first. */
export async function listBooksForChild(childId: string): Promise<DbBook[]> {
  if (!childId) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("books")
    .select(COLUMNS)
    .eq("child_id", childId)
    .neq("status", "removed")
    .order("listed_at", { ascending: false });

  if (error) {
    console.error("[books] listForChild failed:", error);
    return [];
  }
  return (data ?? []) as DbBook[];
}

/**
 * Book row plus the minimum child/parent context needed by the home feed
 * card: whose child listed it, which society they're in.
 */
export interface DbBookWithListerContext extends DbBook {
  child: {
    id: string;
    name: string;
    emoji: string | null;
    age_group: string;
    parent: {
      id: string;
      society_id: string | null;
    };
  };
}

/**
 * Fetch all non-removed books whose lister's parent belongs to the given
 * society. Powers the home feed.
 *
 * Implementation: PostgREST embedded resource with !inner (INNER JOIN),
 * then filter on the embedded society_id. If this syntax breaks in a
 * future SDK version we can swap to a SECURITY INVOKER view or an RPC.
 */
export async function listBooksForSociety(
  societyId: string
): Promise<DbBookWithListerContext[]> {
  if (!societyId) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("books")
    .select(
      `${COLUMNS},
       child:children!inner(
         id, name, emoji, age_group,
         parent:parents!inner(id, society_id)
       )`
    )
    .eq("child.parent.society_id", societyId)
    .neq("status", "removed")
    .order("listed_at", { ascending: false });

  if (error) {
    console.error("[books] listForSociety failed:", error);
    return [];
  }
  return (data ?? []) as unknown as DbBookWithListerContext[];
}

/** Fetch a single book by id. Null if not found. */
export async function getBookById(id: string): Promise<DbBook | null> {
  if (!id) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("books")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[books] getById failed:", error);
    return null;
  }
  return (data ?? null) as DbBook | null;
}

/**
 * Update book status. Only the owning parent can do this (enforced by RLS
 * via is_parent_of on the book's child_id).
 *
 * Prefer this over deleteBook for "removed" — keeps history for audit /
 * admin review. Hard DELETE is intentionally not exposed here.
 */
export async function updateBookStatus(
  id: string,
  status: DbBookStatus
): Promise<DbBook | null> {
  if (!id) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("books")
    .update({ status })
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    console.error("[books] updateStatus failed:", error);
    return null;
  }
  return data as DbBook;
}
