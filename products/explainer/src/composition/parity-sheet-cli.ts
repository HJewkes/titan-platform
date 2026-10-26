import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compositionPage } from "../render/composition-page.js";
import { writeParitySheet } from "./parity-sheet.js";
import { parseTimeline } from "./timeline.js";

// Bundled to dist/sheet/page-sheet.mjs by the page:sheet script: two levels under the package root, as this source is,
// and as render/composition-page.ts expects of the module it is bundled into.
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const KINDS = path.join(PACKAGE_ROOT, "fixtures", "kinds.timeline.json");

const { values } = parseArgs({ options: { timeline: { type: "string" }, out: { type: "string" } } });
const timeline = parseTimeline(JSON.parse(readFileSync(values.timeline ?? KINDS, "utf8")));
const outDir = values.out ?? mkdtempSync(path.join(tmpdir(), "explainer-kind-sheet-"));
const page = await compositionPage(path.join(tmpdir(), "explainer-kind-sheet-page"));
const sheet = await writeParitySheet(page.dir, timeline, outDir);
for (const frame of sheet.frames) process.stdout.write(`${frame.file}  ink ${frame.inkShare.toFixed(3)}\n`);
process.stdout.write(`sheet: ${path.join(outDir, sheet.sheet)}\n`);
