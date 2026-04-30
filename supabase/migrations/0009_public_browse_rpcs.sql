-- =====================================================================
-- 0009 — Public-browse SECURITY DEFINER RPCs (no auth required)
--
-- Adds two read-only RPCs callable by the `anon` role so a visitor can
-- pick a society and peek at its bookshelf BEFORE signing up. The flow:
--
--   1. /welcome — marketing landing
--   2. /library — society picker → public_search_societies()
--   3. /library — browse books   → public_list_books_for_society()
--   4. /auth/sign-in → child-setup (society pre-filled)
--
-- What's exposed (intentionally narrow):
--   - Society names + cities + member counts. Used to populate the
--     picker and badge "verified by N neighbours" without authing.
--   - Books in a society (title, author, cover, status) + the lister
--     CHILD's name and emoji only.
--
-- What's NOT exposed:
--   - parents.*    — emails, phones, IDs all stay restricted.
--   - children.*   — only name + emoji + society_id surface; no
--     parent_id or bookbuddy_id leak through these RPCs.
--   - borrow_requests.* — never readable to anon.
--
-- Why two new RPCs instead of widening RLS to anon? Plain RLS would
-- need policies on books.SELECT, children.SELECT, societies.SELECT
-- adding the anon role — but `parents.SELECT WHERE id = auth.uid()`
-- only works for authenticated callers, and we'd risk a future query
-- joining through children → parents for an anon caller and quietly
-- failing. SECURITY DEFINER RPCs let us hand back precisely the
-- columns the public flow needs and nothing else.
--
-- Run via: Supabase Dashboard → SQL Editor on UAT first, then prod.
-- Idempotent (CREATE OR REPLACE / GRANT is safe to re-run).
-- =====================================================================

-- ── public_search_societies ────────────────────────────────────────
-- Mirrors the authenticated `searchSocietiesWithMembers` helper in
-- src/lib/supabase/societies.ts: ILIKE on name (and optional city
-- filter), with the distinct-parent count joined in. Sorted with
-- the most populated society first.
--
-- Empty `query` returns []  — the picker debounces to ≥ 2 chars.
CREATE OR REPLACE FUNCTION public.public_search_societies(
  query text,
  city_filter text DEFAULT ''
)
RETURNS TABLE (
  id            uuid,
  name          text,
  city          text,
  pincode       text,
  created_at    timestamptz,
  member_count  integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH q AS (
    SELECT
      -- Escape ILIKE wildcards: "100%_pure" must not blow up the pattern.
      replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') AS safe_name,
      replace(replace(replace(trim(city_filter), '\', '\\'), '%', '\%'), '_', '\_') AS safe_city
  ),
  candidates AS (
    SELECT s.id, s.name, s.city, s.pincode, s.created_at
    FROM public.societies s, q
    WHERE
      length(q.safe_name) >= 2
      AND s.name ILIKE '%' || q.safe_name || '%'
      AND (q.safe_city = '' OR s.city ILIKE '%' || q.safe_city || '%')
    ORDER BY s.name
    LIMIT 20
  ),
  member_counts AS (
    SELECT c.id AS society_id, COUNT(DISTINCT ch.parent_id)::int AS member_count
    FROM candidates c
    LEFT JOIN public.children ch ON ch.society_id = c.id
    GROUP BY c.id
  )
  SELECT
    c.id, c.name, c.city, c.pincode, c.created_at,
    COALESCE(mc.member_count, 0) AS member_count
  FROM candidates c
  LEFT JOIN member_counts mc ON mc.society_id = c.id
  ORDER BY mc.member_count DESC NULLS LAST, c.name;
$$;

GRANT EXECUTE ON FUNCTION public.public_search_societies(text, text)
  TO anon, authenticated;

-- ── public_list_books_for_society ──────────────────────────────────
-- All non-removed books in a society, with the lister-child's name +
-- emoji pre-joined. Sort newest first (matches the home feed).
--
-- Status is exposed as text so the public client doesn't need to
-- pin to the books.status enum. The same UI labels ("available",
-- "borrowed", "out_of_stock") are used post-auth.
CREATE OR REPLACE FUNCTION public.public_list_books_for_society(
  society_uuid uuid
)
RETURNS TABLE (
  id              uuid,
  child_id        uuid,
  child_name      text,
  child_emoji     text,
  title           text,
  author          text,
  category        text,
  cover_url       text,
  cover_source    text,
  status          text,
  listed_at       timestamptz,
  age_range       text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    b.id,
    b.child_id,
    c.name              AS child_name,
    c.emoji             AS child_emoji,
    b.title,
    b.author,
    b.category,
    b.cover_url,
    b.cover_source::text AS cover_source,
    b.status::text       AS status,
    b.listed_at,
    -- age_range lives in metadata jsonb; pull as text or NULL.
    NULLIF(b.metadata->>'age_range', '') AS age_range
  FROM public.books b
  JOIN public.children c ON c.id = b.child_id
  WHERE c.society_id = society_uuid
    AND b.status <> 'removed'
  ORDER BY b.listed_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.public_list_books_for_society(uuid)
  TO anon, authenticated;
