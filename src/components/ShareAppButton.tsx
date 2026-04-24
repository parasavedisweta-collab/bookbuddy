"use client";

import { useState } from "react";

/**
 * Share the BookBuddy app link with friends / society members.
 *
 * Platform behaviour:
 *   - Modern mobile + most desktops: `navigator.share` opens the OS share
 *     sheet (WhatsApp, Messages, Mail, etc.).
 *   - Older browsers / no `share` API: copies the link to the clipboard
 *     and shows a brief "Link copied!" toast.
 *   - If even clipboard access fails (permissions, insecure context),
 *     we fall back to window.prompt() so the user can copy manually.
 *
 * Two visual variants:
 *   - "default": compact outline button, for Profile's Actions list.
 *   - "prominent": full-bleed gradient card with headline copy, for
 *     first-in-society placements (register success, home banner).
 *
 * The URL is derived from NEXT_PUBLIC_APP_URL when set (lets us point
 * to production from a UAT build, or share a custom domain) and falls
 * back to window.location.origin otherwise.
 */
export default function ShareAppButton({
  variant = "default",
  headline,
  subhead,
}: {
  variant?: "default" | "prominent";
  /** Override the card headline (prominent variant only). */
  headline?: string;
  /** Override the card subhead (prominent variant only). */
  subhead?: string;
}) {
  const [toast, setToast] = useState<string | null>(null);

  async function handleShare() {
    const url =
      process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin : "");
    const title = "BookBuddy";
    const text =
      "Share books with kids in your society on BookBuddy 📚 — list one, borrow many!";

    // Native share sheet path.
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (err) {
        // AbortError = user dismissed the sheet; silently bail. Anything
        // else falls through to the clipboard path.
        if ((err as { name?: string })?.name === "AbortError") return;
        console.warn("[share] navigator.share failed, falling back:", err);
      }
    }

    // Clipboard fallback.
    const shareText = `${text}\n${url}`;
    try {
      await navigator.clipboard.writeText(shareText);
      showToast("Link copied! Paste it in your group chat.");
      return;
    } catch (err) {
      console.warn("[share] clipboard.writeText failed:", err);
    }

    // Last-resort: blocking prompt so the user can select-all and copy.
    if (typeof window !== "undefined") {
      window.prompt("Copy this link and share it with your society:", shareText);
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  if (variant === "prominent") {
    return (
      <>
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#a7fc46] to-[#417000] p-5 shadow-[0_8px_32px_rgba(65,112,0,0.18)]">
          <div className="relative z-10 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span
                className="material-symbols-outlined text-white text-xl"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                group_add
              </span>
              <h3 className="font-headline font-extrabold text-white text-lg leading-tight">
                {headline ?? "You're first in your society!"}
              </h3>
            </div>
            <p className="text-white/90 text-sm leading-snug">
              {subhead ??
                "Invite neighbours so there are books to borrow. Share the app in your society WhatsApp group."}
            </p>
            <button
              onClick={handleShare}
              className="mt-1 self-start flex items-center gap-2 bg-white/95 hover:bg-white text-primary font-bold text-sm px-4 py-2.5 rounded-full shadow-sm active:scale-95 transition-transform"
            >
              <span className="material-symbols-outlined text-base">share</span>
              Share BookBuddy
            </button>
          </div>
          {/* Decorative corner blob */}
          <div className="absolute -bottom-6 -right-6 w-28 h-28 bg-white/10 rounded-full blur-2xl pointer-events-none" />
        </div>
        {toast && <Toast message={toast} />}
      </>
    );
  }

  // Default: outline button, matches Button's outline styling.
  return (
    <>
      <button
        onClick={handleShare}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-full border-2 border-primary/30 text-primary font-bold text-sm active:scale-[0.98] transition-transform"
      >
        <span className="material-symbols-outlined text-lg">share</span>
        Invite friends to BookBuddy
      </button>
      {toast && <Toast message={toast} />}
    </>
  );
}

/**
 * Minimal toast. Rendered inline inside a portal-less container — the
 * caller positions it via fixed positioning so it overlays whatever
 * screen the button sits on.
 */
function Toast({ message }: { message: string }) {
  return (
    <div className="fixed inset-x-0 bottom-24 z-50 flex justify-center pointer-events-none">
      <div className="bg-on-surface/95 text-surface px-5 py-2.5 rounded-full text-sm font-bold shadow-xl flex items-center gap-2">
        <span className="material-symbols-outlined text-base">check_circle</span>
        {message}
      </div>
    </div>
  );
}
