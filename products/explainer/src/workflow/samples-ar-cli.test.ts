import { afterEach, describe, expect, it } from "vitest";
import { fakeHost, fakeRender, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";
import { runAbCli } from "./samples-cli.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

function run(...argv: string[]): Promise<{ code: number; err: string }> {
  fx = fixture();
  const err: string[] = [];
  const deps = { host: fakeHost(fx, fakeScriptModel(undefined, { usd: 0.05 }), fakeRender()), out: () => undefined, err: (text: string) => err.push(text) };
  return runAbCli(["ab", "--variants", "champion", "champion", "--cases", fx.dataDir, "--ar-result", "--data-dir", fx.dataDir, ...argv], deps).then((code) => ({ code, err: err.join("") }));
}

describe("explainer ab --ar-result", () => {
  it("refuses a stage other than script", async () => {
    const result = await run("--stage", "rewrite", "--judge", "unused.json");

    expect(result.code).toBe(2);
    expect(result.err).toContain("--ar-result scores the script stage; got rewrite");
  });

  it("refuses a run with no judge for the cold viewer", async () => {
    const result = await run("--stage", "script");

    expect(result.code).toBe(2);
    expect(result.err).toContain("--ar-result needs --judge");
  });
});
