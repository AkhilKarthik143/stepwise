"use client";

import Image from "next/image";
import { useState } from "react";

// Product photo: resized by Next's optimizer, loaded only near the viewport (unless priority).
// While loading, the tile stays dark with a soft shimmer; the white backdrop fades in with the photo.
export default function ProductImage({
  src,
  sizes,
  padded = true,
  priority = false,
  className = "",
}: {
  src: string;
  sizes: string;
  padded?: boolean;
  priority?: boolean;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  // LEGO/IKEA CDNs ignore resize params; drop them so the optimizer's allow-list matches.
  const clean = src.split("?")[0];
  return (
    <>
      <span aria-hidden className={`absolute inset-0 bg-white transition-opacity duration-500 ${loaded ? "opacity-100" : "opacity-0"}`} />
      {!loaded && <span aria-hidden className="absolute inset-0 animate-pulse bg-gradient-to-br from-white/[0.06] to-white/[0.02]" />}
      <Image
        src={clean}
        alt=""
        fill
        sizes={sizes}
        priority={priority}
        onLoad={() => setLoaded(true)}
        className={`object-contain transition duration-500 ${padded ? "p-3" : ""} ${loaded ? "opacity-100" : "opacity-0"} ${className}`}
      />
    </>
  );
}
