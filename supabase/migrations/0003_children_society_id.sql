-- =====================================================================
-- 0003 — Denormalise society_id onto children so the home feed can
-- filter books by society without joining through parents.
--
-- Run ONCE in each Supabase project (UAT + Prod) via:
--   Supabase Dashboard → SQL Editor → paste this file → Run.
--
-- Why: parents.RLS is "SELECT WHERE id = auth.uid()" (each browser only
-- sees its own parent row). The home-feed query was books ⟵ children!inner
-- ⟵ parents!inner, which PostgREST translates to an INNER JOIN. After
-- RLS, parents is effectively a one-row table from the caller's POV,
-- so the join dropped every book listed by a different family — the
-- feed only ever returned the caller's own books. children.RLS is
-- already "any authenticated can SELECT" (names/emojis are meant to be
-- public next to books), so lifting society_id onto children lets us
-- query books ⟵ children!inner(society_id eq …) with no join through
-- parents, and RLS stops blocking cross-family visibility.
--
-- Kept in sync by a trigger on both INSERT to children and UPDATE of
-- parents.society_id (in case a family ever moves — unlikely but cheap
-- to support). The column is NOT NULL after backfill.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS, DROP TRIGGER IF EXISTS.
-- =====================================================================

-- 1. Add the column nullable, so the backfill has room to run.
ALTER TABLE public.children
  ADD COLUMN IF NOT EXISTS society_id uuid
  REFERENCES public.societies(id) ON DELETE RESTRICT;

-- 2. Backfill from the parent's current society_id.
UPDATE public.children c
   SET society_id = p.society_id
  FROM public.parents p
 WHERE c.parent_id = p.id
   AND c.society_id IS DISTINCT FROM p.society_id;

-- 3. Tighten: now that every row has a value, require it on INSERT.
--    If any row is still NULL (orphan child — shouldn't happen), this
--    will fail loudly and we can investigate before retrying.
ALTER TABLE public.children
  ALTER COLUMN society_id SET NOT NULL;

-- 4. Index for the feed filter.
CREATE INDEX IF NOT EXISTS children_society_id_idx
  ON public.children (society_id);

-- 5. Trigger: on INSERT of a child, copy the parent's society_id in so
--    the app layer doesn't have to pass it (and can't get it wrong).
CREATE OR REPLACE FUNCTION public.children_fill_society_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.society_id IS NULL THEN
    SELECT society_id INTO NEW.society_id
      FROM public.parents
     WHERE id = NEW.parent_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS children_fill_society_id_trg ON public.children;
CREATE TRIGGER children_fill_society_id_trg
  BEFORE INSERT ON public.children
  FOR EACH ROW
  EXECUTE FUNCTION public.children_fill_society_id();

-- 6. Trigger: if a parent's society_id ever changes (family moves,
--    admin merges duplicate societies), cascade to all their children.
CREATE OR REPLACE FUNCTION public.parents_propagate_society_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.society_id IS DISTINCT FROM OLD.society_id THEN
    UPDATE public.children
       SET society_id = NEW.society_id
     WHERE parent_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parents_propagate_society_id_trg ON public.parents;
CREATE TRIGGER parents_propagate_society_id_trg
  AFTER UPDATE OF society_id ON public.parents
  FOR EACH ROW
  EXECUTE FUNCTION public.parents_propagate_society_id();
