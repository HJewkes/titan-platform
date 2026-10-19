// Shoots every console route from the twin fixtures into dist/twin: `pnpm --filter titan-console capture [--out <dir>]`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { embedSnapshot } from "@titan-design/react-app";
import { PAGE_FILE, TWIN_DIR } from "../paths.js";
import { captureTwin, NondeterministicCaptureError } from "./capture.js";
import { TWIN_ROUTES, TWIN_VIEWPORTS } from "./routes.js";
import { twinSnapshot } from "./snapshot.js";

const { values } = parseArgs({ options: { out: { type: "string" } } });
const outDir = path.resolve(values.out ?? TWIN_DIR);

const page = await readFile(PAGE_FILE, "utf8").catch(() => {
  throw new Error(`${PAGE_FILE} is missing; run \`pnpm --filter titan-console build\` first`);
});

try {
  const manifest = await captureTwin({ html: embedSnapshot(page, await twinSnapshot()), routes: TWIN_ROUTES, viewports: TWIN_VIEWPORTS, outDir });
  console.log(`wrote ${manifest.frames.length} frames to ${outDir}, each identical across two shots`);
} catch (error) {
  if (!(error instanceof NondeterministicCaptureError)) throw error;
  console.error(`${error.message}\nboth shots of each are in ${outDir} as <route>.png and <route>.second.png`);
  process.exitCode = 1;
}
