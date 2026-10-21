import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const build = path.resolve("apps/web/.next");
const canaries = [
  "m0-qloo-secret-sentinel",
  "m0-llm-secret-sentinel",
  "m0-migrator-secret-sentinel",
];
let count = 0;
/** @param {string} dir */
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "cache")
        await scan(file);
    } else if (entry.isFile()) {
      const content = await readFile(file, "utf8");
      if (canaries.some((value) => content.includes(value)))
        throw new Error("Secret canary in build output");
      // Server validation must name forbidden variables. Browser assets must not.
      if (
        file.startsWith(path.join(build, "static") + path.sep) &&
        /[A-Z0-9_]+_API_KEY|DATABASE_URL_MIGRATOR/.test(content)
      ) {
        throw new Error("Secret variable name in browser assets");
      }
      count++;
    }
  }
}
await scan(build);
console.log(
  JSON.stringify({ event: "bundle_secret_check_passed", files: count }),
);
