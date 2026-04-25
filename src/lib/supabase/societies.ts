/**
 * Supabase-backed societies data layer.
 *
 * Replaces the old localStorage-derived society list in userStore.ts.
 * The societies table has RLS `select true` for authenticated users
 * (anon + verified), and `insert with check true` — any signed-in
 * user (including the anonymous JWT minted by SupabaseAuthBootstrap)
 * may propose a new society. Admin-side curation (merge duplicates,
 * delete spam) is not exposed here and goes through the service-role
 * admin client.
 *
 * All functions are side-effect-free w.r.t. local state and return
 * empty / null on error after logging. Callers should handle the
 * null case — do not assume success.
 */
"use client";

import { getSupabase } from "./client";

/** Row shape matching public.societies (see supabase/migrations/0001_init.sql). */
export interface DbSociety {
  id: string;
  name: string;
  city: string;
  pincode: string | null;
  created_at: string;
}

const COLUMNS = "id, name, city, pincode, created_at" as const;

/** Return every society, alphabetised. Intended for admin views, not user UX. */
export async function listSocieties(): Promise<DbSociety[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("societies")
    .select(COLUMNS)
    .order("name", { ascending: true });

  if (error) {
    console.error("[societies] list failed:", error);
    return [];
  }
  return (data ?? []) as DbSociety[];
}

/**
 * Fuzzy server-side search for societies whose name matches `query`.
 * Optionally restricted to a city substring.
 *
 * Uses ILIKE `%query%`. Minimum query length of 2 to avoid scanning
 * the whole table on every keystroke. Caller is responsible for
 * debouncing input.
 *
 * Note: this does not rank by Levenshtein; Postgres pg_trgm would be
 * the upgrade path if ranking matters. For now, alphabetical + limit 20.
 */
export async function searchSocietiesByName(
  query: string,
  cityFilter = ""
): Promise<DbSociety[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const supabase = getSupabase();
  // Escape ILIKE wildcards so user input like "100%_pure" doesn't explode the pattern.
  const safe = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  let req = supabase
    .from("societies")
    .select(COLUMNS)
    .ilike("name", `%${safe}%`);

  const cityQ = cityFilter.trim();
  if (cityQ) {
    const safeCity = cityQ.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    req = req.ilike("city", `%${safeCity}%`);
  }

  const { data, error } = await req
    .order("name", { ascending: true })
    .limit(20);

  if (error) {
    console.error("[societies] search failed:", error);
    return [];
  }
  return (data ?? []) as DbSociety[];
}

/**
 * A society row plus the count of distinct parents who've registered
 * a child in it. Used by the registration picker to show "verified by
 * neighbours" / "listed by a neighbour" social-proof badges with real
 * cross-device numbers (the previous picker only counted users from
 * the current device's localStorage, which silently broke for any
 * second-device or post-sign-out registration).
 */
export interface DbSocietyWithMembers extends DbSociety {
  memberCount: number;
}

/**
 * Search societies by name + member-count, sorted with the most
 * populated society first. Built on top of `searchSocietiesByName`
 * so the ILIKE/escape logic stays in one place.
 *
 * Implementation: one query for the matching society rows, then a
 * second query against `children` (permissive SELECT RLS, carries
 * denormalised society_id) to count distinct parent_ids per society.
 * Two round-trips not one — Postgrest can't `count(distinct ...)`
 * cleanly without an RPC, and at picker scale (≤20 societies, ≤dozens
 * of members each) the second query is small. If society + member
 * counts ever balloon, swap this for a SECURITY DEFINER RPC.
 *
 * On the second query failing, we still return the society list with
 * memberCount=0 — the picker should at least show the society names
 * even if the badges go missing.
 */
export async function searchSocietiesWithMembers(
  query: string
): Promise<DbSocietyWithMembers[]> {
  const societies = await searchSocietiesByName(query);
  if (societies.length === 0) return [];

  const supabase = getSupabase();
  const ids = societies.map((s) => s.id);
  const { data: childRows, error } = await supabase
    .from("children")
    .select("society_id, parent_id")
    .in("society_id", ids);

  if (error) {
    console.error(
      "[societies] member-count fetch failed; returning bare societies:",
      error
    );
    return societies.map((s) => ({ ...s, memberCount: 0 }));
  }

  const bySociety = new Map<string, Set<string>>();
  for (const row of childRows ?? []) {
    if (!row.society_id || !row.parent_id) continue;
    let set = bySociety.get(row.society_id);
    if (!set) {
      set = new Set();
      bySociety.set(row.society_id, set);
    }
    set.add(row.parent_id);
  }

  return societies
    .map((s) => ({ ...s, memberCount: bySociety.get(s.id)?.size ?? 0 }))
    .sort((a, b) => b.memberCount - a.memberCount);
}

/**
 * Look up a society by exact (case-insensitive) name + city.
 * If none found, insert a new row and return it.
 *
 * Returns null on validation failure (blank input) or DB error.
 *
 * Race condition note: two concurrent first-time registrants for the
 * same society will each see "no match" and each insert a row. We
 * accept that — admin can merge duplicates later. A proper fix needs
 * a UNIQUE (lower(name), lower(city)) constraint, which we can add
 * in a follow-up migration once the schema stabilises.
 */
export async function findOrCreateSociety(
  name: string,
  city: string,
  pincode?: string
): Promise<DbSociety | null> {
  const trimmedName = name.trim();
  const trimmedCity = city.trim();
  if (!trimmedName || !trimmedCity) return null;

  const supabase = getSupabase();

  // Step 1: exact case-insensitive match.
  // ILIKE without %/_ wildcards behaves as case-insensitive equality.
  const safeName = trimmedName.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const safeCity = trimmedCity.replace(/[\\%_]/g, (ch) => `\\${ch}`);

  const { data: existing, error: findErr } = await supabase
    .from("societies")
    .select(COLUMNS)
    .ilike("name", safeName)
    .ilike("city", safeCity)
    .limit(1)
    .maybeSingle();

  if (findErr) {
    console.error("[societies] find failed:", findErr);
    return null;
  }
  if (existing) return existing as DbSociety;

  // Step 2: insert.
  const { data: inserted, error: insertErr } = await supabase
    .from("societies")
    .insert({
      name: trimmedName,
      city: trimmedCity,
      pincode: pincode?.trim() || null,
    })
    .select(COLUMNS)
    .single();

  if (insertErr) {
    console.error("[societies] insert failed:", insertErr);
    return null;
  }
  return inserted as DbSociety;
}

/** Fetch a single society by id, or null if not found. */
export async function getSocietyById(id: string): Promise<DbSociety | null> {
  if (!id) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("societies")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[societies] get failed:", error);
    return null;
  }
  return (data ?? null) as DbSociety | null;
}
