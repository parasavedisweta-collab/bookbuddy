# Web Push Setup

Step-by-step to bring web push notifications online for BookBuddy. **Run these in both UAT and Prod Supabase projects** — the keys are project-scoped.

---

## 1. Generate VAPID keys

VAPID is the spec push services use to verify "yes, this server is allowed to push to this endpoint." You need one keypair, used by both the client (public half) and the Edge Function (both halves).

```bash
# From the repo root
npx web-push generate-vapid-keys
```

You'll get something like:

```
Public Key:  BLgg...A4
Private Key: kQH7...gE
```

Keep both safe. Use the **same pair** for UAT and Prod if you want testers' subscriptions to keep working when we promote — easier debugging.

---

## 2. Apply migrations

In each Supabase project (UAT + Prod):

1. Dashboard → SQL Editor
2. Paste and Run, in order:
   - `supabase/migrations/0005_get_lister_contact_rpc.sql` (if not already applied — needed for the borrow flow's contact reveal, separate from push)
   - `supabase/migrations/0006_push_subscriptions.sql` (creates the table push notifications need)

---

## 3. Set environment variables

### Client (Vercel → Project → Settings → Environment Variables)

| Name | Scope | Value |
|---|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Production + Preview | the **public** half from step 1 |

Redeploy after adding (Vercel → Deployments → Redeploy → "Use existing Build Cache" off, to be safe).

### Edge Function (Supabase Dashboard → Edge Functions → Settings → Add new secret)

For **each** Supabase project (UAT and Prod):

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the **public** half (yes, also here — function needs it) |
| `VAPID_PRIVATE_KEY` | the **private** half |
| `VAPID_SUBJECT` | `mailto:you@example.com` (your email; required by spec) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the platform — don't set them manually.

---

## 4. Deploy the Edge Function

Install the Supabase CLI if you haven't:

```bash
brew install supabase/tap/supabase
# or: npm i -g supabase
```

Link the local repo to your project (one-time, per project):

```bash
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>   # find it in Dashboard → Project Settings → General
```

Deploy:

```bash
supabase functions deploy send-push-notification --no-verify-jwt
```

The `--no-verify-jwt` flag is **required** — webhook payloads come from the database trigger, not an authenticated user, so they don't carry a JWT. The function uses the service-role key (auto-injected) for DB access instead.

Repeat for the other project (re-link with the other ref, redeploy).

---

## 5. Wire the database webhook

In each Supabase project:

1. Dashboard → Database → **Webhooks** → New Hook
2. Configure:
   - **Name:** `borrow_requests_push`
   - **Table:** `borrow_requests`
   - **Events:** ✅ Insert, ✅ Update (leave Delete unchecked)
   - **Type:** Supabase Edge Functions
   - **Edge Function:** `send-push-notification`
   - **HTTP Headers:** add `Content-Type: application/json` (Supabase auto-fills this in newer dashboards)
3. Save. Supabase will start posting to the function on every INSERT/UPDATE.

---

## 6. Smoke test

1. Open BookBuddy on Android Chrome (or installed iOS PWA).
2. Profile → toggle **Push notifications** on. Accept the OS prompt.
3. From a second device or incognito session, request one of your books.
4. Within ~5 seconds the first device should buzz with **"New borrow request"**.
5. Check `push_subscriptions.last_used_at` in Supabase — it should be within the last few seconds.

If nothing happens, in this order:

| Symptom | Where to look |
|---|---|
| No row in `push_subscriptions` after toggling on | Browser DevTools console for `[push]` errors. Common: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` not set or app not redeployed since adding it. |
| Row exists, no notification | Supabase Dashboard → Edge Functions → `send-push-notification` → Logs. Look for missing VAPID secrets or 4xx from the push service. |
| Function never invoked at all | Database → Webhooks → `borrow_requests_push` → Logs. Check the webhook is enabled and pointing at the right function. |
| iOS Safari ignores the notification | Confirm the user is in the installed PWA (tab-bar Safari is unsupported by Apple). The toggle's "needs-pwa" state should already block this case. |

---

## What's where (file map)

| Layer | File |
|---|---|
| DB schema | `supabase/migrations/0006_push_subscriptions.sql` |
| Service worker | `public/sw.js` |
| Client subscribe/unsubscribe | `src/lib/push.ts` |
| SW registration on app boot | `src/components/PushBootstrap.tsx` |
| Inline post-action prompt | `src/components/PushPermissionNudge.tsx` |
| Profile toggle | `src/components/PushSettingsToggle.tsx` |
| Edge Function sender | `supabase/functions/send-push-notification/index.ts` |

---

## Platform notes

- **Android / desktop Chrome / Firefox:** works in regular browser tabs. No PWA install required.
- **iOS Safari ≥ 16.4:** works **only** in installed PWAs (home-screen shortcut, opened from there). The client detects this via `display-mode: standalone` and renders a "needs-pwa" state instead of a useless permission prompt.
- **Older iOS:** unsupported. Toggle renders the "Notifications aren't supported" message.
