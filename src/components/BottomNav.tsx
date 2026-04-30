"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/shelf", label: "Shelf", icon: "auto_stories" },
  { href: "/profile", label: "Profile", icon: "person" },
] as const;

export default function BottomNav() {
  const pathname = usePathname();

  // Hide nav on auth pages and the marketing landing. /library
  // intentionally keeps it — anonymous browsers see the same chrome
  // they'll get post-signup, just with sign-in bounces from Shelf
  // and Profile (handled by those pages' own gates).
  if (pathname.startsWith("/auth")) return null;
  if (pathname === "/welcome") return null;

  return (
    <nav className="fixed bottom-0 inset-x-0 z-50 bg-surface/80 backdrop-blur-md border-t border-outline-variant">
      <div className="flex justify-around items-center px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {tabs.map((tab) => {
          const active =
            tab.href === "/"
              ? pathname === "/"
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex flex-col items-center gap-1 transition-colors ${
                active ? "text-primary" : "text-on-surface-variant"
              }`}
            >
              <span
                className="material-symbols-outlined text-2xl"
                style={
                  active
                    ? { fontVariationSettings: "'FILL' 1" }
                    : undefined
                }
              >
                {tab.icon}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider font-[var(--font-label)]">
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
