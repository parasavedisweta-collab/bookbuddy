"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { AGE_RANGES, ageDisplayToDb } from "@/lib/types";
import {
  registerNewChild,
  searchSocieties,
  societyNameToId,
  type SocietySuggestion,
} from "@/lib/userStore";
import { suggestCities, canonicaliseCity } from "@/lib/cities";
import { findOrCreateSociety } from "@/lib/supabase/societies";
import { createParent } from "@/lib/supabase/parents";
import { createChild } from "@/lib/supabase/children";

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

/** Extract the most specific name from a Nominatim result. */
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

/** Final chosen society — source tells us how it was picked. */
type ChosenSociety = {
  id: string;
  name: string;
  city: string;
  source: "gps" | "osm" | "neighbour" | "manual";
  lat?: number;
  lng?: number;
};

type LocationState =
  | { status: "idle" }
  | { status: "detecting" }
  | { status: "error"; message: string };

export default function ChildSetupPage() {
  const router = useRouter();
  const [childName, setChildName] = useState("");
  const [ageGroup, setAgeGroup] = useState<string>("");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);

  const [chosen, setChosen] = useState<ChosenSociety | null>(null);
  const [location, setLocation] = useState<LocationState>({ status: "idle" });

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [osmResults, setOsmResults] = useState<NominatimResult[]>([]);
  const [neighbourResults, setNeighbourResults] = useState<SocietySuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Manual entry state
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualCity, setManualCity] = useState("");
  const [citySuggestionsOpen, setCitySuggestionsOpen] = useState(false);
  const citySuggestions = suggestCities(manualCity);

  /** GPS + reverse geocode */
  function detectLocation() {
    if (!navigator.geolocation) {
      setLocation({ status: "error", message: "GPS not available on this device." });
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
          setChosen({
            id: societyNameToId(name, city),
            name,
            city,
            source: "gps",
            lat,
            lng,
          });
          setLocation({ status: "idle" });
          setSearchQuery("");
          setOsmResults([]);
        } catch {
          setLocation({ status: "error", message: "Couldn't fetch your address. Please search manually." });
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

  /** Search — fires both neighbour (local) and OSM (remote) queries */
  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setOsmResults([]);
      setNeighbourResults([]);
      return;
    }

    // Neighbour search is synchronous from localStorage
    setNeighbourResults(searchSocieties(searchQuery).slice(0, 5));

    // OSM search — debounced
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&addressdetails=1&limit=5`,
          { headers: { "Accept-Language": "en" } }
        );
        const data: NominatimResult[] = await res.json();
        setOsmResults(data);
      } catch {
        // silent
      } finally {
        setSearching(false);
      }
    }, 400);
  }, [searchQuery]);

  function pickNeighbour(s: SocietySuggestion) {
    setChosen({ id: s.id, name: s.name, city: s.city, source: "neighbour" });
    clearSearch();
  }
  function pickOsm(r: NominatimResult) {
    const name = extractSocietyName(r);
    const city = extractCity(r);
    setChosen({
      id: societyNameToId(name, city),
      name,
      city,
      source: "osm",
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
    });
    clearSearch();
  }
  function pickManual() {
    const n = manualName.trim();
    const rawCity = manualCity.trim();
    // Map aliases like "bangalore" / "blr" to "Bengaluru".
    // Unknown cities fall back to title-cased user input.
    const c =
      canonicaliseCity(rawCity) ??
      rawCity.replace(/\b\w/g, (ch) => ch.toUpperCase());
    if (!n || !c) return;
    setChosen({ id: societyNameToId(n, c), name: n, city: c, source: "manual" });
    setManualOpen(false);
    setManualName("");
    setManualCity("");
    setCitySuggestionsOpen(false);
    clearSearch();
  }
  function clearSearch() {
    setSearchQuery("");
    setOsmResults([]);
    setNeighbourResults([]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!childName || !ageGroup || !consent || !chosen) return;
    setLoading(true);

    // Write to Supabase first. Dual-write to localStorage below keeps the
    // rest of the app (profile, home feed, book listing) working during
    // the migration — those callsites will move to Supabase reads next.
    //
    // Failures here fall through and still land the user on /success so
    // UAT smoke-testing isn't blocked by a transient network issue. The
    // error is logged loudly; admins can spot orphaned localStorage-only
    // accounts by diffing Supabase users against local traffic.
    try {
      const parentPhone =
        localStorage.getItem("bb_parent_phone") ?? undefined;
      const ageGroupDb = ageDisplayToDb(ageGroup);

      if (parentPhone && ageGroupDb) {
        const society = await findOrCreateSociety(chosen.name, chosen.city);
        if (society) {
          const parent = await createParent({
            phone: parentPhone,
            society_id: society.id,
          });
          if (parent) {
            await createChild({
              name: childName,
              age_group: ageGroupDb,
            });
          } else {
            console.warn(
              "[child-setup] parent insert returned null; continuing on local only"
            );
          }
        } else {
          console.warn(
            "[child-setup] society upsert returned null; continuing on local only"
          );
        }
      } else {
        console.warn(
          "[child-setup] missing phone or invalid age group; skipping Supabase writes",
          { parentPhone, ageGroup, ageGroupDb }
        );
      }
    } catch (err) {
      console.error("[child-setup] Supabase write failed:", err);
    }

    // Legacy localStorage path — keeps the rest of the app functional
    // until reads are migrated. Remove once profile/home/shelf/feed all
    // pull from Supabase.
    localStorage.setItem(
      "bb_child",
      JSON.stringify({
        name: childName,
        ageGroup,
        societyName: chosen.name,
        societyCity: chosen.city,
        societyLat: chosen.lat ?? null,
        societyLng: chosen.lng ?? null,
      })
    );

    const parentPhone = localStorage.getItem("bb_parent_phone") ?? undefined;
    registerNewChild({
      name: childName,
      ageGroup,
      societyId: chosen.id,
      societyName: chosen.name,
      societyCity: chosen.city,
      parentPhone,
    });

    router.push("/auth/success");
    setLoading(false);
  }

  const hasAnyResults = neighbourResults.length > 0 || osmResults.length > 0;
  const showResults = searchQuery.trim().length >= 2;

  return (
    <main className="flex-1 flex flex-col items-center px-6 pb-12 w-full max-w-lg mx-auto">
      {/* Header */}
      <div className="w-full flex items-center gap-3 py-6">
        <button
          onClick={() => router.back()}
          className="w-10 h-10 flex items-center justify-center bg-surface-container-high rounded-full text-primary"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div className="flex flex-col">
          <span className="text-xs font-bold uppercase tracking-widest text-secondary">
            Step 2 of 2
          </span>
          <div className="flex gap-1 mt-1">
            <div className="h-1.5 w-6 rounded-full bg-primary" />
            <div className="h-1.5 w-12 rounded-full bg-primary" />
          </div>
        </div>
      </div>

      {/* Hero */}
      <div className="text-center mb-8">
        <div className="w-32 h-32 rounded-2xl overflow-hidden shadow-md mx-auto mb-4">
          <img
            src="/bookworm.png"
            alt="BookBuddy worm reading"
            className="w-[200%] h-[200%] object-cover"
            style={{ objectPosition: "0% 0%" }}
          />
        </div>
        <h1 className="text-3xl font-extrabold text-on-surface leading-tight tracking-tight">
          Tell us about your child
        </h1>
        <p className="text-on-surface-variant mt-2 text-base">
          Help us personalize their reading journey.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="w-full space-y-8">
        <Input
          label="Child's first name"
          type="text"
          placeholder="e.g., Leo or Maya"
          value={childName}
          onChange={(e) => setChildName(e.target.value)}
          required
        />

        {/* Age Picker */}
        <div className="space-y-3">
          <label className="block text-sm font-bold text-secondary uppercase tracking-wider ml-1">
            How old is your reader?
          </label>
          <div className="grid gap-3 grid-cols-2">
            {AGE_RANGES.map((age) => (
              <button
                key={age}
                type="button"
                onClick={() => setAgeGroup(age)}
                className={`px-4 py-4 rounded-full font-bold text-base transition-all ${
                  ageGroup === age
                    ? "bg-primary-container text-on-primary-container border-2 border-primary shadow-lg"
                    : "bg-surface-container-lowest text-on-surface border-2 border-transparent hover:bg-primary hover:text-white"
                }`}
              >
                {age}
              </button>
            ))}
          </div>
        </div>

        {/* Society / Location */}
        <div className="space-y-3">
          <label className="block text-sm font-bold text-secondary uppercase tracking-wider ml-1">
            Your Residential Society
          </label>

          {/* CHOSEN STATE */}
          {chosen && (
            <div className="bg-primary-container/30 border border-primary/30 rounded-xl p-4 flex items-start gap-3">
              <span
                className="material-symbols-outlined text-primary text-2xl shrink-0 mt-0.5"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                {chosen.source === "neighbour" ? "groups" : chosen.source === "gps" ? "my_location" : "location_on"}
              </span>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-on-surface truncate">{chosen.name}</p>
                <p className="text-xs text-on-surface-variant mt-0.5 truncate">
                  {chosen.city && <>{chosen.city} · </>}
                  {chosen.source === "gps" && "Detected via GPS"}
                  {chosen.source === "osm" && "From map search"}
                  {chosen.source === "neighbour" && "Verified by your neighbours"}
                  {chosen.source === "manual" && "Entered manually"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setChosen(null); setLocation({ status: "idle" }); }}
                className="text-primary text-xs font-bold shrink-0"
              >
                Change
              </button>
            </div>
          )}

          {/* PICKER (when nothing chosen) */}
          {!chosen && (
            <div className="space-y-3">
              {/* GPS */}
              <button
                type="button"
                onClick={detectLocation}
                className="w-full bg-primary-container/20 border-2 border-dashed border-primary/30 rounded-xl p-5 flex flex-col items-center gap-2 hover:bg-primary-container/40 transition-colors"
              >
                <span
                  className="material-symbols-outlined text-primary text-3xl"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  my_location
                </span>
                <span className="font-bold text-on-surface">Detect my location</span>
                <span className="text-xs text-on-surface-variant">
                  Works best when you&apos;re at your society right now
                </span>
              </button>
              {location.status === "error" && (
                <p className="text-xs text-error font-medium px-1">{location.message}</p>
              )}
              {location.status === "detecting" && (
                <div className="bg-surface-container-low rounded-xl p-5 flex items-center gap-3">
                  <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
                  <p className="text-sm font-medium text-on-surface-variant">Detecting your location…</p>
                </div>
              )}

              {/* Search */}
              <div className="relative">
                <Input
                  label=""
                  placeholder="Or search your society name…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searching && (
                  <span className="absolute right-4 top-[38px] -translate-y-1/2 text-xs text-on-surface-variant">
                    Searching…
                  </span>
                )}

                {/* DROPDOWN */}
                {showResults && (
                  <div className="absolute z-20 w-full mt-1 bg-surface-container-high rounded-xl shadow-lg overflow-hidden border border-outline-variant/20 divide-y divide-outline-variant/10">

                    {/* 1. Verified neighbour matches (≥3 members) */}
                    {neighbourResults.filter((s) => s.verified).length > 0 && (
                      <div>
                        <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-primary">
                          ✓ Verified by neighbours
                        </p>
                        {neighbourResults.filter((s) => s.verified).map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => pickNeighbour(s)}
                            className="w-full text-left px-4 py-3 text-sm hover:bg-primary-container/30 transition-colors flex items-center gap-3"
                          >
                            <span className="material-symbols-outlined text-primary">verified</span>
                            <div className="flex-1 min-w-0">
                              <span className="font-semibold text-on-surface block truncate">{s.name}</span>
                              <span className="text-on-surface-variant text-xs block truncate">
                                {s.memberCount} neighbours here · {s.city}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* 2. Soft neighbour matches (1–2 members) */}
                    {neighbourResults.filter((s) => !s.verified).length > 0 && (
                      <div>
                        <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          Listed by a neighbour
                        </p>
                        {neighbourResults.filter((s) => !s.verified).map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => pickNeighbour(s)}
                            className="w-full text-left px-4 py-3 text-sm hover:bg-primary-container/30 transition-colors flex items-center gap-3"
                          >
                            <span className="material-symbols-outlined text-on-surface-variant">groups</span>
                            <div className="flex-1 min-w-0">
                              <span className="font-semibold text-on-surface block truncate">{s.name}</span>
                              <span className="text-on-surface-variant text-xs block truncate">
                                {s.memberCount} neighbour{s.memberCount === 1 ? "" : "s"} here · {s.city}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* 3. Map (OSM) results */}
                    {osmResults.length > 0 && (
                      <div>
                        <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          From map
                        </p>
                        {osmResults.map((r) => (
                          <button
                            key={r.place_id}
                            type="button"
                            onClick={() => pickOsm(r)}
                            className="w-full text-left px-4 py-3 text-sm hover:bg-primary-container/30 transition-colors flex items-center gap-3"
                          >
                            <span className="material-symbols-outlined text-on-surface-variant">location_on</span>
                            <div className="flex-1 min-w-0">
                              <span className="font-semibold text-on-surface block truncate">
                                {extractSocietyName(r)}
                              </span>
                              <span className="text-on-surface-variant text-xs block truncate">
                                {r.display_name}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* 4. "No matches" hint + manual-entry nudge */}
                    {!hasAnyResults && !searching && (
                      <div className="px-4 py-4">
                        <p className="text-sm text-on-surface-variant">
                          No matches for <span className="font-bold text-on-surface">&ldquo;{searchQuery}&rdquo;</span>.
                        </p>
                      </div>
                    )}

                    {/* 5. Create new (always last) */}
                    <button
                      type="button"
                      onClick={() => {
                        setManualName(searchQuery);
                        setManualOpen(true);
                        clearSearch();
                      }}
                      className="w-full text-left px-4 py-3 text-sm hover:bg-secondary-container/30 transition-colors flex items-center gap-3 bg-secondary-container/10"
                    >
                      <span className="material-symbols-outlined text-secondary">add_circle</span>
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-on-surface block">
                          Can&apos;t find it? Enter manually
                        </span>
                        <span className="text-on-surface-variant text-xs block">
                          Add your society so future neighbours can find it
                        </span>
                      </div>
                    </button>
                  </div>
                )}
              </div>

              {/* Manual entry form (collapsible) */}
              {!showResults && (
                <button
                  type="button"
                  onClick={() => setManualOpen((o) => !o)}
                  className="w-full text-left text-sm text-primary font-bold px-1 py-2 flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-base">edit_location</span>
                  {manualOpen ? "Hide manual entry" : "Can't find your society? Enter manually"}
                </button>
              )}

              {manualOpen && (
                <div className="bg-surface-container-low rounded-xl p-4 space-y-3 border border-outline-variant/20">
                  <p className="text-xs text-on-surface-variant leading-snug">
                    Enter the exact name on your society gate or electricity bill. This helps future neighbours find the same society.
                  </p>
                  <Input
                    label="Society name"
                    placeholder="e.g., L&T Southcity"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                  />
                                    <div className="relative">
                    <Input
                      label="City"
                      placeholder="e.g., Bengaluru"
                      value={manualCity}
                      onChange={(e) => {
                        setManualCity(e.target.value);
                        setCitySuggestionsOpen(true);
                      }}
                      onFocus={() => setCitySuggestionsOpen(true)}
                      onBlur={() => {
                        // Delay so a click on a suggestion registers first
                        setTimeout(() => setCitySuggestionsOpen(false), 150);
                        const canon = canonicaliseCity(manualCity);
                        if (canon) setManualCity(canon);
                      }}
                    />
                    {citySuggestionsOpen && citySuggestions.length > 0 && (
                      <div className="absolute z-30 w-full mt-1 bg-surface-container-high rounded-xl shadow-lg overflow-hidden border border-outline-variant/20 divide-y divide-outline-variant/10">
                        {citySuggestions.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setManualCity(c);
                              setCitySuggestionsOpen(false);
                            }}
                            className="w-full text-left px-4 py-2.5 text-sm hover:bg-primary-container/30 transition-colors flex items-center gap-2"
                          >
                            <span className="material-symbols-outlined text-on-surface-variant text-base">
                              location_city
                            </span>
                            <span className="font-semibold text-on-surface">{c}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={!manualName.trim() || !manualCity.trim()}
                    onClick={pickManual}
                    className="w-full bg-primary text-on-primary font-bold py-3 rounded-xl disabled:opacity-40"
                  >
                    Use this society
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Consent */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-1 w-5 h-5 rounded border-outline-variant text-primary focus:ring-primary-container"
          />
          <span className="text-on-surface font-medium text-sm leading-tight">
            I confirm that I am a resident of the selected society and I consent
            to my child participating in BookBuddy.
          </span>
        </label>

        <Button
          type="submit"
          fullWidth
          disabled={!childName || !ageGroup || !consent || !chosen || loading}
        >
          {loading ? "Creating..." : "Create Account"}
          <span className="material-symbols-outlined">arrow_forward</span>
        </Button>

        <p className="text-center text-xs text-on-surface-variant">
          By creating an account, you agree to our Terms of Service and Privacy
          Policy.
        </p>
      </form>
    </main>
  );
}
