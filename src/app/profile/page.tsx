"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { getCurrentChildId, getAllBooks, getAllRequests, DEMO_CHILDREN, type DemoChildId } from "@/lib/userStore";
import Button from "@/components/ui/Button";

export default function ProfilePage() {
  const [childId, setChildId] = useState<DemoChildId>("c1");
  const [childName, setChildName] = useState("Reader");
  const [societyName, setSocietyName] = useState("Sunshine Residency");
  const [totalListed, setTotalListed] = useState(0);
  const [totalLent, setTotalLent] = useState(0);

  const refresh = useCallback(() => {
    const id = getCurrentChildId();
    setChildId(id);

    const demoChild = DEMO_CHILDREN.find((c) => c.id === id);
    if (demoChild) setChildName(demoChild.name);

    // Prefer registration data if it matches
    const stored = localStorage.getItem("bb_child");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.name) setChildName(parsed.name);
      if (parsed.societyName) setSocietyName(parsed.societyName);
    }

    const books = getAllBooks().filter((b) => b.child_id === id);
    setTotalListed(books.length);

    const requests = getAllRequests();
    const lentCount = requests.filter(
      (r) =>
        r.lister_child_id === id &&
        (r.status === "approved" || r.status === "picked_up")
    ).length;
    setTotalLent(lentCount);
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("bb_user_change", refresh);
    window.addEventListener("bb_books_change", refresh);
    window.addEventListener("bb_requests_change", refresh);
    return () => {
      window.removeEventListener("bb_user_change", refresh);
      window.removeEventListener("bb_books_change", refresh);
      window.removeEventListener("bb_requests_change", refresh);
    };
  }, [refresh]);

  return (
    <main className="flex-1 w-full max-w-2xl mx-auto px-5 pb-28">
      <header className="sticky top-0 z-40 bg-surface/80 backdrop-blur-md py-5">
        <h1 className="text-2xl font-headline font-extrabold text-on-surface">
          Profile
        </h1>
      </header>

      <div className="space-y-6">
        {/* Avatar + Name */}
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-full bg-primary-container flex items-center justify-center">
            <span className="material-symbols-outlined text-primary text-4xl">
              person
            </span>
          </div>
          <div>
            <h2 className="text-2xl font-headline font-extrabold text-on-surface">
              {childName}
            </h2>
            <p className="text-sm text-on-surface-variant flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">
                location_on
              </span>
              {societyName}
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-surface-container-lowest p-5 rounded-xl text-center shadow-sm">
            <p className="text-3xl font-headline font-extrabold text-primary">
              {totalListed}
            </p>
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mt-1">
              Books Listed
            </p>
          </div>
          <div className="bg-surface-container-lowest p-5 rounded-xl text-center shadow-sm">
            <p className="text-3xl font-headline font-extrabold text-secondary">
              {totalLent}
            </p>
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mt-1">
              Currently Lent
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <Link href="/book/list" className="block">
            <Button variant="outline" fullWidth>
              <span className="material-symbols-outlined">add</span>
              List a new book
            </Button>
          </Link>
        </div>

        {/* Info */}
        <div className="bg-surface-container-low p-5 rounded-xl space-y-4">
          <h3 className="font-headline font-bold text-on-surface">
            About BookBuddy
          </h3>
          <p className="text-sm text-on-surface-variant leading-relaxed">
            BookBuddy is a peer-to-peer book sharing platform for kids in your
            housing society. List one book, borrow many. No money involved —
            just share the joy of reading!
          </p>
        </div>
      </div>
    </main>
  );
}
