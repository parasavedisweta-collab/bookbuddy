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
import {
  findOrCreateSociety,
  searchSocietiesWithMembers,
  type DbSocietyWithMembers,
} from "@/lib/supabase/societies";
import { createParent } from "@/lib/supabase/parents";
import { createChild } from "@/lib/supabase/children";
import { ensureAnonymousSession } from "@/lib/supabase/client";

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
  // Is the anonymous Supabase session live? createParent needs auth.uid()
  // to satisfy the `parents.id = auth.uid()` RLS policy, so submitting
  // before bootstrap finishes results in a silently-rejected INSERT and
  // a zombie localStorage-only account. We wait for either `ensureAnonymousSession`
  // to resolve (the happy path) or the `bb_supabase_auth` event fired by
  // SupabaseAuthBootstrap on cold loads.
  const [sessionReady, setSessionReady] = useState(false);
  // User-facing error surfaced when any of the three Supabase writes
  // (findOrCreateSociety / createParent / createChild) fail. Shown above
  // the submit button; cleared on the next submit attempt.
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [chosen, setChosen] = useState<ChosenSociety | null>(null);
  const [location, setLocation] = useState<LocationState>({ status: "idle" });

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [osmResults, setOsmResults] = useState<NominatimResult[]>([]);
  const [neighbourResults, setNeighbourResults] = useState<SocietySuggestion[]>([]);
  // Supabase-backed society matches with real (cross-device) member counts.
  // Replaces the localStorage-only neighbour signal for the common case
  // where the user is registering on a fresh device — without this, a
  // newcomer to an existing society sees no "verified" badge and risks
  // creating a duplicate by typing a slightly different name.
  const [supabaseResults, setSupabaseResults] = useState<DbSocietyWithMembers[]>(
    []
  );
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

  /** Search — fires neighbour (local), Supabase (remote), and OSM (remote) queries in parallel */
  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setOsmResults([]);
      setNeighbourResults([]);
      setSupabaseResults([]);
      return;
    }

    // Neighbour search is synchronous from localStorage. Useful as a
    // fast first paint and for legacy demo data; the Supabase results
    // below supersede it semantically once they arrive.
    setNeighbourResults(searchSocieties(searchQuery).slice(0, 5));

    // Both remote queries are debounced together so we don't spam either
    // backend on every keystroke. Run them in parallel — they're
    // independent and the slower of the two sets the user-visible
    // latency. Each guards its own try/catch so a failure on one
    // doesn't blank the other.
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearching(true);
      const queryAtFire = searchQuery;

      const osmPromise = (async () => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(queryAtFire)}&format=json&addressdetails=1&limit=5`,
            { headers: { "Accept-Language": "en" } }
          );
          const data: NominatimResult[] = await res.json();
          // Stale-response guard: if the user kept typing while we were
          // in flight, the input no longer matches what we asked for —
          // dropping the result keeps the dropdown coherent.
          if (queryAtFire === searchQuery) setOsmResults(data);
        } catch {
          // silent — picker still works without map results
        }
      })();

      const supabasePromise = (async () => {
        try {
          const data = await searchSocietiesWithMembers(queryAtFire);
          if (queryAtFire === searchQuery) setSupabaseResults(data);
        } catch (err) {
          console.warn("[child-setup] supabase society search failed:", err);
        }
      })();

      Promise.all([osmPromise, supabasePromise]).finally(() => {
        if (queryAtFire === searchQuery) setSearching(false);
      });
    }, 400);
  }, [searchQuery]);

  // Wait for the anonymous Supabase session before allowing submit.
  // ensureAnonymousSession() is idempotent — it returns the existing uid
  // when the session is already live (usually the case on re-entry to
  // this page), otherwise it mints one. We also subscribe to the
  // bb_supabase_auth event so we pick up a late bootstrap resolve on
  // cold-start races without having to poll.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const uid = await ensureAnonymousSession();
        if (!cancelled && uid) setSessionReady(true);
      } catch (err) {
        console.error("[child-setup] session bootstrap failed:", err);
      }
    })();
    const onAuth = () => setSessionReady(true);
    window.addEventListener("bb_supabase_auth", onAuth);
    return () => {
      cancelled = true;
      window.removeEventListener("bb_supabase_auth", onAuth);
    };
  }, []);

  function pickNeighbour(s: SocietySuggestion) {
    setChosen({ id: s.id, name: s.name, city: s.city, source: "neighbour" });
    clearSearch();
  }
  /**
   * Pick a Supabase-known society. The exact name + city we store here
   * are what the existing Supabase row already has, so on submit
   * `findOrCreateSociety` will ILIKE-match it and reuse the same UUID
   * — no risk of a duplicate row even though we still go through the
   * upsert path. We tag source as "neighbour" so the chosen-card UI
   * shows the same friendly "Verified by your neighbours" wording the
   * picker promised.
   */
  function pickSupabase(s: DbSocietyWithMembers) {
    setChosen({
      id: societyNameToId(s.name, s.city),
      name: s.name,
      city: s.city,
      source: "neighbour",
    });
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
    setSupabaseResults([]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!childName || !ageGroup || !consent || !chosen) return;
    setSubmitError(null);
    setLoading(true);

    // Supabase is the source of truth. If any of society / parent / child
    // inserts fail, we bail BEFORE writing localStorage or navigating —
    // otherwise the user lands on a success screen backed by no server
    // data, home feed stays empty, and requests can't route to them.
    // (Bug history: this exact path produced the "Mukesh" zombie account
    // on UAT — localStorage said registered, Supabase had nothing.)
    const parentPhone = localStorage.getItem("bb_parent_phone") ?? undefined;
    const ageGroupDb = ageDisplayToDb(ageGroup);

    if (!parentPhone || !ageGroupDb) {
      setSubmitError(
        "Something's off with your details. Please go back and re-enter your phone number."
      );
      setLoading(false);
      return;
    }

    // Belt-and-braces: make sure the anon session is actually live. The
    // submit button is already gated on `sessionReady`, but a user could
    // have the form up from before bootstrap finished, fill it out, and
    // tap submit the instant sessionReady flipped true. ensureAnonymousSession
    // is idempotent and cheap; it also catches the edge case where the
    // session expired between form-fill and submit.
    let uid: string | null = null;
    try {
      uid = await ensureAnonymousSession();
    } catch (err) {
      console.error("[child-setup] ensureAnonymousSession threw:", err);
    }
    if (!uid) {
      setSubmitError(
        "Couldn't connect to the server. Please check your internet and try again."
      );
      setLoading(false);
      return;
    }

    try {
      const society = await findOrCreateSociety(chosen.name, chosen.city);
      if (!society) {
        setSubmitError(
          "Couldn't save your society. Please check your connection and try again."
        );
        setLoading(false);
        return;
      }

      const parent = await createParent({
        phone: parentPhone,
        society_id: society.id,
      });
      if (!parent) {
        // The two realistic failure modes here are:
        //   (a) phone UNIQUE collision — happens when this same number
        //       registered on another device already (Path A's cross-
        //       device limitation). Register page's isPhoneRegistered
        //       check usually catches it, but a transient RPC failure
        //       can let the user slip through.
        //   (b) network blip.
        // We can't distinguish without inspecting the PostgREST error,
        // and createParent already console.errors the real one — surface
        // a message covering both cases.
        setSubmitError(
          "Couldn't create your account. This number may already be registered on another device, " +
            "or there might be a connection issue. Try a different phone number or check your connection."
        );
        setLoading(false);
        return;
      }

      const child = await createChild({
        name: childName,
        age_group: ageGroupDb,
      });
      if (!child) {
        // Parent inserted but child didn't — rare (would need RLS mismatch
        // or network flake on the second round-trip). The parent row is
        // orphaned; we tell the user to retry. On retry, createParent
        // will fail with UNIQUE, and they'll see the error above — at
        // which point they know to contact support. Not ideal, but
        // leaves a clear trail rather than a silent zombie.
        setSubmitError(
          "Almost there — couldn't save your child's profile. Please try again."
        );
        setLoading(false);
        return;
      }
    } catch (err) {
      console.error("[child-setup] Supabase write failed:", err);
      setSubmitError(
        "Something went wrong talking to the server. Please try again."
      );
      setLoading(false);
      return;
    }

    // Supabase state is consistent. NOW we write localStorage for legacy
    // readers (profile, home feed, book listing) and navigate to success.
    // Remove this block once those callsites have fully migrated to
    // Supabase reads.
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

  // Filter localStorage neighbour results down to only those NOT already
  // surfaced by Supabase. Match on (lower(name), lower(city)) — same key
  // findOrCreateSociety uses, so what looks "the same" to the user is
  // the same row in the picker. Without this dedupe, the localStorage
  // entry left over from a previous session shows up next to the
  // authoritative Supabase row with stale member counts.
  const supabaseKeys = new Set(
    supabaseResults.map(
      (s) => `${s.name.toLowerCase()}|${s.city.toLowerCase()}`
    )
  );
  const dedupedNeighbours = neighbourResults.filter(
    (n) => !supabaseKeys.has(`${n.name.toLowerCase()}|${n.city.toLowerCase()}`)
  );
  // Also hide OSM hits that just duplicate a Supabase row by name —
  // OSM verbosity ("Society X, Sector 5, City") doesn't match exactly,
  // so we use a softer "name contains" rule. Prevents the duplicate-row
  // creation foot-gun (user picks OSM variant, findOrCreateSociety's
  // ILIKE misses, new society row gets inserted).
  const supabaseNames = supabaseResults.map((s) => s.name.toLowerCase());
  const dedupedOsm = osmResults.filter((r) => {
    const osmName = extractSocietyName(r).toLowerCase();
    return !supabaseNames.some(
      (n) => osmName.includes(n) || n.includes(osmName)
    );
  });

  const hasAnyResults =
    supabaseResults.length > 0 ||
    dedupedNeighbours.length > 0 ||
    dedupedOsm.length > 0;
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

                    {/* 1. Supabase-verified matches (≥3 distinct parents).
                           These are authoritative cross-device counts —
                           anyone registering on a fresh device will still
                           see existing societies as "verified". This is the
                           section that fixes the Mukesh-style "first member!"
                           regression after a sign-out + re-register. */}
                    {supabaseResults.filter((s) => s.memberCount >= 3).length > 0 && (
                      <div>
                        <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-primary">
                          ✓ Verified by neighbours
                        </p>
                        {supabaseResults
                          .filter((s) => s.memberCount >= 3)
                          .map((s) => (
                            <button
                              key={`sb-${s.id}`}
                              type="button"
                              onClick={() => pickSupabase(s)}
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

                    {/* 2. Supabase soft matches — society exists but with
                           1–2 parents (or 0, which only happens if a user
                           added a society row but no child yet — rare, but
                           still worth surfacing so they don't dupe it). */}
                    {supabaseResults.filter((s) => s.memberCount < 3).length > 0 && (
                      <div>
                        <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          Listed by a neighbour
                        </p>
                        {supabaseResults
                          .filter((s) => s.memberCount < 3)
                          .map((s) => (
                            <button
                              key={`sb-${s.id}`}
                              type="button"
                              onClick={() => pickSupabase(s)}
                              className="w-full text-left px-4 py-3 text-sm hover:bg-primary-container/30 transition-colors flex items-center gap-3"
                            >
                              <span className="material-symbols-outlined text-on-surface-variant">groups</span>
                              <div className="flex-1 min-w-0">
                                <span className="font-semibold text-on-surface block truncate">{s.name}</span>
                                <span className="text-on-surface-variant text-xs block truncate">
                                  {s.memberCount === 0
                                    ? `Already on BookBuddy · ${s.city}`
                                    : `${s.memberCount} neighbour${s.memberCount === 1 ? "" : "s"} here · ${s.city}`}
                                </span>
                              </div>
                            </button>
                          ))}
                      </div>
                    )}

                    {/* 3. Legacy localStorage neighbour matches — only those
                           NOT already in supabaseResults (deduped above).
                           Mostly empty in practice; carries pre-Supabase
                           demo data that hasn't been backfilled yet. */}
                    {dedupedNeighbours.filter((s) => s.verified).length > 0 && (
                      <div>
                        <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          On this device
                        </p>
                        {dedupedNeighbours.filter((s) => s.verified).map((s) => (
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
                                {s.memberCount} neighbours here · {s.city}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    {dedupedNeighbours.filter((s) => !s.verified).length > 0 && (
                      <div>
                        <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          Saved on this device
                        </p>
                        {dedupedNeighbours.filter((s) => !s.verified).map((s) => (
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

                    {/* 4. Map (OSM) results — deduped against Supabase by
                           name substring. Last because they have the
                           weakest signal (no member info at all). */}
                    {dedupedOsm.length > 0 && (
                      <div>
                        <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          From map
                        </p>
                        {dedupedOsm.map((r) => (
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

        {submitError && (
          <div
            role="alert"
            className="bg-error-container/50 border border-error/30 rounded-xl p-4 flex items-start gap-3"
          >
            <span className="material-symbols-outlined text-error shrink-0 mt-0.5">
              error
            </span>
            <p className="text-sm text-on-error-container leading-snug">
              {submitError}
            </p>
          </div>
        )}

        <Button
          type="submit"
          fullWidth
          disabled={
            !childName ||
            !ageGroup ||
            !consent ||
            !chosen ||
            loading ||
            !sessionReady
          }
        >
          {loading
            ? "Creating..."
            : !sessionReady
              ? "Connecting…"
              : "Create Account"}
          <span className="material-symbols-outlined">arrow_forward</span>
        </Button>

        {!sessionReady && !loading && (
          <p className="text-center text-xs text-on-surface-variant">
            Waiting for a secure connection…
          </p>
        )}

        <p className="text-center text-xs text-on-surface-variant">
          By creating an account, you agree to our Terms of Service and Privacy
          Policy.
        </p>
      </form>
    </main>
  );
}
