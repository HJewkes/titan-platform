import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { writePairSheet } from "./pair-sheet.js";
import { parseTimeline } from "./timeline.js";

const { values } = parseArgs({ options: { bridged: { type: "string" }, "in-process": { type: "string" }, timeline: { type: "string" }, out: { type: "string" } } });
const [bridged, inProcess, timelineFile, outDir] = [values.bridged, values["in-process"], values.timeline, values.out];
if (!bridged || !inProcess || !timelineFile || !outDir) throw new Error("usage: page:pairs --bridged <mp4> --in-process <mp4> --timeline <timeline.json> --out <dir>");
const timeline = parseTimeline(JSON.parse(readFileSync(timelineFile, "utf8")));
const { pairs, sheet } = await writePairSheet(bridged, inProcess, timeline, outDir);
for (const pair of pairs) process.stdout.write(`${pair.file}  ${pair.kind}  ssim ${pair.ssim.toFixed(3)}${pair.known ? "  (R5)" : ""}\n`);
process.stdout.write(`sheet: ${path.join(outDir, sheet)}\n`);
