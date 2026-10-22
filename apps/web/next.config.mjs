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
  // Security headers (CSP nonce, HSTS, share-page policy) are set per request in
  // src/proxy.ts: they depend on the runtime APP_ENV, and headers() is fixed at build time.
};

export default nextConfig;
