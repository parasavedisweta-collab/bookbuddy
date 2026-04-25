/**
 * PushBootstrap — registers /sw.js on mount.
 *
 * Splitting this out of SupabaseAuthBootstrap (rather than piggybacking)
 * because the two have different failure modes: auth bootstrap MUST
 * succeed for the app to function, push bootstrap is best-effort and
 * its absence is invisible to the user.
 *
 * Renders nothing.
 */
"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/push";

export default function PushBootstrap() {
  useEffect(() => {
    // Fire-and-forget. registerServiceWorker handles its own try/catch
    // and returns null on failure — no point in awaiting from a useEffect
    // we won't react to anyway.
    void registerServiceWorker();
  }, []);

  return null;
}
