import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "./artifacts.js";
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
    expect(bridge.calls).toEqual(["tts.mjs", "render.ts", "qa.ts", "sheets.sh"]);
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

  it("stops at the eval stage when an error-severity L0 check fails, before any bridged command", async () => {
    fx = fixture();
    const bridge = fakeBridge();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge, { evalChecks: [l0Check(false)] }));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("eval: l0");
    expect(bridge.calls).toEqual([]);
    expect(row(result, "eval").status).toBe("failed");
    expect(row(result, "tts").status).toBe("not run");
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

describe("explainer run --from", () => {
  it("from tts spends nothing on models and hands tts the base run's script sha", async () => {
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
    expect(bridge.ttsInputs).toEqual([row(first, "rewrite").outputs.script, row(first, "rewrite").outputs.script]);
    for (const stage of ["script", "rewrite", "eval"]) {
      expect(row(second, stage)).toMatchObject({ status: "reused", cacheHit: true, usd: 0, wallMs: 0, outputs: row(first, stage).outputs, reusedFrom: first.runId });
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
    expect(row(failed, "qa").status).toBe("failed");
    expect(resumed.status, resumed.error).toBe("completed");
    expect(bridge.calls).toEqual(["qa.ts", "sheets.sh"]);
  });

  it("writes each command's output to the run's log directory", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(readFileSync(path.join(path.dirname(result.reportPath), "logs", "qa-1.log"), "utf8")).toContain("qa PASS demo");
  });
});

describe("run report", () => {
  it("gives each stage its wall time, usd, tokens and shares, and totals that add up", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { usd: 0.05 });

    const { report } = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    const rewrite = report.rows.find((r) => r.stage === "rewrite")!;
    expect(report.rows.every((r) => r.wallMs === 1000)).toBe(true);
    expect(report.totals.wallMs).toBe(8000);
    expect(row({ report } as never, "script")).toMatchObject({ usd: 0.05, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, calls: 1 });
    expect(rewrite.usd).toBeGreaterThan(0);
    expect(report.totals.usd).toBeCloseTo(0.05 + rewrite.usd);
    expect(report.totals.calls).toBe(1 + rewrite.calls);
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
