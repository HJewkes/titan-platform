import { writeFileSync } from "node:fs";
import path from "node:path";
import { runEditCli, type DetachedSpawn, type EditCliDeps } from "./edit-cli.js";
import { runVideo, type RunOutcome } from "./host.js";
import type { RunReport } from "./report.js";
import { fakeRender, fakeHost, fakeScriptModel, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk, run on fakes end to end; no real script, run, render or note.

export const out = (report: RunReport, stage: string) => report.rows.find((r) => r.stage === stage)!.outputs;

interface Base {
  result: RunOutcome;
  scriptSha: string;
  mp4Sha: string;
}

/** A finished base run, an edit file drafted over it, and `explainer edit` on the fixture's data dir; `fx` is read per call. */
export function editHarness(fx: () => Fixture) {
  async function baseRun(extra: Parameters<typeof fakeHost>[3] = {}, model = fakeScriptModel()): Promise<Base> {
    const result = await runVideo({ spine: fx().spine, facts: fx().facts }, fakeHost(fx(), model, fakeRender(), extra));
    return { result, scriptSha: out(result.report, "rewrite").script!, mp4Sha: out(result.report, "render").mp4! };
  }

  function editFile(base: Base, beats: Record<string, unknown>, name = "edit.json"): string {
    const file = path.join(path.join(fx().dataDir, ".."), name);
    const edit = { schema: "explainer.slot-edit/v1", base: { runId: base.result.runId, scriptSha: base.scriptSha, mp4Sha: base.mp4Sha }, beats, createdAt: "2026-10-24T00:00:00Z" };
    writeFileSync(file, JSON.stringify(edit));
    return file;
  }

  async function cli(argv: string[], deps: EditCliDeps = {}): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    const code = await runEditCli(["edit", ...argv, "--data-dir", fx().dataDir], { out: (t) => lines.push(t), err: (t) => lines.push(t), ...deps });
    return { code, text: lines.join("") };
  }

  return { baseRun, editFile, cli };
}

export function recordingSpawn(): { spawn: DetachedSpawn; launched: (readonly string[])[] } {
  const launched: (readonly string[])[] = [];
  return { spawn: (argv) => launched.push(argv), launched };
}
