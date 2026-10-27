import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { WorkflowRunStore } from "@titan-design/workflow";
import { loadQaGate } from "../qa/gate-profile.js";
import { ArtifactStore } from "../workflow/artifacts.js";
import { openState } from "../workflow/host.js";
import { planOf } from "../workflow/video-runs.js";
import { compositionPage } from "./composition-page.js";
import { renderVideo } from "./render-video.js";
import { renderSmoke, runArtifacts, SMOKE_WORKERS, type SmokeResult } from "./render-smoke.js";

// Bundled to dist/render-smoke.mjs by the render:smoke script: one level under the package root, where the doctrine
// loaders look for ../doctrine/.
// The render outputs land in --data-dir's store: point it at a copy of a run store.
const { values } = parseArgs({ options: { "data-dir": { type: "string" }, run: { type: "string" }, out: { type: "string" }, workers: { type: "string" } } });
const [dataDir, runId, outDir] = [values["data-dir"], values.run, values.out];
if (!dataDir || !runId || !outDir) throw new Error("usage: render:smoke --data-dir <copy of a run store> --run <run id> --out <dir> [--workers 16]");
const workers = Number(values.workers ?? SMOKE_WORKERS);

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
  const engine = { page: () => compositionPage(path.join(outDir, "page-cache")), render: renderVideo };
  const result = await renderSmoke({ runId, artifacts, store, gate: loadQaGate(planOf(run).profile), workers, keepDir: outDir }, engine);
  written(result, store);
  if (artifacts.mp4) store.materialise(artifacts.mp4, path.join(outDir, "bridged.mp4"));
  for (const row of result.held) process.stdout.write(`held ${row.kind} ${row.beat}: ${row.reason}\n`);
  process.stdout.write(`${result.pass ? "PASS" : "FAIL"} run ${runId}: qa ${result.qaGate}, ${result.heldErrors} held, mp4 ${result.mp4s.join(" then ")} at ${workers} workers\n`);
  process.exitCode = result.pass ? 0 : 1;
} finally {
  db.close();
}
