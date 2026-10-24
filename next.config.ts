import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Product photos are resized and cached by Next's image optimizer (LEGO's CDN ignores size params).
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "www.lego.com", pathname: "/cdn/product-assets/**", search: "" },
      { protocol: "https", hostname: "www.ikea.com", pathname: "/us/en/images/products/**", search: "" },
    ],
  },
  // Manuals never change: let Vercel's CDN keep them, so only the first open hits lego.com / ikea.com.
  async headers() {
    return [
      {
        source: "/manual-pdf/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400" },
          { key: "CDN-Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
  // Manual PDFs live on lego.com / ikea.com, which browsers can't fetch directly (CORS).
  // These rewrites serve them from our own domain without going through a function.
  async rewrites() {
    return [
      { source: "/manual-pdf/lego/:file", destination: "https://www.lego.com/cdn/product-assets/product.bi.core.pdf/:file" },
      { source: "/manual-pdf/ikea/:path*", destination: "https://www.ikea.com/:path*" },
    ];
  },
};

export default nextConfig;
