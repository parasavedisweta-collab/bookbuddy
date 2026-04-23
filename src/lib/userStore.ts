/**
 * Demo-mode user store.
 * Persists current child ID and borrow requests in localStorage so two browser
 * tabs (or a single tab with the switcher) can simulate two users interacting.
 */
import type { BorrowRequest, Book, Child } from "./types";
import { DEMO_BOOKS, DEMO_BORROW_REQUESTS } from "./demoData";

export const DEMO_CHILDREN = [
  { id: "c1", name: "Jenny",  emoji: "📚", ageGroup: "9-12" },
  { id: "c2", name: "Arjun",  emoji: "🐶", ageGroup: "6-8"  },
  { id: "c3", name: "Priya",  emoji: "✨", ageGroup: "9-12" },
] as const;


/** All child IDs are plain strings; demo IDs happen to be "c1"/"c2"/"c3". */
export type DemoChildId = string;

/* ── Societies ───────────────────────────────────────────────── */

export interface Society {
  id: string;
  name: string;
  city: string;
}

export const DEMO_SOCIETIES: Society[] = [
  { id: "s1", name: "Green Meadows", city: "Mumbai" },
];

/** Slug a free-text society name + city into a stable ID. */
export function societyNameToId(name: string, city: string = ""): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const n = slug(name);
  const c = slug(city);
  if (!n) return "s1";
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

/** Returns the child record (demo or registered) for a given id, or null. */
export function findChildById(id: string) {
  const demo = DEMO_CHILDREN.find((c) => c.id === id);
  if (demo) return { id: demo.id, name: demo.name, emoji: demo.emoji, ageGroup: demo.ageGroup, societyId: "s1" };
  const reg = readRegisteredChildren().find((c) => c.id === id);
  if (reg) return { id: reg.id, name: reg.name, emoji: reg.emoji, ageGroup: reg.ageGroup, societyId: reg.societyId };
  return null;
}

/** All children: demo + registered. */
export function getAllChildren(): Array<{ id: string; name: string; emoji: string; ageGroup: string; societyId: string }> {
  const reg = readRegisteredChildren().map((c) => ({
    id: c.id, name: c.name, emoji: c.emoji, ageGroup: c.ageGroup, societyId: c.societyId,
  }));
  return [
    ...DEMO_CHILDREN.map((c) => ({ ...c, societyId: "s1" })),
    ...reg,
  ];
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
    societyId: params.societyId ?? "s1",
    societyName: params.societyName ?? "Green Meadows",
    societyCity: params.societyCity ?? "Mumbai",
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

/** All known societies (demo + registered), with member and book counts. */
export function getAllSocieties(): SocietyWithStats[] {
  const map = new Map<string, SocietyWithStats>();

  // Seed with demo societies
  for (const s of DEMO_SOCIETIES) {
    map.set(s.id, { ...s, memberCount: 0, bookCount: 0, verified: false });
  }

  // Pull in registered-child societies
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

  // Count members (demo children + registered)
  // DEMO_CHILDREN are all in s1 by convention
  for (const _c of DEMO_CHILDREN) {
    const s = map.get("s1");
    if (s) s.memberCount++;
  }
  for (const r of readRegisteredChildren()) {
    const s = map.get(r.societyId);
    if (s) s.memberCount++;
  }

  // Count books
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

export function getCurrentChildId(): DemoChildId {
  if (typeof window === "undefined") return "c1";
  return (localStorage.getItem(CHILD_KEY) as DemoChildId) ?? "c1";
}

/** Returns the society ID for the currently active child. */
export function getCurrentUserSocietyId(): string {
  const child = findChildById(getCurrentChildId());
  return child?.societyId ?? "s1";
}

export function setCurrentChildId(id: DemoChildId) {
  localStorage.setItem(CHILD_KEY, id);
  window.dispatchEvent(new Event("bb_user_change"));
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

/** All requests: demo seed + locally created/mutated ones.
 *  Local entries override demo entries with the same ID. */
export function getAllRequests(): BorrowRequest[] {
  const local = readLocalRequests();
  const localIds = new Set(local.map((r) => r.id));
  const deduped = DEMO_BORROW_REQUESTS.filter((r) => !localIds.has(r.id));
  return [...deduped, ...local];
}

/** Create a new borrow request from the current user for a book. */
export function createBorrowRequest(bookId: string, borrowerChildId: DemoChildId): BorrowRequest | null {
  const allB = getAllBooks();
  const book = allB.find((b) => b.id === bookId);
  if (!book) return null;

  const listerChild = findChildById(book.child_id);
  const borrowerChild = findChildById(borrowerChildId);

  const req: BorrowRequest = {
    id: `br_${Date.now()}`,
    book_id: bookId,
    borrower_child_id: borrowerChildId,
    lister_child_id: book.child_id as DemoChildId,
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

/** All books: demo seed + locally listed ones, minus removed.
 *  Status is overlaid from active borrow requests so "borrowed" is always accurate. */
export function getAllBooks(): Book[] {
  const removed = readRemovedIds();
  const books = [...DEMO_BOOKS, ...readLocalBooks()].filter((b) => !removed.has(b.id));

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
  } else {
    // It's a demo request — promote it to local so we can mutate it
    const demo = DEMO_BORROW_REQUESTS.find((r) => r.id === requestId);
    if (demo) {
      const updated = {
        ...demo,
        status,
        responded_at: status === "approved" || status === "declined" ? new Date().toISOString() : demo.responded_at,
        picked_up_at: status === "picked_up" ? new Date().toISOString() : demo.picked_up_at,
        returned_at: status === "returned" ? new Date().toISOString() : demo.returned_at,
      };
      writeLocalRequests([...local, updated]);
    }
  }
}
