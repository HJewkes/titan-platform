import { afterEach, describe, expect, it } from "vitest";
import { editHarness } from "./edit-cli.test-helpers.js";
import { runVideo } from "./host.js";
import { runPropsCli } from "./props-cli.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk, run on fakes end to end; no real script, run or render.
let fx: Fixture;
afterEach(() => fx.cleanup());

const { baseRun, editFile, cli } = editHarness(() => fx);

async function props(mp4Sha: string): Promise<{ code: number; result: Record<string, unknown> }> {
  const lines: string[] = [];
  const code = await runPropsCli(["props", "--mp4-sha", mp4Sha, "--json", "--data-dir", fx.dataDir], { out: (t) => lines.push(t), err: (t) => lines.push(t) });
  return { code, result: JSON.parse(lines.join("")) };
}

describe("explainer props --mp4-sha", () => {
  it("reads the run whose export linked that mp4, not a newer run that rendered it without exporting", async () => {
    fx = fixture();
    const base = await baseRun();
    const newer = await runVideo({ from: "resolve", base: base.result.runId, to: "render" }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const { code, result } = await props(base.mp4Sha);

    expect(newer.report.rows.find((r) => r.stage === "render")!.outputs.mp4).toBe(base.mp4Sha);
    expect(code).toBe(0);
    expect(result).toMatchObject({ found: true, runId: base.result.runId, videoId: base.result.runId, saveBack: { enabled: false } });
    expect(result.beats).toEqual(expect.arrayContaining([expect.objectContaining({ id: "h1", spec: expect.any(String), schema: expect.any(Object) })]));
  });

  it("of two runs that exported the same mp4, reads the newer", async () => {
    fx = fixture();
    const base = await baseRun();
    const rerun = await runVideo({ from: "resolve", base: base.result.runId }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const { result } = await props(base.mp4Sha);

    expect(rerun.report.rows.find((r) => r.stage === "export")!.outputs.mp4).toBe(base.mp4Sha);
    expect(result).toMatchObject({ found: true, runId: rerun.runId });
  });

  it("reports the script artifact sha, and an edit drafted on it passes edit check", async () => {
    fx = fixture();
    const base = await baseRun();

    const { result } = await props(base.mp4Sha);
    const file = editFile({ ...base, scriptSha: String(result.scriptSha) }, { h1: { slots: { figures: [{ id: "scan-rate", value: 4, label: "Scans a minute" }] } } });
    const checked = await cli(["check", file]);

    expect(result.scriptSha).toBe(base.scriptSha);
    expect(JSON.parse(checked.text)).toMatchObject({ ok: true, problems: [] });
  });

  it("answers found: false for an mp4 no explainer run exported", async () => {
    fx = fixture();
    await baseRun();

    const { code, result } = await props("f".repeat(64));

    expect(code).toBe(0);
    expect(result).toEqual({ found: false });
    expect(result).not.toHaveProperty("scriptSha");
  });
});
