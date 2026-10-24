"use client";

import { motion } from "motion/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import HudBackdrop from "@/components/hud/HudBackdrop";
import { LogoMark } from "@/components/hud/StatusBar";

export default function UnlockForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: code }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't unlock.");
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-dvh place-items-center px-5">
      <HudBackdrop />
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.5 }}
        className="hud-panel holo-glow relative z-10 w-full max-w-sm rounded-3xl p-7"
      >
        <div className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-[15px] font-semibold tracking-tight">BuildSight</span>
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">Enter passcode</h1>
        <p className="mt-1 text-sm text-white/50">This device will stay unlocked for 30 days.</p>

        <input
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          autoComplete="current-password"
          aria-label="Passcode"
          placeholder="Passcode"
          className="mt-6 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-base text-white placeholder:text-white/30 transition focus:border-sky-300/50 focus:outline-none focus:ring-4 focus:ring-sky-300/10"
        />
        {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}

        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="mt-4 w-full rounded-xl bg-gradient-to-b from-sky-300 to-sky-500 py-3 text-sm font-semibold text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_6px_20px_-6px_rgba(92,200,255,0.7)] transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </motion.form>
    </div>
  );
}
