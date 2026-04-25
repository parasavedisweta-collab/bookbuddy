/**
 * BookBuddy service worker.
 *
 * Scope: this file lives at /sw.js (the site root) so it controls the
 * entire origin. We deliberately do NOT cache any pages — Next.js handles
 * its own caching, and a stale shell would be much worse than a network
 * request. The only reason this SW exists is to receive push events.
 *
 * Lifecycle:
 *   - install: skipWaiting so a new SW takes over on the next page load
 *     instead of waiting for every tab to close.
 *   - activate: claim() so the SW controls already-open pages immediately
 *     (otherwise the first open tab won't have a controller until refresh).
 *   - push: render the notification using the JSON payload from the Edge
 *     Function. We always pass JSON, not a string, so we can ship the
 *     deep-link URL alongside the title and body.
 *   - notificationclick: focus an existing BookBuddy tab if one is open
 *     and navigate it; otherwise open a new tab to the deep-linked URL.
 *
 * Payload contract (must match the Edge Function in supabase/functions/
 * send-push-notification):
 *   { title: string, body: string, url?: string, tag?: string }
 *
 * Notes:
 *   - iOS only delivers push to PWAs added to the home screen. The
 *     subscription will succeed in regular Safari but the OS swallows
 *     the notification. We feature-detect installed-PWA on the client
 *     before even showing the permission prompt.
 *   - tag dedups overlapping notifications (e.g. multiple status updates
 *     for the same borrow request collapse into one banner).
 */

self.addEventListener("install", (event) => {
  // Take over from the previous SW immediately so users on a cold cache
  // see the new push handler without having to close every tab first.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // Claim already-open pages so they start receiving messages from this
  // worker without a manual reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // Defensive: a malformed or empty push (some platforms wake the SW
  // with no payload to keep subscriptions warm) shouldn't crash the
  // event handler. If we can't parse, fall back to a generic banner —
  // dropping the notification entirely would be worse UX than a vague
  // "you have an update" message.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    console.warn("[sw] push payload not JSON", err);
  }

  const title = payload.title || "BookBuddy";
  const body = payload.body || "You have a new update.";
  const url = payload.url || "/";
  const tag = payload.tag || undefined;

  const options = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag,
    data: { url },
    // renotify only matters when tag is set — when it is, we DO want
    // the user to feel a fresh buzz/sound even though it replaces the
    // old banner. Otherwise an "approved" update silently overwriting
    // the original "requested" notification would be invisible.
    renotify: Boolean(tag),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Prefer to focus an already-open BookBuddy tab and navigate it,
      // rather than spawning yet another tab. Match by origin so we don't
      // fight any unrelated PWA the user might have open.
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin) {
            await client.focus();
            // navigate() is the right API here; older code used
            // postMessage but that requires the page to be listening.
            if ("navigate" in client) {
              await client.navigate(targetUrl);
            }
            return;
          }
        } catch {
          // bad URL; skip.
        }
      }

      // No existing tab — open a fresh one at the deep link.
      await self.clients.openWindow(targetUrl);
    })()
  );
});
