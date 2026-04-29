"use client";

import { useEffect, useState } from "react";
import { getAllBooks, getAllRequests, getAllSocieties, type SocietyWithStats } from "@/lib/userStore";
import type { Book, BorrowRequest } from "@/lib/types";

// ─── Demo user metadata ───────────────────────────────────────────────────────
//
// The admin page is internal tooling and historically rendered against
// three hard-coded demo children. Now that the user-facing app no longer
// merges demo data into its read paths, the static list lives here so
// admin still has a useful sandbox view without polluting userStore's
// public surface. A real "list every user" view needs a SECURITY DEFINER
// RPC (parents.RLS hides anyone but the caller); deferred until admin is
// actually used in anger.
const DEMO_CHILDREN: ReadonlyArray<{
  id: string;
  name: string;
  emoji: string;
  ageGroup: string;
}> = [
  { id: "c1", name: "Jenny", emoji: "📚", ageGroup: "9-12" },
  { id: "c2", name: "Arjun", emoji: "🐶", ageGroup: "6-8" },
  { id: "c3", name: "Priya", emoji: "✨", ageGroup: "9-12" },
];
const DEMO_USER_META: Record<string, { phone: string; society: string; registeredAt: string }> = {
  c1: { phone: "+91 98765 43210", society: "Sunshine Residency", registeredAt: "2024-11-01" },
  c2: { phone: "+91 87654 32109", society: "Sunshine Residency", registeredAt: "2024-11-03" },
  c3: { phone: "+91 76543 21098", society: "Sunshine Residency", registeredAt: "2024-11-07" },
};

