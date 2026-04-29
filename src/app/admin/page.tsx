"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import {
  isAdmin,
  adminListUsers,
  adminListBorrowRequests,
  type AdminUserRow,
  type AdminBorrowRequestRow,
} from "@/lib/supabase/adminRpcs";
import { mapFeedRowToBook } from "@/lib/supabase/feed";
import type { DbBookWithListerContext } from "@/lib/supabase/books";
import type { Book, BorrowRequest } from "@/lib/types";

/**
 * SocietyStats is computed in the admin page (not pulled from a single
 * Supabase view) so we can join the admin-only user list against the
 * permissively-readable books table without an extra RPC. Mirrors the
 * old `SocietyWithStats` shape from userStore — kept locally because
 * userStore no longer aggregates anything for admin.
 */
interface SocietyStats {
  id: string;
  name: string;
  city: string;
  memberCount: number;
  bookCount: number;
  /** ≥3 distinct parents; matches the registration picker's notion. */
  verified: boolean;
}

/**
 * Adapter: BorrowRequest in the admin RPC is intentionally flatter
 * (pre-joined names, status as text) than the app's domain
 * `BorrowRequest`. We synthesize partial nested objects so the existing
 * Transactions/Books views — which deeply consume `r.book.title`,
 * `r.borrower_child.name`, etc. — keep working without a wide rewrite.
 * Anything not provided by the RPC (parent_id on the child, age_group)
 * is left blank; admin views never read those fields.
 */
