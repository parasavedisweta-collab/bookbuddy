// =====================================================================
// send-push-notification — Supabase Edge Function (Deno runtime)
//
// Triggered by a Database Webhook on public.borrow_requests:
//   - INSERT (new borrow request)        → push to the LISTER parent
//   - UPDATE where status changed        → push to the OTHER party
//
// Webhook config (set up in Supabase Dashboard → Database → Webhooks):
//   Name:     borrow_requests_push
//   Table:    borrow_requests
//   Events:   INSERT, UPDATE
//   Type:     Supabase Edge Functions
//   Edge fn:  send-push-notification
//   Method:   POST  (HTTP headers: Content-Type: application/json)
//
// The webhook posts a payload that looks like:
//   {
//     "type": "INSERT" | "UPDATE",
//     "table": "borrow_requests",
//     "record": { ...new row... },
//     "old_record": { ...row before change... } | null,
//     "schema": "public"
//   }
//
// Required Function secrets (Supabase Dashboard → Edge Functions →
// Settings → Add new secret):
//   VAPID_PUBLIC_KEY       — same key the client uses (NEXT_PUBLIC_…)
//   VAPID_PRIVATE_KEY      — paired private half, server-only
//   VAPID_SUBJECT          — mailto:you@example.com (web-push spec requires
//                            a contact URI; Apple/Mozilla will reject pushes
//                            without it)
//   SUPABASE_URL           — already auto-set by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — already auto-set, lets us read all push
//                            subscriptions across users (required because
//                            we're pushing to OTHER people, not the trigger
//                            actor)
//
// Deploy with:
//   supabase functions deploy send-push-notification --no-verify-jwt
//
// --no-verify-jwt is critical — webhook payloads come from the database
// itself and don't carry a JWT. The service-role key inside the function
// is what authenticates DB access.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

// ---------- Types -----------------------------------------------------

interface BorrowRequestRow {
  id: string;
  book_id: string;
  borrower_child_id: string;
  lister_child_id: string;
  status:
    | "pending"
    | "approved"
    | "declined"
    | "auto_declined"
    | "picked_up"
    | "returned"
    | "confirmed_return";
  requested_at: string;
  responded_at: string | null;
  picked_up_at: string | null;
  due_date: string | null;
  returned_at: string | null;
  return_confirmed_at: string | null;
}

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: BorrowRequestRow;
  old_record: BorrowRequestRow | null;
}

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// ---------- Boot ------------------------------------------------------

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:noreply@bookbuddy.app";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error(
    "[send-push] missing VAPID env vars. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in Edge Function secrets."
  );
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

// ---------- Notification copy -----------------------------------------

interface NotificationContent {
  /** Whose subscriptions we're pushing to. */
  recipientChildId: string;
  title: string;
  body: string;
  /** Deep link the SW will open / focus on click. */
  url: string;
  /** Dedup tag — multiple updates for the same request collapse into one banner. */
  tag: string;
}

/**
 * Translate a webhook payload to "who do we tell, what do we say."
 *
 * Returns null when the change doesn't warrant a notification (e.g. an
 * UPDATE where status didn't change, or a status transition the user
 * already knows about because they're the one who triggered it).
 */
function buildNotification(
  payload: WebhookPayload,
  bookTitle: string
): NotificationContent | null {
  const r = payload.record;

  if (payload.type === "INSERT") {
    // New borrow request → notify the LISTER. The borrower already knows
    // they just tapped Request.
    return {
      recipientChildId: r.lister_child_id,
      title: "New borrow request",
      body: `Someone wants to borrow "${bookTitle}"`,
      url: `/shelf?tab=incoming`,
      tag: `request-${r.id}-pending`,
    };
  }

  if (payload.type === "UPDATE") {
    const old = payload.old_record;
    if (!old || old.status === r.status) return null; // not a status change

    switch (r.status) {
      case "approved":
        return {
          recipientChildId: r.borrower_child_id,
          title: "Request approved!",
          body: `Your request for "${bookTitle}" was approved. Tap to see contact info.`,
          url: `/book/${r.book_id}`,
          tag: `request-${r.id}-approved`,
        };
      case "declined":
        return {
          recipientChildId: r.borrower_child_id,
          title: "Request declined",
          body: `Your request for "${bookTitle}" was declined.`,
          url: `/shelf?tab=outgoing`,
          tag: `request-${r.id}-declined`,
        };
      case "auto_declined":
        // Auto-decline fires when the lister hasn't responded in N days.
        // Notify the borrower so they don't keep waiting.
        return {
          recipientChildId: r.borrower_child_id,
          title: "Request expired",
          body: `Your request for "${bookTitle}" timed out. You can try another book.`,
          url: `/`,
          tag: `request-${r.id}-expired`,
        };
      case "picked_up":
        // Pickup is usually marked by the borrower → notify the lister.
        return {
          recipientChildId: r.lister_child_id,
          title: "Book picked up",
          body: `"${bookTitle}" has been picked up. Have fun reading!`,
          url: `/shelf?tab=incoming`,
          tag: `request-${r.id}-picked-up`,
        };
      case "returned":
        // Return is marked by the borrower → notify the lister to confirm.
        return {
          recipientChildId: r.lister_child_id,
          title: "Book returned",
          body: `"${bookTitle}" was returned. Tap to confirm receipt.`,
          url: `/shelf?tab=incoming`,
          tag: `request-${r.id}-returned`,
        };
      case "confirmed_return":
        // Lister confirmed → notify the borrower the loop is closed.
        return {
          recipientChildId: r.borrower_child_id,
          title: "Return confirmed",
          body: `Thanks for returning "${bookTitle}"!`,
          url: `/shelf?tab=outgoing`,
          tag: `request-${r.id}-confirmed`,
        };
      default:
        return null;
    }
  }

  return null;
}

