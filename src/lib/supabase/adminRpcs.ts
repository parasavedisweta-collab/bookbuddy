/**
 * Client-side wrappers for the SECURITY DEFINER admin RPCs added in
 * migration 0008.
 *
 * The /admin page used to render against three hard-coded demo
 * children. With the demo data removed it needs system-wide reads
 * (every parent, every borrow request) — both blocked by normal RLS
 * for protected reasons. The RPCs themselves are gated on
 * `is_admin()` in SQL: non-admins calling them get an empty set.
 *
 *   - is_admin()                   — bool, drives the page-level gate.
 *   - admin_list_users()           — parents × children with society
 *                                    name/city pre-joined.
 *   - admin_list_borrow_requests() — every borrow_requests row with
 *                                    pre-joined book + child names.
 *
 * Books are NOT exposed via an admin RPC — books.SELECT is permissive
 * for any authenticated user, so the admin Books tab uses the regular
 * client lib path.
 *
 * Distinct from `./admin.ts`, which is the server-only service-role
 * client used by API routes; that bypasses RLS entirely. This module
 * is for the browser-side admin page.
 */
"use client";

import { getSupabase } from "./client";

/** True iff the current auth.uid() is in admin_emails. */
export async function isAdmin(): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("is_admin");
  if (error) {
    console.error("[admin] is_admin RPC failed:", error);
    return false;
  }
  return Boolean(data);
}

/**
 * One row per (parent, child). Parents with no children appear once
 * with `child_id = null`; parents with two children appear twice. The
 * admin UI groups by parent_id to render a per-user card.
 */
export interface AdminUserRow {
  parent_id: string;
  email: string;
  phone: string | null;
  society_id: string | null;
  society_name: string | null;
  society_city: string | null;
  registered_at: string;
  child_id: string | null;
  child_name: string | null;
  child_emoji: string | null;
  child_bookbuddy_id: string | null;
  child_created_at: string | null;
}

export async function adminListUsers(): Promise<AdminUserRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("admin_list_users");
  if (error) {
    console.error("[admin] admin_list_users RPC failed:", error);
    return [];
  }
  return (data ?? []) as AdminUserRow[];
}

/**
 * One row per borrow_request, with pre-joined names so the admin UI
 * doesn't fan-out to extra queries. Status is stringly-typed because
 * borrow_requests.status is a Postgres enum cast to text in the RPC —
 * keeping a union in sync would couple this client to the migration.
 */
export interface AdminBorrowRequestRow {
  id: string;
  book_id: string;
  book_title: string | null;
  borrower_child_id: string;
  borrower_child_name: string | null;
  lister_child_id: string;
  lister_child_name: string | null;
  status: string;
  requested_at: string;
  responded_at: string | null;
  picked_up_at: string | null;
  returned_at: string | null;
  return_confirmed_at: string | null;
}

export async function adminListBorrowRequests(): Promise<AdminBorrowRequestRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("admin_list_borrow_requests");
  if (error) {
    console.error("[admin] admin_list_borrow_requests RPC failed:", error);
    return [];
  }
  return (data ?? []) as AdminBorrowRequestRow[];
}
