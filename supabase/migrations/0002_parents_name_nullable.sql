-- =====================================================================
-- 0002 — Make parents.name nullable.
--
-- Run ONCE in each Supabase project (UAT + Prod) via:
--   Supabase Dashboard → SQL Editor → paste this file → Run.
--
-- Context: the registration UI collects phone + child details only,
-- not a separate parent name. Treating name as optional avoids having
-- to fake a placeholder ("Parent of Leo") at insert time. When/if we
-- add a "your name" field to the UX, we can backfill and tighten this.
--
-- Safe to re-run.
-- =====================================================================

ALTER TABLE public.parents
  ALTER COLUMN name DROP NOT NULL;
