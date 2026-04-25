"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Persistent "Add to Home Screen" nudge.
 *
 * Two platform-specific flows:
 *   - Android / Chromium: listen for the `beforeinstallprompt` event, cache
 *     it, and fire `prompt()` on tap so the OS shows its native install
 *     sheet. Once the user accepts (`userChoice.outcome === "accepted"`) we
 *     hide the nudge permanently.
 *   - iOS Safari: no programmatic install API exists. We detect iOS via
 *     the user-agent plus the absence of `standalone` and render manual
 *     instructions ("tap the Share icon, then Add to Home Screen").
 *
 * Hidden entirely when:
 *   - The app is already running standalone (`matchMedia('(display-mode:
 *     standalone)')` or `window.navigator.standalone` on iOS).
 *   - The user dismissed less than 7 days ago — we store the dismissal
 *     timestamp in localStorage and re-check on every mount.
 *   - The current route is under /auth — the register flow is fragile
 *     enough without a modal-ish footer competing for attention.
 *
 * Positioned fixed above BottomNav (which is ~72px tall including safe
 * area). We use `bottom-20` + safe-area to stay clear on notched phones.
 *
 * Terminology note: the user explicitly vetoed "Install" — iOS calls it
 * "Add to Home Screen" and that's what we say everywhere.
 */

const DISMISS_KEY = "bb_a2hs_dismissed_at";
const DISMISS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Minimal shape of the `beforeinstallprompt` event. Not in lib.dom yet, so
// we type it ourselves rather than cast to `any`.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type Platform = "android" | "ios" | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  // iPad on iOS 13+ reports desktop Safari UA — the touch + platform
  // combination disambiguates.
  const isIPadOS =
    navigator.platform === "MacIntel" &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || isIPadOS) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS exposes a non-standard `standalone` boolean on navigator. Other
  // browsers rely on the display-mode media query.
  const iosStandalone = (
    window.navigator as unknown as { standalone?: boolean }
  ).standalone;
  if (iosStandalone) return true;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(display-mode: standalone)").matches;
  }
  return false;
}

function isDismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const ts = Number.parseInt(raw, 10);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < DISMISS_WINDOW_MS;
  } catch {
    return false;
  }
}

