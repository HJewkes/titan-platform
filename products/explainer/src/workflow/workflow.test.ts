import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failingRubric, fakeRubricJudge, throwingRubric } from "../cold-rubric-fakes.test-helpers.js";
import type { L0Check } from "../eval-l0.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { sha256 } from "./artifacts.js";
import { MAX_REPAIR_ROUNDS } from "./model-stages.js";
import { resumeVideo, runVideo } from "./host.js";
import { STAGES } from "./records.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, l0Check, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

const row = (outcome: Awaited<ReturnType<typeof runVideo>>, stage: string) => outcome.report.rows.find((r) => r.stage === stage)!;

describe("explainer run", () => {
  it("runs every stage in order and ends with the MP4 linked into the theater", async () => {
    fx = fixture();
    const bridge = fakeBridge();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(result.status, result.error).toBe("completed");
    expect(result.report.rows.map((r) => [r.stage, r.status])).toEqual(STAGES.map((stage) => [stage, "ran"]));
    expect(bridge.calls).toEqual(["tts.mjs", "render.ts", "qa.ts", "sheets.sh", "variety.mjs"]);
    const theaterMp4 = path.join(fx.theater, "demo.mp4");
    expect(sha256(readFileSync(theaterMp4))).toBe(row(result, "render").outputs.mp4);
    expect(row(result, "export").outputs.mp4).toBe(row(result, "render").outputs.mp4);
  });

  it("hands the tts command the rewritten script, not the draft", async () => {
    fx = fixture();
    const bridge = fakeBridge();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(bridge.ttsInputs).toEqual([row(result, "rewrite").outputs.script]);
    expect(row(result, "rewrite").outputs.script).not.toBe(row(result, "script").outputs.draft);
  });

  it("stops at the script stage's l0 gate when an error-severity L0 check fails, before the rewrite spends", async () => {
    fx = fixture();
    const bridge = fakeBridge();
    const model = fakeScriptModel();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, bridge, { evalChecks: [l0Check(false)] }));

    expect(result.status).toBe("failed");
    expect(model.prompts).toHaveLength(1 + MAX_REPAIR_ROUNDS);
    expect(row(result, "script")).toMatchObject({ status: "failed", checks: "3 pass, 1 gate fail, 1 reported fail" });
    expect(result.error).toContain("script: gate l0 failed");
    expect(bridge.calls).toEqual([]);
    expect(row(result, "rewrite").status).toBe("not run");
  });

  it("retries the script call once with the schema issues, and counts both calls", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { invalid: 1, usd: 0.05 });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[0]).toContain("## The script/v1 JSON Schema");
    expect(model.prompts[0]).toContain("Story spine: parcel-desk");
    expect(model.prompts[1]).toContain("Your previous reply was rejected");
    expect(row(result, "script")).toMatchObject({ retries: 1, calls: 2, usd: 0.1 });
  });

  it("repairs a draft that fails L0 with one call naming the failing checks, and keeps the repair", async () => {
    fx = fixture();
    const draft = choppy();
    const model = fakeScriptModel(draft, { repaired: { ...draft, id: `${draft.id}-repaired` } });
    const passesOnceRepaired: L0Check = (input) => l0Check(input.script.id.endsWith("-repaired"))(input);

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge(), { evalChecks: [passesOnceRepaired] }));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("## Checks the draft fails\n\n- fake-l0:");
    expect(row(result, "script")).toMatchObject({ calls: 2, retries: 0, checks: "5 pass, 0 gate fail, 0 reported fail" });
  });

  it("makes no repair call for a draft that passes L0", async () => {
    fx = fixture();
    const model = fakeScriptModel();

    await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(model.prompts).toHaveLength(1);
  });

  it("fails the script stage after one retry, keeping both calls' spend in the report", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { invalid: 2, usd: 0.05 });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(result.status).toBe("failed");
    expect(model.prompts).toHaveLength(2);
    expect(row(result, "script")).toMatchObject({ status: "failed", usd: 0.1, retries: 1 });
    expect(result.report.totals.usd).toBeCloseTo(0.1);
  });
});

