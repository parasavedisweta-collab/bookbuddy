"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getAllBooks, getAllChildren, getCurrentUserSocietyId } from "@/lib/userStore";
import { getCurrentParent } from "@/lib/supabase/parents";
import {
  isAloneInSociety,
  countDistinctParentsInSociety,
} from "@/lib/supabase/children";
import ShareAppButton from "@/components/ShareAppButton";

/**
 * Ordinal suffix for "Xth member" copy. Handles 11/12/13 as the special
 * "th" cases (eleventh, twelfth, thirteenth) — without this, 11 reads
 * "11st" which is wrong. For our scale (members per society in low tens)
 * this matters the moment a society crosses 10 members.
 */
function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

export default function SuccessPage() {
  const [childName, setChildName] = useState("Reader");
  const [memberCount, setMemberCount] = useState(0);
  const [bookCount, setBookCount] = useState(0);
  // Supabase-resolved "is this parent the only registered one in their
  // society?" Starts null so we don't flash the "first member!" copy for
  // someone who's actually the 50th — the localStorage heuristic below is
  // a best-effort fallback until this resolves, but the Supabase answer
  // wins once it arrives.
  const [isAloneSupabase, setIsAloneSupabase] = useState<boolean | null>(null);
  // Authoritative member count from Supabase (distinct parents in this
  // society). 0 = unknown / not loaded yet — render time falls back to
  // the localStorage heuristic so the page is never blank. Once loaded
  // this is what the "Xth member" copy uses.
  const [supabaseMemberCount, setSupabaseMemberCount] = useState<number>(0);

  useEffect(() => {
    // Child name from registration flow
    try {
      const data = localStorage.getItem("bb_child");
      if (data) {
        const parsed = JSON.parse(data);
        setChildName(parsed.name || "Reader");
      }
    } catch {}

    // Society stats (localStorage — instant, used as fallback copy only)
    const societyId = getCurrentUserSocietyId();
    const members = getAllChildren().filter((c) => c.societyId === societyId);
    const books = getAllBooks().filter((b) => b.society_id === societyId);
    setMemberCount(members.length);
    setBookCount(books.length);
  }, []);

  // Supabase authoritative check. Runs once on mount — the user just
  // finished registration so the parent + child rows exist by now. We
  // fetch both "am I alone?" (drives the celebration / share-CTA copy)
  // and the distinct-parent count (drives the "Xth member" line) in
  // parallel so the page settles in one network round-trip's worth of
  // time.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const parent = await getCurrentParent();
        if (cancelled) return;
        if (!parent?.society_id) {
          setIsAloneSupabase(null); // can't determine; keep localStorage guess
          return;
        }
        const [alone, count] = await Promise.all([
          isAloneInSociety(parent.society_id, parent.id),
          countDistinctParentsInSociety(parent.society_id),
        ]);
        if (cancelled) return;
        setIsAloneSupabase(alone);
        setSupabaseMemberCount(count);
      } catch (err) {
        console.error("[success] supabase membership check failed:", err);
      }
    }
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  // Prefer the Supabase answer when available, otherwise fall back to the
  // localStorage member count. This keeps the page snappy on slow networks
  // while still self-correcting once the real data arrives.
  const isFirst =
    isAloneSupabase !== null ? isAloneSupabase : memberCount <= 1;
  // Display count uses Supabase when we have it (>0); falls back to
  // localStorage on cold-load or error. localStorage is the user's own
  // device-known children — after a sign-out it's just them, so it's
  // misleading. Authoritative count is the same query that decides
  // isAlone, so once isAloneSupabase resolves, this is in lockstep.
  const displayMemberCount =
    supabaseMemberCount > 0 ? supabaseMemberCount : memberCount;

  return (
    <main className="flex-grow flex flex-col items-center justify-center p-6 relative overflow-hidden pb-32"
      style={{
        backgroundImage: `
          radial-gradient(circle at 20% 30%, #4fc4fc 4px, transparent 4px),
          radial-gradient(circle at 80% 20%, #ffca4d 6px, transparent 6px),
          radial-gradient(circle at 40% 80%, #a7fc46 5px, transparent 5px),
          radial-gradient(circle at 70% 60%, #f95630 4px, transparent 4px),
          radial-gradient(circle at 10% 90%, #3cb7ed 6px, transparent 6px)
        `,
        backgroundSize: "200px 200px",
      }}
    >
      {/* Decorative blobs */}
      <div className="absolute -top-24 -left-24 w-64 h-64 bg-tertiary/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -right-24 w-80 h-80 bg-primary/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md flex flex-col items-center text-center relative z-10">

        {/* Mascot card */}
        <div className="relative mb-8">
          <div className="absolute inset-0 bg-primary/10 blur-[32px] rounded-full translate-y-2" />
          <div className="relative bg-surface-container-lowest rounded-xl p-8 shadow-sm">
            <div className="w-40 h-40 rounded-2xl overflow-hidden">
              <img
                src="/bookworm.png"
                alt="BookBuddy worm celebrating"
                className="w-[200%] h-[200%] object-cover"
                style={{ objectPosition: "100% 0%" }}
              />
            </div>
            {/* Badge */}
            <div className="absolute -top-4 -right-4 bg-secondary-container p-3 rounded-lg rotate-12 shadow-lg">
              <span
                className="material-symbols-outlined text-on-secondary-container text-3xl"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                {isFirst ? "workspace_premium" : "star"}
              </span>
            </div>
          </div>
        </div>

        {/* Headline */}
        <div className="space-y-4 px-4">
          <h1 className="font-headline font-extrabold text-4xl tracking-tight text-on-surface leading-tight">
            Welcome, {childName}!
          </h1>
          <p className="text-on-surface-variant font-body text-lg max-w-xs mx-auto leading-relaxed">
            {isFirst ? (
              <>You are the very first member of your society&apos;s library club!</>
            ) : (
              <>
                You are officially the{" "}
                <b>
                  {displayMemberCount}
                  {ordinalSuffix(displayMemberCount)}
                </b>{" "}
                member of your society&apos;s library club!
              </>
            )}
          </p>
        </div>

        {/* CTAs */}
        <div className="mt-8 w-full space-y-4">

          {/* CTA 1: List book */}
          <div className="flex flex-col gap-2">
            <Link href="/book/list" className="block">
              <button className="w-full py-4 px-6 rounded-xl bg-gradient-to-br from-[#a7fc46] to-[#417000] shadow-[0_8px_32px_rgba(65,112,0,0.12)] active:scale-95 transition-transform group flex flex-col items-center">
                <span className="flex items-center justify-center gap-3 font-headline font-bold text-lg text-white">
                  List your first book
                  <span className="material-symbols-outlined font-bold group-hover:translate-x-1 transition-transform">
                    arrow_forward
                  </span>
                </span>
              </button>
            </Link>
            <p className="font-body font-medium text-xs text-on-surface-variant">
              {isFirst
                ? "Your society's library starts with YOU."
                : "List a book to unlock borrowing from society library!"}
            </p>
          </div>

          {/* CTA 2: Browse library */}
          <div className="flex flex-col gap-2">
            {isFirst ? (
              <button
                disabled
                className="w-full py-4 px-6 rounded-xl bg-gray-500 border-2 border-gray-400 cursor-not-allowed opacity-80 flex flex-col items-center"
              >
                <span className="flex items-center justify-center gap-3 font-headline font-bold text-lg text-white">
                  Browse library
                  <span className="material-symbols-outlined font-bold">local_library</span>
                </span>
              </button>
            ) : (
              <Link href="/" className="block">
                <button className="w-full py-4 px-6 rounded-xl bg-white border-2 border-primary/20 hover:bg-primary-container/10 active:scale-95 transition-transform group flex flex-col items-center">
                  <span className="flex items-center justify-center gap-3 font-headline font-bold text-lg text-primary">
                    Browse library
                    <span className="material-symbols-outlined font-bold group-hover:translate-x-1 transition-transform">
                      local_library
                    </span>
                  </span>
                </button>
              </Link>
            )}
            <p className={`font-body text-xs text-on-surface-variant text-center px-4 ${isFirst ? "italic opacity-80" : "font-medium"}`}>
              {isFirst
                ? "Build your library first by inviting your friends to join"
                : `There are already ${bookCount} books listed in your society!`}
            </p>
          </div>

          {/* Share CTA — prominent variant turns the "you're first!" moment
              into an invite nudge; everyone else gets the compact default
              button. Both rely on the OS share sheet where available, with
              a clipboard fallback. */}
          <div className="pt-2">
            {isFirst ? (
              <ShareAppButton
                variant="prominent"
                headline="You're first in your society!"
                subhead="Share BookBuddy in your society WhatsApp group so there are books to borrow."
              />
            ) : (
              <ShareAppButton variant="default" />
            )}
          </div>
        </div>
      </div>

      {/* Toast */}
      <div className="fixed top-8 inset-x-0 flex justify-center pointer-events-none z-50">
        <div className="bg-tertiary text-white px-8 py-3 rounded-full font-headline font-bold shadow-lg flex items-center gap-3 animate-bounce">
          <span
            className="material-symbols-outlined"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            celebration
          </span>
          Account Created Successfully!
        </div>
      </div>
    </main>
  );
}
