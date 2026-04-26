/**
 * Auth helpers — Google OAuth + email OTP fallback.
 *
 * Replaces the previous anonymous-auth + phone-as-credential model.
 * Both providers produce a Supabase auth.users row whose `id` becomes
 * `auth.uid()` for RLS, and whose `email` becomes the durable
 * cross-device identity.
 *
 * Flow:
 *   - Google: redirect-based OAuth. We hand off to Google, Google
 *     redirects to <supabase>/auth/v1/callback, Supabase redirects
 *     back to our `redirectTo` URL with a session in the URL hash.
 *     The client picks the session up via `detectSessionInUrl: true`.
 *
 *   - Email OTP: send a 6-digit code via Supabase's email provider,
 *     user types it back, we verify. No magic-link redirects — pure
 *     code-entry, which works smoothly on mobile keyboards.
 *
 * After EITHER flow succeeds, the caller checks `getCurrentParent()`
 * to decide whether the user is fully registered (parent row exists)
 * or needs to complete the registration step (society + phone +
 * child name).
 */
"use client";

import { getSupabase } from "./client";

/**
 * Where Supabase should redirect the browser back to after Google
 * finishes OAuth. We default to a dedicated `/auth/callback` route
 * that finalises the session and routes the user onwards.
 *
 * Must be present in BOTH:
 *   - Google Cloud Console → OAuth client → Authorized redirect URIs
 *     (technically Google redirects to Supabase's callback, then
 *     Supabase redirects here — but `<origin>/auth/callback` must be
 *     in Supabase's "Redirect URLs" allow list under URL Configuration)
 *   - Supabase Dashboard → Authentication → URL Configuration →
 *     Redirect URLs allow list
 */
function callbackUrl(): string {
  if (typeof window === "undefined") return "/auth/callback";
  return `${window.location.origin}/auth/callback`;
}

/**
 * Kick off the Google OAuth flow. Browser navigates away — this
 * function never resolves to a "logged in" state directly; the
 * session arrives on the redirect back, where /auth/callback picks
 * it up.
 */
export async function signInWithGoogle(): Promise<{ error: string | null }> {
  const supabase = getSupabase();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackUrl(),
      // Force the consent screen each time during testing so we can
      // verify scopes; remove or set to "select_account" later if it
      // becomes annoying.
      queryParams: {
        prompt: "select_account",
      },
    },
  });
  if (error) {
    console.error("[auth] signInWithGoogle failed:", error);
    return { error: error.message };
  }
  return { error: null };
}

/**
 * Send a 6-digit OTP to the user's email. Supabase mints + sends
 * the code via whatever SMTP is configured (built-in or custom).
 *
 * `shouldCreateUser: true` means a brand-new email creates an
 * auth.users row — exactly what we want for sign-up. The same
 * function works for returning users (Supabase recognises the
 * existing email and just sends a fresh code).
 */
export async function sendEmailOtp(
  email: string
): Promise<{ error: string | null }> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) {
    return { error: "Please enter a valid email address." };
  }

  const supabase = getSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email: trimmed,
    options: {
      shouldCreateUser: true,
      // No `emailRedirectTo` — we want the OTP code path, not the
      // magic-link path. Supabase's default email template includes
      // both; the user only needs to type the 6-digit code.
    },
  });
  if (error) {
    console.error("[auth] sendEmailOtp failed:", error);
    return { error: error.message };
  }
  return { error: null };
}

/**
 * Verify the 6-digit code the user typed. On success a session is
 * established; the SupabaseAuthBootstrap listener then fires
 * `bb_supabase_auth` and pages re-fetch.
 */
export async function verifyEmailOtp(
  email: string,
  code: string
): Promise<{ error: string | null }> {
  const trimmed = email.trim().toLowerCase();
  const cleanCode = code.replace(/\D/g, "");
  if (cleanCode.length !== 6) {
    return { error: "Please enter the 6-digit code from your email." };
  }

  const supabase = getSupabase();
  const { error } = await supabase.auth.verifyOtp({
    email: trimmed,
    token: cleanCode,
    type: "email",
  });
  if (error) {
    console.error("[auth] verifyEmailOtp failed:", error);
    return { error: error.message };
  }
  return { error: null };
}

/**
 * Tear down the session. We deliberately DON'T clear bb_* localStorage
 * keys here — the legacy demo data is still useful as a fallback feed
 * source, and the session itself living in localStorage is what matters
 * for "you are logged out."
 */
export async function signOut(): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("[auth] signOut failed:", error);
  }
}
