/**
 * PushPermissionNudge — contextual ask for notification permission at a
 * meaningful moment (e.g. right after a borrow request is sent: "we'll
 * tell you the moment they reply").
 *
 * Why a custom nudge instead of just calling Notification.requestPermission
 * directly: browsers throttle the OS-level prompt aggressively (Chrome
 * is now "quiet" on most denied origins). A soft in-app pre-prompt lets
 * the user opt out without burning the OS-level ask, which we can only
 * fire once and would otherwise be wasted on people who don't actually
 * want it.
 *
 * State machine:
 *   - hidden                : nothing renders (unsupported, denied,
 *                             already-subscribed, dismissed within 7d)
 *   - visible (default)     : "Enable notifications" + "Not now"
 *   - visible (needs-pwa)   : "Add to Home Screen first" CTA — iOS only
 *   - visible (denied)      : nothing (re-ask is futile, OS-level only)
 *
 * Re-ask cadence: 7 days after dismiss. Same window as A2HS so we don't
 * pester users with two prompts at once on different schedules.
 */
"use client";

import { useEffect, useState } from "react";
import { getPushState, subscribeToPush, type PushState } from "@/lib/push";

const DISMISS_KEY = "bb_push_nudge_dismissed_at";
const REASK_DAYS = 7;

interface Props {
  /** Headline shown above the CTA. Caller-controlled because the moment
   *  matters: "We'll tell you when Sandy replies" is more compelling
   *  than a generic "Enable notifications". */
  headline: string;
  /** Sub-line under the headline. Optional. */
  subhead?: string;
}

function dismissedRecently(): boolean {
  if (typeof window === "undefined") return false;
  const at = localStorage.getItem(DISMISS_KEY);
  if (!at) return false;
  const ts = parseInt(at, 10);
  if (!Number.isFinite(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs < REASK_DAYS * 24 * 60 * 60 * 1000;
}

export default function PushPermissionNudge({ headline, subhead }: Props) {
  const [state, setState] = useState<PushState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (dismissedRecently()) {
      setDismissed(true);
      return;
    }
    let cancelled = false;
    void getPushState().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed) return null;
  if (state === null) return null; // still loading
  if (state === "unsupported") return null; // pointless on this browser
  if (state === "denied") return null; // OS-level, can't recover via JS
  if (state === "granted-subscribed") return null; // already on
  // "needs-pwa" still renders — we tell iOS users to add to home screen.

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, Date.now().toString());
    setDismissed(true);
  }

  async function enable() {
    setWorking(true);
    const ok = await subscribeToPush();
    setWorking(false);
    if (ok) {
      // Subscribed — collapse the nudge, don't write the dismiss key
      // (state will read as granted-subscribed on the next mount).
      setDismissed(true);
    }
    // If !ok, leave the nudge up so the user can retry. subscribeToPush
    // already console.errors the failure reason for diagnostics.
  }

  // iOS-not-installed branch: we can't subscribe, so route to A2HS.
  if (state === "needs-pwa") {
    return (
      <div className="bg-secondary-container/40 border border-secondary/30 rounded-xl p-4 flex items-start gap-3">
        <span
          className="material-symbols-outlined text-secondary text-2xl shrink-0 mt-0.5"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          install_mobile
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-headline font-bold text-on-surface text-sm leading-snug">
            {headline}
          </p>
          <p className="text-xs text-on-surface-variant mt-1 leading-snug">
            On iPhone, tap <b>Share → Add to Home Screen</b> first. Open the
            app from there and we&apos;ll be able to notify you.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="text-xs font-bold text-on-surface-variant shrink-0 px-2 py-1"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="bg-primary-container/40 border border-primary/30 rounded-xl p-4 flex items-start gap-3">
      <span
        className="material-symbols-outlined text-primary text-2xl shrink-0 mt-0.5"
        style={{ fontVariationSettings: "'FILL' 1" }}
      >
        notifications_active
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-headline font-bold text-on-surface text-sm leading-snug">
          {headline}
        </p>
        {subhead && (
          <p className="text-xs text-on-surface-variant mt-1 leading-snug">
            {subhead}
          </p>
        )}
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={enable}
            disabled={working}
            className="bg-primary text-on-primary font-bold text-xs px-4 py-2 rounded-full disabled:opacity-50"
          >
            {working ? "Enabling…" : "Enable notifications"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            disabled={working}
            className="text-on-surface-variant font-bold text-xs px-3 py-2"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
