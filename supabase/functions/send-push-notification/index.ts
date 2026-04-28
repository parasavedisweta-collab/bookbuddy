// =====================================================================
// send-push-notification — Supabase Edge Function (Deno runtime)
//
// Triggered by a Database Webhook on public.borrow_requests. We only
// fire notifications for the four events the user can't see in real
// time:
//   - INSERT                       → request created → push the LISTER
//   - UPDATE → status=approved     → push the BORROWER
//   - UPDATE → status=declined     → push the BORROWER
//   - UPDATE → status=auto_declined → push the BORROWER (timeout)
//
// We deliberately do NOT notify on picked_up / returned / confirmed_return.
// Those transitions happen offline (the two kids meet, hand the book over,
// later hand it back) and one party is always the one tapping the status
// change in-app — they don't need a push for an action they just took, and
// the other party already coordinated the handover via WhatsApp/in person.
// Marking "returned" exists only so the lister can put the book back on
// their available shelf for the next borrower.
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
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:noreply@bookbuds.in";

// Email is best-effort. If RESEND_API_KEY / EMAIL_FROM / APP_URL aren't
// set, we still deliver push and the function returns 200 — we just log
// once at boot so missing config is visible in the function's startup
// log line rather than silently dropping every email.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error(
    "[send-push] missing VAPID env vars. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in Edge Function secrets."
  );
}
if (!RESEND_API_KEY || !EMAIL_FROM || !APP_URL) {
  console.warn(
    "[send-push] email disabled: set RESEND_API_KEY, EMAIL_FROM, APP_URL in Edge Function secrets to enable."
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
  /** Push banner title + email subject line. Short — ~40 chars max. */
  title: string;
  /** Push banner body. Short — ~120 chars max. */
  body: string;
  /** Deep link the SW will open / focus on click. */
  url: string;
  /** Dedup tag — multiple updates for the same request collapse into one banner. */
  tag: string;
  /**
   * Email-only copy. Push has to fit on a lock screen so we keep the
   * `body` short; email has more room for a personal greeting + a
   * fuller paragraph + a sign-off. Each is one logical paragraph;
   * the renderer wraps them in styled <p> tags.
   */
  emailIntro: string;
  emailBody: string;
  emailSignoff: string;
  /** Label on the CTA button in the email. Per-event so the call to
   *  action matches the moment ("Approve request" vs "Browse books"). */
  ctaLabel: string;
}

/**
 * Translate a webhook payload to "who do we tell, what do we say."
 *
 * Returns null when the change doesn't warrant a notification (e.g. an
 * UPDATE where status didn't change, or a status transition the user
 * already knows about because they're the one who triggered it).
 *
 * Copy choices: BookBuddy is for kids in housing societies, so the tone
 * leans warm + a touch playful — emoji on the title, first names in the
 * body, exclamation marks where the moment earns one. The titles double
 * as both the push banner and the email subject line, so they need to
 * be short enough not to truncate on a phone lock screen (~40 chars).
 */
function buildNotification(
  payload: WebhookPayload,
  bookTitle: string,
  borrowerName: string,
  listerName: string
): NotificationContent | null {
  const r = payload.record;
  // Defensive fallbacks — if the FK lookup somehow returned nothing,
  // "your neighbour" reads better than "undefined".
  const borrower = borrowerName || "Your neighbour";
  const lister = listerName || "Your neighbour";

  if (payload.type === "INSERT") {
    // New borrow request → notify the LISTER. The borrower already knows
    // they just tapped Request.
    return {
      recipientChildId: r.lister_child_id,
      title: `📚 ${borrower} wants your book!`,
      body: `${borrower} would love to borrow "${bookTitle}" from your shelf. Tap to approve or pass.`,
      url: `/shelf?tab=incoming`,
      tag: `request-${r.id}-pending`,
      emailIntro: `Hey ${lister}! 👋`,
      emailBody: `Big news — ${borrower} just spotted "${bookTitle}" on your shelf and would love to borrow it. 📖\n\nGo ahead and approve the request — ${borrower} is waiting!`,
      emailSignoff: `Happy sharing,\nTeam BookBuds 🐛📚`,
      ctaLabel: `Open my shelf`,
    };
  }

  if (payload.type === "UPDATE") {
    const old = payload.old_record;
    if (!old || old.status === r.status) return null; // not a status change

    switch (r.status) {
      case "approved":
        return {
          recipientChildId: r.borrower_child_id,
          title: `🎉 ${lister} said yes!`,
          body: `Woohoo! ${lister} approved your request for "${bookTitle}". Their contact info is now visible in BookBuds — tap to coordinate the handover.`,
          url: `/book/${r.book_id}`,
          tag: `request-${r.id}-approved`,
          emailIntro: `Woohoo, ${borrower}! 🎉`,
          emailBody: `${lister} just approved your request for "${bookTitle}". Get ready to dive in!\n\nTheir contact info is now unlocked inside BookBuds — tap below to message them on WhatsApp or call to figure out the pickup. And don't forget to say a big thank you when you grab the book. 💛`,
          emailSignoff: `Happy reading,\nTeam BookBuds 🐛📚`,
          ctaLabel: `See contact info`,
        };
      case "declined":
        return {
          recipientChildId: r.borrower_child_id,
          title: `${lister} can't share this time`,
          body: `Bummer — ${lister} couldn't lend "${bookTitle}" right now. Plenty of other great books in your society. Tap to keep browsing.`,
          url: `/shelf?tab=outgoing`,
          tag: `request-${r.id}-declined`,
          emailIntro: `Hi ${borrower},`,
          emailBody: `${lister} couldn't share "${bookTitle}" this time round — maybe their kid is in the middle of reading it, or it's already promised to someone else. It happens! 🤷\n\nDon't worry though — your society has plenty of other great books waiting for a new reader. Tap below to keep browsing.`,
          emailSignoff: `Keep reading,\nTeam BookBuds 🐛📚`,
          ctaLabel: `Browse other books`,
        };
      case "auto_declined":
        // Auto-decline fires when the lister hasn't responded in N days.
        // Notify the borrower so they don't keep waiting.
        return {
          recipientChildId: r.borrower_child_id,
          title: `⏰ Request timed out`,
          body: `Your request for "${bookTitle}" expired — ${lister} didn't get a chance to respond. No worries! Try another book.`,
          url: `/`,
          tag: `request-${r.id}-expired`,
          emailIntro: `Hey ${borrower},`,
          emailBody: `Your request for "${bookTitle}" timed out — looks like ${lister} was busy and didn't get a chance to respond. ⏰\n\nNo worries! Try a different book — or if you're still really keen on this one, you can always send another request later when ${lister} is back in the loop.`,
          emailSignoff: `Happy hunting,\nTeam BookBuds 🐛📚`,
          ctaLabel: `Find another book`,
        };
      // picked_up / returned / confirmed_return are deliberately not
      // notified. Those happen offline — the two kids meet, hand the
      // book over, later hand it back. One party is always the one
      // tapping the status change, so a push for an action they just
      // took is noise; the other party already knows because they were
      // standing right there. Falls through to the default branch.
      default:
        return null;
    }
  }

  return null;
}

// ---------- Subscription fetch + send --------------------------------

/**
 * Look up parent_id + parent email for a child, then fetch all active
 * push subscriptions for that parent. Service role bypasses RLS so we
 * can read other users' children + subscriptions.
 *
 * Email is denormalised onto parents (post-0007 it's NOT NULL UNIQUE,
 * the credential column), so this is one round-trip. Returned shape
 * splits subscriptions from email so the caller can fan out push and
 * email in parallel.
 */
interface RecipientContext {
  email: string | null;
  subscriptions: PushSubscriptionRow[];
}

async function fetchRecipientForChild(
  childId: string
): Promise<RecipientContext> {
  const { data: child, error: childErr } = await supabase
    .from("children")
    .select("parent_id, parents(email)")
    .eq("id", childId)
    .maybeSingle<{
      parent_id: string;
      parents: { email: string } | { email: string }[] | null;
    }>();

  if (childErr || !child) {
    console.error("[send-push] child lookup failed:", childErr ?? "no row", childId);
    return { email: null, subscriptions: [] };
  }

  // PostgREST may return the joined parents row as either an object or
  // a single-element array depending on the relation cardinality hint.
  // Normalise both shapes.
  const parents = Array.isArray(child.parents) ? child.parents[0] : child.parents;
  const email = parents?.email ?? null;

  const { data: subs, error: subErr } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("parent_id", child.parent_id);

  if (subErr) {
    console.error("[send-push] subscription lookup failed:", subErr);
    return { email, subscriptions: [] };
  }
  return { email, subscriptions: (subs ?? []) as PushSubscriptionRow[] };
}

/**
 * Minimal HTML escape for user-controlled strings dropped into the email
 * body (book title is the only one). We don't link-render or rich-format
 * anything; this is just a "&" → "&amp;" guard so a "Tom & Jerry"-style
 * title doesn't break the markup.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a paragraph block as inline-styled HTML. Each `\n\n` in the
 * source becomes a separate <p>; single `\n` becomes <br>. Keeps the
 * email-side copy authoring as plain template-literal text without
 * needing a markdown dependency.
 */
function paragraphsToHtml(text: string): string {
  return text
    .split(/\n\n+/)
    .map(
      (para) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#43483a;">${escapeHtml(
          para
        ).replace(/\n/g, "<br>")}</p>`
    )
    .join("");
}

/**
 * Build a tiny inline-styled email body that mirrors the push copy and
 * deep-links back into the app. We keep it dead simple — single-column,
 * no images, no external CSS. That's the most reliable shape across
 * gmail / yahoo / outlook / apple mail and dodges the "email-as-iframe"
 * sandbox most clients use.
 *
 * BookBuddy's brand colour (primary green ~#5e7d3f) is matched on the
 * CTA button. Everything else stays neutral so it reads fine in both
 * light and dark mode email clients.
 */
function renderEmail(
  notif: NotificationContent,
  bookTitle: string
): { html: string; text: string } {
  const safeTitle = escapeHtml(bookTitle);
  // Absolute URL for the deep-link CTA. notif.url is a relative path
  // (e.g. "/shelf?tab=incoming") because that's what the SW consumes.
  const ctaUrl = `${APP_URL.replace(/\/$/, "")}${notif.url}`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#fefcf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1c14;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px 28px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
    <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:1.5px;color:#5e7d3f;text-transform:uppercase;">BookBuds</p>
    <h1 style="margin:0 0 18px;font-size:22px;line-height:1.25;font-weight:800;color:#1a1c14;">${escapeHtml(notif.title)}</h1>
    <p style="margin:0 0 14px;font-size:16px;line-height:1.4;font-weight:600;color:#1a1c14;">${escapeHtml(notif.emailIntro)}</p>
    ${paragraphsToHtml(notif.emailBody)}
    <p style="margin:24px 0 0;"><a href="${ctaUrl}" style="display:inline-block;background:#5e7d3f;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 24px;border-radius:999px;">${escapeHtml(notif.ctaLabel)}</a></p>
    <p style="margin:28px 0 0;font-size:14px;line-height:1.5;color:#43483a;white-space:pre-line;">${escapeHtml(notif.emailSignoff)}</p>
    <hr style="border:none;border-top:1px solid #e8e6dc;margin:28px 0 16px;">
    <p style="margin:0;font-size:12px;line-height:1.5;color:#9a9a8e;">You're getting this because you're part of a BookBuds borrow request for "${safeTitle}". Manage notifications from Profile → Push notifications inside the app.</p>
  </div>
</body></html>`;
  const text =
    `${notif.title}\n\n` +
    `${notif.emailIntro}\n\n` +
    `${notif.emailBody}\n\n` +
    `${notif.ctaLabel}: ${ctaUrl}\n\n` +
    `${notif.emailSignoff}\n\n` +
    `— Sent because you're part of a borrow request for "${bookTitle}".`;
  return { html, text };
}

