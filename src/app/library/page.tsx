/**
 * /library — anonymous browse entry point.
 *
 * Two render states gated by `bb_pending_society` localStorage:
 *   1. No pending society    → LibraryPicker (Screen 2): GPS detect /
 *      typeahead search / manual entry. Picking a society stores it
 *      and flips the page into state 2.
 *   2. Pending society set   → LibraryBrowse (Screens 3/4): a top bar
 *      showing the society name + a "Complete sign-up" avatar, then
 *      either the "Be the first" empty state or the book grid.
 *
 * State 2 is a follow-up commit; this file ships the picker only and
 * renders a placeholder for now if a pending society is detected (e.g.
 * the user previously picked one and reloaded).
 *
 * Anyone who's *signed in* and lands here gets bounced to the real
 * home page — no value in showing the public picker to a logged-in
 * user, and the auth gate on `/` won't have caught them since they
 * came directly to /library.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import {
  publicSearchSocieties,
  publicListBooksForSociety,
  setPendingSociety,
  getPendingSociety,
  clearPendingSociety,
  type PublicSocietyRow,
  type PublicBookRow,
  type PendingSociety,
} from "@/lib/supabase/publicBrowse";
import { suggestCities, canonicaliseCity } from "@/lib/cities";

/** Nominatim reverse-geocode shape (subset we use). */
interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  address?: {
    house?: string;
    building?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    town?: string;
    state?: string;
  };
}

function extractSocietyName(r: NominatimResult): string {
  const a = r.address ?? {};
  return (
    a.building ||
    a.house ||
    a.neighbourhood ||
    a.suburb ||
    r.display_name.split(",")[0]
  ).trim();
}
function extractCity(r: NominatimResult): string {
  const a = r.address ?? {};
  return (a.city || a.town || "").trim();
}

type LocationState =
  | { status: "idle" }
  | { status: "detecting" }
  | { status: "error"; message: string };

type PageMode = "checking-auth" | "picker" | "browse";

export default function LibraryPage() {
  const router = useRouter();
  const [mode, setMode] = useState<PageMode>("checking-auth");
  const [pendingSociety, setPendingSocietyState] = useState<PendingSociety | null>(
    null
  );

  // Auth + pending-society probe on mount. /library is now picker-only:
  // anyone with a session OR a previously picked society renders the
  // unified grid at /, so /library is reached only by visitors who
  // need to pick a society first. The legacy browse mode in this file
  // is dead code — kept temporarily to avoid scope-creep on this PR.
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const supabase = getSupabase();
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        if (data.session?.user?.id) {
          router.replace("/");
          return;
        }
        const stored = getPendingSociety();
        if (cancelled) return;
        if (stored) {
          // Visitor already picked a society in a prior visit. Send
          // them to the home grid instead of the orphan browse view.
          router.replace("/");
        } else {
          setMode("picker");
        }
      } catch (err) {
        console.warn("[library] auth probe failed:", err);
        if (!cancelled) setMode("picker");
      }
    }
    probe();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (mode === "checking-auth") {
    return (
      <main className="flex-1 w-full flex items-center justify-center">
        <div
          className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin"
          aria-label="Loading"
        />
      </main>
    );
  }

  if (mode === "browse") {
    return <LibraryBrowse society={pendingSociety!} />;
  }

  return <LibraryPicker />;
}

/* ──────────────────────────────────────────────────────────────────
 * Picker — Screen 2
 * ──────────────────────────────────────────────────────────────────
 */

