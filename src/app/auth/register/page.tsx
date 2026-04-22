"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { isPhoneRegistered, findChildByPhone, setCurrentChildId } from "@/lib/userStore";
import { isPhoneRegistered as isPhoneRegisteredInSupabase } from "@/lib/supabase/parents";

export default function RegisterPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    setError(null);
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) return;
    setLoading(true);

    // 1) Fast path: recognised on this device (localStorage demo/migrated data)
    //    — log them back in without hitting the network.
    if (isPhoneRegistered(phone)) {
      const child = findChildByPhone(phone);
      if (child) setCurrentChildId(child.id);
      router.push("/");
      setLoading(false);
      return;
    }

    // 2) Cross-device guard: if the phone is registered to some OTHER
    //    anon auth.uid() in Supabase, block. Path A anonymous auth
    //    can't re-authenticate them onto this device — surfacing the
    //    conflict beats failing with a UNIQUE violation at the end of
    //    child-setup.
    try {
      const takenElsewhere = await isPhoneRegisteredInSupabase(digits);
      if (takenElsewhere) {
        setError(
          "This number is already registered on another device. " +
            "Cross-device sign-in isn't live yet — please contact support."
        );
        setLoading(false);
        return;
      }
    } catch (e) {
      // Lookup failure: fall through and let child-setup's INSERT catch
      // a real collision. We still proceed so users aren't blocked by
      // a flaky network read.
      console.warn("[register] phone lookup failed, continuing:", e);
    }

    // 3) New user — stash phone for child-setup, continue.
    localStorage.setItem("bb_parent_phone", phone);
    router.push("/auth/child-setup");
    setLoading(false);
  }

  return (
    <main className="flex-grow flex flex-col items-center justify-center px-6 max-w-lg mx-auto w-full py-12">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-full bg-secondary-container flex items-center justify-center">
          <span className="material-symbols-outlined text-on-secondary-container">
            auto_stories
          </span>
        </div>
        <span className="text-primary font-headline font-extrabold text-2xl tracking-tight">
          BookBuddy
        </span>
      </div>

      {/* Bookworm mascot */}
      <div className="w-36 h-36 rounded-2xl overflow-hidden shadow-md mb-8 shrink-0">
        <img
          src="/bookworm.png"
          alt="BookBuddy worm reading"
          className="w-[200%] h-[200%] object-cover"
          style={{ objectPosition: "0% 0%" }}
        />
      </div>

      <div className="w-full space-y-8">
        <div className="space-y-3">
          <h1 className="text-on-surface font-headline font-bold text-3xl leading-tight tracking-tight">
            Let&apos;s set up your child&apos;s account
          </h1>
          <p className="text-on-surface-variant text-lg">
            Parents, we just need your WhatsApp number.
          </p>
        </div>

        <div className="space-y-6">
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
            />
          </div>
          <Button fullWidth onClick={handleContinue} disabled={loading}>
            {loading ? "Continuing..." : "Continue"}
            <span className="material-symbols-outlined">arrow_forward</span>
          </Button>
          {error && (
            <p className="text-sm text-error font-medium bg-error-container/40 rounded-lg px-4 py-3 leading-snug">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-4 bg-surface-container-low p-5 rounded-lg">
          <span className="material-symbols-outlined text-tertiary">
            verified_user
          </span>
          <p className="text-on-surface-variant text-sm leading-snug">
            We use your number only to reach out about your child&apos;s book
            swaps. No spam, ever.
          </p>
        </div>
      </div>
    </main>
  );
}
