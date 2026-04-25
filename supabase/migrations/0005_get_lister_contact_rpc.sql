-- =====================================================================
-- 0005 — Lister contact reveal RPC
--
-- Bug being fixed: the book-detail page was rendering WhatsApp + phone
-- buttons unconditionally for any non-own book, using a hardcoded
-- placeholder number ("9876543210"). Two problems:
--   1. Privacy: lister's number was implied to be visible without the
--      borrower having requested the book or the lister approving.
--   2. Correctness: the displayed number was a fake demo string —
--      tapping it on a real device would WhatsApp/dial a stranger.
--
-- We can't hand the phone out via plain RLS on parents (parents.SELECT
-- is restricted to id = auth.uid() and we don't want to widen that —
-- it would leak phone numbers across the entire user table). Instead,
-- a SECURITY DEFINER RPC checks the borrow_requests table for an
-- approved-or-better request from the caller for the given book, and
-- returns the lister's phone only when that's the case.
--
-- Run via: Supabase Dashboard → SQL Editor.
-- Safe to re-run (CREATE OR REPLACE).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_lister_contact(book_uuid uuid)
RETURNS TABLE (phone text, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT p.phone, p.name
  FROM public.books b
  JOIN public.children lc ON lc.id = b.child_id
  JOIN public.parents p   ON p.id  = lc.parent_id
  WHERE b.id = book_uuid
    -- Caller must have an "approved" or further-along borrow request
    -- for this book. Pending requests do NOT reveal contact — that's
    -- the whole point of the lister approval step.
    AND EXISTS (
      SELECT 1
      FROM public.borrow_requests r
      JOIN public.children bc ON bc.id = r.borrower_child_id
      WHERE r.book_id = b.id
        AND bc.parent_id = auth.uid()
        AND r.status IN ('approved', 'picked_up', 'returned', 'confirmed_return')
    );
$$;

-- Anon can call it but the auth.uid() check inside guarantees they get
-- nothing back unless they're a logged-in borrower with an approved
-- request. Granting to anon keeps the call surface uniform with the
-- other RPCs (is_parent_of, is_phone_registered).
GRANT EXECUTE ON FUNCTION public.get_lister_contact(uuid) TO anon, authenticated;
