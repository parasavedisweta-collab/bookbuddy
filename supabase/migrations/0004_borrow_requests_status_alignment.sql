-- =====================================================================
-- 0004 — Align borrow_requests.status CHECK with the app's TypeScript
-- vocabulary so the data-access layer doesn't have to translate names
-- on every read/write.
--
-- Run ONCE in each Supabase project (UAT + Prod) via:
--   Supabase Dashboard → SQL Editor → paste this file → Run.
--
-- Context: the table was created in 0001_init.sql with a CHECK using
--   'rejected', 'return_confirmed', 'cancelled'
-- but the app code (src/lib/types.ts → BorrowStatus) has always used
--   'declined', 'confirmed_return', and also needs 'auto_declined'
-- (for the case where one lister approves first and the system auto-
-- declines the runners-up).
--
-- As of this migration the borrow_requests write path has never been
-- connected to Supabase, so in a normal world the table is empty.
-- We still do a defensive UPDATE to rename any stray rows to the new
-- vocab — cheap, idempotent, and lets us drop the old CHECK cleanly.
--
-- 'cancelled' is removed from the allowed set because the app has no
-- cancel flow yet. If we add one later, we add it back here.
--
-- Safe to re-run: DROP CONSTRAINT IF EXISTS + conditional UPDATE.
-- =====================================================================

-- 1. Rename any legacy rows to the new vocab before tightening the CHECK.
--    These UPDATEs are no-ops on a fresh table.
UPDATE public.borrow_requests
   SET status = 'declined'
 WHERE status = 'rejected';

UPDATE public.borrow_requests
   SET status = 'confirmed_return'
 WHERE status = 'return_confirmed';

-- 'cancelled' has no direct analogue — promote to 'declined' since the
-- only pre-existing semantic was "this request is dead". Harmless on an
-- empty table; only fires if someone manually inserted a cancelled row.
UPDATE public.borrow_requests
   SET status = 'declined'
 WHERE status = 'cancelled';

-- 2. Swap the CHECK constraint. The original was an inline CHECK so it
--    carries an auto-generated name; find it and drop by that name.
DO $$
DECLARE
  conname text;
BEGIN
  SELECT c.conname
    INTO conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'borrow_requests'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%status%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.borrow_requests DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE public.borrow_requests
  ADD CONSTRAINT borrow_requests_status_check
  CHECK (status IN (
    'pending',
    'approved',
    'declined',
    'auto_declined',
    'picked_up',
    'returned',
    'confirmed_return'
  ));
