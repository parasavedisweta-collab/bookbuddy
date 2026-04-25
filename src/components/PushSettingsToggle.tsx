/**
 * PushSettingsToggle — the always-available push on/off control. Lives
 * on the Profile page; the inline post-action nudge handles first-time
 * onboarding, this is for users who want to revisit the choice.
 *
 * Shows different copy + behaviour depending on getPushState():
 *   - unsupported          : "Notifications aren't available on this browser"
 *   - needs-pwa            : "Add BookBuddy to your home screen first" (iOS)
 *   - denied               : "Blocked — enable in your phone's settings"
 *   - default              : "Off" toggle, tapping enables
 *   - granted-not-subscribed: "Off" toggle, tapping enables
 *   - granted-subscribed   : "On" toggle, tapping disables
 *
 * The toggle is the OS-permission state (denied is permanent in JS), so
 * for "denied" we render an inert message rather than a misleading switch
 * that does nothing when tapped.
 */
"use client";

import { useEffect, useState } from "react";
import {
  getPushState,
  subscribeToPush,
  unsubscribeFromPush,
  type PushState,
} from "@/lib/push";

export default function PushSettingsToggle() {
  const [state, setState] = useState<PushState | null>(null);
  const [working, setWorking] = useState(false);

  async function refresh() {
    setState(await getPushState());
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (state === null) {
    // First paint — render a placeholder so the row doesn't pop into
    // existence after the async check.
    return (
      <div className="bg-surface-container-low p-4 rounded-xl flex items-center gap-3">
        <span className="material-symbols-outlined text-on-surface-variant">
          notifications
        </span>
        <p className="text-sm text-on-surface-variant flex-1">Loading…</p>
      </div>
    );
  }

  if (state === "unsupported") {
    return (
      <div className="bg-surface-container-low p-4 rounded-xl flex items-center gap-3">
        <span className="material-symbols-outlined text-on-surface-variant">
          notifications_off
        </span>
        <p className="text-sm text-on-surface-variant flex-1 leading-snug">
          Notifications aren&apos;t supported on this browser.
        </p>
      </div>
    );
  }

  if (state === "needs-pwa") {
    return (
      <div className="bg-surface-container-low p-4 rounded-xl flex items-start gap-3">
        <span className="material-symbols-outlined text-on-surface-variant mt-0.5">
          install_mobile
        </span>
        <div className="flex-1 leading-snug">
          <p className="text-sm font-bold text-on-surface">
            Add to Home Screen first
          </p>
          <p className="text-xs text-on-surface-variant mt-1">
            On iPhone, tap <b>Share → Add to Home Screen</b>, then open
            BookBuddy from there to enable notifications.
          </p>
        </div>
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div className="bg-surface-container-low p-4 rounded-xl flex items-start gap-3">
        <span className="material-symbols-outlined text-error mt-0.5">
          notifications_off
        </span>
        <div className="flex-1 leading-snug">
          <p className="text-sm font-bold text-on-surface">
            Notifications blocked
          </p>
          <p className="text-xs text-on-surface-variant mt-1">
            You previously declined. Re-enable from your phone&apos;s
            Settings → BookBuddy → Notifications.
          </p>
        </div>
      </div>
    );
  }

  const isOn = state === "granted-subscribed";

  async function toggle() {
    setWorking(true);
    if (isOn) {
      await unsubscribeFromPush();
    } else {
      await subscribeToPush();
    }
    await refresh();
    setWorking(false);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={working}
      className="w-full bg-surface-container-low p-4 rounded-xl flex items-center gap-3 hover:bg-surface-container transition-colors disabled:opacity-60"
    >
      <span
        className={`material-symbols-outlined ${isOn ? "text-primary" : "text-on-surface-variant"}`}
        style={{ fontVariationSettings: isOn ? "'FILL' 1" : undefined }}
      >
        {isOn ? "notifications_active" : "notifications"}
      </span>
      <div className="flex-1 text-left leading-snug">
        <p className="text-sm font-bold text-on-surface">
          Push notifications
        </p>
        <p className="text-xs text-on-surface-variant mt-0.5">
          {isOn
            ? "On — we'll notify you about borrow requests and replies."
            : "Off — turn on to get notified about borrow requests."}
        </p>
      </div>
      {/* Visual switch — purely decorative, real toggle is the button itself. */}
      <span
        className={`shrink-0 w-10 h-6 rounded-full p-0.5 flex ${isOn ? "bg-primary justify-end" : "bg-outline-variant/40 justify-start"} transition-colors`}
      >
        <span className="w-5 h-5 bg-white rounded-full shadow-sm" />
      </span>
    </button>
  );
}