// ---------- Subscription fetch + send --------------------------------

/**
 * Look up parent_id for a child, then fetch all active push subscriptions
 * for that parent. Service role bypasses RLS so we can read other users'
 * children + subscriptions.
 */
async function fetchSubscriptionsForChild(
  childId: string
): Promise<PushSubscriptionRow[]> {
  const { data: child, error: childErr } = await supabase
    .from("children")
    .select("parent_id")
    .eq("id", childId)
    .maybeSingle();

  if (childErr || !child) {
    console.error("[send-push] child lookup failed:", childErr ?? "no row", childId);
    return [];
  }

  const { data: subs, error: subErr } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("parent_id", child.parent_id);

  if (subErr) {
    console.error("[send-push] subscription lookup failed:", subErr);
    return [];
  }
  return (subs ?? []) as PushSubscriptionRow[];
}

/**
 * Send the actual push. Cleans up dead subscriptions on 404/410 — those
 * mean the user uninstalled the PWA / cleared site data, and the push
 * service has already forgotten about them. Keeping the row around just
 * means we'll fail-and-retry on every future event.
 */
async function deliver(
  sub: PushSubscriptionRow,
  payload: object
): Promise<void> {
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      JSON.stringify(payload)
    );
  } catch (err: unknown) {
    const status =
      typeof err === "object" && err && "statusCode" in err
        ? (err as { statusCode: number }).statusCode
        : 0;
    if (status === 404 || status === 410) {
      // Subscription is dead — clean up so we don't keep retrying.
      console.warn("[send-push] dead subscription, cleaning:", sub.endpoint);
      await supabase
        .from("push_subscriptions")
        .delete()
        .eq("endpoint", sub.endpoint);
    } else {
      console.error("[send-push] delivery failed:", err);
    }
  }
}

// ---------- HTTP handler ---------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (payload.table !== "borrow_requests" || !payload.record) {
    // Webhook misconfigured or pointed at the wrong table — fail fast
    // so it shows up in the Edge Function logs.
    return new Response("Unexpected payload", { status: 400 });
  }

  // We need the book title for the notification copy. One round-trip;
  // skip if the book somehow doesn't exist (shouldn't happen given the
  // FK constraint, but don't crash if it does).
  const { data: book } = await supabase
    .from("books")
    .select("title")
    .eq("id", payload.record.book_id)
    .maybeSingle();
  const bookTitle = book?.title ?? "a book";

  const notif = buildNotification(payload, bookTitle);
  if (!notif) {
    return new Response("No notification for this change", { status: 200 });
  }

  const subs = await fetchSubscriptionsForChild(notif.recipientChildId);
  if (subs.length === 0) {
    // Recipient hasn't enabled push (yet). Still a 200 — the in-app
    // bell will pick it up next time they open the app.
    return new Response("No subscriptions for recipient", { status: 200 });
  }

  const pushBody = {
    title: notif.title,
    body: notif.body,
    url: notif.url,
    tag: notif.tag,
  };

  // Fan out in parallel — push services are slow enough that serial
  // delivery to a 3-device household would noticeably delay the response.
  await Promise.allSettled(subs.map((s) => deliver(s, pushBody)));

  // Best-effort: update last_used_at so we have visibility into which
  // subscriptions are actually being delivered to. Failure is non-fatal.
  await supabase
    .from("push_subscriptions")
    .update({ last_used_at: new Date().toISOString() })
    .in(
      "endpoint",
      subs.map((s) => s.endpoint)
    );

  return new Response(
    JSON.stringify({ delivered: subs.length, recipientChildId: notif.recipientChildId }),
    { headers: { "Content-Type": "application/json" } }
  );
});
