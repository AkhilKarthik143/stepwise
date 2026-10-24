"use client";

import { motion } from "motion/react";
import ProductImage from "@/components/hud/ProductImage";
import type { ManualSource } from "@/lib/manuals";

const SOURCE_LABEL: Record<ManualSource, string> = { lego: "LEGO", ikea: "IKEA", upload: "PDF" };

type Props = {
  source: ManualSource;
  title: string;
  subtitle: string;
  coverUrl?: string;
  meta?: string; // "19.96 MB" or "Page 12 of 100"
  progress?: number; // 0–1, library cards only
  action: string;
  busy?: boolean;
  index?: number;
  onAction: () => void;
  onRemove?: () => void;
};

export default function ManualCard({ source, title, subtitle, coverUrl, meta, progress, action, busy, index = 0, onAction, onRemove }: Props) {
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      whileHover={{ y: -4 }}
      transition={{ delay: index * 0.04, type: "spring", stiffness: 260, damping: 26 }}
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] shadow-[0_10px_30px_-12px_rgba(0,0,0,0.7)] transition-colors hover:border-sky-300/30 hover:shadow-[0_20px_50px_-20px_rgba(92,200,255,0.45)]"
    >
      <button
        onClick={onAction}
        disabled={busy}
        aria-label={`${action} ${title}`}
        className={`relative aspect-[4/3] w-full overflow-hidden ${coverUrl ? "bg-white/[0.03]" : "bg-gradient-to-b from-sky-400/10 to-transparent"}`}
      >
        {coverUrl ? (
          <ProductImage src={coverUrl} sizes="(max-width: 640px) 100vw, 380px" className="group-hover:scale-[1.04]" />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <svg viewBox="0 0 48 48" className="h-14 w-14 text-sky-300/70" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 6h18l8 8v28H12z" />
              <path d="M30 6v8h8M17 24h14M17 30h14M17 36h9" />
            </svg>
          </div>
        )}
        <span className="absolute left-3 top-3 rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white backdrop-blur">
          {SOURCE_LABEL[source]}
        </span>
        {busy && <span className="scan-bar absolute inset-x-0 bottom-0 h-1" />}
      </button>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="text-[15px] font-semibold leading-snug tracking-tight">{title}</h3>
        <p className="mt-0.5 text-xs text-white/50">{subtitle}</p>
        {progress != null && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-cyan-300" style={{ width: `${Math.max(3, progress * 100)}%` }} />
          </div>
        )}
        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <span className="font-mono text-[11px] text-white/40">{meta}</span>
          <div className="flex items-center gap-1">
            {onRemove && (
              <button onClick={onRemove} aria-label={`Remove ${title}`} className="rounded-lg px-2.5 py-1.5 text-xs text-white/40 transition hover:bg-white/5 hover:text-rose-300">
                Remove
              </button>
            )}
            <button
              onClick={onAction}
              disabled={busy}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400 hover:text-ink active:scale-95 disabled:opacity-50"
            >
              {busy ? "Opening…" : `${action} →`}
            </button>
          </div>
        </div>
      </div>
    </motion.article>
  );
}