function LibraryPicker() {
  const [location, setLocation] = useState<LocationState>({ status: "idle" });
  const [searchQuery, setSearchQuery] = useState("");
  const [supabaseResults, setSupabaseResults] = useState<PublicSocietyRow[]>([]);
  const [osmResults, setOsmResults] = useState<NominatimResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Manual entry expansion — collapsed by default; the inline link
  // ("Can't find your society? Enter manually") flips it open.
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualCity, setManualCity] = useState("");
  const [citySuggestionsOpen, setCitySuggestionsOpen] = useState(false);
  const citySuggestions = suggestCities(manualCity);

  /** GPS + reverse-geocode → pending society in one go. */
  function detectLocation() {
    if (!navigator.geolocation) {
      setLocation({
        status: "error",
        message: "GPS not available on this device.",
      });
      return;
    }
    setLocation({ status: "detecting" });
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude: lat, longitude: lng } = pos.coords;
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
            { headers: { "Accept-Language": "en" } }
          );
          if (!res.ok) throw new Error("Reverse geocode failed");
          const data: NominatimResult = await res.json();
          const name = extractSocietyName(data);
          const city = extractCity(data);
          // GPS-detected societies don't yet have a real Supabase row,
          // so we leave `id` empty and rely on `findOrCreateSociety` at
          // sign-up time to mint or match it. We still persist the
          // user's pick so child-setup can pre-populate.
          handlePick({
            id: "",
            name,
            city,
            lat,
            lng,
            source: "gps",
          });
        } catch {
          setLocation({
            status: "error",
            message: "Couldn't fetch your address. Please search manually.",
          });
        }
      },
      (err) => {
        const msg =
          err.code === 1
            ? "Location permission denied. Please search manually."
            : "Couldn't get your location. Please search manually.";
        setLocation({ status: "error", message: msg });
      },
      { timeout: 10000 }
    );
  }

  /** Typeahead — Supabase + Nominatim in parallel, debounced. */
  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSupabaseResults([]);
      setOsmResults([]);
      return;
    }
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearching(true);
      const queryAtFire = searchQuery;

      const supaPromise = (async () => {
        try {
          const data = await publicSearchSocieties(queryAtFire);
          if (queryAtFire === searchQuery) setSupabaseResults(data);
        } catch (err) {
          console.warn("[library] supabase society search failed:", err);
        }
      })();

      const osmPromise = (async () => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(queryAtFire)}&format=json&addressdetails=1&limit=5`,
            { headers: { "Accept-Language": "en" } }
          );
          const data: NominatimResult[] = await res.json();
          if (queryAtFire === searchQuery) setOsmResults(data);
        } catch {
          /* silent — Supabase results carry the picker without OSM */
        }
      })();

      Promise.all([supaPromise, osmPromise]).finally(() => {
        if (queryAtFire === searchQuery) setSearching(false);
      });
    }, 350);

    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [searchQuery]);

  function handlePick(s: PendingSociety) {
    setPendingSociety(s);
    // After a pick, route to the home page — the unified grid (same
    // BookCard / search / filters as the registered home) renders
    // there for both authenticated and unauthenticated visitors.
    // Hard reload so all transient picker state (search query, OSM
    // results, etc.) drops cleanly.
    window.location.assign("/");
  }

  function pickSupabase(s: PublicSocietyRow) {
    handlePick({
      id: s.id,
      name: s.name,
      city: s.city,
      source: "search",
    });
  }
  function pickOsm(r: NominatimResult) {
    const name = extractSocietyName(r);
    const city = extractCity(r);
    handlePick({
      id: "",
      name,
      city,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      source: "search",
    });
  }
  function pickManual() {
    const name = manualName.trim();
    const city = canonicaliseCity(manualCity.trim());
    if (!name || !city) return;
    handlePick({ id: "", name, city, source: "manual" });
  }

  // Filter OSM hits that just duplicate a Supabase row by name —
  // OSM verbosity ("Society X, Sector 5, City") doesn't match
  // exactly, so we use a softer "name contains" rule.
  const supabaseKeys = new Set(
    supabaseResults.map(
      (s) => `${s.name.toLowerCase()}|${s.city.toLowerCase()}`
    )
  );
  const filteredOsm = osmResults.filter((r) => {
    const name = extractSocietyName(r).toLowerCase();
    const city = extractCity(r).toLowerCase();
    if (supabaseKeys.has(`${name}|${city}`)) return false;
    return supabaseResults.every(
      (s) => !s.name.toLowerCase().includes(name)
    );
  });

  return (
    <main className="flex-1 w-full max-w-xl mx-auto px-5 pb-24">
      {/* Back to /welcome. Standalone arrow per the design. */}
      <header className="pt-5">
        <Link
          href="/welcome"
          aria-label="Back"
          className="inline-flex w-10 h-10 items-center justify-center rounded-full hover:bg-surface-container-low transition-colors"
        >
          <span className="material-symbols-outlined text-primary text-2xl">
            arrow_back
          </span>
        </Link>
      </header>

      {/* Hero illustration */}
      <div className="flex justify-center mt-2">
        <div className="w-56 h-56 rounded-3xl bg-tertiary-container/30 flex items-center justify-center text-7xl">
          🐛
        </div>
      </div>

      {/* Description */}
      <p className="mt-8 text-center text-on-surface text-base leading-relaxed">
        To browse nearby books, we need to find your local library club by
        accessing your location.
      </p>

      {/* Detect-location card */}
      <button
        type="button"
        onClick={detectLocation}
        disabled={location.status === "detecting"}
        className="mt-8 w-full bg-primary-container/40 border-2 border-dashed border-primary rounded-3xl p-6 flex flex-col items-center gap-2 active:scale-[0.99] transition-transform disabled:opacity-70"
      >
        <span
          className="material-symbols-outlined text-primary text-3xl"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          my_location
        </span>
        <span className="font-headline font-extrabold text-on-surface text-2xl">
          {location.status === "detecting"
            ? "Detecting…"
            : "Detect my location"}
        </span>
        <span className="text-on-surface-variant text-sm text-center">
          Works best when you&apos;re at your society right now
        </span>
      </button>
      {location.status === "error" && (
        <p
          role="alert"
          className="mt-3 text-sm text-error text-center leading-snug"
        >
          {location.message}
        </p>
      )}

      {/* Search input */}
      <div className="relative mt-6">
        <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline">
          search
        </span>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Or search your society name"
          className="w-full bg-surface-container-low rounded-full pl-12 pr-4 py-3.5 text-base text-on-surface placeholder:text-outline-variant focus:ring-2 focus:ring-primary outline-none border-none"
        />
      </div>

      {/* Search results dropdown */}
      {(searchQuery.trim().length >= 2 ||
        supabaseResults.length > 0 ||
        filteredOsm.length > 0) && (
        <div className="mt-3 bg-surface rounded-2xl border border-outline-variant/20 overflow-hidden">
          {searching && (
            <p className="px-4 py-3 text-xs text-outline">Searching…</p>
          )}
          {supabaseResults.map((s) => (
            <button
              key={`supa-${s.id}`}
              type="button"
              onClick={() => pickSupabase(s)}
              className="w-full px-4 py-3 flex items-start justify-between gap-3 hover:bg-surface-container-low text-left border-b border-outline-variant/10 last:border-b-0"
            >
              <div className="flex-1 leading-tight">
                <p className="font-bold text-on-surface text-sm">{s.name}</p>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  {s.city}
                </p>
              </div>
              {s.member_count >= 3 && (
                <span className="shrink-0 text-xs text-primary font-bold flex items-center gap-1">
                  <span
                    className="material-symbols-outlined text-sm"
                    style={{ fontVariationSettings: "'FILL' 1" }}
                  >
                    verified
                  </span>
                  Verified
                </span>
              )}
            </button>
          ))}
          {filteredOsm.map((r) => (
            <button
              key={`osm-${r.place_id}`}
              type="button"
              onClick={() => pickOsm(r)}
              className="w-full px-4 py-3 flex items-start gap-3 hover:bg-surface-container-low text-left border-b border-outline-variant/10 last:border-b-0"
            >
              <span className="material-symbols-outlined text-outline shrink-0">
                location_on
              </span>
              <div className="flex-1 leading-tight">
                <p className="font-bold text-on-surface text-sm">
                  {extractSocietyName(r)}
                </p>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  {extractCity(r) || r.display_name}
                </p>
              </div>
            </button>
          ))}
          {!searching &&
            supabaseResults.length === 0 &&
            filteredOsm.length === 0 &&
            searchQuery.trim().length >= 2 && (
              <p className="px-4 py-3 text-sm text-outline">
                No matches. Try a different name or enter manually below.
              </p>
            )}
        </div>
      )}

      {/* Manual entry */}
      <div className="mt-5">
        {!manualOpen ? (
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="flex items-center gap-2 text-primary font-bold text-base"
          >
            <span
              className="material-symbols-outlined text-primary"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              edit_location_alt
            </span>
            Can&apos;t find your society? Enter manually
          </button>
        ) : (
          <div className="bg-surface-container-low rounded-2xl p-4 space-y-3">
            <h3 className="font-headline font-bold text-on-surface text-sm">
              Enter your society details
            </h3>
            <input
              type="text"
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="Society name"
              className="w-full bg-surface rounded-xl px-4 py-3 text-sm text-on-surface placeholder:text-outline-variant border border-outline-variant/30 focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
            />
            <div className="relative">
              <input
                type="text"
                value={manualCity}
                onChange={(e) => {
                  setManualCity(e.target.value);
                  setCitySuggestionsOpen(true);
                }}
                onBlur={() =>
                  setTimeout(() => setCitySuggestionsOpen(false), 150)
                }
                onFocus={() => setCitySuggestionsOpen(true)}
                placeholder="City"
                className="w-full bg-surface rounded-xl px-4 py-3 text-sm text-on-surface placeholder:text-outline-variant border border-outline-variant/30 focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
              />
              {citySuggestionsOpen && citySuggestions.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full bg-surface rounded-xl border border-outline-variant/30 overflow-hidden max-h-44 overflow-y-auto">
                  {citySuggestions.map((c) => (
                    <li key={c}>
                      <button
                        type="button"
                        onClick={() => {
                          setManualCity(c);
                          setCitySuggestionsOpen(false);
                        }}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-surface-container-low"
                      >
                        {c}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={pickManual}
                disabled={!manualName.trim() || !manualCity.trim()}
                className="flex-1 bg-primary text-on-primary font-bold text-sm py-3 rounded-full disabled:opacity-50 active:scale-95 transition-transform"
              >
                Use this society
              </button>
              <button
                type="button"
                onClick={() => setManualOpen(false)}
                className="px-5 text-on-surface-variant font-bold text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Locked-preview teaser ("Your Neighbourhood Library"). Pure
          decoration — until the visitor picks a society we have no
          real books to show. The padlock thumbnails are a visual
          promise of what comes next. */}
      <section className="mt-12">
        <h2 className="text-2xl font-headline font-extrabold text-tertiary text-center">
          Your Neighbourhood Library
        </h2>
        <div className="mt-5 grid grid-cols-3 gap-3 opacity-70">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="aspect-[3/4] rounded-2xl bg-surface-container flex items-center justify-center"
            >
              <span className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center">
                <span className="material-symbols-outlined text-outline text-lg">
                  lock
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Browse — Screens 3 (empty) and 4 (populated)
 * ──────────────────────────────────────────────────────────────────
 *
 * Renders the post-pick view. Pulls books for the chosen society via
 * the SECURITY DEFINER public RPC. Two paths:
 *   - 0 books: "Be the first to start the library" empty state with
 *     two CTAs (sign up / WhatsApp share).
 *   - 1+ books: persistent "Unlock Borrowing!" banner + search + genre
 *     filter chips + 2-column grid.
 *
 * Cards are non-tappable for now — anonymous book detail with a locked
 * borrow CTA can come in a follow-up. Today the path forward is "tap
 * the banner / sign up / pick a different society".
 */

function LibraryBrowse({ society }: { society: PendingSociety }) {
  const [books, setBooks] = useState<PublicBookRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [genreFilter, setGenreFilter] = useState<string | null>(null);

  // Fetch books on mount. The picker stores three id-shapes:
  //   - "" when the user picked via GPS / OSM / manual entry — those
  //     paths return a name + city but no Supabase UUID.
  //   - real UUID when the user picked from the Supabase typeahead.
  //
  // Empty `id` does NOT necessarily mean the society has no row in
  // Supabase — Seawoods NRI Complex has 4 books even when reached via
  // GPS detect. So before falling through to "no books", try resolving
  // the UUID by name + city via the public search RPC. If we find a
  // match, persist it back to localStorage so subsequent loads skip
  // this lookup.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      let societyId = society.id;

      if (!societyId) {
        try {
          const matches = await publicSearchSocieties(society.name);
          if (cancelled) return;
          // Match on (name, city) case-insensitively. The search RPC
          // already does ILIKE on name; we add the city check here so
          // a "Sunshine Society" in Delhi doesn't claim books listed
          // under "Sunshine Society" in Mumbai.
          // Name matching is substring in either direction: Nominatim
          // often returns a shorter form ("NRI Complex") while Supabase
          // has the fuller name registered by the first member
          // ("Seawoods NRI Complex"). The RPC's ILIKE already surfaces
          // the row; we just need to confirm it's the same society, not
          // a different one in the same city.
          const cityKey = society.city.trim().toLowerCase();
          const nameKey = society.name.trim().toLowerCase();
          const hit = matches.find((m) => {
            const mName = m.name.trim().toLowerCase();
            const mCity = m.city.trim().toLowerCase();
            const nameMatch =
              mName === nameKey ||
              mName.includes(nameKey) ||
              nameKey.includes(mName);
            return nameMatch && mCity === cityKey;
          });
          if (hit) {
            societyId = hit.id;
            // Patch localStorage so future page loads (e.g. a refresh
            // mid-session) skip the resolve hop.
            setPendingSociety({ ...society, id: hit.id });
          }
        } catch (err) {
          console.warn(
            "[library] resolveSocietyId by name+city failed:",
            err
          );
        }
      }

      if (!societyId) {
        if (!cancelled) setBooks([]);
        return;
      }

      const rows = await publicListBooksForSociety(societyId);
      if (!cancelled) setBooks(rows);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [society.id, society.name, society.city]);

  // Genre chips — "All Books" + every distinct category in the
  // current society's listings. Cap to a sensible width by dropping
  // duplicates and sorting alphabetically.
  const genres = useMemo(() => {
    if (!books) return [];
    const set = new Set<string>();
    for (const b of books) {
      if (b.category) set.add(b.category);
    }
    return Array.from(set).sort();
  }, [books]);

  const filtered = useMemo(() => {
    if (!books) return [];
    let out = books;
    if (genreFilter) out = out.filter((b) => b.category === genreFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.author?.toLowerCase().includes(q) ||
          b.child_name.toLowerCase().includes(q)
      );
    }
    // Sort: available first, then by listed_at desc.
    return [...out].sort((a, b) => {
      const aAvail = a.status === "available" ? 0 : 1;
      const bAvail = b.status === "available" ? 0 : 1;
      if (aAvail !== bAvail) return aAvail - bAvail;
      return (
        new Date(b.listed_at).getTime() - new Date(a.listed_at).getTime()
      );
    });
  }, [books, genreFilter, search]);

  function handleSwitchSociety() {
    if (
      window.confirm(
        "Switch societies? You'll go back to the picker."
      )
    ) {
      clearPendingSociety();
      window.location.assign("/library");
    }
  }

  function handleShareWhatsApp() {
    const url =
      process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin : "");
    const text = `Hey! Let's start a book-sharing club for ${society.name} on BookBuds 📚 — list one book, borrow many. ${url}`;
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator
        .share({ title: "BookBuds", text, url })
        .catch(() => {
          /* user cancelled — silent */
        });
      return;
    }
    // WhatsApp Web/desktop fallback.
    const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(wa, "_blank", "noopener,noreferrer");
  }

  const isEmpty = books !== null && books.length === 0;
  const isLoading = books === null;

  return (
    <main className="flex-1 w-full max-w-2xl mx-auto px-5 pb-24">
      {/* Top bar — society label on the left, sign-up avatar on the
          right. Tapping the society opens the switch confirm. */}
      <header className="sticky top-0 z-40 bg-surface/80 backdrop-blur-md py-4 flex items-center justify-between">
        <button
          type="button"
          onClick={handleSwitchSociety}
          className="flex items-center gap-2 active:scale-95 transition-transform"
        >
          <span
            className="material-symbols-outlined text-primary text-xl"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            location_on
          </span>
          <span className="font-headline font-extrabold text-on-surface text-base text-left line-clamp-1 max-w-[180px]">
            {society.name}
          </span>
        </button>
        <Link
          href="/auth/sign-in"
          aria-label="Sign in or complete profile"
          className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center hover:bg-primary-container/80 transition-colors"
        >
          <span className="material-symbols-outlined text-on-primary-container">
            person
          </span>
        </Link>
      </header>

      {isLoading ? (
        <div className="mt-16 flex justify-center">
          <div
            className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin"
            aria-label="Loading books"
          />
        </div>
      ) : isEmpty ? (
        <EmptyState
          society={society}
          onShareWhatsApp={handleShareWhatsApp}
        />
      ) : (
        <PopulatedState
          society={society}
          books={books!}
          filtered={filtered}
          genres={genres}
          genreFilter={genreFilter}
          setGenreFilter={setGenreFilter}
          search={search}
          setSearch={setSearch}
        />
      )}
    </main>
  );
}

