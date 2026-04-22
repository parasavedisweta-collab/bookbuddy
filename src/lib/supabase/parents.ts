/**
 * Supabase-backed parents data layer.
 *
 * One-to-one with auth.users via parents.id = auth.uid(). Each browser's
 * anonymous JWT maps to at most one parent row. Phone numbers are
 * unique across the table (Postgres UNIQUE constraint), so a second
 * device trying to register the same phone will fail at INSERT —
 * that's Path A's known limitation until we add real auth (magic link
 * / WhatsApp OTP) for cross-device identity.
 *
 * RLS policies (see 0001_init.sql):
 *   SELECT / INSERT / UPDATE only where id = auth.uid().
 *   There is no DELETE policy — parents rows outlive their browsers.
 */
"use client";

import { getSupabase } from "./client";

/** Row shape matching public.parents. */
export interface DbParent {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  society_id: string | null;
  created_at: string;
}

const COLUMNS = "id, phone, name, email, society_id, created_at" as const;

/**
 * Fetch the parent row belonging to the current auth.uid(), if any.
 * Returns null for a fresh anonymous user who hasn't completed registration.
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
 * Cross-row phone lookup. Uses the SECURITY DEFINER RPC
 * `is_phone_registered` (see 0001_init.sql) so we don't need a
 * blanket SELECT policy on parents — only true/false leaks.
 *
 * Normalise the phone to digits before calling; callers should
 * do the same transform consistently so matches succeed.
 */
export async function isPhoneRegistered(phone: string): Promise<boolean> {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return false;

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("is_phone_registered", {
    check_phone: digits,
  });

  if (error) {
    console.error("[parents] isPhoneRegistered failed:", error);
    // Fail closed: treat lookup failure as "unknown, let them continue"
    // — the INSERT later will catch a real collision via UNIQUE.
    return false;
  }
  return Boolean(data);
}

/**
 * Create the parent row for the current anonymous user.
 * Asserts parents.id = auth.uid() (the RLS policy will reject anything else).
 *
 * Returns null on error. Possible failures:
 *   - phone already in use (UNIQUE violation) — another device registered it
 *   - no active session — bootstrap hasn't run yet
 *   - society_id doesn't exist (FK violation)
 */
export async function createParent(params: {
  phone: string;
  name?: string | null;
  society_id?: string | null;
  email?: string | null;
}): Promise<DbParent | null> {
  const digits = params.phone.replace(/\D/g, "");
  if (!digits) {
    console.error("[parents] createParent: empty phone after normalisation");
    return null;
  }

  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user?.id;
  if (!uid) {
    console.error("[parents] createParent: no session — is bootstrap running?");
    return null;
  }

  const { data, error } = await supabase
    .from("parents")
    .insert({
      id: uid,
      phone: digits,
      name: params.name?.trim() || null,
      email: params.email?.trim() || null,
      society_id: params.society_id ?? null,
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
 * Patch the current parent row. Only the current user's row can be updated
 * (enforced by RLS).
 */
export async function updateCurrentParent(
  patch: Partial<Pick<DbParent, "name" | "email" | "society_id">>
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
