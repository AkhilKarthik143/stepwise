"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BookPicker from "@/components/hud/BookPicker";
import CatalogCard from "@/components/hud/CatalogCard";
import HudBackdrop from "@/components/hud/HudBackdrop";
import ManualCard from "@/components/hud/ManualCard";
import StatusBar from "@/components/hud/StatusBar";
import { categoriesOf, IKEA, LEGO, matches, toResult, type CatalogItem, type CatalogManual } from "@/lib/catalog";
import { addFromResult, addUpload, listManuals, removeManual, type Manual, type ManualResult } from "@/lib/manuals";

type Tab = "lego" | "ikea" | "mine";
const isSetNumber = (q: string) => /^\d{4,7}(-\d)?$/.test(q.trim());

export default function Hub() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("lego");
  const [category, setCategory] = useState<string>("All");
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState<Manual[] | null>(null);
  const [picking, setPicking] = useState<CatalogItem | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live search for things not in the catalog (any LEGO set number, any IKEA product)
  const [live, setLive] = useState<{ q: string; results: ManualResult[] } | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    listManuals().then(setLibrary).catch(() => setLibrary([]));
  }, []);

  // Tracks whether the tab bar has scrolled up and pinned.
  const tabsSentinel = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const el = tabsSentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setPinned(!entry.isIntersecting && entry.boundingClientRect.top < 0));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const items = useMemo(() => (tab === "lego" ? LEGO : tab === "ikea" ? IKEA : []), [tab]);
  const categories = useMemo(() => ["All", ...categoriesOf(items)], [items]);
  const shown = useMemo(
    () => items.filter((i) => (category === "All" || i.category === category) && (!query.trim() || matches(i, query))),
    [items, category, query],
  );
  const inProgress = library?.find((m) => m.page > 1);

  function switchTab(t: Tab) {
    setTab(t);
    setCategory("All");
    setLive(null);
  }

  async function openResult(r: ManualResult) {
    setOpening(r.pdfPath);
    const m = await addFromResult(r);
    // Start downloading the PDF now; the build screen picks up the same in-flight load.
    import("@/lib/pdf").then(({ openManualPdf }) => openManualPdf(m).catch(() => {}));
    router.push(`/build/${m.id}`);
  }

  function openItem(item: CatalogItem) {
    if (item.manuals.length > 1) return setPicking(item);
    openManual(item, item.manuals[0]);
  }

  function openManual(item: CatalogItem, manual: CatalogManual) {
    setPicking(null);
    setOpening(item.id);
    openResult(toResult(item, manual));
  }

  const liveSearch = useCallback(async (q: string) => {
    const text = q.trim();
    if (text.length < 2) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(text)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setLive({ q: text, results: data.results });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }, []);

  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("That isn't a PDF. Drop a PDF manual.");
      return;
    }
    setOpening("upload");
    const m = await addUpload(file);
    router.push(`/build/${m.id}`);
  }

  async function remove(id: string) {
    await removeManual(id);
    setLibrary((l) => l?.filter((m) => m.id !== id) ?? null);
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "lego", label: "LEGO", count: LEGO.length },
    { id: "ikea", label: "IKEA", count: IKEA.length },
    { id: "mine", label: "My projects", count: library?.length },
  ];

  return (
    <div
      className="relative min-h-dvh w-full overflow-x-clip"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        upload(e.dataTransfer.files?.[0]);
      }}
    >
      <HudBackdrop />
      <StatusBar />

      <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-col px-5 pb-24 sm:px-8">
        {/* hero + search */}
        <section className="flex flex-col items-center pt-12 text-center sm:pt-20">
          <motion.h1
            initial={{ opacity: 0, y: 12, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.6 }}
            className="text-sheen text-[2.4rem] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-6xl"
          >
            What are we building?
          </motion.h1>

          <motion.form
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (tab === "mine") return;
              // Catalog filters as you type; Enter also searches LEGO/IKEA live for anything not listed.
              liveSearch(query);
            }}
            className="hud-panel holo-glow mt-8 flex w-full max-w-2xl items-center gap-3 rounded-2xl p-2 pl-5 transition focus-within:border-sky-300/40"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-white/40" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLive(null);
              }}
              placeholder={tab === "ikea" ? "Search IKEA furniture" : tab === "lego" ? "Search sets, themes or a set number" : "Search your projects"}
              aria-label="Search manuals"
              className="min-w-0 flex-1 bg-transparent py-3 text-base text-white placeholder:text-white/35 focus:outline-none"
            />
            {tab !== "mine" && (
              <button
                type="submit"
                disabled={searching}
                className="shrink-0 rounded-xl bg-gradient-to-b from-sky-300 to-sky-500 px-5 py-3 text-sm font-semibold text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_6px_20px_-6px_rgba(92,200,255,0.7)] transition hover:brightness-110 active:scale-95 disabled:opacity-60"
              >
                {searching ? "Searching…" : "Search"}
              </button>
            )}
          </motion.form>

          {inProgress && (
            <button
              onClick={() => router.push(`/build/${inProgress.id}`)}
              className="mt-4 flex items-center gap-2 rounded-full border border-sky-300/25 bg-sky-300/10 px-4 py-1.5 text-xs text-sky-100 transition hover:bg-sky-300/20"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-sky-300" />
              Continue {inProgress.title} · page {inProgress.page}
              <span aria-hidden>→</span>
            </button>
          )}
        </section>

        {/* tabs: a frosted bar only once pinned to the top */}
        <div ref={tabsSentinel} aria-hidden className="mt-10 h-px" />
        <nav
          className={`sticky top-0 z-20 -mx-5 px-5 pb-3 pt-3 transition-colors duration-300 sm:-mx-8 sm:px-8 ${
            pinned ? "border-b border-white/[0.06] bg-ink/85 backdrop-blur-xl" : "bg-transparent"
          }`}
        >
          <div className="flex items-center gap-1 border-b border-white/[0.07]">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => switchTab(t.id)}
                className={`relative -mb-px flex items-center gap-2 px-3 py-2.5 text-sm font-medium transition ${tab === t.id ? "text-white" : "text-white/45 hover:text-white/80"}`}
              >
                {t.label}
                {t.count != null && t.count > 0 && <span className="rounded-full bg-white/[0.07] px-1.5 text-[11px] text-white/50">{t.count}</span>}
                {tab === t.id && <motion.span layoutId="tab-underline" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-sky-300" />}
              </button>
            ))}
          </div>

          {tab !== "mine" && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition ${
                    category === c ? "border-sky-300/50 bg-sky-300/15 text-white" : "border-white/10 bg-white/[0.03] text-white/60 hover:text-white"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </nav>

        {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}

        {/* live search results (anything not in the catalog) */}
        <AnimatePresence>
          {(searching || live) && tab !== "mine" && (
            <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4">
              <h2 className="text-sm font-semibold text-white/90">
                {searching ? "Searching LEGO and IKEA…" : `From ${isSetNumber(live!.q) ? "LEGO" : "IKEA"} for “${live!.q}”`}
              </h2>
              {searching && <div className="scan-bar mt-3 h-0.5 w-full rounded-full" />}
              {live && live.results.length === 0 && (
                <p className="mt-2 text-sm text-white/50">Nothing found. LEGO needs a set number (e.g. 31163); for IKEA try the product name.</p>
              )}
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {live?.results.map((r, i) => (
                  <ManualCard
                    key={r.pdfPath}
                    index={i}
                    source={r.source}
                    title={r.title}
                    subtitle={r.subtitle}
                    coverUrl={r.coverUrl}
                    meta={r.sizeLabel}
                    action="Build"
                    busy={opening === r.pdfPath}
                    onAction={() => openResult(r)}
                  />
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* catalog */}
        {tab !== "mine" && (
          <section className="mt-4">
            {shown.length === 0 && !live && (
              <p className="mt-6 text-sm text-white/50">
                Nothing in the catalog matches. Press <span className="text-white/80">Search</span> to look it up on {tab === "lego" ? "LEGO" : "IKEA"}.
              </p>
            )}
            <motion.div layout className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
              <AnimatePresence mode="popLayout">
                {shown.map((item, i) => (
                  <CatalogCard key={item.id} item={item} index={i} busy={opening === item.id} onOpen={() => openItem(item)} />
                ))}
              </AnimatePresence>
            </motion.div>
          </section>
        )}

        {/* my projects */}
        {tab === "mine" && (
          <section className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <button
              onClick={() => fileInput.current?.click()}
              className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-6 text-center transition hover:border-sky-300/50 hover:bg-sky-300/5"
            >
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-sky-300/10 text-sky-300 ring-1 ring-sky-300/20">
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16" />
                </svg>
              </span>
              <span className="text-sm font-semibold">Upload a manual</span>
              <span className="text-xs text-white/45">Any PDF build instructions, or drop one anywhere on this page</span>
            </button>
            <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => upload(e.target.files?.[0])} />

            <AnimatePresence>
              {library
                ?.filter((m) => !query.trim() || `${m.title} ${m.subtitle}`.toLowerCase().includes(query.trim().toLowerCase()))
                .map((m, i) => (
                  <ManualCard
                    key={m.id}
                    index={i}
                    source={m.source}
                    title={m.title}
                    subtitle={m.subtitle}
                    coverUrl={m.coverUrl}
                    meta={m.pageCount ? `Page ${m.page} of ${m.pageCount}` : "Not started"}
                    progress={m.pageCount ? m.page / m.pageCount : 0}
                    action={m.page > 1 ? "Resume" : "Start"}
                    onAction={() => router.push(`/build/${m.id}`)}
                    onRemove={() => remove(m.id)}
                  />
                ))}
            </AnimatePresence>
          </section>
        )}
      </main>

      <AnimatePresence>{picking && <BookPicker item={picking} onPick={(m) => openManual(picking, m)} onClose={() => setPicking(null)} />}</AnimatePresence>

      {/* drag-and-drop overlay */}
      <AnimatePresence>
        {(dragging || opening === "upload") && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-ink/80 backdrop-blur-sm"
          >
            <div className="hud-panel holo-glow rounded-3xl border-dashed px-14 py-12 text-center">
              <p className="text-2xl font-semibold tracking-tight">{opening === "upload" ? "Opening manual…" : "Drop to add manual"}</p>
              <p className="mt-2 text-sm text-white/50">Any PDF build instructions</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
