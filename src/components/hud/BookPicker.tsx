"use client";

import { motion } from "motion/react";
import { useEffect } from "react";
import ProductImage from "@/components/hud/ProductImage";
import type { CatalogItem, CatalogManual } from "@/lib/catalog";

// Sheet for items with several instruction books: pick which one to build.
export default function BookPicker({ item, onPick, onClose }: { item: CatalogItem; onPick: (m: CatalogManual) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-end bg-ink/70 backdrop-blur-sm sm:place-items-center"
    >
      <motion.div
        role="dialog"
        aria-label={`Choose a manual for ${item.name}`}
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="hud-panel w-full max-w-lg rounded-t-3xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-sky-300">{item.source === "lego" ? `LEGO ${item.set}` : `IKEA ${item.itemNo}`}</p>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight">{item.name}</h2>
            <p className="text-sm text-white/50">
              {item.source === "lego" && item.category === "Creator"
                ? "This is a 3-in-1 set: each book builds a different model from the same bricks. Pick one."
                : item.source === "lego"
                  ? "This set's instructions come in several books. Start with Book 1."
                  : "This product's assembly comes in several manuals. Start with Part 1."}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-white/50 transition hover:bg-white/10 hover:text-white">
            ✕
          </button>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {item.manuals.map((m) => (
            <button
              key={m.pdfPath}
              onClick={() => onPick(m)}
              className="group overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] text-left transition hover:border-sky-300/40"
            >
              <div className="relative aspect-square bg-white/[0.03]">
                <ProductImage src={m.coverUrl ?? item.image} sizes="160px" padded={false} className="group-hover:scale-105" />
              </div>
              <div className="p-2">
                <p className="text-xs font-semibold">{m.label}</p>
                {m.size && <p className="font-mono text-[10px] text-white/40">{m.size}</p>}
              </div>
            </button>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}
