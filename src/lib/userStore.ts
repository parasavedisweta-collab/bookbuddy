/**
 * localStorage-backed user store.
 *
 * Persists the current device's child id, listed books, and borrow
 * requests in localStorage. Originally seeded with hard-coded "demo"
 * children/books for the prototype phase; that demo data has been
 * removed now that the app is live and every reader path is gated on
 * a real Supabase session. What remains is the cross-device cache that
 * sits in front of Supabase reads (mostly to keep base64 cover photos
 * accessible while Supabase Storage upload is unwired).
 *
 * Read paths return [] when localStorage is empty — there is no
 * "default" identity any more. Pages that depend on a real child id
 * either route through /auth/* or check the Supabase session first.
 */
import type { BorrowRequest, Book, Child } from "./types";

/* ── Societies ───────────────────────────────────────────────── */

export interface Society {
  id: string;
  name: string;
  city: string;
}

/** Slug a free-text society name + city into a stable ID. */
export function societyNameToId(name: string, city: string = ""): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const n = slug(name);
  const c = slug(city);
  if (!n) return "";
  return c ? `s_${n}_${c}` : `s_${n}`;
}

/** Normalise a string for fuzzy society-name comparison. */
function normaliseForMatch(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Cheap Levenshtein distance (for suggestion fuzzy-match). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  const curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/* ── Registered (real) children ──────────────────────────────── */

export interface RegisteredChild {
  id: string;
  name: string;
  ageGroup: string;
  societyId: string;
  societyName: string;
  societyCity: string;
  emoji: string;
  parentPhone?: string;
}

const REGISTERED_CHILDREN_KEY = "bb_registered_children";

function readRegisteredChildren(): RegisteredChild[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(REGISTERED_CHILDREN_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** Returns the registered child record for a given id, or null. */
export function findChildById(id: string) {
  const reg = readRegisteredChildren().find((c) => c.id === id);
  if (reg) return { id: reg.id, name: reg.name, emoji: reg.emoji, ageGroup: reg.ageGroup, societyId: reg.societyId };
  return null;
}

/** All registered children on this device. */
export function getAllChildren(): Array<{ id: string; name: string; emoji: string; ageGroup: string; societyId: string }> {
  return readRegisteredChildren().map((c) => ({
    id: c.id, name: c.name, emoji: c.emoji, ageGroup: c.ageGroup, societyId: c.societyId,
  }));
}

/** Normalise a phone number to digits only for comparison. */
function normalisePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

/** True if a phone number is already linked to a registered child. */
export function isPhoneRegistered(phone: string): boolean {
  const n = normalisePhone(phone);
  return readRegisteredChildren().some(
    (c) => c.parentPhone && normalisePhone(c.parentPhone) === n
  );
}

/** Return the registered child whose parent phone matches, or null. */
export function findChildByPhone(phone: string): RegisteredChild | null {
  const n = normalisePhone(phone);
  return (
    readRegisteredChildren().find(
      (c) => c.parentPhone && normalisePhone(c.parentPhone) === n
    ) ?? null
  );
}

/** Create a new child from the registration flow and switch to it. */
export function registerNewChild(params: {
  name: string;
  ageGroup: string;
  societyId?: string;
  societyName?: string;
  societyCity?: string;
  parentPhone?: string;
}): string {
  const id = `c_${Date.now()}`;
  const child: RegisteredChild = {
    id,
    name: params.name,
    ageGroup: params.ageGroup,
    // Empty defaults — the registration flow is the single producer of
    // these values now and always passes them. Falling back to a
    // hard-coded "Green Meadows" was demo-era convenience.
    societyId: params.societyId ?? "",
    societyName: params.societyName ?? "",
    societyCity: params.societyCity ?? "",
    emoji: "📖",
    parentPhone: params.parentPhone,
  };
  const existing = readRegisteredChildren();
  localStorage.setItem(REGISTERED_CHILDREN_KEY, JSON.stringify([...existing, child]));
  setCurrentChildId(id); // also fires bb_user_change
  window.dispatchEvent(new Event("bb_registered_change"));
  return id;
}

/* ── Society aggregation & search ────────────────────────────── */

export interface SocietyWithStats extends Society {
  memberCount: number;
  bookCount: number;
  /** Members < 3 means the slug isn't yet verified-by-neighbours. */
  verified: boolean;
}

/** All societies known to this device (from registered children), with
 *  member and book counts. Used by the registration picker and admin tool. */
export function getAllSocieties(): SocietyWithStats[] {
  const map = new Map<string, SocietyWithStats>();

  // Pull in registered-child societies. With demo data removed, this is
  // the only seed source — empty on a fresh device until the user
  // completes registration and registerNewChild writes a row.
  for (const r of readRegisteredChildren()) {
    if (!map.has(r.societyId)) {
      map.set(r.societyId, {
        id: r.societyId,
        name: r.societyName,
        city: r.societyCity,
        memberCount: 0,
        bookCount: 0,
        verified: false,
      });
    }
  }

  // Count members from the same registered-children set.
  for (const r of readRegisteredChildren()) {
    const s = map.get(r.societyId);
    if (s) s.memberCount++;
  }

  // Count books listed locally.
  for (const b of getAllBooks()) {
    const s = map.get(b.society_id);
    if (s) s.bookCount++;
  }

  // Mark as verified if ≥3 neighbours
  for (const s of map.values()) s.verified = s.memberCount >= 3;

  return Array.from(map.values());
}

/** Look up society by id (null if unknown). */
export function getSocietyById(id: string): SocietyWithStats | null {
  return getAllSocieties().find((s) => s.id === id) ?? null;
}

export interface SocietySuggestion extends SocietyWithStats {
  /** 0 = exact match, higher = fuzzier. */
  distance: number;
}

/** Fuzzy search across all known societies. Optionally restrict by city. */
export function searchSocieties(query: string, cityFilter = ""): SocietySuggestion[] {
  const q = normaliseForMatch(query);
  if (q.length < 2) return [];
  const cityKey = normaliseForMatch(cityFilter);

  return getAllSocieties()
    .map((s) => {
      if (!s?.name) return null; 
      if (cityKey && !normaliseForMatch(s.city).includes(cityKey)) return null;
      const n = normaliseForMatch(s.name);
      // Substring match = distance 0; otherwise use Levenshtein
      if (n.includes(q) || q.includes(n)) return { ...s, distance: 0 };
      const d = levenshtein(q, n);
      // Accept only reasonably close matches (≤ 3 char edits or 40% of query length)
      if (d <= Math.max(3, Math.floor(q.length * 0.4))) return { ...s, distance: d };
      return null;
    })
    .filter((x): x is SocietySuggestion => x !== null)
    .sort((a, b) => {
      // Verified (≥3 members) first, then fewer edits, then more members
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return b.memberCount - a.memberCount;
    });
}

const CHILD_KEY    = "bb_current_child";
const REQUEST_KEY  = "bb_borrow_requests";
const BOOKS_KEY    = "bb_listed_books";
const REMOVED_KEY  = "bb_removed_books";

/* ── Current user ─────────────────────────────────────────── */

/**
 * Active child id on this device, or empty string if none. Returns "" on
 * SSR (no localStorage) and on fresh devices that haven't completed
 * registration. Callers must handle the empty case — there's no longer
 * a Jenny-shaped fallback.
 */
export function getCurrentChildId(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(CHILD_KEY) ?? "";
}

/** Society ID for the currently active child, or empty string if none. */
export function getCurrentUserSocietyId(): string {
  const id = getCurrentChildId();
  if (!id) return "";
  return findChildById(id)?.societyId ?? "";
}

export function setCurrentChildId(id: string) {
  localStorage.setItem(CHILD_KEY, id);
  window.dispatchEvent(new Event("bb_user_change"));
}

/**
 * Wipe every user-scoped localStorage key on this device.
 *
 * Used by Sign Out (and any future "switch account" flow). The keys here
 * are deliberately hard-coded in one place so we don't drift — any new
 * user-scoped key must be added here too. Fires every change event so
 * pages re-render against the cleared state in the same tick.
 *
 * Notes on what is / isn't cleared:
 *   - Cleared: child id, registered children, listed books, borrow
 *     requests, removed books, parent phone, onboarding child blob.
 *   - NOT cleared: Supabase session — that's owned by the Supabase client
 *     and the caller handles signOut() separately. Also nothing under a
 *     non-`bb_` prefix (third-party libs).
 *
 * Supabase data is NOT touched: rows remain attached to the old parent
 * via their child_id, but RLS makes them invisible to the freshly signed-
 * in (or anonymous) user. That's the intended semantics — sign-out
 * blanks the device, not the server.
 */
export function clearLocalUserData() {
  if (typeof window === "undefined") return;
  const keys = [
    CHILD_KEY,
    REQUEST_KEY,
    BOOKS_KEY,
    REMOVED_KEY,
    REGISTERED_CHILDREN_KEY,
    "bb_child",
    "bb_parent_phone",
  ];
  for (const k of keys) localStorage.removeItem(k);
  // Fire all downstream change events so any mounted page (bell, shelf,
  // home) re-reads the now-empty store in this same tick.
  window.dispatchEvent(new Event("bb_user_change"));
  window.dispatchEvent(new Event("bb_books_change"));
  window.dispatchEvent(new Event("bb_requests_change"));
  window.dispatchEvent(new Event("bb_registered_change"));
}

/**
 * Rehydrate localStorage from Supabase after a fresh sign-in.
 *
 * Read-side helpers in this file (`getCurrentChildId`,
 * `getCurrentUserSocietyId`, etc.) read from localStorage and return
 * empty strings when nothing is set. After sign-out we wipe localStorage;
 * without this hydrate call on sign-back-in, the legacy readers would
 * stay empty and pages dependent on them would render with no child /
 * society context until a manual switch.
 *
 * Call this from /auth/callback after `getCurrentParent()` confirms the
 * user is registered. Pass the parent and their first child (or whichever
 * child you want active) and we'll write the keys the legacy localStorage
 * readers consult, so home/profile/shelf paint the right identity on
 * first render.
 *
 * Idempotent — safe to call multiple times. Doesn't touch books / requests
 * keys; those are filled by their own Supabase fetches in pages.
 */
export function hydrateLocalFromSupabase(params: {
  childId: string;
  childName: string;
  childEmoji?: string | null;
  parentPhone: string | null;
  societyId: string;
  societyName: string | null;
  societyCity: string | null;
}) {
  if (typeof window === "undefined") return;

  const {
    childId,
    childName,
    childEmoji,
    parentPhone,
    societyId,
    societyName,
    societyCity,
  } = params;

  // Active child pointer. Without this, getCurrentChildId() returns "" and
  // pages depending on a real child id render their unregistered state.
  localStorage.setItem(CHILD_KEY, childId);

  // Registered-children list. Drives the society / member lookups in the
  // legacy readers; we write a one-element array reflecting the Supabase
  // child so getCurrentUserSocietyId() resolves to the user's real society.
  const child: RegisteredChild = {
    id: childId,
    name: childName,
    ageGroup: "", // post-0007 we no longer capture age_group
    societyId,
    societyName: societyName ?? "",
    societyCity: societyCity ?? "",
    emoji: childEmoji ?? "📖",
    parentPhone: parentPhone ?? undefined,
  };
  localStorage.setItem(REGISTERED_CHILDREN_KEY, JSON.stringify([child]));

  // bb_child blob — read by the registration-success screen and a few
  // other legacy paths. Mirrors what registerNewChild writes during
  // first-time registration so signing in on a new device looks the same
  // as registering on it.
  localStorage.setItem(
    "bb_child",
    JSON.stringify({
      name: childName,
      societyName: societyName ?? "",
      societyCity: societyCity ?? "",
      societyLat: null,
      societyLng: null,
    })
  );

  // Phone is occasionally read for copy-paste convenience in flows like
  // book/[id]. Safe to write even when the field doesn't exist on this
  // device.
  if (parentPhone) {
    localStorage.setItem("bb_parent_phone", parentPhone);
  }

  // Single batch of events so any mounted page re-renders against the
  // fresh state in one tick.
  window.dispatchEvent(new Event("bb_user_change"));
  window.dispatchEvent(new Event("bb_registered_change"));
}

/* ── Borrow requests ──────────────────────────────────────── */

function readLocalRequests(): BorrowRequest[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(REQUEST_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function writeLocalRequests(reqs: BorrowRequest[]) {
  localStorage.setItem(REQUEST_KEY, JSON.stringify(reqs));
  window.dispatchEvent(new Event("bb_requests_change"));
}

/** All requests on this device. */
export function getAllRequests(): BorrowRequest[] {
  return readLocalRequests();
}

/** Create a new borrow request from the current user for a book. */
export function createBorrowRequest(bookId: string, borrowerChildId: string): BorrowRequest | null {
  const allB = getAllBooks();
  const book = allB.find((b) => b.id === bookId);
  if (!book) return null;

  const listerChild = findChildById(book.child_id);
  const borrowerChild = findChildById(borrowerChildId);

  const req: BorrowRequest = {
    id: `br_${Date.now()}`,
    book_id: bookId,
    borrower_child_id: borrowerChildId,
    lister_child_id: book.child_id,
    status: "pending",
    requested_at: new Date().toISOString(),
    responded_at: null,
    picked_up_at: null,
    due_date: null,
    returned_at: null,
    return_confirmed_at: null,
    book,
        borrower_child: borrowerChild
      ? { id: borrowerChild.id, parent_id: "p_demo", name: borrowerChild.name, age_group: borrowerChild.ageGroup as Child["age_group"], bookbuddy_id: "BB-DEMO", created_at: "" }
      : undefined,
    lister_child: listerChild
      ? { id: listerChild.id, parent_id: "p_demo", name: listerChild.name, age_group: listerChild.ageGroup as Child["age_group"], bookbuddy_id: "BB-DEMO", created_at: "" }
      : book.child
        ? { id: book.child.id, parent_id: "p_demo", name: book.child.name, age_group: book.child.age_group, bookbuddy_id: book.child.bookbuddy_id, created_at: "" }
        : undefined,
  };

  writeLocalRequests([...readLocalRequests(), req]);
  return req;
}

/**
 * Rewrite a locally-created borrow request's id. Mirrors replaceLocalBookId:
 * after a successful Supabase dual-write we rename the local row so the two
 * sources share one id and the shelf's dedup-by-id merge doesn't render the
 * same request twice (one "br_123" local, one UUID from Supabase).
 *
 * No-op if no local request with `oldId` exists or the id is already aligned.
 */
export function replaceLocalRequestId(oldId: string, newId: string) {
  if (typeof window === "undefined" || oldId === newId) return;
  const local = readLocalRequests();
  const idx = local.findIndex((r) => r.id === oldId);
  if (idx < 0) return;
  local[idx] = { ...local[idx], id: newId };
  writeLocalRequests(local);
}

/* ── Listed books ─────────────────────────────────────────── */

function readLocalBooks(): Book[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(BOOKS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function readRemovedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem(REMOVED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** All locally-listed books on this device, minus removed.
 *  Status is overlaid from active borrow requests so "borrowed" is always accurate. */
export function getAllBooks(): Book[] {
  const removed = readRemovedIds();
  const books = readLocalBooks().filter((b) => !removed.has(b.id));

  const requests = getAllRequests();
  const borrowedIds = new Set(
    requests
      .filter((r) => r.status === "approved" || r.status === "picked_up")
      .map((r) => r.book_id)
  );

  return books.map((b) => ({
    ...b,
    status: borrowedIds.has(b.id) ? "borrowed" : b.status === "borrowed" ? "available" : b.status,
  }));
}

/**
 * Rewrite a locally-listed book's id. Used by the book-list page after a
 * successful Supabase insert so the local copy and the Supabase copy share
 * the same id — otherwise the shelf/home merge sees them as two different
 * books and shows the card twice (one with the base64 cover from local,
 * one with the null cover from Supabase).
 *
 * No-op if no local book with `oldId` exists. Also rewrites the
 * `bb_removed_books` set so a deletion that has already happened survives
 * the renaming.
 */
export function replaceLocalBookId(oldId: string, newId: string) {
  if (typeof window === "undefined" || oldId === newId) return;
  const local = readLocalBooks();
  const idx = local.findIndex((b) => b.id === oldId);
  if (idx < 0) return;
  local[idx] = { ...local[idx], id: newId };
  localStorage.setItem(BOOKS_KEY, JSON.stringify(local));

  // Preserve removed-state across the rename.
  const removed = readRemovedIds();
  if (removed.has(oldId)) {
    removed.delete(oldId);
    removed.add(newId);
    localStorage.setItem(REMOVED_KEY, JSON.stringify([...removed]));
  }

  window.dispatchEvent(new Event("bb_books_change"));
}

/** Remove a book from the library (works for both demo and locally listed). */
export function removeListedBook(bookId: string) {
  const removed = readRemovedIds();
  removed.add(bookId);
  localStorage.setItem(REMOVED_KEY, JSON.stringify([...removed]));
  // Also remove from local books array if present
  const local = readLocalBooks().filter((b) => b.id !== bookId);
  localStorage.setItem(BOOKS_KEY, JSON.stringify(local));
  window.dispatchEvent(new Event("bb_books_change"));
}

/** Save a newly listed book for the current user. */
export function saveListedBook(data: {
  title: string;
  author: string;
  series?: string;
  genre: string;
  ageRange: string;
  summary: string;
  coverUrl: string | null;
  userPhotoUrl: string | null;
  selectedCover: "api" | "user_photo";
}): Book {
  const childId = getCurrentChildId();
  const child = findChildById(childId);
  if (!child) return null as unknown as Book; // shouldn't happen

  const book: Book = {
    id: `book_${Date.now()}`,
    child_id: childId,
    society_id: child.societyId,
    title: data.title,
    author: data.author,
    genre: data.genre as import("./types").Genre,
    age_range: data.ageRange,
    summary: data.summary,
    cover_url: data.selectedCover === "api"
      ? (data.coverUrl ?? data.userPhotoUrl ?? null)
      : (data.userPhotoUrl ?? data.coverUrl ?? null),
    cover_source: data.selectedCover,
    status: "available",
    listed_at: new Date().toISOString(),
    child: {
      id: childId,
      parent_id: "p_demo",
      name: child.name,
      age_group: child.ageGroup as Child["age_group"],
      bookbuddy_id: "BB-DEMO",
      created_at:  "",
    },
  };

  localStorage.setItem(BOOKS_KEY, JSON.stringify([...readLocalBooks(), book]));
  window.dispatchEvent(new Event("bb_books_change"));
  return book;
}

/** Update status of a request (approve / decline / return). */
export function updateRequestStatus(
  requestId: string,
  status: BorrowRequest["status"]
) {
  const local = readLocalRequests();
  const idx = local.findIndex((r) => r.id === requestId);

  if (idx >= 0) {
    local[idx] = {
      ...local[idx],
      status,
      responded_at: status === "approved" || status === "declined" ? new Date().toISOString() : local[idx].responded_at,
      picked_up_at: status === "picked_up" ? new Date().toISOString() : local[idx].picked_up_at,
      returned_at: status === "returned" ? new Date().toISOString() : local[idx].returned_at,
    };
    writeLocalRequests(local);
  }
  // No fallback — pre-cleanup we promoted demo requests to local on
  // first mutation; with demo data gone there's nothing to promote.
}
