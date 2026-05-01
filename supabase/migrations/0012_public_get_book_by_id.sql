-- =====================================================================
-- 0012 — public_get_book_by_id() SECURITY DEFINER RPC
--
-- Adds an anon-callable single-book read so the unauthenticated
-- /book/[id] route works. Mirrors the public-browse pattern from
-- migration 0009 — exposes the book row + the listing child's name
-- and emoji, but nothing that crosses parents (no PII, no contact
-- info, no borrow_requests).
--
-- Why a dedicated RPC instead of widening books.SELECT to anon?
--   Same reasoning as 0009: keeping anon out of the books table
--   directly preserves the audit trail for what the public flow can
--   see, and lets us return exactly the columns the public UI needs
--   without the risk of a future query joining through children →
--   parents and quietly failing for an anon caller.
--
-- Run via: Supabase Dashboard → SQL Editor on UAT first, then prod.
-- Idempotent (CREATE OR REPLACE / GRANT).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.public_get_book_by_id(
  book_uuid uuid
)
RETURNS TABLE (
  id              uuid,
  child_id        uuid,
  child_name      text,
  child_emoji     text,
  child_society_id uuid,
  title           text,
  author          text,
  category        text,
  cover_url       text,
  cover_source    text,
  status          text,
  listed_at       timestamptz,
  age_range       text,
  description     text
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
    c.society_id        AS child_society_id,
    b.title,
    b.author,
    b.category,
    b.cover_url,
    b.cover_source::text AS cover_source,
    b.status::text       AS status,
    b.listed_at,
    NULLIF(b.metadata->>'age_range', '') AS age_range,
    b.description
  FROM public.books b
  JOIN public.children c ON c.id = b.child_id
  WHERE b.id = book_uuid
    AND b.status <> 'removed';
$$;

GRANT EXECUTE ON FUNCTION public.public_get_book_by_id(uuid)
  TO anon, authenticated;
