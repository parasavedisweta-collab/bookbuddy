-- =====================================================================
-- 0011 — home_bootstrap() SECURITY DEFINER RPC
--
-- The home page used to fire 4 separate Supabase queries on mount:
--   1. resolveCurrentSocietyId()    — parents row for auth.uid()
--   2. listChildrenForCurrentParent — my children
--   3. fetchSocietyFeed              — books in my society with lister
--   4. fetchMyRequests               — borrow requests I'm involved in
--   (plus isAloneInSociety, which re-fetched parent + children-in-society)
--
-- On laptop wifi those parallel calls are invisible (~50ms RTT × 1
-- TLS handshake each). On mobile 4G with 250–500ms RTT each
-- handshake adds up — the home grid took 5–10s to appear and books
-- listed from other devices trickled in last.
--
-- This RPC returns everything the home page needs in a SINGLE round
-- trip, shaped to match the existing client mappers (mapFeedRowToBook,
-- mapRequestRow) so the page-level code change is just "swap N fetches
-- for one RPC call".
--
-- Security: SECURITY DEFINER bypasses RLS — every CTE/subquery
-- explicitly scopes to auth.uid() or to the parent's society. No data
-- leaks across users.
--
-- Run via: Supabase Dashboard → SQL Editor on UAT first, then prod.
-- Idempotent (CREATE OR REPLACE / GRANT).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.home_bootstrap()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH
    me AS (
      SELECT auth.uid() AS uid
    ),
    p AS (
      SELECT pa.id, pa.society_id, pa.phone, pa.name
      FROM public.parents pa, me
      WHERE pa.id = me.uid
    ),
    my_children AS (
      SELECT c.id, c.parent_id, c.name, c.emoji, c.society_id,
             c.bookbuddy_id, c.created_at
      FROM public.children c, me
      WHERE c.parent_id = me.uid
    ),
    feed AS (
      -- Same shape as DbBookWithListerContext (books.ts) so
      -- mapFeedRowToBook on the client works without changes.
      SELECT
        b.id, b.child_id, b.title, b.author, b.isbn, b.description,
        b.category, b.cover_url,
        b.cover_source::text AS cover_source,
        b.status::text       AS status,
        b.listed_at, b.metadata,
        jsonb_build_object(
          'id',         c.id,
          'name',       c.name,
          'emoji',      c.emoji,
          'society_id', c.society_id,
          'parent_id',  c.parent_id
        ) AS child
      FROM public.books b
      JOIN public.children c ON c.id = b.child_id
      WHERE c.society_id = (SELECT society_id FROM p)
        AND b.status <> 'removed'
      ORDER BY b.listed_at DESC
    ),
    requests AS (
      -- Same shape as DbRequestWithContext (requests.ts) so
      -- mapRequestRow works unchanged.
      SELECT
        br.id, br.book_id, br.borrower_child_id, br.lister_child_id,
        br.status, br.requested_at, br.responded_at, br.picked_up_at,
        br.due_date, br.returned_at, br.return_confirmed_at,
        CASE WHEN bk.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id',           bk.id,
          'child_id',     bk.child_id,
          'title',        bk.title,
          'author',       bk.author,
          'isbn',         bk.isbn,
          'description',  bk.description,
          'category',     bk.category,
          'cover_url',    bk.cover_url,
          'cover_source', bk.cover_source::text,
          'status',       bk.status::text,
          'listed_at',    bk.listed_at,
          'metadata',     bk.metadata
        ) END AS book,
        CASE WHEN bc.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id',           bc.id,
          'parent_id',    bc.parent_id,
          'name',         bc.name,
          'emoji',        bc.emoji,
          'society_id',   bc.society_id,
          'bookbuddy_id', bc.bookbuddy_id,
          'created_at',   bc.created_at
        ) END AS borrower_child,
        CASE WHEN lc.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id',           lc.id,
          'parent_id',    lc.parent_id,
          'name',         lc.name,
          'emoji',        lc.emoji,
          'society_id',   lc.society_id,
          'bookbuddy_id', lc.bookbuddy_id,
          'created_at',   lc.created_at
        ) END AS lister_child
      FROM public.borrow_requests br
      LEFT JOIN public.books    bk ON bk.id = br.book_id
      LEFT JOIN public.children bc ON bc.id = br.borrower_child_id
      LEFT JOIN public.children lc ON lc.id = br.lister_child_id
      WHERE br.borrower_child_id IN (SELECT id FROM my_children)
         OR br.lister_child_id   IN (SELECT id FROM my_children)
      ORDER BY br.requested_at DESC
    )
  SELECT jsonb_build_object(
    -- parent: NULL when the user is signed in but hasn't completed
    -- registration (no parents row yet). Client treats null as
    -- "send to /auth/child-setup".
    'parent', COALESCE(
      (SELECT to_jsonb(p) FROM p),
      'null'::jsonb
    ),
    'children', COALESCE(
      (SELECT jsonb_agg(to_jsonb(my_children) ORDER BY my_children.created_at) FROM my_children),
      '[]'::jsonb
    ),
    'feed', COALESCE(
      (SELECT jsonb_agg(to_jsonb(feed)) FROM feed),
      '[]'::jsonb
    ),
    'requests', COALESCE(
      (SELECT jsonb_agg(to_jsonb(requests)) FROM requests),
      '[]'::jsonb
    ),
    -- is_alone: I'm alone in my society iff no OTHER parent has any
    -- children in it. Mirrors the existing isAloneInSociety helper:
    --   "alone" = nobody else, OR I'm the only one listed.
    'is_alone', COALESCE(
      (
        SELECT NOT EXISTS (
          SELECT 1
          FROM public.children oc
          WHERE oc.society_id = (SELECT society_id FROM p)
            AND oc.parent_id IS NOT NULL
            AND oc.parent_id <> (SELECT uid FROM me)
        )
        FROM p
      ),
      false
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.home_bootstrap() TO authenticated;