/**
 * Send a transactional email via Resend's HTTP API. Best-effort —
 * returns void and logs failures rather than throwing, so a Resend
 * outage doesn't break push delivery (which uses a different vendor).
 */
async function deliverEmail(
  to: string,
  subject: string,
  html: string,
  text: string
): Promise<void> {
  if (!RESEND_API_KEY || !EMAIL_FROM) return; // disabled by missing config
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        "[send-push] resend send failed:",
        res.status,
        detail.slice(0, 500)
      );
    }
  } catch (err) {
    console.error("[send-push] resend fetch threw:", err);
  }
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

/**
 * Do all the slow work: fetch context, fan out push + email, update
 * last_used_at. Pulled out of the request handler so it can run in the
 * background via EdgeRuntime.waitUntil() while we return 200 immediately
 * to pg_net (whose default webhook timeout is 1s — easily exceeded once
 * Resend's HTTP round-trip is in the path).
 */
async function processWebhook(payload: WebhookPayload): Promise<void> {
  // Fetch the three pieces of context the copy needs: book title +
  // borrower's child name + lister's child name. Three parallel reads;
  // service role bypasses RLS so we can pull names across parents.
  const [bookRes, borrowerRes, listerRes] = await Promise.all([
    supabase
      .from("books")
      .select("title")
      .eq("id", payload.record.book_id)
      .maybeSingle(),
    supabase
      .from("children")
      .select("name")
      .eq("id", payload.record.borrower_child_id)
      .maybeSingle(),
    supabase
      .from("children")
      .select("name")
      .eq("id", payload.record.lister_child_id)
      .maybeSingle(),
  ]);
  const bookTitle = (bookRes.data as { title?: string } | null)?.title ?? "a book";
  const borrowerName =
    (borrowerRes.data as { name?: string } | null)?.name ?? "";
  const listerName = (listerRes.data as { name?: string } | null)?.name ?? "";

  const notif = buildNotification(payload, bookTitle, borrowerName, listerName);
  if (!notif) return;

  const recipient = await fetchRecipientForChild(notif.recipientChildId);
  const subs = recipient.subscriptions;

  const pushBody = {
    title: notif.title,
    body: notif.body,
    url: notif.url,
    tag: notif.tag,
  };

  // Fan out push + email in parallel. Either channel can fail without
  // affecting the other — push goes through Apple/Mozilla/Google FCM,
  // email through Resend. Promise.allSettled so a transient failure on
  // one doesn't reject the whole batch.
  const tasks: Promise<unknown>[] = subs.map((s) => deliver(s, pushBody));
  if (recipient.email) {
    const { html, text } = renderEmail(notif, bookTitle);
    tasks.push(deliverEmail(recipient.email, notif.title, html, text));
  }
  await Promise.allSettled(tasks);

  // Best-effort: update last_used_at so we have visibility into which
  // subscriptions are actually being delivered to. Failure is non-fatal.
  if (subs.length > 0) {
    await supabase
      .from("push_subscriptions")
      .update({ last_used_at: new Date().toISOString() })
      .in(
        "endpoint",
        subs.map((s) => s.endpoint)
      );
  }

  console.log(
    `[send-push] ${payload.type} ${payload.record.id}: pushDelivered=${subs.length} emailDelivered=${recipient.email ? 1 : 0}`
  );
}

// EdgeRuntime is a Supabase-supplied global on Deno. Its waitUntil keeps
// the function alive past the response so background work completes —
// same idea as Cloudflare Workers' ctx.waitUntil. Typed as `unknown` so
// the file still type-checks if Deno upgrades and removes the global.
declare const EdgeRuntime:
  | { waitUntil: (p: Promise<unknown>) => void }
  | undefined;

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

  // Background the slow work; return 200 immediately so pg_net's 1s
  // webhook timeout never trips. processWebhook logs its own outcome.
  const work = processWebhook(payload).catch((err) => {
    console.error("[send-push] processWebhook threw:", err);
  });
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(work);
  }
  // Note: if EdgeRuntime is missing (older runtime) the promise is
  // floating — Deno will still let it run to completion in practice
  // but isn't guaranteed to. The fast path is the EdgeRuntime branch.

  return new Response(
    JSON.stringify({ accepted: true, type: payload.type, id: payload.record.id }),
    { headers: { "Content-Type": "application/json" } }
  );
});