/* ── Empty state (Screen 3) ───────────────────────────────────────── */

function EmptyState({
  society,
  onShareWhatsApp,
}: {
  society: PendingSociety;
  onShareWhatsApp: () => void;
}) {
  return (
    <div className="mt-4">
      <div className="flex justify-center">
        <div className="w-56 h-56 rounded-3xl bg-tertiary-container/30 flex items-center justify-center text-7xl">
          🐛
        </div>
      </div>
      <div className="mt-8 bg-surface-container-low rounded-3xl p-6 text-center">
        <h2 className="font-headline font-extrabold text-on-surface text-2xl leading-tight">
          Be the first to start <br />
          the library in{" "}
          <span className="text-primary">{society.name}!</span>
        </h2>
        <p className="mt-3 text-on-surface-variant text-sm leading-relaxed">
          It looks like it&apos;s quiet here. Plant the first seed of
          knowledge and watch your community&apos;s bookshelf grow!
        </p>
      </div>
      <div className="mt-6 space-y-3">
        <Link
          href="/auth/sign-in"
          className="w-full flex items-center justify-center gap-2 bg-primary text-on-primary font-bold text-base py-4 rounded-full active:scale-95 transition-transform"
        >
          Complete Sign Up to List a Book
          <span
            className="material-symbols-outlined text-lg"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            add_circle
          </span>
        </Link>
        <button
          type="button"
          onClick={onShareWhatsApp}
          className="w-full flex items-center justify-center gap-2 bg-surface-container-high text-on-surface font-bold text-base py-3.5 rounded-full active:scale-95 transition-transform"
        >
          <span className="material-symbols-outlined text-primary">
            chat
          </span>
          Share on WhatsApp
        </button>
      </div>
    </div>
  );
}

