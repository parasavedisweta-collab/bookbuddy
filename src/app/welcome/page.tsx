/**
 * /welcome — marketing landing for unauthenticated visitors.
 *
 * The home page (`/`) used to redirect logged-out users straight to
 * /auth/sign-in. That made cold-traffic conversion brutal — strangers
 * arriving from a WhatsApp share link were dropped into a sign-in form
 * with no context. This page replaces that landing: explains what
 * BookBuds is, walks through the six-step user journey, and offers
 * two paths forward — direct sign-up ("Get Started") or peek-first
 * ("Start Browsing", which routes to /library for the society picker).
 *
 * Pure presentation — no data fetching, no auth gate. If a *signed-in*
 * user lands here (e.g. via a stale link), the buttons still work
 * naturally: Get Started → /auth/sign-in is bounced by sign-in's own
 * "you're already signed in" flow back to /, and Start Browsing →
 * /library will check session and route to the authenticated home.
 */
"use client";

import Link from "next/link";

const HOW_IT_WORKS: Array<{ n: number; title: string; body: string; color: string }> = [
  {
    n: 1,
    title: "Sign Up in a Minute",
    body: "Register with your email to get started.",
    color: "bg-secondary text-on-secondary",
  },
  {
    n: 2,
    title: "Snap and List Your Favourites",
    body: "Photograph the book — AI fills the details.",
    color: "bg-primary text-on-primary",
  },
  {
    n: 3,
    title: "Browse Your Neighbours' Shelves",
    body: "Search by title, author, genre, or friend.",
    color: "bg-tertiary text-on-tertiary",
  },
  {
    n: 4,
    title: "Request and Get Approval",
    body: "Request a book and wait for lister's approval.",
    color: "bg-secondary-container text-on-secondary-container",
  },
  {
    n: 5,
    title: "See Contact Details and Coordinate",
    body: "Once approved, view lister's contact and arrange pickup.",
    color: "bg-primary-container text-on-primary-container",
  },
  {
    n: 6,
    title: "Read and Return",
    body: "Read it, then meet to return.",
    color: "bg-tertiary-container text-on-tertiary-container",
  },
];

export default function WelcomePage() {
  return (
    <main className="flex-1 w-full max-w-2xl mx-auto px-5 pb-12">
      {/* ── Top bar: logo + Get Started ─────────────────────────── */}
      <header className="sticky top-0 z-40 bg-surface/80 backdrop-blur-md py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-2xl">
            auto_stories
          </span>
          <span className="text-primary font-headline font-extrabold text-xl">
            BookBuds
          </span>
        </div>
        <Link
          href="/auth/sign-in"
          className="bg-primary text-on-primary font-bold text-sm px-5 py-2 rounded-full active:scale-95 transition-transform"
        >
          Get Started
        </Link>
      </header>

      {/* ── Hero ───────────────────────────────────────────────── */}
      <section className="text-center pt-6">
        <h1 className="text-4xl font-headline font-extrabold text-primary leading-tight">
          Welcome to <br className="sm:hidden" />
          BookBuds 📚
        </h1>
        <p className="mt-3 text-on-surface-variant text-base">
          The book-sharing community for your neighbourhood.
        </p>
      </section>

      {/* ── Hero illustration ──────────────────────────────────────
          Wide banner showing kids reading together — sets the
          community tone before the marketing copy. Bleeds to the
          screen edges on mobile (negates the px-5 main padding) for
          a more immersive feel, then stays rounded inside the
          content column on tablet/desktop.
          eslint-disable-next-line @next/next/no-img-element — public
          static asset, no Next/Image loader configured. */}
      <section className="mt-6 -mx-5 sm:mx-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/welcome-hero.jpg"
          alt="Kids reading books together in their society garden"
          className="w-full sm:rounded-3xl object-cover aspect-[1024/434]"
          loading="eager"
        />
      </section>

      {/* ── Pitch card ─────────────────────────────────────────── */}
      <section className="mt-8 bg-surface-container-low rounded-3xl p-6">
        <p className="text-on-surface text-sm leading-relaxed text-center">
          Got a shelf full of books your child has outgrown? Looking for the
          next adventure to read? BookBuds is where families in your society
          come together to share, swap, and discover books — for free. We
          believe every book is too good to read just once. So we built a
          place where bookworms find each other, list their favourites, and
          borrow from their neighbours. No money, no shipping, no hassle.
          Just kids, books, and the joy of reading together.
        </p>
        <p className="mt-4 text-primary font-bold text-sm leading-snug text-center">
          List your favourites. Discover your neighbours&apos; books. Borrow
          what you love.
        </p>
      </section>

      {/* ── How it works ───────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="text-3xl font-headline font-extrabold text-primary text-center">
          How It Works
        </h2>
        <ol className="mt-6 space-y-3">
          {HOW_IT_WORKS.map((step) => (
            <li
              key={step.n}
              className="bg-surface-container-low rounded-2xl p-4 flex items-start gap-4"
            >
              <span
                className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center font-headline font-extrabold text-base ${step.color}`}
              >
                {step.n}
              </span>
              <div className="flex-1 leading-snug">
                <h3 className="font-headline font-bold text-on-surface text-base">
                  {step.title}
                </h3>
                <p className="text-on-surface-variant text-sm mt-1">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Library Peek CTA ───────────────────────────────────── */}
      <section className="mt-10 bg-primary-container/40 rounded-3xl p-6 text-center">
        <h2 className="text-2xl font-headline font-extrabold text-primary leading-tight">
          Peek Into the <br />
          Neighbourhood Library
        </h2>
        <p className="mt-3 text-on-surface-variant text-sm leading-relaxed">
          Your society&apos;s bookshelf is just a tap away. Browse what your
          neighbours are reading, find a fresh adventure, and request your
          next favourite read.
        </p>
        <Link
          href="/library"
          className="mt-5 inline-flex items-center justify-center gap-2 bg-primary text-on-primary font-bold text-base px-6 py-3 rounded-full active:scale-95 transition-transform"
        >
          Start Browsing
          <span className="material-symbols-outlined text-lg">arrow_forward</span>
        </Link>
      </section>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="mt-12 text-center text-xs text-on-surface-variant">
        <p className="text-primary font-headline font-extrabold text-base">
          BookBuds
        </p>
        <nav className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <Link href="/welcome" className="hover:underline">
            Privacy
          </Link>
          <Link href="/welcome" className="hover:underline">
            Terms
          </Link>
          <a href="mailto:help@bookbuds.in" className="hover:underline">
            Support
          </a>
          <Link href="/library" className="hover:underline">
            Library Peek
          </Link>
        </nav>
        <p className="mt-3 text-outline">
          © {new Date().getFullYear()} BookBuds. Made with joy for little
          readers.
        </p>
      </footer>
    </main>
  );
}
