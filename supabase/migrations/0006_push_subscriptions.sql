-- =====================================================================
-- 0006 — Web push subscriptions
--
-- One row per (browser × device × parent) — i.e. if Sweta has
-- BookBuddy installed on her phone and her laptop, two rows. The
-- browser hands us an opaque endpoint URL + p256dh/auth crypto pair
-- when the user grants notification permission; we pass those to the
-- web-push library in the Edge Function to deliver a notification.
--
-- Endpoint is UNIQUE because the same browser will hand back the same
-- endpoint on a re-subscribe — we want an UPSERT on (endpoint), not a
-- duplicate row each time the user toggles notifications off-and-on.
--
-- Run via: Supabase Dashboard → SQL Editor.
-- Safe to re-run (CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     uuid NOT NULL REFERENCES public.parents(id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

-- The hot lookup is "every subscription for this parent" when the
-- Edge Function is about to push. Endpoint already has its own UNIQUE
-- index from the constraint.
CREATE INDEX IF NOT EXISTS push_subscriptions_parent_id_idx
  ON public.push_subscriptions (parent_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Drop-then-create makes the migration idempotent.
DROP POLICY IF EXISTS push_subscriptions_select_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_select_own
  ON public.push_subscriptions
  FOR SELECT TO authenticated
  USING (parent_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_insert_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_insert_own
  ON public.push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (parent_id = auth.uid());

-- UPDATE allowed so client can UPSERT (endpoint conflict → update the
-- p256dh/auth/user_agent on the existing row) without needing service role.
DROP POLICY IF EXISTS push_subscriptions_update_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_update_own
  ON public.push_subscriptions
  FOR UPDATE TO authenticated
  USING (parent_id = auth.uid())
  WITH CHECK (parent_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_delete_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_delete_own
  ON public.push_subscriptions
  FOR DELETE TO authenticated
  USING (parent_id = auth.uid());

-- The Edge Function reads this table with the service-role key, which
-- bypasses RLS entirely. No special policy needed for it.
