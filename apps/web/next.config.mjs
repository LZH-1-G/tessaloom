import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  transpilePackages: ["@tessaloom/config", "@tessaloom/core", "@tessaloom/db"],
  poweredByHeader: false,
  // Share pages never leak through referrers, caches, or search engines (SECURITY §4.3).
  async headers() {
    return [
      {
        source: "/share/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
