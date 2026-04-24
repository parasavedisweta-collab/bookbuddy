"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { BorrowRequest } from "@/lib/types";
import { fetchMyRequests } from "@/lib/supabase/requests";
import { listChildrenForCurrentParent } from "@/lib/supabase/children";

/**
 * Header bell with an unread badge + dropdown panel.
 *
 * Source of truth: the current user's borrow_requests (RLS already
 * restricts the result set to rows where I'm either the borrower or
 * lister parent — see requests.ts). We don't persist a separate
 * notifications table; the status + timestamps on each request tell
 * us everything:
 *
 *   As lister:
 *     pending      → "X requested <book>"
 *     picked_up    → "X picked up <book>"
 *     returned     → "X says they returned <book>"
 *   As borrower:
 *     approved          → "Y approved your request for <book>"
 *     declined          → "Y declined your request for <book>"
 *     auto_declined     → same copy as declined
 *     confirmed_return  → "Y confirmed the return of <book>"
 *
 * Read-state tracking: a single `bb_notif_last_seen` timestamp in
 * localStorage. Anything newer is unread. Opening the dropdown marks
 * everything as read by advancing the timestamp to now — good enough
 * for v1; per-item dismissal would need a notifications table.
 *
 * The event timestamp used for ordering and read-state is status-
 * dependent: approved/declined use responded_at, picked_up uses
 * picked_up_at, etc. A fresh pending uses requested_at. See eventAt().
 */

const LAST_SEEN_KEY = "bb_notif_last_seen";

interface NotifItem {
  id: string; // request id — stable for React keys
  request: BorrowRequest;
  eventAt: number; // ms since epoch
  message: string;
  icon: string; // material symbol name
  side: "lister" | "borrower";
}

function eventAt(req: BorrowRequest): number {
  // Pick the timestamp that corresponds to the *current* status. If the
  // matching column is somehow null, fall back to requested_at — better
  // to show the notification out of order than drop it entirely.
  let raw: string | null | undefined;
  switch (req.status) {
    case "approved":
    case "declined":
    case "auto_declined":
      raw = req.responded_at;
      break;
    case "picked_up":
      raw = req.picked_up_at;
      break;
    case "returned":
      raw = req.returned_at;
      break;
    case "confirmed_return":
      raw = req.return_confirmed_at;
      break;
    default:
      raw = req.requested_at;
  }
  const t = Date.parse(raw || req.requested_at);
  return Number.isFinite(t) ? t : 0;
}