describe("the cold rubric on every run", () => {
  it("scores J8 to J12 on the final script and records them as a note and an artifact, never a check", async () => {
    fx = fixture();
    const host = fakeHost(fx, fakeScriptModel(), fakeBridge());

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, host);

    const evalRow = row(result, "eval");
    expect(host.rubric.calls).toHaveLength(1);
    expect(evalRow.outputs["cold-rubric"]).toMatch(/^[0-9a-f]{64}$/);
    expect(evalRow.notes[0]).toMatch(/^cold rubric \(reported only\): J8 \d, J9 \d, J10 \d, J11 \d, J12 \d; canary held$/);
    expect(evalRow.checks).toBe("2 pass, 0 gate fail, 0 reported fail");
  });

  // Mutation: adding the rubric to the eval stage's checks, failing below 3 or on a missed canary, fails this test.
  it.each([
    ["scores every row 1 and misses its canary", fakeRubricJudge({ score: 1, lenient: true }).harness],
    ["fails its call", failingRubric],
    ["throws", throwingRubric],
  ])("cannot fail the run or gate a stage when the rubric judge %s", async (_, harness) => {
    fx = fixture();
    const bridge = fakeBridge();
    const rubric = { harness, calls: [] as string[] };

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge, { rubric }));

    expect(result.status, result.error).toBe("completed");
    expect(row(result, "eval").checks).toBe("2 pass, 0 gate fail, 0 reported fail");
    expect(row(result, "eval").notes[0]).toMatch(/^cold rubric \(reported only\)/);
    expect(bridge.calls).toEqual(["tts.mjs", "render.ts", "qa.ts", "sheets.sh", "variety.mjs"]);
  });
});

describe("explainer run --from", () => {
  it("from tts spends nothing on models, and the unchanged script hits the stage cache from tts on", async () => {
    fx = fixture();
    const model = fakeScriptModel();
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, bridge));
    const host = fakeHost(fx, model, bridge);

    const second = await runVideo({ from: "tts" }, host);

    expect(second.status, second.error).toBe("completed");
    expect(model.prompts).toHaveLength(1);
    expect(host.rewriter.prompts).toHaveLength(0);
    expect(second.report.totals.usd).toBe(0);
    expect(bridge.ttsInputs).toEqual([row(first, "rewrite").outputs.script]);
    for (const stage of ["script", "rewrite", "eval"]) {
      expect(row(second, stage)).toMatchObject({ status: "reused", cacheHit: true, usd: 0, wallMs: 0, outputs: row(first, stage).outputs, reusedFrom: first.runId });
    }
    for (const stage of ["tts", "render", "qa", "sheets"]) {
      expect(row(second, stage)).toMatchObject({ status: "cached", cacheHit: true, wallMs: 0, outputs: row(first, stage).outputs, childRunId: row(first, stage).childRunId });
    }
    expect(second.report.linked).toEqual([{ runId: first.runId, usd: first.report.totals.usd }]);
  });

  it("refuses a --from whose base run never finished the stages before it, naming the stage", async () => {
    fx = fixture();
    const bridge = fakeBridge({ qaFails: true });
    const failed = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));

    await expect(runVideo({ from: "sheets", base: failed.runId }, fakeHost(fx, fakeScriptModel(), bridge))).rejects.toThrow(/has no completed qa stage/);
  });
});

describe("spend cap", () => {
  it("stops before the next stage once spend reaches the cap, naming that stage", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { usd: 0.05 });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, budgetUsd: 0.05 }, fakeHost(fx, model, fakeBridge()));

    expect(result.status).toBe("failed");
    expect(result.report.stop).toEqual({ stage: "rewrite", spentUsd: 0.05, capUsd: 0.05 });
    expect(row(result, "rewrite").status).toBe("not run");
    expect(readFileSync(result.reportPath, "utf8")).toContain("Stopped at the spend cap before stage rewrite");
  });

  it("resumes a stopped run from the named stage under a higher cap, without paying for the script again", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { usd: 0.05 });
    const bridge = fakeBridge();
    const stopped = await runVideo({ spine: fx.spine, facts: fx.facts, budgetUsd: 0.05 }, fakeHost(fx, model, bridge));

    const resumed = await resumeVideo(stopped.runId, fakeHost(fx, model, bridge), { budgetUsd: 5 });

    expect(resumed.status, resumed.error).toBe("completed");
    expect(resumed.report.from).toBe("rewrite");
    expect(model.prompts).toHaveLength(1);
    expect(row(resumed, "script")).toMatchObject({ status: "reused", outputs: row(stopped, "script").outputs });
    expect(resumed.report.videoUsd).toBeCloseTo(0.05 + resumed.report.totals.usd);
  });

  it("caps the script call's own budget at what the run has left", async () => {
    fx = fixture();
    const model = fakeScriptModel();

    await runVideo({ spine: fx.spine, facts: fx.facts, budgetUsd: 1.5 }, fakeHost(fx, model, fakeBridge()));

    expect(model.budgets).toEqual([1.5]);
  });
});

