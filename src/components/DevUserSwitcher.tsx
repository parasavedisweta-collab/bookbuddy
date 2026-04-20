"use client";

import { useEffect, useState } from "react";
import { getAllChildren, getCurrentChildId, setCurrentChildId } from "@/lib/userStore";

export default function DevUserSwitcher() {
  const [current, setCurrent] = useState("c1");
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState(getAllChildren());

  useEffect(() => {
    const refresh = () => {
      setCurrent(getCurrentChildId());
      setChildren(getAllChildren());
    };
    refresh();
    window.addEventListener("bb_user_change", refresh);
    window.addEventListener("bb_registered_change", refresh);
    return () => {
      window.removeEventListener("bb_user_change", refresh);
      window.removeEventListener("bb_registered_change", refresh);
    };
  }, []);

  const currentChild = children.find((c) => c.id === current);

  return (
    <div className="fixed bottom-24 right-4 z-50 flex flex-col items-end gap-2">
      {/* Expanded picker */}
      {open && (
        <div className="bg-surface-container-high border border-outline-variant/30 rounded-2xl shadow-xl p-3 flex flex-col gap-1 min-w-[180px] max-h-[60vh] overflow-y-auto">
          <p className="text-[10px] font-bold uppercase tracking-widest text-outline px-2 mb-1">
            Switch user
          </p>
          {children.map((child) => (
            <button
              key={child.id}
              onClick={() => {
                setCurrentChildId(child.id);
                setOpen(false);
              }}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-bold transition-colors ${
                current === child.id
                  ? "bg-primary text-on-primary"
                  : "hover:bg-primary-container/40 text-on-surface"
              }`}
            >
              <span className="text-base">{child.emoji}</span>
              {child.name}
              <span className="text-[10px] font-medium text-on-surface-variant ml-auto">
                {child.id.startsWith("c_") ? "new" : child.id}
              </span>
            </button>
          ))}
          <div className="border-t border-outline-variant/20 mt-1 pt-1">
            <button
              onClick={() => {
                [
                  "bb_borrow_requests",
                  "bb_listed_books",
                  "bb_removed_books",
                  "bb_registered_children",
                  "bb_child",
                  "bb_parent_phone",
                ].forEach((k) => localStorage.removeItem(k));
                // Reset current user to first demo child
                setCurrentChildId("c1");
                window.dispatchEvent(new Event("bb_requests_change"));
                window.dispatchEvent(new Event("bb_books_change"));
                window.dispatchEvent(new Event("bb_registered_change"));
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-error hover:bg-error/10 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">restart_alt</span>
              Reset demo data
            </button>
          </div>
        </div>
      )}

      {/* Trigger pill */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="bg-tertiary text-on-tertiary px-4 py-2 rounded-full shadow-lg flex items-center gap-2 text-sm font-bold"
      >
        <span className="text-base">{currentChild?.emoji ?? "👤"}</span>
        {currentChild?.name ?? "Unknown"}
        <span className="material-symbols-outlined text-base">
          {open ? "expand_more" : "swap_horiz"}
        </span>
      </button>
    </div>
  );
}
