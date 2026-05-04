-- =====================================================================
-- 0013 — Funnel-event tracking
--
-- Captures the four conversion stages an unauthenticated visitor moves
-- through before becoming a registered, listing user:
--   1. visited        — first page load on / or /welcome
--   2. viewed_books   — picked a society and saw the home grid
--   3. registered     — finished /auth/child-setup
--   4. listed_book    — successfully wrote a book to public.books
--
-- Each visitor gets a random visitor_id minted into localStorage on
-- first visit (bb_visitor_id). The same id is sent with every event,
-- so we can de-dup per visitor and follow them across the funnel even
-- before they have an auth.uid(). Once they register we patch
-- parent_id onto subsequent events so the admin can correlate.
--
-- Privacy: no IP, no user-agent, no fingerprint. The only identifier
-- captured for an anonymous visitor is the random UUID they themselves
-- generated. The society they picked is included on `viewed_books` so
-- the admin can see "where" the funnel is performing.
--
-- Run via: Supabase Dashboard → SQL Editor on UAT first, then prod.
-- Idempotent (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION).
-- =====================================================================

-- ── Table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.funnel_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id  text NOT NULL,
  event_type  text NOT NULL CHECK (
    event_type IN ('visited', 'viewed_books', 'registered', 'listed_book')
  ),
  parent_id   uuid REFERENCES public.parents(id) ON DELETE SET NULL,
  society_id  uuid REFERENCES public.societies(id) ON DELETE SET NULL,
  book_id     uuid REFERENCES public.books(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS funnel_events_visitor_idx
  ON public.funnel_events(visitor_id);
CREATE INDEX IF NOT EXISTS funnel_events_event_type_idx
  ON public.funnel_events(event_type);
CREATE INDEX IF NOT EXISTS funnel_events_created_at_idx
  ON public.funnel_events(created_at DESC);

-- RLS: nobody reads or writes the table directly. Reads happen via
-- the admin RPCs below (gated on is_admin()); writes happen via the
-- log_funnel_event RPC (SECURITY DEFINER so anon callers can insert).
ALTER TABLE public.funnel_events ENABLE ROW LEVEL SECURITY;

-- ── log_funnel_event() ─────────────────────────────────────────────
-- Anon-callable insert for funnel events. SECURITY DEFINER so anon
-- callers can write despite RLS on the table.
--
-- We trust visitor_id from the client because it's anonymous data the
-- client itself minted; the worst case for a malicious caller is
-- writing junk events under made-up visitor_ids, which inflates funnel
-- totals but doesn't compromise anyone. If that becomes a real
-- problem we can rate-limit by visitor_id at the RPC level.
CREATE OR REPLACE FUNCTION public.log_funnel_event(
  p_visitor_id  text,
  p_event_type  text,
  p_parent_id   uuid DEFAULT NULL,
  p_society_id  uuid DEFAULT NULL,
  p_book_id     uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_visitor_id IS NULL OR length(trim(p_visitor_id)) = 0 THEN
    RETURN;
  END IF;
  IF p_event_type NOT IN ('visited', 'viewed_books', 'registered', 'listed_book') THEN
    RETURN;
  END IF;
  INSERT INTO public.funnel_events (
    visitor_id, event_type, parent_id, society_id, book_id
  ) VALUES (
    trim(p_visitor_id), p_event_type, p_parent_id, p_society_id, p_book_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_funnel_event(text, text, uuid, uuid, uuid)
  TO anon, authenticated;

-- ── admin_funnel_summary() ─────────────────────────────────────────
-- Returns four rows, one per stage, with the distinct visitor count
-- at that stage. Admin UI computes conversion % from the sequence.
--
-- "Distinct visitor count" — a visitor who fired `visited` 5 times
-- still counts as 1. Stages are independent: a visitor with both
-- `viewed_books` and `registered` events counts in both rows.
CREATE OR REPLACE FUNCTION public.admin_funnel_summary()
RETURNS TABLE (
  event_type text,
  visitor_count integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT fe.event_type, COUNT(DISTINCT fe.visitor_id)::int AS visitor_count
  FROM public.funnel_events fe
  WHERE public.is_admin()
  GROUP BY fe.event_type
  ORDER BY CASE fe.event_type
    WHEN 'visited'      THEN 1
    WHEN 'viewed_books' THEN 2
    WHEN 'registered'   THEN 3
    WHEN 'listed_book'  THEN 4
    ELSE 5
  END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_funnel_summary()
  TO anon, authenticated;

-- ── admin_funnel_visitors() ────────────────────────────────────────
-- One row per visitor_id, with the highest stage they reached and
-- when they were last seen. Used by the admin Users tab to show
-- anonymous visitors alongside registered parents.
--
-- "Highest stage" is encoded numerically server-side and translated
-- back to its label. parent_id surfaces if any of the visitor's
-- events carry one — so the admin can spot which anonymous visitors
-- have already converted.
CREATE OR REPLACE FUNCTION public.admin_funnel_visitors()
RETURNS TABLE (
  visitor_id     text,
  max_stage      text,
  last_seen      timestamptz,
  parent_id      uuid,
  society_id     uuid,
  society_name   text,
  event_count    integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH per_visitor AS (
    SELECT
      fe.visitor_id,
      MAX(CASE fe.event_type
        WHEN 'visited'      THEN 1
        WHEN 'viewed_books' THEN 2
        WHEN 'registered'   THEN 3
        WHEN 'listed_book'  THEN 4
        ELSE 0
      END) AS max_stage_n,
      MAX(fe.created_at) AS last_seen,
      -- parent_id: pick the most recent non-null. UUID has no MAX
      -- aggregate so we use the same array-agg pattern as society_id.
      (ARRAY_AGG(fe.parent_id ORDER BY fe.created_at DESC)
        FILTER (WHERE fe.parent_id IS NOT NULL))[1] AS parent_id,
      -- Society: prefer the most recent non-null pick
      (ARRAY_AGG(fe.society_id ORDER BY fe.created_at DESC)
        FILTER (WHERE fe.society_id IS NOT NULL))[1] AS society_id,
      COUNT(*)::int AS event_count
    FROM public.funnel_events fe
    GROUP BY fe.visitor_id
  )
  SELECT
    pv.visitor_id,
    CASE pv.max_stage_n
      WHEN 1 THEN 'visited'
      WHEN 2 THEN 'viewed_books'
      WHEN 3 THEN 'registered'
      WHEN 4 THEN 'listed_book'
      ELSE 'unknown'
    END AS max_stage,
    pv.last_seen,
    pv.parent_id,
    pv.society_id,
    s.name AS society_name,
    pv.event_count
  FROM per_visitor pv
  LEFT JOIN public.societies s ON s.id = pv.society_id
  WHERE public.is_admin()
  ORDER BY pv.last_seen DESC;
$$;

GRANT EXECUTE ON FUNCTION public.admin_funnel_visitors()
  TO anon, authenticated;
