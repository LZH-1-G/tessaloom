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
};

export default nextConfig;
