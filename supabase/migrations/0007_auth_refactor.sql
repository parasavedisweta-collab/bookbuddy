-- =====================================================================
-- 0007 — Auth refactor: email is the credential, phone is contact-only.
--
-- BookBuddy now authenticates via Google OAuth (primary) or email-OTP
-- (fallback). Both produce a verified auth.users row whose `email` is
-- the durable identity across devices. The previous model used
-- anonymous auth + a UNIQUE phone column as a soft credential — that
-- approach (a) blocked legitimate cross-device sign-ins and (b) made
-- impersonation trivially possible to anyone who knew the number.
--
-- Schema-side consequences of the new model:
--   - parents.email becomes NOT NULL UNIQUE (it IS the credential).
--   - parents.phone stays NOT NULL (the lister contact reveal needs
--     a real number) but loses its UNIQUE constraint — phone is now
--     just a contact field, household members can share it.
--   - parents.name is dropped entirely. We address users by their
--     first child's name (matches how parents in a society refer to
--     each other anyway: "Aanya's mum").
--   - children.age_group is dropped — it was captured at registration
--     but nothing on the read side ever filtered by it. Re-add later
--     if a real use case appears.
--   - is_phone_registered RPC is dropped. Cross-device identity is
--     handled by Supabase Auth now; we don't need a public phone
--     uniqueness lookup.
--   - get_lister_contact returns (phone, child_name) instead of
--     (phone, parent_name). The borrow detail UI uses the lister's
--     child name as the human-facing label.
--
-- IMPORTANT prerequisites:
--   1. Run WIPE_DATA.sql first.
--   2. Delete all rows from auth.users via Dashboard → Authentication
--      → Users (the SET NOT NULL on email will fail otherwise).
--   3. Then run this migration.
--
-- Run in BOTH Supabase projects (prod + UAT). Idempotent where
-- feasible (IF EXISTS / IF NOT EXISTS guards on every drop/add).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Drop the legacy phone-credential RPC.
--    With email as the auth identifier, phone has no credential
--    semantics; exposing a public phone-uniqueness lookup is now both
--    useless and a small privacy leak (lets anyone enumerate registered
--    phone numbers one at a time).
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.is_phone_registered(text);

-- ---------------------------------------------------------------------
-- 2. parents — drop UNIQUE on phone, drop name, enforce email.
-- ---------------------------------------------------------------------

-- Drop the UNIQUE constraint on phone. Constraint name from 0001 was
-- the auto-generated "parents_phone_key"; guarded with IF EXISTS so
-- re-running is safe.
ALTER TABLE public.parents
  DROP CONSTRAINT IF EXISTS parents_phone_key;

-- The matching index from 0001 was created separately as
-- idx_parents_phone — keep it (lookups by phone for contact reveal
-- still benefit from the index, just not from uniqueness).

-- Drop parent name. Nothing in the UI displays it anymore.
ALTER TABLE public.parents
  DROP COLUMN IF EXISTS name;

-- Email becomes the canonical credential identifier. It mirrors
-- auth.users.email but we keep a denormalised copy on parents so
-- joins / display reads don't need a cross-schema query.
--
-- Two-step: add NOT NULL, then add UNIQUE constraint. Order matters —
-- the UNIQUE constraint creates an index that's faster to populate
-- on a non-null column.
ALTER TABLE public.parents
  ALTER COLUMN email SET NOT NULL;

-- Guarded so re-running doesn't double-add. Postgres has no "ADD
-- CONSTRAINT IF NOT EXISTS" syntax, so we check pg_constraint first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'parents_email_key'
      AND conrelid = 'public.parents'::regclass
  ) THEN
    ALTER TABLE public.parents
      ADD CONSTRAINT parents_email_key UNIQUE (email);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. children — drop age_group.
-- ---------------------------------------------------------------------

ALTER TABLE public.children
  DROP COLUMN IF EXISTS age_group;

-- ---------------------------------------------------------------------
-- 4. get_lister_contact — return child name, not parent name.
--
-- The book-detail page shows "Contact <name>" once a request is
-- approved. Since parent.name no longer exists, the natural fallback
-- is the lister's child name — which is what's shown everywhere else
-- on the book card / shelf row anyway, so this also makes the UI
-- consistent (one identity, one label, end-to-end).
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_lister_contact(uuid);

CREATE OR REPLACE FUNCTION public.get_lister_contact(book_uuid uuid)
RETURNS TABLE (phone text, child_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT p.phone, lc.name AS child_name
  FROM public.books b
  JOIN public.children lc ON lc.id = b.child_id
  JOIN public.parents p   ON p.id = lc.parent_id
  WHERE b.id = book_uuid
    AND EXISTS (
      SELECT 1
      FROM public.borrow_requests r
      JOIN public.children bc ON bc.id = r.borrower_child_id
      WHERE r.book_id = b.id
        AND bc.parent_id = auth.uid()
        AND r.status IN (
          'approved', 'picked_up', 'returned', 'confirmed_return'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.get_lister_contact(uuid) TO authenticated;

-- =====================================================================
-- Done. Verification queries:
--
--   -- Should show email NOT NULL, no name column:
--   SELECT column_name, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'parents';
--
--   -- Should show no age_group column:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'children';
--
--   -- Should show parents_email_key (UNIQUE) but NOT parents_phone_key:
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.parents'::regclass AND contype = 'u';
--
--   -- Should show is_phone_registered MISSING and get_lister_contact
--   -- returning (phone, child_name):
--   SELECT proname, pg_get_function_result(oid)
--     FROM pg_proc WHERE proname IN ('is_phone_registered','get_lister_contact');
-- =====================================================================
