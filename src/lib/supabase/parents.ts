/**
 * Supabase-backed parents data layer.
 *
 * One-to-one with auth.users via parents.id = auth.uid(). After
 * migration 0007 the auth model is Google OAuth + email-OTP — email
 * is the cross-device identity, phone is a contact field only
 * (no longer UNIQUE, no longer a credential).
 *
 * RLS policies (see 0001_init.sql):
 *   SELECT / INSERT / UPDATE only where id = auth.uid().
 *   There is no DELETE policy — parents rows outlive their browsers.
 */
"use client";

import { getSupabase } from "./client";

/** Row shape matching public.parents (post-0007). */
export interface DbParent {
  id: string;
  email: string;
  phone: string | null;
  society_id: string | null;
  created_at: string;
}

const COLUMNS = "id, email, phone, society_id, created_at" as const;

/**
 * Fetch the parent row belonging to the current auth.uid(), if any.
 * Returns null when there is no session, or the user is signed in
 * but hasn't completed registration (no parents row yet).
 */
export async function getCurrentParent(): Promise<DbParent | null> {
  const supabase = getSupabase();

  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from("parents")
    .select(COLUMNS)
    .eq("id", uid)
    .maybeSingle();

  if (error) {
    console.error("[parents] getCurrent failed:", error);
    return null;
  }
  return (data ?? null) as DbParent | null;
}

/**
 * Create the parent row for the currently-authenticated user.
 * Asserts parents.id = auth.uid() (the RLS policy will reject
 * anything else).
 *
 * `email` is sourced from auth.user().email — caller doesn't pass
 * it, we read it ourselves to guarantee it matches the auth
 * identity. `phone` is the contact number captured at registration.
 *
 * Returns null on error. Possible failures:
 *   - no active session (caller should redirect to /auth/sign-in)
 *   - email collision (same email already has a parent row — shouldn't
 *     happen since email = auth identity, but guard surfaces it)
 *   - society_id doesn't exist (FK violation)
 */
export async function createParent(params: {
  phone: string;
  society_id: string;
}): Promise<DbParent | null> {
  const phoneDigits = params.phone.replace(/\D/g, "");
  if (!phoneDigits) {
    console.error("[parents] createParent: empty phone after normalisation");
    return null;
  }

  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData.session;
  const uid = session?.user?.id;
  const email = session?.user?.email;

  if (!uid || !email) {
    console.error(
      "[parents] createParent: no authenticated session — caller should redirect to /auth/sign-in"
    );
    return null;
  }

  const { data, error } = await supabase
    .from("parents")
    .insert({
      id: uid,
      email,
      phone: phoneDigits,
      society_id: params.society_id,
    })
    .select(COLUMNS)
    .single();

  if (error) {
    console.error("[parents] createParent failed:", error);
    return null;
  }
  return data as DbParent;
}

/**
 * Reveal the lister's contact info for a given book — but only when the
 * current user has an approved (or further-along) borrow request for it.
 *
 * Backed by the SECURITY DEFINER RPC `get_lister_contact` (migration
 * 0007 form), which short-circuits to "no rows" unless the caller's
 * parent_id has a borrow_requests row for `bookId` with status in
 * (approved, picked_up, returned, confirmed_return).
 *
 * Returns null when the caller has no qualifying request, the book
 * doesn't exist, or the RPC errors.
 *
 * The RPC now returns the lister's CHILD name (not parent name) —
 * matches the UI's "Listed by Aanya" labelling everywhere else.
 */
export async function getListerContactForBook(
  bookId: string
): Promise<{ phone: string; childName: string | null } | null> {
  if (!bookId) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .rpc("get_lister_contact", { book_uuid: bookId });

  if (error) {
    console.error("[parents] getListerContactForBook failed:", error);
    return null;
  }
  // RPC returns SETOF (table) → array of {phone, child_name}. Empty
  // when the caller doesn't qualify, which is the most common path
  // before approval.
  const row = Array.isArray(data) ? data[0] : null;
  if (!row?.phone) return null;
  return { phone: row.phone, childName: row.child_name ?? null };
}

/**
 * Patch the current parent row. Only the current user's row can be
 * updated (enforced by RLS). Email is intentionally NOT patchable
 * here — email is the auth identity and must always match
 * auth.users.email. Society + phone are user-editable contact fields.
 */
export async function updateCurrentParent(
  patch: Partial<Pick<DbParent, "phone" | "society_id">>
): Promise<DbParent | null> {
  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from("parents")
    .update(patch)
    .eq("id", uid)
    .select(COLUMNS)
    .single();

  if (error) {
    console.error("[parents] updateCurrent failed:", error);
    return null;
  }
  return data as DbParent;
}
