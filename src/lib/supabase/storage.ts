/**
 * Supabase Storage helpers — book cover uploads.
 *
 * Until 0010 user-uploaded covers lived as base64 in localStorage with
 * `books.cover_url = NULL`. Other readers (society members, the public
 * /library browse) saw the placeholder. This module uploads the photo
 * to the public `book-covers` bucket and returns a URL that goes
 * straight into `books.cover_url`, so every reader sees the same image
 * via a CDN-cached public URL.
 *
 * Path convention: <auth_uid>/<uuid>.jpg — see migration 0010 for the
 * RLS reasoning. The bucket policies require the top-level folder to
 * match the uploader's auth.uid().
 */
"use client";

import { getSupabase } from "./client";

const BUCKET = "book-covers";

/** Compression target: long-edge px and JPEG quality. Keeps covers
 * around 80–150 KB while still legible at the 3:4 grid card size used
 * across home / shelf / library. */
const MAX_DIMENSION = 800;
const JPEG_QUALITY = 0.8;

/**
 * Upload a user-photo cover to Supabase Storage and return the public
 * URL. Returns null on any failure — the caller is expected to fall
 * back to writing `cover_url=null` and keeping the base64 in
 * localStorage so the listing flow doesn't break for the lister.
 *
 * Accepts either a base64 data URL (what book/list/page.tsx currently
 * carries in state) or a Blob/File (for future call-sites that have
 * the original file).
 */
export async function uploadBookCover(
  source: string | Blob
): Promise<string | null> {
  if (typeof window === "undefined") return null;

  try {
    const supabase = getSupabase();

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) {
      console.warn("[storage] uploadBookCover: no session, skipping upload");
      return null;
    }

    // Compress regardless of input shape. Browser cameras hand back
    // 3–5 MB JPEGs; without this the bucket fills up fast and slow
    // networks would stall on upload.
    const compressed = await compressToJpeg(source);
    if (!compressed) return null;

    const filename = `${cryptoRandomId()}.jpg`;
    const path = `${userId}/${filename}`;

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, compressed, {
        contentType: "image/jpeg",
        cacheControl: "31536000", // 1 year — filename is unique per upload
        upsert: false,
      });
    if (uploadErr) {
      console.error("[storage] uploadBookCover failed:", uploadErr);
      return null;
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error("[storage] uploadBookCover threw:", err);
    return null;
  }
}

/**
 * Decode (if needed) and compress to a JPEG Blob ≤ 800 px on the long
 * edge. We always re-encode to JPEG even if the source is PNG/WebP —
 * the bucket only allows image/* types and JPEG-of-JPEG is what
 * mobile cameras hand us anyway.
 */
async function compressToJpeg(source: string | Blob): Promise<Blob | null> {
  const dataUrl =
    typeof source === "string" ? source : await blobToDataUrl(source);
  if (!dataUrl) return null;

  const img = await loadImage(dataUrl);
  if (!img) return null;

  const { width, height } = fitWithin(img.width, img.height, MAX_DIMENSION);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);

  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", JPEG_QUALITY);
  });
}

function fitWithin(
  w: number,
  h: number,
  max: number
): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = w >= h ? max / w : max / h;
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for very old browsers — non-cryptographic but uniqueness
  // is only required within one user's folder at one moment.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
