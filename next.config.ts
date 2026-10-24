import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // One self-contained Node server for the Docker image (Azure Container Apps).
  output: "standalone",
  serverExternalPackages: ["@azure/monitor-opentelemetry"],
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
};

export default nextConfig;
