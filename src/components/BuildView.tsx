/* eslint-disable @next/next/no-img-element -- step pictures are data URLs rendered in the browser */
"use client";

import { AnimatePresence, motion } from "motion/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { CheckResult } from "@/app/api/check/route";
import type { ExtractedStep } from "@/app/api/extract/route";
import CameraFeed, { type CameraHandle } from "@/components/CameraFeed";
import { getManual, getPageSteps, saveManual, savePageSteps, type Manual } from "@/lib/manuals";
import { openManualPdf, renderPage } from "@/lib/pdf";
import { startListening, type Listener } from "@/lib/listen";
import { primeAudio, speak, stopSpeaking } from "@/lib/speech";

const Hologram = dynamic(() => import("@/components/Hologram"), { ssr: false });

type Phase = { kind: "loading"; label: string } | { kind: "ready" } | { kind: "error"; message: string } | { kind: "done" };
type Check = { state: "checking" } | { state: "result"; result: CheckResult; frame: string } | { state: "error"; message: string };

// Cuts a step's picture out of the rendered page (box is 0–1 of the page), with a little padding.
async function crop(pageImage: string, box: ExtractedStep["box"]): Promise<string> {
  const img = new Image();
  img.src = pageImage;
  await img.decode();
  const pad = 0.02;
  const x = Math.max(0, box.x - pad) * img.width;
  const y = Math.max(0, box.y - pad) * img.height;
  const w = Math.min(1, box.w + 2 * pad) * img.width;
  const h = Math.min(1, box.h + 2 * pad) * img.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(w, img.width - x);
  canvas.height = Math.min(h, img.height - y);
  canvas.getContext("2d")?.drawImage(img, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

// Spoken commands, matched in code so they're instant. Anything else is a question for Claude.
type Command = "next" | "back" | "repeat" | "check" | "stop" | "question";
function command(heard: string): Command {
  const t = heard.toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(ok |okay |alright |and )?(next|next step|next one|continue|go on|go ahead|move on|skip)( please)?$/.test(t)) return "next";
  if (/^(go )?(back|previous|previous step|last step|go back one|back one)( please)?$/.test(t)) return "back";
  if (/^(repeat|repeat that|say that again|again|what was that|come again|one more time|what do i do)( please)?$/.test(t)) return "repeat";
  if (/^(check|check it|check this|check my build|check the build|is this right|did i do it right|does this look right|how does this look|i'm done|im done|done|finished|all done)( please)?$/.test(t)) return "check";
  if (/^(stop|quiet|be quiet|shut up|stop talking|pause)$/.test(t)) return "stop";
  return "question";
}

// "go to step 8", "I'm on step 8" -> 8; "I finished step 7", "completed steps 1 through 7" -> 8.
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
function wordsToDigits(t: string): string {
  return t
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, a, b) => String(NUMBER_WORDS[a] + NUMBER_WORDS[b]))
    .replace(/\b[a-z]+\b/g, (w) => (w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w));
}
export function stepTarget(heard: string): number | null {
  const t = wordsToDigits(heard.toLowerCase().replace(/[^a-z0-9' -]/g, " ").replace(/\s+/g, " ").trim());
  const done = t.match(/\b(?:finished|completed|done with|did|done|through|up to|thru)\b.*?\bsteps?\b(?:.*?\b(?:to|through|thru|and)\b)?\s*(\d{1,3})\b|\bsteps? \d{1,3} (?:to|through|thru|-) (\d{1,3})\b.*\b(?:done|finished|completed)\b/);
  if (done) return Number(done[1] ?? done[2]) + 1;
  const go = t.match(/\b(?:go to|goto|skip to|jump to|take me to|i'm on|im on|i am on|on|show me|open)?\s*step (?:number )?(\d{1,3})\b/);
  if (go && (/^(?:go to |goto |skip to |jump to |take me to |show me |open )?step (?:number )?\d{1,3}$/.test(t) || /\b(?:go to|goto|skip to|jump to|take me to|i'm on|im on|i am on)\b/.test(t))) return Number(go[1]);
  return null;
}

// How many pages ahead to read in the background, and how many Claude calls may run at once.
const LOOKAHEAD = 6;
const MAX_PARALLEL = 6;

// Runs at most `n` tasks at a time; extra ones wait in line.
function limiter(n: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  return async <T,>(task: () => Promise<T>): Promise<T> => {
    if (running >= n) await new Promise<void>((r) => queue.push(r));
    running++;
    try {
      return await task();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
}

type PageJob = { image: Promise<string>; steps: Promise<ExtractedStep[]> };

// Renders and reads pages, each at most once: shared by the current page and the read-ahead.
// shareKey (catalog manuals only) lets the server reuse a page another device already read.
function pageReader(manualId: string, doc: PDFDocumentProxy, shareKey?: string) {
  const jobs = new Map<number, PageJob>();
  const read = new Map<number, ExtractedStep[]>();
  const limit = limiter(MAX_PARALLEL);
  const readPage = (page: number): PageJob => {
    const existing = jobs.get(page);
    if (existing) return existing;
    const image = renderPage(doc, page, 1200);
    const steps = (async () => {
      const cached = await getPageSteps<ExtractedStep>(manualId, page);
      if (cached) return cached;
      const pageImage = await image;
      const data = await limit(async () => {
        const res = await fetch("/api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: pageImage, key: shareKey && `${shareKey}#${page}` }) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Couldn't read that page.");
        return body;
      });
      await savePageSteps(manualId, page, data.steps);
      return data.steps as ExtractedStep[];
    })();
    const job = { image, steps };
    steps.then((found) => read.set(page, found)).catch(() => {});
    // A failed page can be retried.
    Promise.all([image, steps]).catch(() => jobs.delete(page));
    jobs.set(page, job);
    return job;
  };
  // Every step read so far, in page order (for questions about other steps).
  const known = () => [...read.entries()].sort(([a], [b]) => a - b).flatMap(([, found]) => found);
  return Object.assign(readPage, { known });
}

export default function BuildView() {
  const { id } = useParams<{ id: string }>();
  const camera = useRef<CameraHandle>(null);
  const direction = useRef<1 | -1>(1);
  const targetStep = useRef<number | null>(null); // set by "go to step N" while pages are searched

  const [manual, setManual] = useState<Manual | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(0);
  const [pageImage, setPageImage] = useState<string | null>(null);
  const [steps, setSteps] = useState<ExtractedStep[]>([]);
  const [stepIdx, setStepIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "loading", label: "Opening manual" });
  const [target, setTarget] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [muted, setMuted] = useState(false);
  const [showManual, setShowManual] = useState(true);
  const [attempt, setAttempt] = useState(0); // bumped by Retry to re-read the page
  const [preview, setPreview] = useState<string | null>(null); // page image shown while Claude reads it
  const [listener, setListener] = useState<Listener | null>(null);
  const [heard, setHeard] = useState<string | null>(null); // what the mic is hearing right now
  const [reply, setReply] = useState<string | null>(null); // the last spoken answer, as text
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const history = useRef<{ q: string; a: string }[]>([]);

  // Every page change shows the loading card first.
  const turnTo = useCallback((p: number) => {
    setPhase({ kind: "loading", label: `Reading page ${p}` });
    setCheck(null);
    setPage(p);
  }, []);

  const step = steps[stepIdx] as ExtractedStep | undefined;
  const part = step?.parts[0];

  // 1. load the manual and its PDF
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await getManual(id);
      if (!m) return setPhase({ kind: "error", message: "That manual isn't in your library on this device." });
      setManual(m);
      try {
        const d = await openManualPdf(m);
        if (cancelled) return;
        const updated = { ...m, pageCount: d.numPages, openedAt: Date.now() };
        await saveManual(updated);
        setManual(updated);
        setDoc(d);
        turnTo(Math.min(m.page, d.numPages));
      } catch (e) {
        setPhase({ kind: "error", message: e instanceof Error ? e.message : "Couldn't open the PDF." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, turnTo]);

  const reader = useMemo(() => (doc && manual ? pageReader(manual.id, doc, manual.source === "upload" ? undefined : manual.pdfPath) : null), [doc, manual?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 2. read the current page (and the next few in the background); skip pages with no steps
  useEffect(() => {
    if (!reader || !doc || !manual || page < 1) return;
    let cancelled = false;
    for (let k = 1; k <= LOOKAHEAD && page + k <= doc.numPages; k++) reader(page + k);
    const job = reader(page);
    job.image.then((img) => !cancelled && setPreview(img)).catch(() => {});
    Promise.all([job.image, job.steps])
      .then(([image, found]) => {
        if (cancelled) return;
        if (found.length === 0) {
          const next = page + direction.current;
          if (next >= 1 && next <= doc.numPages) return turnTo(next);
          if (next > doc.numPages) return setPhase({ kind: "done" });
          direction.current = 1;
          return turnTo(page + 1);
        }
        setPageImage(image);
        setSteps(found);
        const wanted = targetStep.current === null ? -1 : found.findIndex((s) => s.number === targetStep.current);
        targetStep.current = null;
        setStepIdx(wanted >= 0 ? wanted : direction.current === 1 ? 0 : found.length - 1);
        setPhase({ kind: "ready" });
        saveManual({ ...manual, page, openedAt: Date.now() });
      })
      .catch((e) => !cancelled && setPhase({ kind: "error", message: e instanceof Error ? e.message : "Couldn't read that page." }));
    return () => {
      cancelled = true;
    };
    // manual is saved as a side effect; re-running on its change would loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, page, attempt]);

  // 3. cut out this step's target picture (and the one before it) for display and checking
  useEffect(() => {
    if (!pageImage || !step) return;
    let cancelled = false;
    crop(pageImage, step.box).then((t) => !cancelled && setTarget(t));
    const prev = steps[stepIdx - 1];
    (prev ? crop(pageImage, prev.box) : Promise.resolve(null)).then((p) => !cancelled && setPrevious(p));
    return () => {
      cancelled = true;
    };
  }, [pageImage, step, steps, stepIdx]);

  // 4. read each new step aloud
  useEffect(() => {
    if (phase.kind === "ready" && step && !muted) speak(`Step ${step.number}. ${step.instruction}`);
  }, [phase.kind, step, muted]);
  useEffect(() => stopSpeaking, []);

  // Says a reply out loud (unless muted) and shows it as a caption.
  const say = useCallback(
    (text: string) => {
      setReply(text);
      if (!muted) speak(text);
    },
    [muted],
  );

  const go = useCallback(
    (delta: 1 | -1) => {
      if (phase.kind !== "ready" || !doc) return;
      setCheck(null);
      direction.current = delta;
      const nextIdx = stepIdx + delta;
      if (nextIdx >= 0 && nextIdx < steps.length) return setStepIdx(nextIdx);
      const nextPage = page + delta;
      if (nextPage < 1) return;
      if (nextPage > doc.numPages) return setPhase({ kind: "done" });
      turnTo(nextPage);
    },
    [phase.kind, doc, stepIdx, steps.length, page, turnTo],
  );

  const runCheck = useCallback(async () => {
    if (!step || !target || check?.state === "checking") return;
    const frame = camera.current?.capture();
    if (!frame) return setCheck({ state: "error", message: "Camera isn't ready yet." });
    setCheck({ state: "checking" });
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame, expected: target, previous: previous ?? undefined, instruction: step.instruction, watchFor: step.watchFor }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const result = data as CheckResult;
      setCheck({ state: "result", result, frame });
      if (result.say) say(result.say);
      if (result.step_complete && result.confidence >= 0.7) setTimeout(() => go(1), 1800);
    } catch (e) {
      setCheck({ state: "error", message: e instanceof Error && e.message ? e.message : "Check failed." });
    }
  }, [step, target, previous, check?.state, say, go]);

  // A question that isn't a command: Claude answers from this step's manual picture and the camera.
  const ask = useCallback(
    async (question: string) => {
      if (!step) return say("Open a manual first.");
      setReply("Thinking…");
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question,
            frame: camera.current?.capture() ?? undefined,
            expected: target ?? undefined,
            step: { number: step.number, instruction: step.instruction, parts: step.parts.map((p) => ({ name: p.name, qty: p.qty })), watchFor: step.watchFor },
            known: (reader?.known() ?? []).slice(0, 120).map((s) => ({ number: s.number, instruction: s.instruction, parts: s.parts.map((p) => `${p.qty > 1 ? `${p.qty}x ` : ""}${p.name}`).join(", ") })),
            history: history.current,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        history.current = [...history.current, { q: question, a: data.text }].slice(-4);
        say(data.text);
      } catch (e) {
        say(e instanceof Error && e.message ? e.message : "I couldn't answer that.");
      }
    },
    [step, target, say, reader],
  );

  // Jumps to step n: on this page if it's here, otherwise reads pages ahead (or back) until it finds it.
  const goToStep = useCallback(
    async (n: number) => {
      if (!reader || !doc || phase.kind === "loading") return;
      const here = steps.findIndex((s) => s.number === n);
      if (here >= 0) {
        setCheck(null);
        return setStepIdx(here);
      }
      const dir: 1 | -1 = !step || n > step.number ? 1 : -1;
      setCheck(null);
      setPhase({ kind: "loading", label: `Finding step ${n}` });
      try {
        for (let p = page + dir; p >= 1 && p <= doc.numPages; p += dir) {
          for (let k = 1; k <= LOOKAHEAD; k++) if (p + k * dir >= 1 && p + k * dir <= doc.numPages) reader(p + k * dir);
          const found = await reader(p).steps;
          if (found.some((s) => s.number === n)) {
            targetStep.current = n;
            direction.current = 1;
            return turnTo(p);
          }
          // Passed it (numbers jumped over n): this book doesn't have that step.
          if (found.length && (dir === 1 ? found[0].number > n : found[found.length - 1].number < n)) break;
        }
      } catch (e) {
        return setPhase({ kind: "error", message: e instanceof Error ? e.message : "Couldn't read that page." });
      }
      setPhase({ kind: "ready" });
      say(`I couldn't find step ${n} in this book.`);
    },
    [reader, doc, phase.kind, steps, step, page, turnTo, say],
  );

  // Latest handlers for the mic callback, which is set up once per listening session.
  const onHeard = useRef<(text: string) => void>(() => {});
  useEffect(() => {
    onHeard.current = (text: string) => {
      setHeard(text);
      const n = stepTarget(text);
      if (n !== null) return goToStep(n);
      switch (command(text)) {
        case "next":
          return go(1);
        case "back":
          return go(-1);
        case "repeat":
          return step && say(`Step ${step.number}. ${step.instruction}`);
        case "check":
          return runCheck();
        case "stop":
          return stopSpeaking();
        default:
          return ask(text);
      }
    };
  }, [go, step, say, runCheck, ask, goToStep]);

  const toggleMic = useCallback(async () => {
    primeAudio();
    setVoiceError(null);
    if (listener) {
      listener.stop();
      setListener(null);
      setHeard(null);
      return;
    }
    try {
      const l = await startListening({
        onPartial: (t) => setHeard(t),
        onFinal: (t) => onHeard.current(t),
        onError: (m) => setVoiceError(m),
      });
      setListener(l);
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "Couldn't start the mic.");
    }
  }, [listener]);
  useEffect(() => () => listener?.stop(), [listener]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        runCheck();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, runCheck]);

  const verdict = useMemo(() => {
    if (check?.state !== "result") return null;
    const { result } = check;
    if (result.confidence < 0.5) return "unsure" as const;
    if (result.issues.length > 0) return "fix" as const;
    return result.step_complete ? ("pass" as const) : ("notyet" as const);
  }, [check]);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-ink text-white">
      <CameraFeed ref={camera} />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-ink/70 via-transparent to-ink/80" />

      {/* top bar */}
      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6">
        <Link href="/" className="hud-panel flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-white/85 transition hover:text-white">
          ← Hub
        </Link>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-[15px] font-semibold tracking-tight">{manual?.title ?? "BuildSight"}</p>
          <p className="truncate text-[11px] text-white/50">
            {manual?.subtitle}
            {doc && page > 0 ? ` · Page ${page}/${doc.numPages}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={toggleMic}
            className={`hud-panel rounded-xl px-3 py-2 text-xs font-medium ${listener ? "text-sky-200 ring-1 ring-sky-300/60" : "text-white/85"}`}
            aria-pressed={Boolean(listener)}
            title={listener ? `Listening (${listener.mode === "cartesia" ? "Cartesia Ink" : "browser"})` : "Talk to BuildSight"}
          >
            {listener ? (
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 animate-pulse rounded-full bg-sky-300" />
                {listener.mode === "cartesia" ? "Listening" : "Listening (browser)"}
              </span>
            ) : (
              "Mic"
            )}
          </button>
          <button
            onClick={() => {
              primeAudio();
              setMuted((m) => !m);
              stopSpeaking();
            }}
            className="hud-panel rounded-xl px-3 py-2 text-xs font-medium text-white/85"
            aria-pressed={muted}
          >
            {muted ? "Voice off" : "Voice on"}
          </button>
        </div>
      </header>

      {/* reticle: shows while a check is running */}
      <AnimatePresence>
        {check?.state === "checking" && (
          <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute left-1/2 top-[42%] z-10 -translate-x-1/2 -translate-y-1/2">
            <svg viewBox="0 0 200 200" className="h-56 w-56">
              <g className="spin-fast" style={{ transformBox: "fill-box" }}>
                <circle cx="100" cy="100" r="90" fill="none" stroke="rgba(79,195,255,0.8)" strokeWidth="2" strokeDasharray="30 20" />
              </g>
              <g className="spin-rev" style={{ transformBox: "fill-box" }}>
                <circle cx="100" cy="100" r="70" fill="none" stroke="rgba(79,195,255,0.5)" strokeWidth="1.5" strokeDasharray="4 8" />
              </g>
              <path d="M100 20v20M100 160v20M20 100h20M160 100h20" stroke="rgba(79,195,255,0.9)" strokeWidth="2" />
            </svg>
            <p className="mt-2 text-center text-xs font-medium text-sky-200 holo-text">Checking your build…</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* target state: the manual's picture of this step */}
      <AnimatePresence>
        {target && phase.kind === "ready" && (
          <motion.aside
            key={target.slice(-40)}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="absolute right-3 top-20 z-10 w-36 sm:right-6 sm:top-24 sm:w-72"
          >
            <button onClick={() => setShowManual((s) => !s)} className="hud-panel holo-glow block w-full overflow-hidden rounded-xl text-left">
              <div className="flex items-center justify-between px-3 pt-2">
                <span className="text-[10px] font-semibold text-white/70 sm:text-[11px]">Step {step?.number} · manual</span>
                <span className="text-[10px] text-white/40">{showManual ? "Tap for color" : "Tap for glow"}</span>
              </div>
              <div className="relative m-2 overflow-hidden rounded-lg bg-ink/60">
                <img src={target} alt={`Manual picture for step ${step?.number}`} className={`w-full ${showManual ? "holo-image" : ""}`} />
              </div>
            </button>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* bottom: hologram + step card */}
      <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-3 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:bottom-6 sm:left-6 sm:right-auto sm:w-[440px] sm:p-0">
        {(heard || reply || voiceError) && (
          <div className="hud-panel rounded-2xl px-4 py-3 text-sm" aria-live="polite">
            {heard && <p className="text-white/55">You: {heard}</p>}
            {reply && <p className="mt-0.5 text-sky-100">BuildSight: {reply}</p>}
            {voiceError && <p className="mt-0.5 text-rose-300">{voiceError}</p>}
          </div>
        )}

        {phase.kind === "ready" && part && (
          <div className="relative mx-auto h-36 w-36 sm:mx-0 sm:h-48 sm:w-48">
            <Hologram part={part} />
            <span className="absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium text-sky-200/80">Next part</span>
          </div>
        )}

        <AnimatePresence mode="wait">
          <motion.section
            key={phase.kind === "ready" ? `step-${page}-${stepIdx}` : phase.kind}
            initial={{ opacity: 0, y: 24, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, filter: "blur(6px)" }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            className="hud-panel holo-glow rounded-3xl p-5"
          >
            {phase.kind === "loading" && (
              <div>
                <p className="text-xs font-semibold text-sky-300">{phase.label}</p>
                <div className="scan-bar mt-3 h-1 rounded-full" />
                {preview ? (
                  <div className="relative mt-3 overflow-hidden rounded-xl bg-ink/60">
                    <img src={preview} alt="Manual page being read" className="holo-image max-h-56 w-full object-contain" />
                    <span className="hud-sweep pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-transparent via-sky-300/25 to-transparent" />
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-white/50">Opening the manual…</p>
                )}
              </div>
            )}

            {phase.kind === "error" && (
              <div>
                <p className="text-xs font-semibold text-rose-300">System error</p>
                <p className="mt-2 text-sm text-white/80">{phase.message}</p>
                <div className="mt-4 flex gap-2">
                  <Link href="/" className="rounded-xl border border-white/15 px-4 py-2.5 text-sm">Back to hub</Link>
                  {doc && (
                    <button
                      onClick={() => {
                        setPhase({ kind: "loading", label: `Reading page ${page}` });
                        setAttempt((a) => a + 1);
                      }}
                      className="rounded-xl bg-holo px-4 py-2.5 text-sm font-semibold text-ink"
                    >
                      Retry
                    </button>
                  )}
                </div>
              </div>
            )}

            {phase.kind === "done" && (
              <div>
                <p className="text-xs font-semibold text-emerald-300">Build complete</p>
                <p className="mt-2 text-2xl font-semibold tracking-tight">That&apos;s the last step in this manual.</p>
                <Link href="/" className="mt-4 inline-block rounded-xl bg-holo px-4 py-2.5 text-sm font-semibold text-ink">Back to hub</Link>
              </div>
            )}

            {phase.kind === "ready" && step && (
              <>
                <div className="flex items-baseline justify-between">
                  <p className="text-xs font-semibold text-sky-300">Step {step.number}</p>
                  <p className="text-[11px] text-white/40">
                    {stepIdx + 1}/{steps.length} on page {page}
                  </p>
                </div>
                <h1 className="mt-1 text-xl font-semibold leading-snug sm:text-2xl">{step.instruction}</h1>

                {step.parts.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {step.parts.map((p, i) => (
                      <li key={`${p.name}-${i}`} className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-sm">
                        <span className="h-3 w-3 rounded-sm ring-1 ring-white/20" style={{ background: p.color }} />
                        {p.name}
                        <span className="text-white/50">×{p.qty}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {step.watchFor[0] && (
                  <p className="mt-3 flex gap-2 text-xs text-amber-200/90">
                    <span className="font-mono">⚠</span>
                    {step.watchFor[0]}
                  </p>
                )}

                <AnimatePresence>
                  {check && check.state !== "checking" && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className={`mt-4 overflow-hidden rounded-xl border p-3 text-sm ${
                        check.state === "error" || verdict === "unsure" || verdict === "notyet"
                          ? "border-white/15 bg-white/5 text-white/80"
                          : verdict === "pass"
                            ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
                            : "border-amber-400/40 bg-amber-400/10 text-amber-100"
                      }`}
                    >
                      {check.state === "error" ? (
                        check.message
                      ) : (
                        <>
                          <p className="text-[11px] font-semibold">
                            {{ pass: "Verified", fix: "Hold on", notyet: "Not done yet", unsure: "Need a better look" }[verdict ?? "unsure"]} ·{" "}
                            {Math.round(check.result.confidence * 100)}%
                          </p>
                          <p className="mt-1">{check.result.say}</p>
                          {verdict === "fix" && check.result.issues.length > 0 && (
                            <div className="mt-3 grid grid-cols-2 gap-2">
                              <figure>
                                <img src={target ?? ""} alt="Manual" className="rounded-md bg-white" />
                                <figcaption className="mt-1 text-[10px] text-white/50">Manual</figcaption>
                              </figure>
                              <figure>
                                <img src={check.frame} alt="Your build" className="rounded-md" />
                                <figcaption className="mt-1 text-[10px] text-white/50">Your build</figcaption>
                              </figure>
                            </div>
                          )}
                        </>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="mt-5 grid grid-cols-[1fr_1.4fr_1fr] gap-2">
                  <button onClick={() => (primeAudio(), go(-1))} className="rounded-xl border border-white/15 bg-white/[0.06] py-3 text-sm font-medium text-white/80 transition hover:bg-white/10 active:scale-95">
                    Back
                  </button>
                  <button
                    onClick={() => (primeAudio(), runCheck())}
                    disabled={check?.state === "checking"}
                    className="rounded-xl bg-gradient-to-b from-sky-300 to-sky-500 py-3 text-sm font-semibold text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_6px_20px_-6px_rgba(92,200,255,0.7)] transition hover:brightness-110 active:scale-95 disabled:opacity-60"
                  >
                    {check?.state === "checking" ? "Checking…" : "Check build"}
                  </button>
                  <button onClick={() => (primeAudio(), go(1))} className="rounded-xl border border-white/15 bg-white/[0.06] py-3 text-sm font-medium text-white transition hover:bg-white/10 active:scale-95">
                    Next
                  </button>
                </div>
              </>
            )}
          </motion.section>
        </AnimatePresence>
      </div>
    </main>
  );
}
