-- =====================================================================
-- 0008 — Admin allowlist + SECURITY DEFINER read RPCs
--
-- The /admin page historically rendered against three hard-coded demo
-- children (Jenny / Arjun / Priya). With the demo data removed, admin
-- needs to read from real Supabase rows — but plain RLS hides most of
-- what admin needs:
--   - parents.SELECT is restricted to `id = auth.uid()` (so admin
--     can't list other registrants).
--   - borrow_requests.SELECT only allows the borrower or the lister
--     parent (so admin can't see system-wide activity).
--
-- We don't want to widen those policies — they protect real PII (phone,
-- email) and request history. Instead, this migration:
--
--   1. Creates `admin_emails` — a tiny allowlist table seeded with the
--      app owner's email. Admin status is derived from the caller's
--      auth.email() being present here.
--   2. Adds `public.is_admin()` — SECURITY DEFINER bool helper that
--      page-level effects can call to decide whether to render or
--      redirect.
--   3. Adds two read RPCs (`admin_list_users`, `admin_list_borrow_requests`)
--      that internally check `is_admin()` and return system-wide data
--      only for those callers. Non-admins get an empty set (the
--      RPC bodies are gated, not just access — even if a non-admin
--      were to discover and call them, they get [].
--
-- Books are NOT exposed via an admin RPC because books.SELECT is already
-- permissive (any authenticated user can read any book row); the admin
-- UI uses the existing client lib for the books tab.
--
-- Run via: Supabase Dashboard → SQL Editor on UAT first, then prod.
-- Safe to re-run (everything is CREATE OR REPLACE / IF NOT EXISTS).
-- =====================================================================

-- ── Allowlist table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_emails (
  email      text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_emails ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policies for normal users — admin
-- membership is managed by the project owner via the SQL editor (or
-- by the service role). Even the admins themselves don't need to read
-- this table; `is_admin()` is the only read path and runs SECURITY
-- DEFINER.

-- Seed the initial admin. Idempotent — re-running the migration is a
-- no-op for existing rows.
INSERT INTO public.admin_emails (email)
VALUES ('parasavedi.sweta@gmail.com')
ON CONFLICT (email) DO NOTHING;

-- ── is_admin() ─────────────────────────────────────────────────────
-- SECURITY DEFINER so we can read admin_emails despite RLS, and join
-- against parents (RLS-restricted) by auth.uid() to find the caller's
-- email. STABLE because it doesn't write and the result is consistent
-- within a statement.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.parents p
    JOIN public.admin_emails ae ON ae.email = p.email
    WHERE p.id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- ── admin_list_users() ─────────────────────────────────────────────
-- Returns one row per (parent, child) pair — i.e. a parent with no
-- children appears once with NULL child_*; a parent with two children
-- appears twice. Admin UI groups by parent_id.
--
-- Body is gated: non-admins get an empty result. This is defence-in-
-- depth; even though we GRANT EXECUTE to anon/authenticated, only
-- admins observe rows.
CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  parent_id          uuid,
  email              text,
  phone              text,
  society_id         uuid,
  society_name       text,
  society_city       text,
  registered_at      timestamptz,
  child_id           uuid,
  child_name         text,
  child_emoji        text,
  child_bookbuddy_id text,
  child_created_at   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    p.id            AS parent_id,
    p.email,
    p.phone,
    p.society_id,
    s.name          AS society_name,
    s.city          AS society_city,
    p.created_at    AS registered_at,
    c.id            AS child_id,
    c.name          AS child_name,
    c.emoji         AS child_emoji,
    c.bookbuddy_id  AS child_bookbuddy_id,
    c.created_at    AS child_created_at
  FROM public.parents p
  LEFT JOIN public.societies s ON s.id = p.society_id
  LEFT JOIN public.children c  ON c.parent_id = p.id
  WHERE public.is_admin()
  ORDER BY p.created_at DESC, c.created_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_users() TO anon, authenticated;

-- ── admin_list_borrow_requests() ───────────────────────────────────
-- Every borrow_requests row, with the joined book title and the two
-- children's names so the admin UI doesn't have to issue a separate
-- batch lookup. Children + books have permissive SELECT RLS so the
-- joins below are safe to inline (admin doesn't need DEFINER for those).
CREATE OR REPLACE FUNCTION public.admin_list_borrow_requests()
RETURNS TABLE (
  id                  uuid,
  book_id             uuid,
  book_title          text,
  borrower_child_id   uuid,
  borrower_child_name text,
  lister_child_id     uuid,
  lister_child_name   text,
  status              text,
  requested_at        timestamptz,
  responded_at        timestamptz,
  picked_up_at        timestamptz,
  returned_at         timestamptz,
  return_confirmed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    br.id,
    br.book_id,
    b.title          AS book_title,
    br.borrower_child_id,
    bc.name          AS borrower_child_name,
    br.lister_child_id,
    lc.name          AS lister_child_name,
    br.status::text  AS status,
    br.requested_at,
    br.responded_at,
    br.picked_up_at,
    br.returned_at,
    br.return_confirmed_at
  FROM public.borrow_requests br
  LEFT JOIN public.books    b  ON b.id  = br.book_id
  LEFT JOIN public.children bc ON bc.id = br.borrower_child_id
  LEFT JOIN public.children lc ON lc.id = br.lister_child_id
  WHERE public.is_admin()
  ORDER BY br.requested_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_borrow_requests() TO anon, authenticated;
