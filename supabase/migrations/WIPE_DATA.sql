-- =====================================================================
-- WIPE_DATA — Run BEFORE migration 0007.
--
-- The auth refactor (anonymous → Google/email-OTP) makes existing
-- parent rows impossible to log back into: they were keyed to
-- anonymous auth.users IDs that won't be re-issued. Rather than try
-- to migrate test data with no recoverable owner, we wipe.
--
-- Order matters: children of FK chains first.
--
-- Run in BOTH Supabase projects (prod + UAT) via:
--   Dashboard → SQL Editor → paste → Run.
--
-- THEN, separately, in Dashboard → Authentication → Users:
--   select all → delete. (The auth.users table is managed by Supabase
--   and not directly writable from SQL Editor on the free tier.)
--
-- ONLY after the wipe + auth.users deletion, run 0007_auth_refactor.sql.
-- Otherwise the NOT NULL email constraint will fail on legacy rows.
-- =====================================================================

DELETE FROM public.push_subscriptions;
DELETE FROM public.borrow_requests;
DELETE FROM public.books;
DELETE FROM public.children;
DELETE FROM public.parents;

-- societies: keep. They're shared lookup data; new users will join the
-- same Seawoods / Green Meadows / etc. rows.
