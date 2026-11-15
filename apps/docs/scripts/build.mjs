// pnpm --filter titan-docs build: client build, SSR build, prerender into dist/site, then the dist check.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { checkDist } from "./dist-check.mjs";
import { prerender } from "./prerender.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
await build({ root, logLevel: "warn", build: { outDir: join(dist, "client") } });
await build({ root, logLevel: "warn", build: { ssr: "src/entry-server.tsx", outDir: join(dist, "server") } });

const routes = await prerender(dist);
const problems = checkDist(join(dist, "site"));
for (const line of problems) console.error(`dist-check: ${line}`);
if (problems.length > 0) process.exit(1);
console.log(`titan-docs: prerendered ${routes.length} route(s) into dist/site`);