export default function AddToHomeScreenPrompt() {
  const pathname = usePathname();
  // `ready` gates the first render — SSR + hydration mismatch if we rendered
  // based on UA during server render, so we always start hidden and reveal
  // after the mount-time checks run.
  const [ready, setReady] = useState(false);
  const [platform, setPlatform] = useState<Platform>("other");
  const [show, setShow] = useState(false);
  const [showIosInstructions, setShowIosInstructions] = useState(false);
  // Cached Android install prompt. Stored in state (not a ref) so changes to
  // its availability re-render the CTA — the button is disabled until we
  // actually have an event to fire.
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    setReady(true);
    const plat = detectPlatform();
    setPlatform(plat);

    // Hard exits: already installed, recently dismissed, or not a
    // supported platform.
    if (isStandalone()) return;
    if (isDismissedRecently()) return;

    if (plat === "ios") {
      // iOS always shows manual instructions — there is no install API.
      setShow(true);
      return;
    }

    if (plat === "android") {
      // Android may or may not fire beforeinstallprompt. Chrome fires it
      // once PWA install criteria are met (manifest + SW + engagement
      // heuristic). If it never fires, we stay hidden — showing a button
      // that can't do anything is worse than showing nothing.
      const onPrompt = (e: Event) => {
        e.preventDefault();
        setDeferredPrompt(e as BeforeInstallPromptEvent);
        setShow(true);
      };
      const onInstalled = () => {
        setShow(false);
        setDeferredPrompt(null);
        // Treat "installed" as a permanent dismissal so we don't re-prompt
        // on the next visit if standalone detection flakes.
        try {
          localStorage.setItem(DISMISS_KEY, String(Date.now()));
        } catch {}
      };
      window.addEventListener(
        "beforeinstallprompt",
        onPrompt as EventListener
      );
      window.addEventListener("appinstalled", onInstalled);
      return () => {
        window.removeEventListener(
          "beforeinstallprompt",
          onPrompt as EventListener
        );
        window.removeEventListener("appinstalled", onInstalled);
      };
    }
  }, []);

  function handleAdd() {
    if (platform === "ios") {
      setShowIosInstructions(true);
      return;
    }
    if (platform === "android" && deferredPrompt) {
      // Fire the native sheet. We don't need to await before hiding the
      // bar — the OS sheet takes focus. We DO await userChoice so a
      // "dismissed" outcome re-opens the bar next week, while "accepted"
      // permanently hides it (the appinstalled listener will also fire).
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then((choice) => {
        if (choice.outcome === "accepted") {
          try {
            localStorage.setItem(DISMISS_KEY, String(Date.now()));
          } catch {}
        } else {
          // User tapped "Cancel" on the native sheet — treat as a regular
          // dismissal so we don't nag them again this week.
          handleDismiss();
        }
        setDeferredPrompt(null);
        setShow(false);
      });
    }
  }

  function handleDismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
    setShow(false);
    setShowIosInstructions(false);
  }

  // Hide on auth pages — matches BottomNav's rule, keeps the register
  // flow uncluttered.
  if (!ready) return null;
  if (pathname?.startsWith("/auth")) return null;
  if (!show) return null;

  return (
    <>
      {/* Bar sits above BottomNav. `bottom-20` ≈ nav height (80px) + a
          hair of breathing room; safe-area handles notched iPhones. */}
      <div
        className="fixed inset-x-0 z-40 px-3 pointer-events-none"
        style={{
          bottom: "calc(5rem + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {/* Tone-down note: the original used bg-primary-container (#a7fc46
            lime) which read as neon. Switched to a near-white surface with a
            soft deep-green border + a 5% deep-green wash to keep the brand
            identity without making the bar eye-watering. The Add button
            stays full-saturation primary so the CTA still pops. */}
        <div className="pointer-events-auto mx-auto max-w-2xl bg-surface-container-lowest border border-primary/30 rounded-2xl shadow-md p-3 flex items-center gap-3" style={{ backgroundImage: "linear-gradient(135deg, rgba(65,112,0,0.06), rgba(65,112,0,0.02))" }}>
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <span
              className="material-symbols-outlined text-primary text-xl"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              add_to_home_screen
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-headline font-bold text-on-surface text-sm leading-tight">
              Add BookBuddy to your home screen
            </p>
            <p className="text-on-surface-variant text-xs leading-snug mt-0.5">
              Opens full-screen, just like an app.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleAdd}
              disabled={platform === "android" && !deferredPrompt}
              className="flex-shrink-0 bg-primary text-white font-bold text-xs px-3 py-2 rounded-full shadow-sm active:scale-95 transition-transform disabled:opacity-60 disabled:cursor-not-allowed"
            >
              Add
            </button>
            <button
              onClick={handleDismiss}
              aria-label="Dismiss"
              className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-primary/10 active:scale-95 transition-transform"
            >
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>
        </div>
      </div>

      {/* iOS manual-instructions modal. Triggered when an iOS user taps
          "Add" — there's no programmatic install, so we walk them through
          the Safari Share → Add to Home Screen path. Tap backdrop or the
          Got it button to dismiss. */}
      {showIosInstructions && (
        <div
          className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center p-4"
          onClick={() => setShowIosInstructions(false)}
        >
          <div
            className="bg-surface rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center">
                <span
                  className="material-symbols-outlined text-primary"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  add_to_home_screen
                </span>
              </div>
              <h2 className="font-headline font-extrabold text-on-surface text-lg">
                Add to Home Screen
              </h2>
            </div>
            <ol className="space-y-3 text-sm text-on-surface">
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-container text-primary font-bold flex items-center justify-center text-xs">
                  1
                </span>
                <span className="leading-snug">
                  Tap the{" "}
                  <span className="material-symbols-outlined align-middle text-base mx-0.5">
                    ios_share
                  </span>{" "}
                  <b>Share</b> icon at the bottom of Safari.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-container text-primary font-bold flex items-center justify-center text-xs">
                  2
                </span>
                <span className="leading-snug">
                  Scroll down and tap <b>Add to Home Screen</b>.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-container text-primary font-bold flex items-center justify-center text-xs">
                  3
                </span>
                <span className="leading-snug">
                  Tap <b>Add</b> in the top-right corner — BookBuddy is now on
                  your home screen!
                </span>
              </li>
            </ol>
            <button
              onClick={() => setShowIosInstructions(false)}
              className="w-full py-3 rounded-full bg-primary text-white font-bold text-sm active:scale-95 transition-transform"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
