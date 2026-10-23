import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { runRunCli } from "./run-cli.js";
import { z } from "zod";
import { runStageCli } from "./stage-cli.js";

const ReportRowsSchema = z.object({ rows: z.array(z.object({ stage: z.string(), outputs: z.record(z.string(), z.string()) })) });
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

describe("explainer stage and run variants CLI", () => {
  it("run --variant reruns from the varied stage, and report --compare names the cache hits", async () => {
    fx = fixture();
    const host = fakeHost(fx, fakeScriptModel(), fakeBridge());
    const { run, out } = cli(host);
    const variant = path.join(fx.dataDir, "render.json");
    writeFileSync(variant, JSON.stringify({ schema: "explainer.variant/v1", stage: "render", name: "w8", params: { workers: 8 } }));

    await run("--spine", fx.spine, "--facts", fx.facts);
    const first = /^run (\S+):/.exec(out[0] ?? "")?.[1];
    out.length = 0;
    expect(await run("--spine", fx.spine, "--facts", fx.facts, "--variant", `render=${variant}`)).toBe(0);
    const second = /^run (\S+):/.exec(out[0] ?? "")?.[1];
    out.length = 0;
    await run("report", second!, "--compare", first!);

    expect(out.join("")).toContain("| tts | cached | **bridge** |");
    expect(out.join("")).toContain(`## Compare: ${second} against ${first}`);
    expect(out.join("")).toContain("Cache hits in");
  });

  it("stage runs one stage from stored shas and prints a cache hit the second time", async () => {
    fx = fixture();
    const host = fakeHost(fx, fakeScriptModel(), fakeBridge());
    const { run, out } = cli(host);
    await run("--spine", fx.spine, "--facts", fx.facts, "--to", "script");
    const runId = /^run (\S+):/.exec(out[0] ?? "")?.[1];
    out.length = 0;
    await run("report", runId!, "--json");
    const draft = ReportRowsSchema.parse(JSON.parse(out.join(""))).rows.find((r) => r.stage === "script")!.outputs.draft!;
    const lines: string[] = [];
    const stage = (...argv: string[]) => runStageCli(["stage", ...argv, "--data-dir", fx.dataDir], { host, out: (t) => lines.push(t), err: (t) => lines.push(t) });

    expect(await stage("rewrite", "--in", `draft=${draft}`, "--sample", "3")).toBe(0);
    expect(await stage("rewrite", "--in", `draft=${draft}`, "--sample", "3")).toBe(0);
    expect(await stage("rewrite", "--in", "draft=abc")).toBe(2);

    expect(lines.filter((l) => l.startsWith("stage rewrite:")).map((l) => l.split(";")[0])).toEqual(["stage rewrite: ran", "stage rewrite: cache hit"]);
  });
});
