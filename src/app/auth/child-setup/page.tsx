"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
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
import { createParent, getCurrentParent } from "@/lib/supabase/parents";
import { createChild } from "@/lib/supabase/children";
import { getCurrentUserId } from "@/lib/supabase/client";
import { subscribeToPush } from "@/lib/push";
import {
  getPendingSociety,
  clearPendingSociety,
} from "@/lib/supabase/publicBrowse";

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
  const [phone, setPhone] = useState("");
  // Push-notifications opt-in. Required to submit; the actual subscribe
  // call fires after the Supabase writes succeed (we need a parent row
  // for the push_subscriptions FK). Users on iOS without Add-to-Home
  // Screen still need to tick this — the subscribe will no-op in that
  // case and the Profile push toggle later guides them through install.
  const [allowPush, setAllowPush] = useState(false);
  const [loading, setLoading] = useState(false);
  // Auth gate: must be signed in (Google or email-OTP) before this page
  // is even useful — `parents.id = auth.uid()` makes the createParent
  // INSERT depend on a live session. We check on mount and redirect to
  // /auth/sign-in if there's no session. While the check is in flight
  // we render a small placeholder rather than the form (avoids a flash
  // of unauthorised content + a broken submit if the user races us).
  const [authChecked, setAuthChecked] = useState(false);
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

  // Auth gate. Two cases:
  //   - No session at all → push to /auth/sign-in.
  //   - Session exists AND a parent row already exists → user has
  //     already completed registration; bounce them home so they can't
  //     accidentally trigger a duplicate INSERT (which would fail the
  //     parents PK on auth.uid() anyway, but better to short-circuit).
  // Once both checks pass, render the form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uid = await getCurrentUserId();
      if (cancelled) return;
      if (!uid) {
        router.replace("/auth/sign-in");
        return;
      }
      const existing = await getCurrentParent();
      if (cancelled) return;
      if (existing) {
        router.replace("/");
        return;
      }
      setAuthChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Pre-fill the chosen society from `bb_pending_society` if the user
  // came in via /library (peek-and-pick). Saves them re-doing the
  // detect/search flow now that they've already committed to one.
  // They can still tap "Change" on the chosen-card to override.
  // Runs once on mount; we don't react to subsequent changes because
  // the user might pick something else mid-form, and we don't want a
  // late localStorage write to silently overwrite their selection.
  useEffect(() => {
    const pending = getPendingSociety();
    if (!pending) return;
    setChosen({
      id: pending.id || societyNameToId(pending.name, pending.city),
      name: pending.name,
      city: pending.city,
      source: pending.source === "gps" ? "gps" : "neighbour",
      lat: pending.lat,
      lng: pending.lng,
    });
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

  const phoneDigits = phone.replace(/\D/g, "");
  const phoneValid = phoneDigits.length >= 10;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Push opt-in is required: borrow requests can't reach the lister
    // without a notification surface. We used to disable the submit
    // button when the box was unchecked, which left users tapping a
    // dead button with no feedback. Now we surface an inline error so
    // the reason is obvious and they know exactly what to do.
    if (!childName || !phoneValid || !chosen) return;
    if (!allowPush) {
      setSubmitError(
        "Please allow push notifications to continue. We use them to ping you when neighbours request your books."
      );
      // Scroll the error into view in case the checkbox is below the
      // fold on shorter screens.
      if (typeof window !== "undefined") {
        const node = document.getElementById("push-opt-in");
        node?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    setSubmitError(null);
    setLoading(true);

    // Belt-and-braces auth re-check: the gate above already redirected
    // anyone unauthenticated, but a session can expire between mount
    // and submit. Failing fast here beats the cryptic RLS error.
    const uid = await getCurrentUserId();
    if (!uid) {
      router.replace("/auth/sign-in");
      return;
    }

    // Supabase is the source of truth. If any of society / parent / child
    // inserts fail, we bail BEFORE writing localStorage or navigating —
    // otherwise the user lands on a success screen backed by no server
    // data, home feed stays empty, and requests can't route to them.
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
        phone: phoneDigits,
        society_id: society.id,
      });
      if (!parent) {
        // After the auth refactor (migration 0007), parents.email is the
        // UNIQUE credential — but email comes from auth.users, so an
        // INSERT can't collide on email unless something is very wrong.
        // The realistic failure modes are network blips and (rarely) a
        // stale session whose JWT no longer matches an auth.users row.
        // createParent already console.errors the underlying message —
        // we surface a generic retry prompt here.
        setSubmitError(
          "Couldn't create your account. Please check your connection and try again."
        );
        setLoading(false);
        return;
      }

      const child = await createChild({
        name: childName,
      });
      if (!child) {
        // Parent inserted but child didn't — rare (would need RLS mismatch
        // or network flake on the second round-trip). The parent row is
        // orphaned; we tell the user to retry. On retry, createParent
        // will fail with PK collision (id=auth.uid() already exists) and
        // surface the error above. Not ideal, but leaves a clear trail
        // rather than a silent zombie.
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
        societyName: chosen.name,
        societyCity: chosen.city,
        societyLat: chosen.lat ?? null,
        societyLng: chosen.lng ?? null,
      })
    );

    registerNewChild({
      name: childName,
      // age_group is gone from the DB (migration 0007) but the legacy
      // localStorage helper still requires the key — pass a placeholder
      // string. Nothing reads it on the filter side.
      ageGroup: "",
      societyId: chosen.id,
      societyName: chosen.name,
      societyCity: chosen.city,
      parentPhone: phoneDigits,
    });

    // Best-effort push subscribe. The user ticked "Allow notifications"
    // to get here, so we run the full pipeline now that the parents row
    // exists (push_subscriptions FK requires it). Failures don't block
    // navigation — Profile's PushSettingsToggle is the recovery surface
    // for: iOS users who need to install the PWA first, users who deny
    // the OS prompt, or transient errors. Logged for visibility but
    // intentionally not surfaced to the user mid-flow.
    try {
      const ok = await subscribeToPush();
      if (!ok) {
        console.warn(
          "[child-setup] subscribeToPush returned false; user can re-enable from Profile"
        );
      }
    } catch (err) {
      console.warn("[child-setup] subscribeToPush threw:", err);
    }

    // Registration is committed — clear the public-browse pending
    // society so a future sign-out + new visit doesn't pre-fill a
    // stale choice from this device's localStorage.
    clearPendingSociety();

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

  if (!authChecked) {
    return (
      <main className="flex-1 flex items-center justify-center px-6 w-full max-w-lg mx-auto">
        <div className="flex items-center gap-3 text-on-surface-variant">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Checking your session…</span>
        </div>
      </main>
    );
  }

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
            Almost done
          </span>
          <div className="flex gap-1 mt-1">
            <div className="h-1.5 w-12 rounded-full bg-primary" />
            <div className="h-1.5 w-12 rounded-full bg-primary" />
          </div>
        </div>
      </div>

      {/* Hero */}
      <div className="text-center mb-8">
        <div className="w-32 h-32 rounded-2xl overflow-hidden shadow-md mx-auto mb-4">
          <img
            src="/bookworm.png"
            alt="BookBuds worm reading"
            className="w-[200%] h-[200%] object-cover"
            style={{ objectPosition: "0% 0%" }}
          />
        </div>
        <h1 className="text-3xl font-extrabold text-on-surface leading-tight tracking-tight">
          Tell us about your child
        </h1>
        <p className="text-on-surface-variant mt-2 text-base">
          Just a couple of details and you&apos;re in.
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

        {/* Phone — used to reach you about borrow requests, NOT a
            credential. Email is the credential (auth identity). */}
        <div className="space-y-3">
          <label className="block text-sm font-bold text-secondary uppercase tracking-wider ml-1">
            Your WhatsApp number
          </label>
          <div className="flex gap-3">
            <div className="w-20 bg-surface-container-high rounded-lg flex items-center justify-center font-body font-bold text-lg text-on-surface shrink-0">
              +91
            </div>
            <Input
              type="tel"
              placeholder="98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="text-xl font-bold"
              required
            />
          </div>
          <p className="text-xs text-on-surface-variant px-1 leading-snug">
            We share this only with neighbours you&apos;ve approved a book
            swap with. No spam, ever.
          </p>
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
                                    ? `Already on BookBuds · ${s.city}`
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

        {/* Push-notifications opt-in. Required to submit — borrow
            requests fall flat without a way to ping the lister, so we
            ask up-front. Users can later toggle off from Profile if
            they change their mind. */}
        <div id="push-opt-in" className="space-y-2">
          {submitError && !allowPush && (
            <div
              role="alert"
              className="bg-error-container/50 border border-error/40 rounded-xl p-3 flex items-start gap-2"
            >
              <span className="material-symbols-outlined text-error shrink-0 mt-0.5 text-lg">
                error
              </span>
              <p className="text-sm text-on-error-container leading-snug font-semibold">
                {submitError}
              </p>
            </div>
          )}
          <label
            className={`flex items-start gap-3 cursor-pointer bg-surface-container-low rounded-xl p-4 ${
              submitError && !allowPush ? "ring-2 ring-error/40" : ""
            }`}
          >
            <input
              type="checkbox"
              checked={allowPush}
              onChange={(e) => {
                setAllowPush(e.target.checked);
                if (e.target.checked) setSubmitError(null);
              }}
              className="mt-1 w-5 h-5 rounded border-outline-variant text-primary focus:ring-primary-container"
            />
            <div className="flex-1 leading-tight">
              <p className="text-on-surface font-bold text-sm flex items-center gap-1.5">
                <span
                  className="material-symbols-outlined text-primary text-base"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  notifications_active
                </span>
                Allow push notifications
              </p>
              <p className="text-xs text-on-surface-variant mt-1">
                We&apos;ll let you know when neighbours request your books or
                reply to yours. You can change this any time from your
                profile.
              </p>
            </div>
          </label>
        </div>

        {submitError && allowPush && (
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
            !phoneValid ||
            !chosen ||
            loading
          }
        >
          {loading ? "Creating..." : "Create Account"}
          <span className="material-symbols-outlined">arrow_forward</span>
        </Button>
      </form>
    </main>
  );
}
