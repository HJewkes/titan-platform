// Writes dist/console.html, the built page with its first-paint answers embedded, that opens from disk: `pnpm --filter titan-console export`.
import { readFile, writeFile } from "node:fs/promises";
import { embedSnapshot } from "@titan-design/react-app";
import { resolveConfig } from "./config.js";
import { EXPORT_FILE, PAGE_FILE } from "./paths.js";
import { createConsoleRegistry, recordFirstPaint } from "./registry.js";
import { createUpstreams } from "./upstreams.js";

const page = await readFile(PAGE_FILE, "utf8").catch(() => {
  throw new Error(`${PAGE_FILE} is missing; run \`pnpm --filter titan-console build\` first`);
});
const snapshot = await recordFirstPaint(createConsoleRegistry(createUpstreams(resolveConfig())));
await writeFile(EXPORT_FILE, embedSnapshot(page, snapshot));
console.log(`wrote ${EXPORT_FILE} (${Object.keys(snapshot.calls).length} recorded call)`);
