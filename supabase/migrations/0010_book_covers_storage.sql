-- =====================================================================
-- 0010 — book-covers Storage bucket + RLS
--
-- Until now, user-uploaded book photos lived as base64 in each lister's
-- localStorage with `books.cover_url = NULL` in Supabase. That meant
-- any non-lister (other society members AND the unauthenticated public
-- browse) saw the menu_book placeholder instead of the cover. The
-- /library browse for NRI Complex made this very visible.
--
-- This migration provisions the public bucket the listing flow uploads
-- to. Code path (src/app/book/list/page.tsx) compresses to ~800px JPEG
-- and writes the public URL into books.cover_url, so all readers
-- (anonymous public browse + authenticated home feed + admin) get the
-- cover for free via the same URL.
--
-- Why public-read instead of signed URLs?
--   - Covers are non-sensitive, browsed by unauthenticated visitors on
--     /library, and the public_list_books_for_society RPC already
--     returns the URL to anon callers. Signed URLs would force a
--     server round-trip per browse render.
--   - Edge CDN caches public objects; signed URLs do not.
--
-- Path convention: <auth_uid>/<random>.jpg
--   - Top-level segment is the uploader's auth.uid() so the write
--     policy can use storage.foldername(name)[1] = auth.uid()::text
--     without joining through children/parents.
--   - The file's UUID makes it unguessable enough that a leaked URL
--     doesn't enumerate the bucket.
--
-- Run via: Supabase Dashboard → SQL Editor on UAT first, then prod.
-- Idempotent (ON CONFLICT DO UPDATE on the bucket; CREATE POLICY is
-- guarded by a DROP IF EXISTS so re-running is safe).
-- =====================================================================

-- ── Bucket ─────────────────────────────────────────────────────────
-- Public read so the same URL works for anon browse, authenticated
-- feed, and admin without signing. file_size_limit caps a single
-- upload at 2 MB — the client already compresses to ~100 KB, so 2 MB
-- is a generous ceiling that still rejects unprocessed multi-MB
-- raw mobile photos if compression is somehow skipped.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'book-covers',
  'book-covers',
  true,
  2 * 1024 * 1024,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── RLS policies on storage.objects ───────────────────────────────

-- Public read. We deliberately do NOT scope this by auth — anon
-- visitors browsing /library must be able to load covers.
DROP POLICY IF EXISTS "book-covers public read" ON storage.objects;
CREATE POLICY "book-covers public read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'book-covers');

-- Authenticated users can upload, but only into a folder named after
-- their own auth.uid(). storage.foldername returns the path split on
-- '/', 1-indexed; [1] is the top-level directory.
DROP POLICY IF EXISTS "book-covers owner insert" ON storage.objects;
CREATE POLICY "book-covers owner insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'book-covers'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Same scoping for updates (e.g. re-listing the same book and
-- replacing its cover). Uncommon today but cheap to allow.
DROP POLICY IF EXISTS "book-covers owner update" ON storage.objects;
CREATE POLICY "book-covers owner update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'book-covers'
  AND (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'book-covers'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Owners can delete their own covers (e.g. via a future "remove book"
-- flow). Admins go through the service-role key, which bypasses RLS,
-- so they don't need a separate policy here.
DROP POLICY IF EXISTS "book-covers owner delete" ON storage.objects;
CREATE POLICY "book-covers owner delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'book-covers'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
