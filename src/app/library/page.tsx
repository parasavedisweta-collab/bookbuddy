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

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import {
  publicSearchSocieties,
  setPendingSociety,
  getPendingSociety,
  type PublicSocietyRow,
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

  // Auth + pending-society probe on mount. Logged-in users go straight
  // to /; logged-out users with a stored pending society flip to browse;
  // everyone else stays on the picker.
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
          setPendingSocietyState(stored);
          setMode("browse");
        } else {
          setMode("picker");
        }
      } catch (err) {
        console.warn("[library] auth probe failed:", err);
        if (!cancelled) setMode("picker");
      }
    }
    probe();
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
    // Browse view ships in chunk 3. For now, a placeholder so a
    // reload after picking a society doesn't drop the user into the
    // picker again.
    return <BrowsePlaceholder society={pendingSociety!} />;
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
    // Hard reload — the picker page reads pending society on mount and
    // flips to the browse view. Router.refresh works too but reload
    // resets all transient state cleanly, including search/OSM/etc.
    window.location.assign("/library");
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
 * Browse-mode placeholder
 * ──────────────────────────────────────────────────────────────────
 */

function BrowsePlaceholder({ society }: { society: PendingSociety }) {
  return (
    <main className="flex-1 w-full max-w-xl mx-auto px-5 pb-24">
      <header className="pt-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="material-symbols-outlined text-primary text-xl"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            location_on
          </span>
          <span className="font-headline font-extrabold text-on-surface text-lg">
            {society.name}
          </span>
        </div>
        <Link
          href="/auth/sign-in"
          className="bg-primary text-on-primary font-bold text-xs px-4 py-2 rounded-full"
        >
          Sign up
        </Link>
      </header>
      <div className="mt-12 bg-surface-container-low rounded-3xl p-6 text-center space-y-4">
        <p className="font-headline font-extrabold text-on-surface text-xl">
          Browse view coming next
        </p>
        <p className="text-sm text-on-surface-variant">
          You picked <span className="font-bold">{society.name}</span> in{" "}
          {society.city}. The book grid lands in the next deploy.
        </p>
        <button
          type="button"
          onClick={() => {
            localStorage.removeItem("bb_pending_society");
            window.location.reload();
          }}
          className="text-primary font-bold text-sm"
        >
          Pick a different society
        </button>
      </div>
    </main>
  );
}
