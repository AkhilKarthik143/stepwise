"use client";

import { motion } from "motion/react";
import ProductImage from "@/components/hud/ProductImage";
import { metaLine, type CatalogItem } from "@/lib/catalog";

export default function CatalogCard({ item, index, busy, onOpen }: { item: CatalogItem; index: number; busy: boolean; onOpen: () => void }) {
  return (
    <motion.button
      layout
      onClick={onOpen}
      disabled={busy}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      whileHover={{ y: -4 }}
      transition={{ delay: Math.min(index, 12) * 0.025, type: "spring", stiffness: 260, damping: 26 }}
      className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] text-left shadow-[0_10px_30px_-12px_rgba(0,0,0,0.7)] transition-colors hover:border-sky-300/30 hover:shadow-[0_20px_50px_-20px_rgba(92,200,255,0.45)] disabled:opacity-70"
    >
      <div className="relative aspect-square w-full overflow-hidden bg-white/[0.03]">
        <ProductImage src={item.image} priority={index < 8} sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 280px" className="group-hover:scale-[1.05]" />
        <span className="absolute left-2.5 top-2.5 rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
          {item.category}
        </span>
        {item.manuals.length > 1 && (
          <span className="absolute right-2.5 top-2.5 rounded-md bg-white/90 px-2 py-0.5 text-[10px] font-semibold text-slate-800 ring-1 ring-black/5">
            {item.manuals.length} books
          </span>
        )}
        {busy && <span className="scan-bar absolute inset-x-0 bottom-0 h-1" />}
      </div>
      <div className="flex flex-1 flex-col p-3.5">
        <h3 className="line-clamp-2 text-[14px] font-semibold leading-snug tracking-tight">{item.name}</h3>
        <p className="mt-1 text-[11px] text-white/45">{metaLine(item)}</p>
        <span className="mt-auto pt-3 text-xs font-semibold text-sky-300 opacity-80 transition group-hover:opacity-100">
          {busy ? "Opening…" : "Build →"}
        </span>
      </div>
    </motion.button>
  );
}
