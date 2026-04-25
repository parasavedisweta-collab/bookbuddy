/**
 * ListBookFab — floating "List a book" action on the home page.
 *
 * Why a FAB and not just a header button: listing is the single most
 * conversion-critical action on the home page (you can't borrow until
 * you've listed), and the home page is grid-dense — a fixed FAB stays
 * thumb-reachable while the user scrolls through other people's books.
 *
 * Position: above the bottom nav AND above the AddToHomeScreen prompt
 * when both are visible. We can't easily detect whether the A2HS bar is
 * mounted (it's a sibling at the layout level), so we pad once for nav
 * (~5rem / 80px) and a constant `2rem` extra so we clear the A2HS bar
 * if it's there. On users who've already installed (no A2HS bar) the
 * FAB just floats slightly higher than strictly necessary, which is
 * still well within thumb reach.
 *
 * Hidden when the user is unregistered — there's no useful destination
 * for them yet (book/list bounces them back through registration). The
 * caller component (home page) doesn't render us in that state.
 */
"use client";

import Link from "next/link";

export default function ListBookFab() {
  return (
    <Link
      href="/book/list"
      aria-label="List a new book"
      className="fixed right-4 z-30 group"
      style={{
        // 5rem = BottomNav clearance, 2rem = clear of A2HS bar (when shown),
        // env() handles iPhone notch / home indicator.
        bottom: "calc(5rem + 2rem + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <span className="flex items-center gap-2 bg-primary text-white font-headline font-bold text-sm px-4 py-3 rounded-full shadow-lg shadow-primary/30 active:scale-95 transition-transform">
        <span
          className="material-symbols-outlined text-lg"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          add
        </span>
        List a book
      </span>
    </Link>
  );
}
