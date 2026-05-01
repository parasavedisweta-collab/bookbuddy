/**
 * One-shot home page bootstrap helper.
 *
 * The home page used to fire 4 separate Supabase queries on mount
 * (parent, children, society feed, my requests, plus is-alone). Each
 * one is a network round-trip with its own TLS handshake — invisible on
 * laptop wifi, painfully slow on mobile 4G where every RTT adds 250–
 * 500 ms.
 *
 * Migration 0011 (home_bootstrap()) returns everything the home page
 * needs in one shot, shaped to match the existing client mappers
 * (mapFeedRowToBook, mapRequestRow). This module is the thin wrapper
 * that calls the RPC and maps its JSONB payload to app-domain types.
 *
 * Lives in its own file rather than feed.ts because it bridges feed +
 * requests, and putting it in feed would create a circular import
 * (requests.ts already imports mapPlainBookToBook from feed).
 */
"use client";

import { getSupabase } from "./client";
import { mapFeedRowToBook } from "./feed";
import { mapRequestRow } from "./requests";
import type { Book, BorrowRequest } from "../types";
import type { DbBookWithListerContext } from "./books";

export interface HomeBootstrap {
  /** parent row for auth.uid(), or null if the user hasn't completed
   * registration yet (no parents row exists). */
  parent: {
    id: string;
    society_id: string | null;
    phone: string | null;
  } | null;
  /** Every child owned by the current parent. Used to build the
   * "my children" id-set for the home grid's "is mine" check. */
  childIds: string[];
  /** Society feed: every non-removed book in the parent's society
   * with the lister-child summary pre-joined. */
  feed: Book[];
  /** Borrow requests this parent is involved in (as borrower OR
   * lister), with full book + child context joined. */
  requests: BorrowRequest[];
  /** True when the user is the only registered parent in their
   * society (drives the "invite your neighbours" banner). */
  isAlone: boolean;
}

interface RawBootstrap {
  parent: HomeBootstrap["parent"];
  children: { id: string }[];
  feed: DbBookWithListerContext[];
  // The request rows match DbRequestWithContext (private type in
  // requests.ts). We rely on mapRequestRow's input contract rather
  // than re-declaring the shape here.
  requests: Parameters<typeof mapRequestRow>[0][];
  is_alone: boolean;
}

/**
 * Fetch all home-page data in one round-trip. Returns null when the
 * RPC fails — caller falls back to the legacy multi-fetch path.
 */
export async function fetchHomeBootstrap(): Promise<HomeBootstrap | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("home_bootstrap");
  if (error) {
    console.error("[bootstrap] home_bootstrap failed:", error);
    return null;
  }
  if (!data) return null;

  const raw = data as RawBootstrap;
  return {
    parent: raw.parent ?? null,
    childIds: (raw.children ?? []).map((c) => c.id),
    feed: (raw.feed ?? []).map(mapFeedRowToBook),
    requests: (raw.requests ?? []).map(mapRequestRow),
    isAlone: Boolean(raw.is_alone),
  };
}
