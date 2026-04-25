/**
 * Web push subscription helpers.
 *
 * The full pipeline:
 *   1. registerServiceWorker() — registers /sw.js. Idempotent.
 *   2. subscribeToPush() — asks for permission (if not yet decided),
 *      calls swReg.pushManager.subscribe(), and stores the resulting
 *      endpoint+keys in Supabase via UPSERT-on-endpoint.
 *   3. unsubscribeFromPush() — reverse: cancels the browser subscription
 *      and deletes the row in Supabase.
 *   4. getPushState() — returns the current state ("unsupported" |
 *      "needs-pwa" | "denied" | "granted-subscribed" |
 *      "granted-not-subscribed" | "default") so the Profile toggle and
 *      first-action prompt can render the right UI without each calling
 *      half-a-dozen browser APIs themselves.
 *
 * Platform reality:
 *   - Chrome/Android: works in a regular browser tab. Permission ask
 *     can happen any time the user makes a meaningful gesture.
 *   - Safari/iOS: web push only works if the PWA is added to the home
 *     screen AND opened from there. We surface this as the "needs-pwa"
 *     state so the UI can route the user to the A2HS instructions
 *     instead of asking for permission that won't deliver.
 *   - Desktop Safari/Firefox: works but our user base is mobile-first,
 *     so we treat them like any other supported browser.
 */
"use client";

import { getSupabase } from "./supabase/client";

// VAPID public key — must match the private key the Edge Function uses.
// Distributed to clients by being NEXT_PUBLIC_*; server keeps the private
// half. Generate the pair once via `npx web-push generate-vapid-keys`
// (see PUSH_SETUP.md).
const VAPID_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export type PushState =
  | "unsupported" // browser doesn't support push at all (e.g. desktop Safari ancient version)
  | "needs-pwa" // iOS, not running in standalone mode
  | "denied" // user previously said no — they have to flip OS-level setting to recover
  | "default" // never asked
  | "granted-not-subscribed" // permission yes, but no active subscription (rare; usually after manual unsubscribe)
  | "granted-subscribed"; // fully wired up

/**
 * Convert the URL-safe-base64 VAPID key the spec hands us into the
 * Uint8Array PushManager.subscribe() expects. Stock Chrome rejects the
 * string form, even though most tutorials show it that way.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Crypto subscription object → JSON-safe shape for Supabase storage. */
function subscriptionToRow(sub: PushSubscription) {
  const json = sub.toJSON();
  // toJSON's typing is loose — narrow to what we actually store.
  return {
    endpoint: json.endpoint!,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
  };
}

/** True if running as an installed PWA (standalone display mode). */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS-only legacy property.
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone;
  if (iosStandalone === true) return true;
  return window.matchMedia("(display-mode: standalone)").matches;
}

/** True if the platform fundamentally supports the push pipeline. */
function isPushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Best-effort iOS detection for the "needs-pwa" gate. */
function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPad on iOS 13+ identifies as MacIntel + touch.
  const isIpad =
    /MacIntel/.test(navigator.platform) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || isIpad;
}

/**
 * Register /sw.js. Returns the registration so callers can chain
 * .pushManager operations on it. Idempotent — repeated calls return
 * the existing registration without re-installing.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      // Force network revalidation of the SW file on each navigation.
      // Without this, browsers can serve a stale SW for 24h after a
      // deploy and users miss notification UX changes.
      updateViaCache: "none",
    });
    return reg;
  } catch (err) {
    console.error("[push] service worker registration failed:", err);
    return null;
  }
}

/**
 * Top-level "what should I show on the toggle?" query. Single source
 * of truth — every UI surface should call this rather than poking at
 * Notification.permission / pushManager directly.
 */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  if (isIos() && !isStandalone()) return "needs-pwa";

  const perm = Notification.permission;
  if (perm === "denied") return "denied";
  if (perm === "default") return "default";

  // permission === "granted" — check for an actual active subscription.
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg) return "granted-not-subscribed";
  const sub = await reg.pushManager.getSubscription();
  return sub ? "granted-subscribed" : "granted-not-subscribed";
}

/**
 * The full subscribe pipeline. Call this from a user gesture (button tap)
 * — Notification.requestPermission must be inside a user-activated event
 * on most browsers, otherwise it silently fails or shows nothing.
 *
 * Returns true on success, false if the user denied or the browser
 * couldn't complete the handshake. On failure we leave any partial
 * state in place — the next call retries from wherever we got to.
 */
export async function subscribeToPush(): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY) {
    console.error(
      "[push] NEXT_PUBLIC_VAPID_PUBLIC_KEY missing — cannot subscribe. See PUSH_SETUP.md."
    );
    return false;
  }
  if (!isPushSupported()) return false;
  if (isIos() && !isStandalone()) {
    // Subscribing in regular Safari succeeds but iOS swallows the
    // notification. Don't waste the user's permission slot.
    return false;
  }

  const reg = await registerServiceWorker();
  if (!reg) return false;

  // Ask. If the user tapped the toggle, they've already opted in
  // emotionally — but the OS-level permission is still required.
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return false;

  // If a subscription already exists (old session left it hanging), reuse
  // the same endpoint — the UPSERT below patches keys in place.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast: TS lib.dom narrows applicationServerKey to ArrayBufferView
        // with a non-shared ArrayBuffer, but Uint8Array carries the wider
        // ArrayBufferLike. Runtime accepts Uint8Array fine — the spec was
        // updated, the .d.ts hasn't caught up.
        applicationServerKey: urlBase64ToUint8Array(
          VAPID_PUBLIC_KEY
        ) as unknown as BufferSource,
      });
    } catch (err) {
      console.error("[push] pushManager.subscribe failed:", err);
      return false;
    }
  }

  const row = subscriptionToRow(sub);
  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user?.id;
  if (!uid) {
    // No parent row to attach to. Drop the browser subscription so we
    // don't strand a dead endpoint — the user can re-subscribe after
    // registration.
    await sub.unsubscribe();
    console.warn("[push] no session; aborting subscribe");
    return false;
  }

  // UPSERT on endpoint — same browser hands back the same endpoint on
  // repeat subscribe, and we want one row per (browser, parent) not a
  // pile of dupes.
  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(
      {
        parent_id: uid,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        user_agent:
          typeof navigator !== "undefined"
            ? navigator.userAgent.slice(0, 256)
            : null,
      },
      { onConflict: "endpoint" }
    );

  if (error) {
    console.error("[push] supabase upsert failed:", error);
    // Leave the browser subscription in place — we'll retry on next
    // attempt. Removing it would force a permission re-prompt, which
    // most browsers throttle aggressively.
    return false;
  }

  return true;
}

/**
 * Reverse of subscribeToPush. Cancels at the browser level AND deletes
 * the Supabase row so the Edge Function stops trying to push to a dead
 * endpoint (which would otherwise throw 410 Gone forever).
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg) return true; // nothing to do

  const sub = await reg.pushManager.getSubscription();
  if (!sub) return true; // already unsubscribed at browser level

  const endpoint = sub.endpoint;
  const ok = await sub.unsubscribe();
  if (!ok) {
    console.warn("[push] browser-side unsubscribe returned false");
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint);
  if (error) {
    console.error("[push] supabase delete failed:", error);
    return false;
  }
  return true;
}
