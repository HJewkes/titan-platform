import { afterEach, describe, expect, it } from "vitest";
import { runRunCli } from "./run-cli.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

function cli(host: ReturnType<typeof fakeHost>) {
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) => runRunCli(["run", ...argv, "--data-dir", fx.dataDir], { host, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { run, out, err };
}

describe("explainer run CLI", () => {
  it("runs a video, exits 0, and `run report` prints the stage table", async () => {
    fx = fixture();
    const { run, out } = cli(fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const code = await run("--spine", fx.spine, "--facts", fx.facts);
    const runId = /^run (\S+): completed/.exec(out[0] ?? "")?.[1];
    out.length = 0;
    const reportCode = await run("report", runId!);

    expect(code).toBe(0);
    expect(reportCode).toBe(0);
    expect(out.join("")).toContain("| tts | ran | **bridge** |");
  });

  it("exits 1 on a stopped run and prints how to resume it", async () => {
    fx = fixture();
    const { run, err } = cli(fakeHost(fx, fakeScriptModel(undefined, { usd: 0.05 }), fakeBridge()));

    const code = await run("--spine", fx.spine, "--facts", fx.facts, "--budget-usd", "0.05");

    expect(code).toBe(1);
    expect(err.join("")).toMatch(/continue with: explainer run resume \S+/);
  });

  it("exits 2 on an unknown stage or a runaway cap", async () => {
    fx = fixture();
    const { run } = cli(fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(await run("--from", "mix")).toBe(2);
    expect(await run("--budget-usd", "2000")).toBe(2);
  });
});
