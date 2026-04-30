"use client";

/**
 * Sign-in page — the entry point for unauthenticated users.
 *
 * Two paths:
 *   - "Continue with Google" → redirect to Google OAuth → back via
 *     /auth/callback. Always preferred when available.
 *   - "Sign in with email" → 6-digit code emailed → typed back here.
 *     Fallback for users without a Google account or who prefer not
 *     to grant Google profile access.
 *
 * After EITHER path succeeds, the auth listener in
 * SupabaseAuthBootstrap fires `bb_supabase_auth` and the callback
 * page (or this page, for OTP) routes the user onwards: home if
 * registration is complete, /auth/child-setup otherwise.
 *
 * This page replaces the old phone-entry register page. The previous
 * "phone is the credential" model couldn't authenticate the same
 * person across devices and offered effectively zero impersonation
 * resistance.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import {
  signInWithGoogle,
  sendEmailOtp,
  verifyEmailOtp,
} from "@/lib/supabase/auth";

type Mode = "choose" | "email-entry" | "code-entry";

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function handleGoogle() {
    setError(null);
    setLoading(true);
    const { error: err } = await signInWithGoogle();
    if (err) {
      setError(err);
      setLoading(false);
    }
    // On success the browser navigates away; no need to clear loading.
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    const { error: err } = await sendEmailOtp(email);
    setLoading(false);
    if (err) {
      setError(err);
      return;
    }
    setMode("code-entry");
    setInfo(`We sent a 6-digit code to ${email.trim().toLowerCase()}.`);
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: err } = await verifyEmailOtp(email, code);
    if (err) {
      setError(err);
      setLoading(false);
      return;
    }
    // Delegate routing + localStorage hydration to /auth/callback so the
    // email-OTP and Google paths share one finalisation flow. Without
    // this, returning users on a fresh device land with empty
    // localStorage and the profile/home pages render the default
    // "Reader" identity instead of their real name + society.
    router.replace("/auth/callback");
  }

  /**
   * Back button behaviour:
   *   - In "code-entry" mode, step back to "email-entry" so the user
   *     can correct the email rather than re-do the whole flow.
   *   - In "email-entry" mode, step back to "choose".
   *   - In "choose" mode, leave the page entirely. router.back() picks
   *     up wherever the user came from (/welcome on cold landing,
   *     /library after the peek-and-pick browse). When there's no
   *     history (direct paste of /auth/sign-in URL, or a second-tab
   *     situation) we fall back to /welcome rather than dumping them
   *     on a 404 or letting the back button no-op.
   */
  function handleBack() {
    if (mode === "code-entry") {
      setMode("email-entry");
      setError(null);
      setInfo(null);
      return;
    }
    if (mode === "email-entry") {
      setMode("choose");
      setError(null);
      setInfo(null);
      return;
    }
    // Mode === "choose"
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.replace("/welcome");
    }
  }

  return (
    <main className="relative flex-grow flex flex-col items-center justify-center px-6 max-w-lg mx-auto w-full py-12">
      {/* Back arrow — fixed to top-left so it doesn't fight with the
          centered hero content below. Adjusts behaviour by mode (see
          handleBack) so a partway-through OTP flow rewinds rather
          than dropping the user back at /welcome. */}
      <button
        type="button"
        onClick={handleBack}
        aria-label="Back"
        className="absolute top-4 left-4 w-10 h-10 inline-flex items-center justify-center rounded-full hover:bg-surface-container-low transition-colors"
      >
        <span className="material-symbols-outlined text-primary text-2xl">
          arrow_back
        </span>
      </button>

      {/* Logo */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-full bg-secondary-container flex items-center justify-center">
          <span className="material-symbols-outlined text-on-secondary-container">
            auto_stories
          </span>
        </div>
        <span className="text-primary font-headline font-extrabold text-2xl tracking-tight">
          BookBuds
        </span>
      </div>

      {/* Mascot */}
      <div className="w-32 h-32 rounded-2xl overflow-hidden shadow-md mb-8 shrink-0">
        <img
          src="/bookworm.png"
          alt="BookBuds worm reading"
          className="w-[200%] h-[200%] object-cover"
          style={{ objectPosition: "0% 0%" }}
        />
      </div>

      <div className="w-full space-y-6">
        {mode === "choose" && (
          <>
            <div className="space-y-2 text-center">
              <h1 className="text-on-surface font-headline font-bold text-3xl leading-tight tracking-tight">
                Sign in to BookBuds
              </h1>
              <p className="text-on-surface-variant text-base">
                Same account works on every device.
              </p>
            </div>

            <button
              onClick={handleGoogle}
              disabled={loading}
              className="w-full bg-white border-2 border-outline-variant/40 hover:border-primary/30 active:scale-95 transition-all rounded-xl py-4 px-6 flex items-center justify-center gap-3 font-headline font-bold text-on-surface disabled:opacity-50"
            >
              {/* Google "G" — inline SVG so we don't need an extra asset */}
              <svg width="22" height="22" viewBox="0 0 48 48" aria-hidden>
                <path
                  fill="#FFC107"
                  d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
                />
                <path
                  fill="#FF3D00"
                  d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"
                />
                <path
                  fill="#4CAF50"
                  d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.5 2.4-7.2 2.4-5.3 0-9.7-3.4-11.3-8L6.2 33C9.5 39.5 16.2 44 24 44z"
                />
                <path
                  fill="#1976D2"
                  d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2c-.4.4 6.6-4.8 6.6-14.7 0-1.3-.1-2.4-.4-3.5z"
                />
              </svg>
              {loading && mode === "choose"
                ? "Redirecting…"
                : "Continue with Google"}
            </button>

            <div className="flex items-center gap-3">
              <span className="flex-1 h-px bg-outline-variant/40" />
              <span className="text-xs text-on-surface-variant uppercase tracking-wider font-bold">
                or
              </span>
              <span className="flex-1 h-px bg-outline-variant/40" />
            </div>

            <Button
              variant="outline"
              fullWidth
              onClick={() => {
                setError(null);
                setMode("email-entry");
              }}
            >
              <span className="material-symbols-outlined">mail</span>
              Sign in with email
            </Button>
          </>
        )}

        {mode === "email-entry" && (
          <form onSubmit={handleSendCode} className="space-y-5">
            <div className="space-y-2">
              <h1 className="text-on-surface font-headline font-bold text-2xl leading-tight">
                Enter your email
              </h1>
              <p className="text-on-surface-variant text-sm">
                We&apos;ll send you a 6-digit code.
              </p>
            </div>
            <Input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
            <Button type="submit" fullWidth disabled={loading || !email.trim()}>
              {loading ? "Sending…" : "Send code"}
              <span className="material-symbols-outlined">arrow_forward</span>
            </Button>
            <button
              type="button"
              onClick={() => {
                setMode("choose");
                setError(null);
              }}
              className="w-full text-sm text-on-surface-variant hover:text-on-surface"
            >
              ← Back
            </button>
          </form>
        )}

        {mode === "code-entry" && (
          <form onSubmit={handleVerifyCode} className="space-y-5">
            <div className="space-y-2">
              <h1 className="text-on-surface font-headline font-bold text-2xl leading-tight">
                Enter the code
              </h1>
              {info && (
                <p className="text-on-surface-variant text-sm">{info}</p>
              )}
            </div>
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              autoFocus
              required
              className="text-2xl tracking-[0.5em] text-center font-bold"
            />
            <Button
              type="submit"
              fullWidth
              disabled={loading || code.length !== 6}
            >
              {loading ? "Verifying…" : "Verify"}
              <span className="material-symbols-outlined">arrow_forward</span>
            </Button>
            <button
              type="button"
              onClick={() => {
                setMode("email-entry");
                setCode("");
                setError(null);
                setInfo(null);
              }}
              className="w-full text-sm text-on-surface-variant hover:text-on-surface"
            >
              ← Use a different email
            </button>
          </form>
        )}

        {error && (
          <div
            role="alert"
            className="bg-error-container/40 border border-error/30 rounded-xl p-4 text-sm text-on-error-container leading-snug"
          >
            {error}
          </div>
        )}
      </div>
    </main>
  );
}
