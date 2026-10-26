import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVideo } from "../workflow/host.js";
import { StageRecordSchema } from "../workflow/records.js";
import { runPaths } from "../workflow/run-dir.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "../workflow/run-fakes.test-helpers.js";
import { fakeQa, heldOverlap } from "./qa-fakes.test-helpers.js";
import { QaReportSchema } from "./qa-report.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

const row = (outcome: Awaited<ReturnType<typeof runVideo>>, stage: string) => outcome.report.rows.find((r) => r.stage === stage)!;

describe("explainer run through the qa stage", () => {
  it("fails qa on a held error with a per-kind summary, stops before sheets and keeps the verdicts", async () => {
    fx = fixture();
    const qa = fakeQa(heldOverlap());

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge(), { qaEngine: qa }));

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/qa: gate held-errors failed \(qa FAIL: \d+ held errors \(text-overlap \d+\)/);
    expect([row(result, "qa").status, row(result, "sheets").status, row(result, "export").status]).toEqual(["failed", "not run", "not run"]);
    const failed = StageRecordSchema.parse(JSON.parse(readFileSync(runPaths(fx.dataDir, row(result, "qa").childRunId!).failed("qa"), "utf8")));
    expect(failed.checks.map(({ name, gate, pass }) => [name, gate, pass])).toEqual([
      ["held-errors", true, false], ["mp4-duration", true, true], ["motion-happened", true, true], ["clipped-text", true, true], ["content-fill", true, true], ["stage-empty", false, true],
      ["picture-change", true, true], ["picture-change-warn", false, true], ["static-window", true, true], ["cue-onset", true, true], ["reading-hold", true, true],
      ["direction-gates", false, false], ["black-frames", false, true], ["silence-2s", false, true], ["frozen-frames", false, true],
    ]);
    const report = QaReportSchema.parse(JSON.parse(readFileSync(path.join(fx.dataDir, "artifacts", failed.outputs.qa!), "utf8")));
    expect(report.timeline).toBe("words");
    expect(new Set(report.errors.map((error) => error.beat)).size).toBeGreaterThan(1);
  });

  it("opens the bridged page by its theater stem with the cues it resolved, and passes a clean page", async () => {
    fx = fixture();
    const qa = fakeQa();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge(), { qaEngine: qa }));

    expect(result.status, result.error).toBe("completed");
    expect(row(result, "qa")).toMatchObject({ checks: "14 pass, 0 gate fail, 1 reported fail" });
    expect(qa.opened.map(({ url }) => url)).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/\?page=demo$/)]);
  });
});
