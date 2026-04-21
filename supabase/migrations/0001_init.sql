-- =====================================================================
-- BookBuddy schema v1 — initial migration
--
-- Run this ONCE in each Supabase project (UAT + Prod) via:
--   Supabase Dashboard → SQL Editor → paste this file → Run.
--
-- Safe to re-run: all DDL uses IF NOT EXISTS / CREATE OR REPLACE
-- where feasible. CREATE POLICY is not idempotent — if you re-run,
-- drop existing policies first or skip the policy block.
-- =====================================================================

-- Extensions ---------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================================
-- Tables
-- =====================================================================

-- Societies (apartment complexes / communities)
CREATE TABLE IF NOT EXISTS public.societies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  city       text NOT NULL,
  pincode    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Parents (one per auth.users anonymous user).
-- The `id` column matches auth.uid() so RLS policies can do id = auth.uid().
CREATE TABLE IF NOT EXISTS public.parents (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone      text NOT NULL UNIQUE,
  name       text NOT NULL,
  email      text,
  society_id uuid REFERENCES public.societies(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Children (one parent can have multiple kids)
CREATE TABLE IF NOT EXISTS public.children (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     uuid NOT NULL REFERENCES public.parents(id) ON DELETE CASCADE,
  name          text NOT NULL,
  emoji         text,
  age_group     text NOT NULL CHECK (age_group IN ('below-5','6-8','9-12','12+')),
  bookbuddy_id  text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Books (listed by a child/parent)
CREATE TABLE IF NOT EXISTS public.books (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id      uuid NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
  title         text NOT NULL,
  author        text,
  isbn          text,
  description   text,
  category      text,
  cover_url     text,
  cover_source  text CHECK (cover_source IN ('api','user')),
  status        text NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','borrowed','out_of_stock','removed')),
  listed_at     timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb
);

-- Borrow requests
CREATE TABLE IF NOT EXISTS public.borrow_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id              uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  borrower_child_id    uuid NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
  lister_child_id      uuid NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'pending'
                          CHECK (status IN (
                            'pending','approved','rejected',
                            'picked_up','returned','return_confirmed','cancelled'
                          )),
  requested_at         timestamptz NOT NULL DEFAULT now(),
  responded_at         timestamptz,
  picked_up_at         timestamptz,
  due_date             date,
  returned_at          timestamptz,
  return_confirmed_at  timestamptz
);

-- =====================================================================
-- Indexes
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_parents_phone       ON public.parents(phone);
CREATE INDEX IF NOT EXISTS idx_parents_society     ON public.parents(society_id);
CREATE INDEX IF NOT EXISTS idx_children_parent     ON public.children(parent_id);
CREATE INDEX IF NOT EXISTS idx_books_child_status  ON public.books(child_id, status);
CREATE INDEX IF NOT EXISTS idx_books_status        ON public.books(status) WHERE status <> 'removed';
CREATE INDEX IF NOT EXISTS idx_br_borrower_status  ON public.borrow_requests(borrower_child_id, status);
CREATE INDEX IF NOT EXISTS idx_br_lister_status    ON public.borrow_requests(lister_child_id, status);
CREATE INDEX IF NOT EXISTS idx_br_book_status      ON public.borrow_requests(book_id, status);

-- =====================================================================
-- Helper functions (SECURITY DEFINER so RLS checks can call them)
-- =====================================================================

-- Is the current auth user the parent of this child?
CREATE OR REPLACE FUNCTION public.is_parent_of(child_uuid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.children c
    WHERE c.id = child_uuid AND c.parent_id = auth.uid()
  );
$$;

-- Public boolean lookup: is a given phone already registered?
-- (Returns only true/false, so it's safe to expose to anon.)
CREATE OR REPLACE FUNCTION public.is_phone_registered(check_phone text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.parents WHERE phone = check_phone
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_parent_of(uuid)       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_phone_registered(text) TO anon, authenticated;

-- =====================================================================
-- Row Level Security
-- =====================================================================

ALTER TABLE public.societies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.children         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.books            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.borrow_requests  ENABLE ROW LEVEL SECURITY;

-- ----- societies -----
-- All authenticated users can read all societies (for dropdown search).
-- Authenticated users can propose new societies.
-- Update/Delete: admin only (no policy → denied).

CREATE POLICY "societies_select_all"
  ON public.societies FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "societies_insert_authenticated"
  ON public.societies FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ----- parents -----
-- You can only read/write your own parent row.
-- Phone number is never leaked across users.

CREATE POLICY "parents_select_self"
  ON public.parents FOR SELECT
  TO authenticated
  USING (id = auth.uid());

CREATE POLICY "parents_insert_self"
  ON public.parents FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());

CREATE POLICY "parents_update_self"
  ON public.parents FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ----- children -----
-- Read: all authenticated can read any child row (name/emoji/age shows
-- in the public feed next to books).
-- Write: only the owning parent.

CREATE POLICY "children_select_any"
  ON public.children FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "children_insert_own"
  ON public.children FOR INSERT
  TO authenticated
  WITH CHECK (parent_id = auth.uid());

CREATE POLICY "children_update_own"
  ON public.children FOR UPDATE
  TO authenticated
  USING (parent_id = auth.uid())
  WITH CHECK (parent_id = auth.uid());

CREATE POLICY "children_delete_own"
  ON public.children FOR DELETE
  TO authenticated
  USING (parent_id = auth.uid());

-- ----- books -----
-- Read: all authenticated (the shared feed).
-- Write: only if the owning child is yours.

CREATE POLICY "books_select_any"
  ON public.books FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "books_insert_own_child"
  ON public.books FOR INSERT
  TO authenticated
  WITH CHECK (public.is_parent_of(child_id));

CREATE POLICY "books_update_own_child"
  ON public.books FOR UPDATE
  TO authenticated
  USING (public.is_parent_of(child_id))
  WITH CHECK (public.is_parent_of(child_id));

CREATE POLICY "books_delete_own_child"
  ON public.books FOR DELETE
  TO authenticated
  USING (public.is_parent_of(child_id));

-- ----- borrow_requests -----
-- Read: only if you're the borrower OR the lister.
-- Insert: you must be the borrower.
-- Update: either party can progress the flow.

CREATE POLICY "br_select_involved"
  ON public.borrow_requests FOR SELECT
  TO authenticated
  USING (
    public.is_parent_of(borrower_child_id)
    OR public.is_parent_of(lister_child_id)
  );

CREATE POLICY "br_insert_as_borrower"
  ON public.borrow_requests FOR INSERT
  TO authenticated
  WITH CHECK (public.is_parent_of(borrower_child_id));

CREATE POLICY "br_update_involved"
  ON public.borrow_requests FOR UPDATE
  TO authenticated
  USING (
    public.is_parent_of(borrower_child_id)
    OR public.is_parent_of(lister_child_id)
  )
  WITH CHECK (
    public.is_parent_of(borrower_child_id)
    OR public.is_parent_of(lister_child_id)
  );

-- =====================================================================
-- Done.
-- =====================================================================