function mapAdminRequestToBorrowRequest(
  r: AdminBorrowRequestRow,
  bookMap: Map<string, Book>
): BorrowRequest {
  const book = bookMap.get(r.book_id);
  return {
    id: r.id,
    book_id: r.book_id,
    borrower_child_id: r.borrower_child_id,
    lister_child_id: r.lister_child_id,
    status: r.status as BorrowRequest["status"],
    requested_at: r.requested_at,
    responded_at: r.responded_at,
    picked_up_at: r.picked_up_at,
    returned_at: r.returned_at,
    return_confirmed_at: r.return_confirmed_at,
    due_date: null,
    book,
    borrower_child: r.borrower_child_name
      ? {
          id: r.borrower_child_id,
          parent_id: "",
          name: r.borrower_child_name,
          bookbuddy_id: "",
          created_at: "",
        }
      : undefined,
    lister_child: r.lister_child_name
      ? {
          id: r.lister_child_id,
          parent_id: "",
          name: r.lister_child_name,
          bookbuddy_id: "",
          created_at: "",
        }
      : undefined,
  };
}

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
//
// One row per (parent, child) combo. The admin RPC returns parents
// LEFT-JOIN children, so a parent with two kids appears as two rows
// and a parent with no kids appears once with `child_id = null`. We
// render the kid-less rows as a "no children yet" entry — it's the
// signal that someone signed up but never finished adding a child.
function UsersView({
  users,
  books,
  requests,
}: {
  users: AdminUserRow[];
  books: Book[];
  requests: BorrowRequest[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (users.length === 0) {
    return (
      <p className="text-center text-on-surface-variant py-12 text-sm">
        No users registered yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {users.map((u) => {
        // Each row's stable key — parent_id alone collides for parents
        // with multiple children, so we mix in child_id (or "none" for
        // the no-children case).
        const rowKey = `${u.parent_id}::${u.child_id ?? "none"}`;

        // Books / requests for the no-children case have no child_id
        // to match against, so the activity sections are empty.
        const childId = u.child_id;
        const myListedBooks = childId
          ? books.filter((b) => b.child_id === childId)
          : [];
        const lendingReqs = childId
          ? requests.filter(
              (r) =>
                r.lister_child_id === childId &&
                ["pending", "approved", "picked_up"].includes(r.status)
            )
          : [];
        const readingReqs = childId
          ? requests.filter(
              (r) =>
                r.borrower_child_id === childId &&
                ["approved", "picked_up"].includes(r.status)
            )
          : [];
        const requestedReqs = childId
          ? requests.filter(
              (r) =>
                r.borrower_child_id === childId && r.status === "pending"
            )
          : [];
        const availableBooks = myListedBooks.filter(
          (b) =>
            b.status === "available" &&
            !lendingReqs.find((r) => r.book_id === b.id)
        );

        const isOpen = expanded === rowKey;

        const sections = [
          { label: "Listed & Available", books: availableBooks,                                            color: "text-primary",   icon: "shelves"        },
          { label: "I'm Lending",        books: lendingReqs.map((r) => r.book).filter(Boolean) as Book[],   color: "text-secondary", icon: "upload"         },
          { label: "I'm Reading",        books: readingReqs.map((r) => r.book).filter(Boolean) as Book[],   color: "text-tertiary",  icon: "menu_book"      },
          { label: "Requested",          books: requestedReqs.map((r) => r.book).filter(Boolean) as Book[], color: "text-outline",   icon: "pending"        },
        ];

        const societyLabel = [u.society_name, u.society_city]
          .filter(Boolean)
          .join(", ");
        const childLabel = childId
          ? u.child_name
          : "No children yet";
        const emoji = u.child_emoji || "👤";

        return (
          <div
            key={rowKey}
            className="border border-outline-variant/20 rounded-xl overflow-hidden"
          >
            {/* Row header */}
            <button
              onClick={() => setExpanded(isOpen ? null : rowKey)}
              className="w-full flex items-center gap-4 px-5 py-4 hover:bg-surface-container-low transition-colors text-left"
            >
              <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-xl shrink-0">
                {emoji}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-headline font-bold text-on-surface">
                    {childLabel}
                  </span>
                  {u.child_bookbuddy_id && (
                    <span className="font-mono text-xs text-outline">
                      {u.child_bookbuddy_id}
                    </span>
                  )}
                  <span className="text-xs text-on-surface-variant">
                    {u.email}
                  </span>
                  {u.phone && (
                    <span className="text-xs text-on-surface-variant">
                      {u.phone}
                    </span>
                  )}
                  {societyLabel && (
                    <span className="text-xs text-on-surface-variant">
                      {societyLabel}
                    </span>
                  )}
                  <span className="text-xs text-outline">
                    Joined {fmt(u.registered_at)}
                  </span>
                </div>
                <div className="flex items-center gap-4 mt-1.5 flex-wrap">
                  {sections.map(
                    (s) =>
                      s.books.length > 0 && (
                        <span
                          key={s.label}
                          className={`text-xs font-bold ${s.color}`}
                        >
                          {s.books.length} {s.label}
                        </span>
                      )
                  )}
                  {sections.every((s) => s.books.length === 0) && (
                    <span className="text-xs text-outline">No activity</span>
                  )}
                </div>
              </div>
              <span
                className={`material-symbols-outlined text-outline transition-transform ${
                  isOpen ? "rotate-180" : ""
                }`}
              >
                expand_more
              </span>
            </button>

            {/* Expanded detail — only meaningful when there's a child */}
            {isOpen && childId && (
              <div className="border-t border-outline-variant/20 px-5 py-4 bg-surface-container-lowest grid grid-cols-2 gap-5">
                {sections.map((s) => (
                  <div key={s.label}>
                    <h4
                      className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider mb-2 ${s.color}`}
                    >
                      <span className="material-symbols-outlined text-sm">
                        {s.icon}
                      </span>
                      {s.label}
                    </h4>
                    {s.books.length === 0 ? (
                      <p className="text-xs text-outline italic">None</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {s.books.map((b) => (
                          <BookPill key={b.id} book={b} />
                        ))}
                      </div>
                    )}
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
function SocietiesView({ societies }: { societies: SocietyStats[] }) {
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
//
// Auth gate: every read on this page is admin-only. We probe is_admin()
// once on mount and route non-admins back to / before any UI renders.
// "checking" while the probe is in flight; "ok" lets the page render;
// "denied" should be transient (the redirect runs immediately) but is
// captured separately so the page never renders a half-loaded admin
// chrome to a non-admin.
type AdminGate = "checking" | "ok" | "denied";

export default function AdminPage() {
  const router = useRouter();
  const [gate, setGate] = useState<AdminGate>("checking");
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [requests, setRequests] = useState<BorrowRequest[]>([]);

  // Auth gate. Two failure modes — no session (kicked to /auth/sign-in)
  // and signed-in-but-not-admin (kicked to /). Both end up off this
  // page; the distinct destinations are nicer for the human flow.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const supabase = getSupabase();
        const { data: sessionData } = await supabase.auth.getSession();
        if (cancelled) return;
        if (!sessionData.session?.user?.id) {
          setGate("denied");
          router.replace("/auth/sign-in");
          return;
        }
        const allowed = await isAdmin();
        if (cancelled) return;
        if (!allowed) {
          setGate("denied");
          router.replace("/");
          return;
        }
        setGate("ok");
      } catch (err) {
        console.error("[admin] gate check failed:", err);
        if (!cancelled) {
          setGate("denied");
          router.replace("/");
        }
      }
    }
    check();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Fetch data in parallel once admin status is confirmed. Kept
  // separate from the gate effect so a slow data load doesn't block
  // the gate's redirect, and so we never issue the (admin-only) RPCs
  // for a non-admin caller.
  useEffect(() => {
    if (gate !== "ok") return;
    let cancelled = false;
    async function load() {
      try {
        const supabase = getSupabase();
        const [userRows, requestRows, bookRowsResult] = await Promise.all([
          adminListUsers(),
          adminListBorrowRequests(),
          // books.SELECT is permissive RLS, so admin reads it directly
          // via the same join-on-children pattern used by the home feed.
          // Reuse mapFeedRowToBook to keep the cover/null-handling rules
          // in one place.
          supabase
            .from("books")
            .select(
              `id, child_id, title, author, isbn, description, category,
               cover_url, cover_source, status, listed_at, metadata,
               child:children!inner(id, name, emoji, society_id, parent_id)`
            )
            .neq("status", "removed")
            .order("listed_at", { ascending: false }),
        ]);
        if (cancelled) return;

        const bookRows = (bookRowsResult.data ??
          []) as unknown as DbBookWithListerContext[];
        const mappedBooks = bookRows.map(mapFeedRowToBook);
        const bookMap = new Map(mappedBooks.map((b) => [b.id, b]));

        const mappedRequests = requestRows.map((r) =>
          mapAdminRequestToBorrowRequest(r, bookMap)
        );

        setUsers(userRows);
        setBooks(mappedBooks);
        setRequests(mappedRequests);
      } catch (err) {
        console.error("[admin] data load failed:", err);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  // Compute society stats from the user + book rows we already fetched.
  // Member count = distinct parents per society (admin RPC handles the
  // RLS); book count = books whose child.society_id matches.
  const societies: SocietyStats[] = useMemo(() => {
    const map = new Map<string, SocietyStats>();
    const parentsBySociety = new Map<string, Set<string>>();

    for (const u of users) {
      if (!u.society_id) continue;
      if (!map.has(u.society_id)) {
        map.set(u.society_id, {
          id: u.society_id,
          name: u.society_name ?? "—",
          city: u.society_city ?? "",
          memberCount: 0,
          bookCount: 0,
          verified: false,
        });
      }
      let set = parentsBySociety.get(u.society_id);
      if (!set) {
        set = new Set<string>();
        parentsBySociety.set(u.society_id, set);
      }
      set.add(u.parent_id);
    }
    for (const [sid, set] of parentsBySociety.entries()) {
      const s = map.get(sid);
      if (s) s.memberCount = set.size;
    }
    for (const b of books) {
      const s = map.get(b.society_id);
      if (s) s.bookCount++;
    }
    for (const s of map.values()) s.verified = s.memberCount >= 3;
    return Array.from(map.values());
  }, [users, books]);

  const stats = {
    // Distinct parents (a parent with two children appears twice in
    // the RPC payload but should only count once).
    users: new Set(users.map((u) => u.parent_id)).size,
    books: books.length,
    active: requests.filter(
      (r) => r.status === "picked_up" || r.status === "approved"
    ).length,
    pending: requests.filter((r) => r.status === "pending").length,
  };

  // Render gate. While the auth probe is in flight, show a thin
  // spinner — this is the admin chrome's first paint, so a bare div
  // is better than flashing the full layout for a non-admin who's
  // about to be redirected.
  if (gate !== "ok") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface">
        <div
          className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin"
          aria-label="Checking admin access"
        />
      </div>
    );
  }

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
            <p className="text-xs text-outline mt-0.5">All societies · Live data</p>
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
          {tab === "users"        && <UsersView        users={users} books={books} requests={requests} />}
          {tab === "transactions" && <TransactionsView books={books} requests={requests} />}
          {tab === "books"        && <BooksView        books={books} requests={requests} />}
          {tab === "societies"    && <SocietiesView    societies={societies} />}
        </div>
      </div>
    </div>
  );
}
