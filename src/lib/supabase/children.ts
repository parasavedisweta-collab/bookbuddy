/**
 * Supabase-backed children data layer.
 *
 * Each child row FKs to parents.id via parent_id. RLS (see 0001_init.sql):
 *   SELECT: any authenticated user can read any child row — names/emojis
 *           show next to books in the public feed.
 *   INSERT / UPDATE / DELETE: only the owning parent (parent_id = auth.uid()).
 *
 * `bookbuddy_id` is a short human-friendly code used in the admin dashboard
 * and for support correspondence. It's UNIQUE across the table; the generator
 * retries on collision. Collisions at 5^36 ≈ 60M codes are rare but not
 * impossible, especially as the table grows — the retry loop is cheap.
 */
"use client";

import { getSupabase } from "./client";
import type { Child } from "../types";

/** Row shape matching public.children. */
export interface DbChild {
  id: string;
  parent_id: string;
  name: string;
  emoji: string | null;
  age_group: Child["age_group"];
  bookbuddy_id: string;
  created_at: string;
}

const COLUMNS =
  "id, parent_id, name, emoji, age_group, bookbuddy_id, created_at" as const;

/**
 * Generate a short, shareable code like "BB-K3F9Q".
 * 5 base-36 chars = ~60M possible values, enough while membership is small.
 * Uses crypto.getRandomValues for unbiased picks.
 */
export function generateBookbuddyId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // excludes 0/O/1/I for readability
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return `BB-${code}`;
}

/**
 * Fetch all children belonging to the current auth.uid().
 * Returns [] for fresh users.
 */
export async function listChildrenForCurrentParent(): Promise<DbChild[]> {
  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user?.id;
  if (!uid) return [];

  const { data, error } = await supabase
    .from("children")
    .select(COLUMNS)
    .eq("parent_id", uid)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[children] list failed:", error);
    return [];
  }
  return (data ?? []) as DbChild[];
}

/** Fetch a single child by id (readable by any authenticated user). */
export async function getChildById(id: string): Promise<DbChild | null> {
  if (!id) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("children")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[children] getById failed:", error);
    return null;
  }
  return (data ?? null) as DbChild | null;
}

/**
 * Create a child row owned by the current auth.uid().
 * Caller must have already created the parent row — the FK on
 * parent_id will reject otherwise.
 *
 * Retries up to 3 times on bookbuddy_id UNIQUE collision.
 */
export async function createChild(params: {
  name: string;
  age_group: Child["age_group"];
  emoji?: string | null;
}): Promise<DbChild | null> {
  const name = params.name.trim();
  if (!name) {
    console.error("[children] createChild: empty name");
    return null;
  }

  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user?.id;
  if (!uid) {
    console.error("[children] createChild: no session");
    return null;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const bookbuddy_id = generateBookbuddyId();
    const { data, error } = await supabase
      .from("children")
      .insert({
        parent_id: uid,
        name,
        age_group: params.age_group,
        emoji: params.emoji?.trim() || null,
        bookbuddy_id,
      })
      .select(COLUMNS)
      .single();

    if (!error) return data as DbChild;

    // Postgres "23505 unique_violation" — retry with a new code.
    // Any other error is permanent; bail.
    const code = (error as { code?: string })?.code;
    if (code !== "23505") {
      console.error("[children] createChild failed:", error);
      return null;
    }
    console.warn("[children] bookbuddy_id collision, retrying");
  }

  console.error("[children] createChild: 3 bookbuddy_id collisions, giving up");
  return null;
}