function formatRelative(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  // Older than a week — show a date so "30d ago" doesn't blur together.
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function buildNotification(
  req: BorrowRequest,
  myChildIds: Set<string>
): NotifItem | null {
  const iAmLister = myChildIds.has(req.lister_child_id);
  const iAmBorrower = myChildIds.has(req.borrower_child_id);
  // Defensive: RLS shouldn't show us rows we're not involved in, but
  // demo/localStorage-only requests can leak through during the transition.
  if (!iAmLister && !iAmBorrower) return null;

  const bookTitle = req.book?.title || "a book";
  const borrowerName = req.borrower_child?.name || "Someone";
  const listerName = req.lister_child?.name || "Someone";

  // Lister side: pending, picked_up, returned are the moments they care
  // about. Approved/declined are actions they took themselves → skip.
  if (iAmLister) {
    if (req.status === "pending") {
      return {
        id: req.id,
        request: req,
        eventAt: eventAt(req),
        message: `${borrowerName} requested "${bookTitle}"`,
        icon: "library_add",
        side: "lister",
      };
    }
    if (req.status === "picked_up") {
      return {
        id: req.id,
        request: req,
        eventAt: eventAt(req),
        message: `${borrowerName} picked up "${bookTitle}"`,
        icon: "outbox",
        side: "lister",
      };
    }
    if (req.status === "returned") {
      return {
        id: req.id,
        request: req,
        eventAt: eventAt(req),
        message: `${borrowerName} says they returned "${bookTitle}" — tap to confirm`,
        icon: "assignment_return",
        side: "lister",
      };
    }
    // If we also happen to be the borrower (self-borrow, shouldn't really
    // happen but children.society_id could match), fall through to the
    // borrower branch below.
  }

  if (iAmBorrower) {
    if (req.status === "approved") {
      return {
        id: req.id,
        request: req,
        eventAt: eventAt(req),
        message: `${listerName} approved your request for "${bookTitle}"`,
        icon: "check_circle",
        side: "borrower",
      };
    }
    if (req.status === "declined" || req.status === "auto_declined") {
      return {
        id: req.id,
        request: req,
        eventAt: eventAt(req),
        message: `${listerName} declined your request for "${bookTitle}"`,
        icon: "cancel",
        side: "borrower",
      };
    }
    if (req.status === "confirmed_return") {
      return {
        id: req.id,
        request: req,
        eventAt: eventAt(req),
        message: `${listerName} confirmed the return of "${bookTitle}"`,
        icon: "task_alt",
        side: "borrower",
      };
    }
  }

  return null;
}

export default function NotificationBell() {
  const [requests, setRequests] = useState<BorrowRequest[]>([]);
  const [myChildIds, setMyChildIds] = useState<Set<string>>(() => new Set());
  const [lastSeenAt, setLastSeenAt] = useState<number>(0);
  const [open, setOpen] = useState(false);
  // Ref on the outer container so we can close the dropdown on outside
  // taps — clicking a Link inside the panel DOES close via route change,
  // but tapping the dimmed background should dismiss too.
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Load last-seen timestamp from localStorage once on mount. Parsing
  // failures → 0 (everything is unread).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAST_SEEN_KEY);
      const n = raw ? Number.parseInt(raw, 10) : 0;
      setLastSeenAt(Number.isFinite(n) ? n : 0);
    } catch {
      setLastSeenAt(0);
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [children, reqs] = await Promise.all([
        listChildrenForCurrentParent(),
        fetchMyRequests(),
      ]);
      setMyChildIds(new Set(children.map((c) => c.id)));
      setRequests(reqs);
    } catch (err) {
      console.error("[notifications] load failed:", err);
    }
  }, []);

  useEffect(() => {
    loadAll();
    const onChange = () => loadAll();
    // Refresh whenever the shelf or auth state changes — same contract
    // the rest of the app uses (bb_requests_change fires on transitions,
    // bb_supabase_auth fires when the anon session lands).
    window.addEventListener("bb_requests_change", onChange);
    window.addEventListener("bb_user_change", onChange);
    window.addEventListener("bb_supabase_auth", onChange);
    return () => {
      window.removeEventListener("bb_requests_change", onChange);
      window.removeEventListener("bb_user_change", onChange);
      window.removeEventListener("bb_supabase_auth", onChange);
    };
  }, [loadAll]);

  // Close on outside tap / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const notifications = useMemo(() => {
    const items: NotifItem[] = [];
    for (const r of requests) {
      const n = buildNotification(r, myChildIds);
      if (n) items.push(n);
    }
    items.sort((a, b) => b.eventAt - a.eventAt);
    // Cap to the most recent 30 so the panel doesn't grow unbounded on a
    // power user. Older stuff is reachable via /shelf anyway.
    return items.slice(0, 30);
  }, [requests, myChildIds]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => n.eventAt > lastSeenAt).length,
    [notifications, lastSeenAt]
  );

  function toggleOpen() {
    setOpen((prev) => {
      const next = !prev;
      // Opening counts as "I saw these" — advance the watermark so the
      // badge clears. Closing without opening never resets.
      if (next) {
        const now = Date.now();
        setLastSeenAt(now);
        try {
          localStorage.setItem(LAST_SEEN_KEY, String(now));
        } catch {}
      }
      return next;
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : "Notifications"
        }
        onClick={toggleOpen}
        className="relative p-2 text-on-surface-variant active:scale-95 transition-transform"
      >
        <span
          className="material-symbols-outlined"
          style={open ? { fontVariationSettings: "'FILL' 1" } : undefined}
        >
          notifications
        </span>
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-tertiary text-white text-[10px] font-bold flex items-center justify-center shadow">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-[min(22rem,90vw)] bg-surface rounded-2xl shadow-2xl border border-outline-variant z-50 overflow-hidden"
          role="menu"
        >
          <div className="px-4 py-3 border-b border-outline-variant flex items-center justify-between">
            <h3 className="font-headline font-extrabold text-on-surface text-base">
              Notifications
            </h3>
            {notifications.length > 0 && (
              <span className="text-xs text-on-surface-variant">
                {notifications.length}{" "}
                {notifications.length === 1 ? "update" : "updates"}
              </span>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <span className="material-symbols-outlined text-4xl text-outline-variant mb-2 block">
                notifications_off
              </span>
              <p className="text-sm text-on-surface-variant">
                No notifications yet. You&apos;ll see requests and approvals here.
              </p>
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto divide-y divide-outline-variant">
              {notifications.map((n) => {
                const isUnread = n.eventAt > lastSeenAt;
                return (
                  <li key={n.id}>
                    <Link
                      href="/shelf"
                      onClick={() => setOpen(false)}
                      className={`flex items-start gap-3 px-4 py-3 transition-colors ${
                        isUnread
                          ? "bg-primary-container/40 hover:bg-primary-container/60"
                          : "hover:bg-surface-container-low"
                      }`}
                    >
                      <div
                        className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
                          n.side === "lister"
                            ? "bg-secondary-container text-on-secondary-container"
                            : "bg-tertiary-container text-on-tertiary-container"
                        }`}
                      >
                        <span
                          className="material-symbols-outlined text-lg"
                          style={{ fontVariationSettings: "'FILL' 1" }}
                        >
                          {n.icon}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-sm leading-snug ${
                            isUnread
                              ? "text-on-surface font-bold"
                              : "text-on-surface-variant"
                          }`}
                        >
                          {n.message}
                        </p>
                        <p className="text-xs text-on-surface-variant mt-0.5">
                          {formatRelative(n.eventAt)}
                        </p>
                      </div>
                      {isUnread && (
                        <span
                          aria-hidden
                          className="flex-shrink-0 mt-2 w-2 h-2 rounded-full bg-tertiary"
                        />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
