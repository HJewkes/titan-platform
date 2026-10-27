import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WorkflowRunStore } from "@titan-design/workflow";
import { loadQaGate } from "../qa/gate-profile.js";
import { ArtifactStore } from "../workflow/artifacts.js";
import { openState } from "../workflow/host.js";
import { planOf } from "../workflow/video-runs.js";
import { cachedPage, type BuiltPage } from "./composition-page.js";
import { renderVideo } from "./render-video.js";
import { renderSmoke, runArtifacts, SMOKE_WORKERS, type SmokeResult } from "./render-smoke.js";

// Bundled to dist/render-smoke.mjs by the render:smoke script: one level under the package root, where the doctrine
// loaders look for ../doctrine/. composition-page.ts looks two levels up for the page sources, so the smoke names them.
// The render outputs land in --data-dir's store: point it at a copy of a run store.
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PAGE_SOURCE = { root: path.join(PACKAGE_ROOT, "src", "composition"), extra: [path.join(PACKAGE_ROOT, "src", "beat-slots.ts"), path.join(PACKAGE_ROOT, "package.json")] };
const { values } = parseArgs({ options: { "data-dir": { type: "string" }, run: { type: "string" }, out: { type: "string" }, workers: { type: "string" } } });
const [dataDir, runId, outDir] = [values["data-dir"], values.run, values.out];
if (!dataDir || !runId || !outDir) throw new Error("usage: render:smoke --data-dir <copy of a run store> --run <run id> --out <dir> [--workers 16]");
const workers = Number(values.workers ?? SMOKE_WORKERS);

async function builtPage(cacheRoot: string): Promise<BuiltPage> {
  const { build } = await import("vite");
  const configFile = path.join(PAGE_SOURCE.root, "vite.config.ts");
  return cachedPage(PAGE_SOURCE, cacheRoot, async (out) => void (await build({ configFile, logLevel: "warn", build: { outDir: out, emptyOutDir: true } })));
}

function written(result: SmokeResult, store: ArtifactStore): void {
  writeFileSync(path.join(outDir!, "smoke.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (result.mp4s[0]) store.materialise(result.mp4s[0], path.join(outDir!, "in-process.mp4"));
  if (result.timeline) store.materialise(result.timeline, path.join(outDir!, "timeline.json"));
}

mkdirSync(outDir, { recursive: true });
const db = openState(dataDir);
try {
  const run = new WorkflowRunStore(db).get(runId);
  if (!run) throw new Error(`no run ${runId} in ${dataDir}`);
  const artifacts = runArtifacts(run);
  const store = new ArtifactStore(dataDir, db);
  const engine = { page: () => builtPage(path.join(outDir, "page-cache")), render: renderVideo };
  const result = await renderSmoke({ runId, artifacts, store, gate: loadQaGate(planOf(run).profile), workers, keepDir: outDir }, engine);
  written(result, store);
  if (artifacts.mp4) store.materialise(artifacts.mp4, path.join(outDir, "bridged.mp4"));
  for (const row of result.held) process.stdout.write(`held ${row.kind} ${row.beat}: ${row.reason}\n`);
  process.stdout.write(`${result.pass ? "PASS" : "FAIL"} run ${runId}: qa ${result.qaGate}, ${result.heldErrors} held, mp4 ${result.mp4s.join(" then ")} at ${workers} workers\n`);
  process.exitCode = result.pass ? 0 : 1;
} finally {
  db.close();
}
