import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const web = new URL("../apps/web/", import.meta.url);
const target = new URL(".next/standalone/apps/web/.next/", web);
await mkdir(target, { recursive: true });
await cp(
  fileURLToPath(new URL(".next/static", web)),
  fileURLToPath(new URL("static", target)),
  {
    recursive: true,
  },
);
