/**
 * HelpButton — circular `?` icon that opens a small popover with the
 * support email and a one-tap "Send email" mailto link.
 *
 * Lives in the top-right of the home page header next to the
 * NotificationBell. Surface area is intentionally low — first-time
 * users glance and ignore; users who hit a snag tap and find the
 * email instantly.
 *
 * Closes on outside click and on Escape — standard menu behaviour
 * users won't have to think about.
 *
 * The mailto link includes a pre-filled subject so we can recognise
 * help requests at a glance in the Zoho inbox. No body — let the user
 * write whatever they need.
 */
"use client";

import { useEffect, useRef, useState } from "react";

const HELP_EMAIL = "help@bookbuds.in";
const MAILTO = `mailto:${HELP_EMAIL}?subject=${encodeURIComponent("BookBuds help")}`;

export default function HelpButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click + Escape. Effect re-runs only when `open`
  // flips so we're not paying the listener cost on every render.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Help"
        aria-expanded={open}
        title="Need help? Email us"
        className="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center hover:bg-surface-container transition-colors active:scale-95"
      >
        <span className="material-symbols-outlined text-on-surface-variant text-lg">
          help
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Help"
          className="absolute right-0 top-11 w-64 bg-surface rounded-2xl shadow-xl border border-outline-variant/20 p-4 z-50"
        >
          <h4 className="font-headline font-bold text-on-surface text-sm">
            Need help?
          </h4>
          <p className="text-xs text-on-surface-variant leading-snug mt-1">
            For any queries, drop us a line at:
          </p>
          <p className="text-sm font-mono text-primary mt-2 break-all">
            {HELP_EMAIL}
          </p>
          <a
            href={MAILTO}
            onClick={() => setOpen(false)}
            className="mt-3 flex items-center justify-center gap-2 w-full bg-primary text-on-primary font-bold text-sm py-2.5 rounded-full active:scale-95 transition-transform"
          >
            <span className="material-symbols-outlined text-base">mail</span>
            Send email
          </a>
        </div>
      )}
    </div>
  );
}