/* ── Populated state (Screen 4) ───────────────────────────────────── */

function PopulatedState({
  books,
  filtered,
  genres,
  genreFilter,
  setGenreFilter,
  search,
  setSearch,
}: {
  society: PendingSociety;
  books: PublicBookRow[];
  filtered: PublicBookRow[];
  genres: string[];
  genreFilter: string | null;
  setGenreFilter: (g: string | null) => void;
  search: string;
  setSearch: (v: string) => void;
}) {
  return (
    <>
      {/* "Unlock borrowing" upsell — sticky-ish at the top of the
          scroll, doesn't overlap header. */}
      <div className="mt-3 bg-surface-container-low rounded-2xl p-4 flex items-start gap-3 shadow-sm">
        <span
          className="shrink-0 w-10 h-10 rounded-full bg-primary-container flex items-center justify-center"
          aria-hidden
        >
          <span
            className="material-symbols-outlined text-primary text-xl"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            auto_awesome
          </span>
        </span>
        <div className="flex-1 leading-snug">
          <h3 className="font-headline font-bold text-on-surface text-base">
            Unlock Borrowing!
          </h3>
          <p className="text-xs text-on-surface-variant mt-1">
            Complete your sign-up to start bringing these stories home.
          </p>
          <Link
            href="/auth/sign-in"
            className="mt-3 inline-flex items-center justify-center w-full bg-primary text-on-primary font-bold text-sm py-2.5 rounded-full active:scale-95 transition-transform"
          >
            Complete Profile
          </Link>
        </div>
      </div>

      {/* Search */}
      <div className="relative mt-5">
        <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline">
          search
        </span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search for magical tales nearby..."
          className="w-full bg-surface-container-low rounded-full pl-12 pr-4 py-3 text-sm text-on-surface placeholder:text-outline-variant focus:ring-2 focus:ring-primary outline-none border-none"
        />
      </div>

      {/* Genre chips */}
      {genres.length > 0 && (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
          <button
            type="button"
            onClick={() => setGenreFilter(null)}
            className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-bold transition-colors ${
              genreFilter === null
                ? "bg-primary text-on-primary"
                : "bg-surface text-on-surface-variant border border-outline-variant/30"
            }`}
          >
            All Books
          </button>
          {genres.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGenreFilter(g)}
              className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-bold transition-colors ${
                genreFilter === g
                  ? "bg-primary text-on-primary"
                  : "bg-surface text-on-surface-variant border border-outline-variant/30"
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      {/* Section header */}
      <div className="mt-5 flex items-end justify-between">
        <h2 className="text-3xl font-headline font-extrabold text-on-surface leading-tight">
          Available <br /> Nearby
        </h2>
        <p className="text-sm text-on-surface-variant text-right leading-snug">
          {books.length} {books.length === 1 ? "book" : "books"}
          <br /> in your society
        </p>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <p className="mt-8 text-center text-on-surface-variant text-sm">
          No matches. Try clearing the search or genre filter.
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-4">
          {filtered.map((b) => (
            <PublicBookCard key={b.id} book={b} />
          ))}
        </div>
      )}
    </>
  );
}

/* ── Card ─────────────────────────────────────────────────────────── */

function PublicBookCard({ book }: { book: PublicBookRow }) {
  const isOutOfStock = book.status === "out_of_stock";
  const isBorrowed = book.status === "borrowed";

  return (
    <div className="bg-surface rounded-2xl shadow-sm overflow-hidden flex flex-col">
      <div className="aspect-[3/4] bg-surface-container relative">
        {book.cover_url ? (
          // Plain <img> — these covers are public Open-Library URLs and
          // we don't have a Next/image loader configured for them.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={book.cover_url}
            alt={book.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="material-symbols-outlined text-outline text-5xl">
              menu_book
            </span>
          </div>
        )}
        {(isOutOfStock || isBorrowed) && (
          <div className="absolute inset-x-0 bottom-0 bg-error-container/90 text-on-error-container text-[10px] font-bold uppercase tracking-wider py-1.5 text-center">
            {isOutOfStock ? "Out of stock" : "Borrowed"}
          </div>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-1">
        <h3 className="font-headline font-bold text-on-surface text-sm leading-tight line-clamp-2">
          {book.title}
        </h3>
        <div className="mt-auto flex items-center gap-1 text-xs text-on-surface-variant">
          <span className="material-symbols-outlined text-sm">person</span>
          <span className="line-clamp-1">Listed by {book.child_name}</span>
        </div>
      </div>
    </div>
  );
}