type Tab = "users" | "transactions" | "books" | "societies";

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function daysSince(iso: string | null | undefined) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    available:        "bg-primary-container/50 text-on-primary-container",
    borrowed:         "bg-error-container/50 text-on-error-container",
    pending:          "bg-secondary-container text-on-secondary-container",
    approved:         "bg-primary-container text-on-primary-container",
    picked_up:        "bg-primary-container text-on-primary-container",
    returned:         "bg-surface-container-high text-on-surface-variant",
    declined:         "bg-error-container/40 text-on-error-container",
    listed:           "bg-tertiary-container/50 text-on-tertiary-container",
    confirmed_return: "bg-surface-container-high text-on-surface-variant",
  };
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full whitespace-nowrap ${map[status] ?? "bg-surface-container text-on-surface-variant"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function BookPill({ book }: { book: Book }) {
  return (
    <div className="flex items-center gap-1.5 bg-surface-container-low rounded-lg px-2 py-1">
      {book.cover_url && (
        <img src={book.cover_url} alt="" className="w-5 h-7 object-cover rounded shrink-0" />
      )}
      <span className="text-xs text-on-surface font-medium leading-tight line-clamp-1 max-w-[120px]">{book.title}</span>
    </div>
  );
}

// ─── Users View ───────────────────────────────────────────────────────────────
function UsersView({ books, requests }: { books: Book[]; requests: BorrowRequest[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {DEMO_CHILDREN.map((child) => {
        const meta = DEMO_USER_META[child.id];
        const myListedBooks = books.filter(b => b.child_id === child.id);

        const lendingReqs = requests.filter(r =>
          r.lister_child_id === child.id && ["pending", "approved", "picked_up"].includes(r.status)
        );
        const readingReqs = requests.filter(r =>
          r.borrower_child_id === child.id && ["approved", "picked_up"].includes(r.status)
        );
        const requestedReqs = requests.filter(r =>
          r.borrower_child_id === child.id && r.status === "pending"
        );
        const availableBooks = myListedBooks.filter(b =>
          b.status === "available" && !lendingReqs.find(r => r.book_id === b.id)
        );

        const isOpen = expanded === child.id;

        const sections = [
          { label: "Listed & Available", books: availableBooks,                                          color: "text-primary",   icon: "shelves"        },
          { label: "I'm Lending",        books: lendingReqs.map(r => r.book).filter(Boolean) as Book[],  color: "text-secondary", icon: "upload"         },
          { label: "I'm Reading",        books: readingReqs.map(r => r.book).filter(Boolean) as Book[],  color: "text-tertiary",  icon: "menu_book"      },
          { label: "Requested",          books: requestedReqs.map(r => r.book).filter(Boolean) as Book[], color: "text-outline",  icon: "pending"        },
        ];

        return (
          <div key={child.id} className="border border-outline-variant/20 rounded-xl overflow-hidden">
            {/* Row header */}
            <button
              onClick={() => setExpanded(isOpen ? null : child.id)}
              className="w-full flex items-center gap-4 px-5 py-4 hover:bg-surface-container-low transition-colors text-left"
            >
              <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-xl shrink-0">
                {child.emoji}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-headline font-bold text-on-surface">{child.name}</span>
                  <span className="font-mono text-xs text-outline">{child.id}</span>
                  <span className="text-xs text-on-surface-variant">{meta.phone}</span>
                  <span className="text-xs text-on-surface-variant">{meta.society}</span>
                  <span className="text-xs text-outline">Joined {fmt(meta.registeredAt)}</span>
                </div>
                <div className="flex items-center gap-4 mt-1.5 flex-wrap">
                  {sections.map(s => s.books.length > 0 && (
                    <span key={s.label} className={`text-xs font-bold ${s.color}`}>
                      {s.books.length} {s.label}
                    </span>
                  ))}
                  {sections.every(s => s.books.length === 0) && (
                    <span className="text-xs text-outline">No activity</span>
                  )}
                </div>
              </div>
              <span className={`material-symbols-outlined text-outline transition-transform ${isOpen ? "rotate-180" : ""}`}>
                expand_more
              </span>
            </button>

            {/* Expanded detail */}
            {isOpen && (
              <div className="border-t border-outline-variant/20 px-5 py-4 bg-surface-container-lowest grid grid-cols-2 gap-5">
                {sections.map(s => (
                  <div key={s.label}>
                    <h4 className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider mb-2 ${s.color}`}>
                      <span className="material-symbols-outlined text-sm">{s.icon}</span>
                      {s.label}
                    </h4>
                    {s.books.length === 0
                      ? <p className="text-xs text-outline italic">None</p>
                      : (
                        <div className="flex flex-wrap gap-1.5">
                          {s.books.map(b => <BookPill key={b.id} book={b} />)}
                        </div>
                      )
                    }
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Transaction View (unified activity log) ──────────────────────────────────
type TxEvent = {
  id: string;
  ts: string;
  type: "listed" | "requested" | "approved" | "declined" | "picked_up" | "returned";
  book: Book | undefined;
  actor: string;   // who did this action
  other?: string;  // counterparty if relevant
};

function TransactionsView({ books, requests }: { books: Book[]; requests: BorrowRequest[] }) {
  const [filterType, setFilterType] = useState<TxEvent["type"] | "all">("all");
  const [filterUser, setFilterUser] = useState<string>("all");
  const [search, setSearch]         = useState("");

  // Build unified event list
  const events: TxEvent[] = [];

  // Listing events — one per book
  books.forEach(b => {
    events.push({
      id:    `list_${b.id}`,
      ts:    b.listed_at,
      type:  "listed",
      book:  b,
      actor: b.child?.name ?? b.child_id,
    });
  });

  // Borrow request lifecycle events
  requests.forEach(r => {
    const book = r.book ?? books.find(b => b.id === r.book_id);
    const borrower = r.borrower_child?.name ?? r.borrower_child_id;
    const lister   = r.lister_child?.name   ?? r.lister_child_id;

    events.push({ id: `${r.id}_req`,  ts: r.requested_at,  type: "requested",  book, actor: borrower, other: lister });
    if (r.responded_at) {
      if (r.status === "declined") {
        events.push({ id: `${r.id}_dec`, ts: r.responded_at, type: "declined", book, actor: lister, other: borrower });
      } else {
        events.push({ id: `${r.id}_app`, ts: r.responded_at, type: "approved", book, actor: lister, other: borrower });
      }
    }
    if (r.picked_up_at)  events.push({ id: `${r.id}_pick`, ts: r.picked_up_at,  type: "picked_up", book, actor: borrower, other: lister });
    if (r.returned_at)   events.push({ id: `${r.id}_ret`,  ts: r.returned_at,   type: "returned",  book, actor: borrower, other: lister });
  });

  events.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  // All unique actors for the user dropdown
  const allActors = Array.from(new Set(events.flatMap(e => [e.actor, e.other].filter(Boolean) as string[])));

  const visible = events.filter(ev => {
    if (filterType !== "all" && ev.type !== filterType) return false;
    if (filterUser !== "all" && ev.actor !== filterUser && ev.other !== filterUser) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (
        !ev.book?.title?.toLowerCase().includes(q) &&
        !ev.actor.toLowerCase().includes(q) &&
        !(ev.other?.toLowerCase().includes(q))
      ) return false;
    }
    return true;
  });

  const iconMap: Record<TxEvent["type"], { icon: string; color: string; label: string }> = {
    listed:     { icon: "add_circle",    color: "text-tertiary",  label: "Listed"     },
    requested:  { icon: "pending",       color: "text-secondary", label: "Requested"  },
    approved:   { icon: "check_circle",  color: "text-primary",   label: "Approved"   },
    declined:   { icon: "cancel",        color: "text-error",     label: "Declined"   },
    picked_up:  { icon: "local_library", color: "text-primary",   label: "Picked up"  },
    returned:   { icon: "assignment_return", color: "text-outline", label: "Returned" },
  };

  const EVENT_TYPES: { value: TxEvent["type"] | "all"; label: string }[] = [
    { value: "all",       label: "All events"  },
    { value: "listed",    label: "Listed"      },
    { value: "requested", label: "Requested"   },
    { value: "approved",  label: "Approved"    },
    { value: "declined",  label: "Declined"    },
    { value: "picked_up", label: "Picked up"   },
    { value: "returned",  label: "Returned"    },
  ];

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 items-center pb-4 border-b border-outline-variant/20">
        {/* Search */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-outline text-base">search</span>
          <input
            type="text"
            placeholder="Book title or user…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-sm bg-surface-container-high rounded-lg border-none outline-none focus:ring-2 focus:ring-primary-container text-on-surface placeholder:text-outline-variant w-48"
          />
        </div>

        {/* Event type chips */}
        <div className="flex flex-wrap gap-1.5">
          {EVENT_TYPES.map(et => (
            <button
              key={et.value}
              onClick={() => setFilterType(et.value)}
              className={`px-3 py-1 rounded-full text-xs font-bold transition-colors ${
                filterType === et.value
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container"
              }`}
            >
              {et.label}
            </button>
          ))}
        </div>

        {/* User dropdown */}
        <select
          value={filterUser}
          onChange={e => setFilterUser(e.target.value)}
          className="px-3 py-1.5 text-sm bg-surface-container-high rounded-lg border-none outline-none focus:ring-2 focus:ring-primary-container text-on-surface"
        >
          <option value="all">All users</option>
          {allActors.map(a => <option key={a} value={a}>{a}</option>)}
        </select>

        {/* Result count + clear */}
        <span className="text-xs text-outline ml-auto">
          {visible.length} of {events.length} events
        </span>
        {(filterType !== "all" || filterUser !== "all" || search) && (
          <button
            onClick={() => { setFilterType("all"); setFilterUser("all"); setSearch(""); }}
            className="text-xs text-primary font-bold hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Event list */}
      <div className="space-y-1">
        {visible.length === 0 ? (
          <p className="text-center text-outline py-8 text-sm">No events match these filters.</p>
        ) : visible.map(ev => {
          const meta = iconMap[ev.type];
          return (
            <div key={ev.id} className="flex items-center gap-4 px-4 py-3 rounded-xl hover:bg-surface-container-low transition-colors">
              <span className={`material-symbols-outlined text-xl shrink-0 ${meta.color}`}
                style={{ fontVariationSettings: "'FILL' 1" }}>
                {meta.icon}
              </span>
              {ev.book?.cover_url ? (
                <img src={ev.book.cover_url} alt="" className="w-8 h-10 object-cover rounded shrink-0" />
              ) : (
                <div className="w-8 h-10 bg-surface-container-high rounded flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-xs text-outline-variant">menu_book</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-on-surface leading-tight">
                  <span className="font-bold">{ev.actor}</span>
                  {" "}<span className={`font-semibold ${meta.color}`}>{meta.label.toLowerCase()}</span>{" "}
                  <span className="font-bold">&ldquo;{ev.book?.title ?? "Unknown"}&rdquo;</span>
                  {ev.other && ev.type !== "listed" && (
                    <span className="text-on-surface-variant">
                      {" "}{["requested","picked_up","returned"].includes(ev.type) ? "from" : "to"}{" "}
                      <span className="font-semibold text-on-surface">{ev.other}</span>
                    </span>
                  )}
                </p>
                <p className="text-xs text-outline mt-0.5">{fmtTime(ev.ts)}</p>
              </div>
              <StatusPill status={ev.type} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Book View ────────────────────────────────────────────────────────────────
function BooksView({ books, requests }: { books: Book[]; requests: BorrowRequest[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-outline-variant/30 text-left">
            {["Book", "Genre", "Age", "Listed By", "Listed On", "Status", "With", "Since", "Days Out"].map(h => (
              <th key={h} className="pb-3 pr-6 text-[11px] font-bold uppercase tracking-wider text-outline whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-outline-variant/20">
          {books.map((book) => {
            const activeReq = requests.find(
              r => r.book_id === book.id && (r.status === "approved" || r.status === "picked_up")
            );
            const daysOut = activeReq?.picked_up_at ? daysSince(activeReq.picked_up_at) : null;

            return (
              <tr key={book.id} className="hover:bg-surface-container-low transition-colors">
                <td className="py-3 pr-6">
                  <div className="flex items-center gap-2">
                    {book.cover_url ? (
                      <img src={book.cover_url} alt="" className="w-8 h-10 object-cover rounded shrink-0" />
                    ) : (
                      <div className="w-8 h-10 bg-surface-container-high rounded flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-sm text-outline-variant">menu_book</span>
                      </div>
                    )}
                    <div>
                      <p className="font-bold text-on-surface leading-tight line-clamp-1 max-w-[160px]">{book.title}</p>
                      <p className="text-xs text-outline">{book.author}</p>
                    </div>
                  </div>
                </td>
                <td className="py-3 pr-6 text-xs text-on-surface-variant">{book.genre ?? "—"}</td>
                <td className="py-3 pr-6 text-on-surface-variant whitespace-nowrap">{book.age_range ?? "—"}</td>
                <td className="py-3 pr-6 text-on-surface-variant">{book.child?.name ?? book.child_id}</td>
                <td className="py-3 pr-6 text-on-surface-variant whitespace-nowrap">{fmt(book.listed_at)}</td>
                <td className="py-3 pr-6"><StatusPill status={book.status} /></td>
                <td className="py-3 pr-6 text-on-surface-variant">
                  {activeReq ? activeReq.borrower_child?.name ?? activeReq.borrower_child_id : "—"}
                </td>
                <td className="py-3 pr-6 text-on-surface-variant whitespace-nowrap">
                  {activeReq?.picked_up_at ? fmt(activeReq.picked_up_at) : "—"}
                </td>
                <td className="py-3 pr-6">
                  {daysOut !== null
                    ? <span className={`font-bold ${daysOut > 14 ? "text-error" : "text-on-surface"}`}>{daysOut}d</span>
                    : <span className="text-outline">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Societies View ───────────────────────────────────────────────────────────
function SocietiesView({ societies }: { societies: SocietyWithStats[] }) {
  const [search, setSearch] = useState("");

  const filtered = societies.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.city.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
  });

  const verified   = filtered.filter((s) => s.verified).sort((a, b) => b.memberCount - a.memberCount);
  const unverified = filtered.filter((s) => !s.verified).sort((a, b) => b.memberCount - a.memberCount);

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-primary-container/30 rounded-lg px-4 py-3">
          <p className="text-2xl font-headline font-extrabold text-primary">{societies.length}</p>
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mt-1">Total societies</p>
        </div>
        <div className="bg-primary-container/20 rounded-lg px-4 py-3">
          <p className="text-2xl font-headline font-extrabold text-primary">{verified.length}</p>
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mt-1">Verified (≥3 members)</p>
        </div>
        <div className="bg-secondary-container/30 rounded-lg px-4 py-3">
          <p className="text-2xl font-headline font-extrabold text-secondary">{unverified.length}</p>
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mt-1">Needs review</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, city, or id…"
          className="w-full px-4 py-2 rounded-lg bg-surface-container-low border border-outline-variant/20 text-sm placeholder:text-outline focus:outline-none focus:border-primary"
        />
      </div>

      {/* Review queue — unverified societies */}
      {unverified.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-secondary text-base">warning</span>
            <h3 className="text-sm font-bold text-on-surface">Review queue · {unverified.length}</h3>
            <span className="text-xs text-outline">— societies with fewer than 3 members; check for duplicates</span>
          </div>
          <div className="overflow-x-auto rounded-lg border border-outline-variant/20">
            <table className="w-full text-sm">
              <thead className="bg-surface-container text-xs uppercase text-on-surface-variant">
                <tr>
                  <th className="text-left px-4 py-2 font-bold">Society</th>
                  <th className="text-left px-4 py-2 font-bold">City</th>
                  <th className="text-left px-4 py-2 font-bold">ID</th>
                  <th className="text-right px-4 py-2 font-bold">Members</th>
                  <th className="text-right px-4 py-2 font-bold">Books</th>
                  <th className="text-left px-4 py-2 font-bold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {unverified.map((s) => (
                  <tr key={s.id} className="bg-secondary-container/5">
                    <td className="px-4 py-2 font-semibold text-on-surface">{s.name}</td>
                    <td className="px-4 py-2 text-on-surface-variant">{s.city}</td>
                    <td className="px-4 py-2 text-xs text-outline font-mono">{s.id}</td>
                    <td className="px-4 py-2 text-right font-bold">{s.memberCount}</td>
                    <td className="px-4 py-2 text-right">{s.bookCount}</td>
                    <td className="px-4 py-2">
                      <button
                        className="text-xs text-primary font-bold hover:underline"
                        onClick={() => alert(`Merge ${s.name} into another society — TODO wire up`)}
                      >
                        Merge…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Verified societies */}
      {verified.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-primary text-base">verified</span>
            <h3 className="text-sm font-bold text-on-surface">Verified societies · {verified.length}</h3>
          </div>
          <div className="overflow-x-auto rounded-lg border border-outline-variant/20">
            <table className="w-full text-sm">
              <thead className="bg-surface-container text-xs uppercase text-on-surface-variant">
                <tr>
                  <th className="text-left px-4 py-2 font-bold">Society</th>
                  <th className="text-left px-4 py-2 font-bold">City</th>
                  <th className="text-left px-4 py-2 font-bold">ID</th>
                  <th className="text-right px-4 py-2 font-bold">Members</th>
                  <th className="text-right px-4 py-2 font-bold">Books</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {verified.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-2 font-semibold text-on-surface flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary text-base" style={{ fontVariationSettings: "'FILL' 1" }}>verified</span>
                      {s.name}
                    </td>
                    <td className="px-4 py-2 text-on-surface-variant">{s.city}</td>
                    <td className="px-4 py-2 text-xs text-outline font-mono">{s.id}</td>
                    <td className="px-4 py-2 text-right font-bold">{s.memberCount}</td>
                    <td className="px-4 py-2 text-right">{s.bookCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {filtered.length === 0 && (
        <p className="text-center text-on-surface-variant py-12">No societies match your search.</p>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("users");
  const [books, setBooks] = useState<Book[]>([]);
  const [requests, setRequests] = useState<BorrowRequest[]>([]);
  const [societies, setSocieties] = useState<SocietyWithStats[]>([]);

  useEffect(() => {
    const refresh = () => {
      setBooks(getAllBooks());
      setRequests(getAllRequests());
      setSocieties(getAllSocieties());
    };
    refresh();
    window.addEventListener("bb_books_change", refresh);
    window.addEventListener("bb_requests_change", refresh);
    window.addEventListener("bb_registered_change", refresh);
    return () => {
      window.removeEventListener("bb_books_change", refresh);
      window.removeEventListener("bb_requests_change", refresh);
      window.removeEventListener("bb_registered_change", refresh);
    };
  }, []);

  const stats = {
    users:   DEMO_CHILDREN.length,
    books:   books.length,
    active:  requests.filter(r => r.status === "picked_up" || r.status === "approved").length,
    pending: requests.filter(r => r.status === "pending").length,
  };

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "users",        label: "Users",        icon: "group"      },
    { id: "transactions", label: "Transactions", icon: "swap_horiz" },
    { id: "books",        label: "Books",        icon: "menu_book"  },
    { id: "societies",    label: "Societies",    icon: "apartment"  },
  ];

  return (
    <div className="min-h-screen bg-surface">
      {/* Top bar */}
      <header className="bg-surface-container-low border-b border-outline-variant/20 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <span className="material-symbols-outlined text-on-primary text-lg">shield</span>
          </div>
          <div>
            <h1 className="font-headline font-extrabold text-on-surface text-lg leading-none">BookBuds Admin</h1>
            <p className="text-xs text-outline mt-0.5">All societies · Demo data</p>
          </div>
        </div>
        <a href="/" className="text-sm text-primary font-bold flex items-center gap-1 hover:underline">
          <span className="material-symbols-outlined text-sm">arrow_back</span>
          Back to app
        </a>
      </header>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-px bg-outline-variant/10 border-b border-outline-variant/20">
        {[
          { label: "Total Users",        value: stats.users,   color: "text-primary"   },
          { label: "Books in Library",   value: stats.books,   color: "text-secondary" },
          { label: "Active Borrows",     value: stats.active,  color: "text-tertiary"  },
          { label: "Pending Requests",   value: stats.pending, color: "text-error"     },
        ].map(s => (
          <div key={s.label} className="bg-surface px-6 py-4">
            <p className={`text-3xl font-headline font-extrabold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-outline mt-1 uppercase tracking-wide font-bold">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="border-b border-outline-variant/20 px-6 flex gap-1 bg-surface">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-bold border-b-2 transition-colors -mb-px ${
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-outline hover:text-on-surface"
            }`}
          >
            <span className="material-symbols-outlined text-base">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-6">
        <div className="bg-surface-container-lowest rounded-xl shadow-sm p-6">
          {tab === "users"        && <UsersView        books={books} requests={requests} />}
          {tab === "transactions" && <TransactionsView books={books} requests={requests} />}
          {tab === "books"        && <BooksView        books={books} requests={requests} />}
          {tab === "societies"    && <SocietiesView    societies={societies} />}
        </div>
      </div>
    </div>
  );
}
