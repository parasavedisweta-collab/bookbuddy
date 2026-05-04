/**
 * Funnel-event tracking client (migration 0013).
 *
 * Captures the four conversion stages a visitor moves through:
 *   1. visited        — first page load on / or /welcome
 *   2. viewed_books   — picked a society and saw the home grid
 *   3. registered     — finished /auth/child-setup
 *   4. listed_book    — successfully wrote a book
 *
 * Visitor identity is a random UUID minted on first call to
 * getVisitorId() and persisted to localStorage as bb_visitor_id.
 * Same id sticks across visits on this device, links to a parent_id
 * once they register so the admin can correlate.
 *
 * Privacy: no IP, no UA, no fingerprint. Just the random visitor id
 * the client itself generates plus optional society / book context
 * for the relevant events.
 */
"use client";

import { getSupabase } from "./client";

const VISITOR_KEY = "bb_visitor_id";
const DEDUP_KEY = "bb_funnel_fired";

export type FunnelEvent =
  | "visited"
  | "viewed_books"
  | "registered"
  | "listed_book";

/**
 * Read the persisted visitor id from localStorage, minting a new UUID
 * on first access. Returns null on the server (no localStorage).
 */
export function getVisitorId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing && existing.length >= 8) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(VISITOR_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * Per-tab dedup so an effect that re-runs (auth event, prop change)
 * doesn't fire the same once-per-session event repeatedly. Persisted
 * to localStorage so a refresh re-uses it — `visited` should fire
 * once per device per session, not once per pageload.
 */
function alreadyFired(eventType: FunnelEvent, scope: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(DEDUP_KEY);
    const map: Record<string, boolean> = raw ? JSON.parse(raw) : {};
    const key = `${eventType}:${scope}`;
    if (map[key]) return true;
    map[key] = true;
    localStorage.setItem(DEDUP_KEY, JSON.stringify(map));
    return false;
  } catch {
    return false;
  }
}

interface LogParams {
  parentId?: string | null;
  societyId?: string | null;
  bookId?: string | null;
  /** Optional dedup scope. If set, this (event_type, scope) tuple
   * fires at most once per device per browser session — useful for
   * `visited` (scope="session") so we don't double-count refreshes,
   * and for `viewed_books` (scope=societyId) so a visitor who views
   * the same society twice still counts as one. */
  dedupScope?: string;
}

/**
 * Best-effort fire-and-forget event log. Failures are logged to the
 * console but never thrown — funnel tracking should never block the
 * user-visible flow.
 */
export async function logFunnelEvent(
  eventType: FunnelEvent,
  params: LogParams = {}
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const visitorId = getVisitorId();
    if (!visitorId) return;
    if (params.dedupScope && alreadyFired(eventType, params.dedupScope)) {
      return;
    }
    const supabase = getSupabase();
    const { error } = await supabase.rpc("log_funnel_event", {
      p_visitor_id: visitorId,
      p_event_type: eventType,
      p_parent_id: params.parentId ?? null,
      p_society_id: params.societyId ?? null,
      p_book_id: params.bookId ?? null,
    });
    if (error) {
      console.warn("[funnel] log_funnel_event failed:", error);
    }
  } catch (err) {
    console.warn("[funnel] log threw:", err);
  }
}