describe("bridged stages", () => {
  it("fails the run at the stage whose command exits non-zero, and a resume starts there", async () => {
    fx = fixture();
    const failing = fakeBridge({ qaFails: true });
    const failed = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), failing));
    const bridge = fakeBridge();

    const resumed = await resumeVideo(failed.runId, fakeHost(fx, fakeScriptModel(), bridge));

    expect(failed.error).toContain("bridge qa: command 1 (qa.ts) exited 1: held errors at b1");
    expect(row(failed, "qa")).toMatchObject({ status: "failed", checks: "0 pass, 1 gate fail, 0 reported fail" });
    expect(resumed.status, resumed.error).toBe("completed");
    expect(bridge.calls).toEqual(["qa.ts", "sheets.sh", "variety.mjs"]);
  });

  it("writes each command's output to the run's log directory", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const qaChild = row(result, "qa").childRunId!;
    expect(readFileSync(path.join(fx.dataDir, "runs", qaChild, "logs", "qa-1.log"), "utf8")).toContain("qa PASS demo");
  });
});

describe("checks as stage steps", () => {
  /** h1 shows a V6 card on "courier", a word h1 speaks in the draft and in its rewrite. */
  const cued = () => choppy({ h1: { visual: { assertion: "The desk refuses unknown parcels", job: "numbers", cues: [{ action: "V6", target: "card", atCue: "courier" }] } } });

  it("fails the tts stage at its cue gate when the voice drops a cue word, before render", async () => {
    fx = fixture();
    const bridge = fakeBridge({ dropWord: "courier" });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(cued()), bridge));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("tts: gate cue-resolution failed (0 of 1 cues resolve; unresolved: h1:courier)");
    expect(row(result, "tts")).toMatchObject({ status: "failed", checks: "0 pass, 1 gate fail, 0 reported fail" });
    expect(row(result, "render").status).toBe("not run");
    expect(bridge.calls).toEqual(["tts.mjs"]);
  });

  it("passes the cue gate when every cue word is voiced", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(cued()), fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(row(result, "tts").checks).toBe("1 pass, 0 gate fail, 0 reported fail");
  });

  it("records a failed reported-only bridge check and runs on to the theater", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge({ varietyFails: true })));

    expect(result.status, result.error).toBe("completed");
    expect(row(result, "sheets").checks).toBe("0 pass, 0 gate fail, 1 reported fail");
    expect(readFileSync(result.reportPath, "utf8")).toContain("| sheets | variety | reported | **fail** | variety WARN: 3 beats in a row share a framing |");
  });

  it("lists every stage's verdicts with their role in the report", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const md = readFileSync(result.reportPath, "utf8");
    expect(md).toContain("| script | l0 | gate | pass |");
    expect(md).toContain("| rewrite | rewrite-rows | reported |");
    expect(md).toContain("| tts | cue-resolution | gate | pass | 0 of 0 cues resolve |");
  });
});

describe("run report", () => {
  it("gives each stage its wall time, usd, tokens and shares, and totals that add up", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { usd: 0.05 });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    const { report } = result;
    const rewrite = row(result, "rewrite");
    // One clock read for the body's start and one each for its end and the checks step's end; export has no checks step.
    expect(report.rows.map((r) => r.wallMs)).toEqual([...Array(7).fill(2000), 1000]);
    expect(report.totals.wallMs).toBe(15000);
    expect(row(result, "script")).toMatchObject({ usd: 0.05, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, calls: 1 });
    expect(rewrite.usd).toBeGreaterThan(0);
    expect(row(result, "eval")).toMatchObject({ usd: 0.01, calls: 1 });
    expect(report.totals.usd).toBeCloseTo(0.05 + rewrite.usd + 0.01);
    expect(report.totals.calls).toBe(1 + rewrite.calls + 1);
  });

  it("marks exactly the bridged stages, and lists each stage's output shas", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const md = readFileSync(result.reportPath, "utf8");
    const bridgedRows = md.split("\n").filter((line) => line.includes("**bridge**")).map((line) => line.split("|")[1]!.trim());
    expect(bridgedRows).toEqual(["tts", "render", "qa", "sheets"]);
    expect(md).toContain(`mp4 ${row(result, "render").outputs.mp4!.slice(0, 12)}`);
    expect(md).toContain("qa PASS demo: 0 held errors");
    expect(existsSync(result.reportPath.replace(/\.md$/, ".json"))).toBe(true);
  });
});
