"use client";

/**
 * Legacy phone-entry register page — replaced by /auth/sign-in after
 * migration 0007. Kept as a thin redirect so old bookmarks, push
 * notifications, and any in-flight Vercel previews still land
 * somewhere sensible.
 *
 * Safe to delete once we're confident no live link points here.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LegacyRegisterRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/auth/sign-in");
  }, [router]);

  return (
    <main className="flex-1 flex items-center justify-center px-6">
      <div className="flex items-center gap-3 text-on-surface-variant">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">Taking you to the new sign-in…</span>
      </div>
    </main>
  );
}
