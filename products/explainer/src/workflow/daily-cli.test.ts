import { afterEach, describe, expect, it } from "vitest";
import { cpSync } from "node:fs";
import path from "node:path";
import { DAILY_FIXTURE, fakeCli, fakeGh, fixtureTasks, REPO } from "../presets/daily/daily-fakes.test-helpers.js";
import { runDailyCli } from "./daily-cli.js";
import { cloneFixture, dropSeeds, fakeBriefModels, fakeHost, fakeRender, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture | undefined;
afterEach(() => fx?.cleanup());

/** The argv the daily command hands the run CLI, with the run itself stubbed out. */
async function argvFor(args: string[], now: string): Promise<string[]> {
  let seen: string[] = [];
  await runDailyCli(["daily", ...args], { now: () => new Date(now), run: async (argv) => { seen = [...argv]; return 0; } });
  return seen;
}

const flagValue = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

describe("explainer daily argv", () => {
  it("picks the day before a clock just after midnight UTC", async () => {
    const argv = await argvFor([], "2026-11-15T00:20:00Z");

    expect(flagValue(argv, "--day")).toBe("2026-11-14");
  });

  it("still picks the previous day at the end of the UTC day", async () => {
    const argv = await argvFor([], "2026-11-15T23:59:00Z");

    expect(flagValue(argv, "--day")).toBe("2026-11-14");
  });

  it("lets --day override the clock", async () => {
    const argv = await argvFor(["--day", "2026-11-10"], "2026-11-15T00:20:00Z");

    expect(flagValue(argv, "--day")).toBe("2026-11-10");
  });

  it("runs the daily overview from gather on a $6 cap with the reflection deposited", async () => {
    const argv = await argvFor(["--repo", "a/b", "--theater", "t", "--transcripts", "x", "--data-dir", "d"], "2026-11-15T00:20:00Z");

    expect(argv.slice(0, 1)).toEqual(["run"]);
    expect(flagValue(argv, "--from")).toBe("gather");
    expect(flagValue(argv, "--facts-from")).toBe("gatherDaily");
    expect(flagValue(argv, "--type")).toBe("daily-overview");
    expect(flagValue(argv, "--profile")).toBe("daily-overview");
    expect(flagValue(argv, "--reflection")).toBe("deposit");
    expect(flagValue(argv, "--budget-usd")).toBe("6");
    expect(["--repo", "--theater", "--transcripts", "--data-dir"].map((f) => flagValue(argv, f))).toEqual(["a/b", "t", "x", "d"]);
  });

  it("lets --budget-usd override the default cap", async () => {
    const argv = await argvFor(["--budget-usd", "9"], "2026-11-15T00:20:00Z");

    expect(flagValue(argv, "--budget-usd")).toBe("9");
  });
});

describe("explainer daily exit code", () => {
  afterEach(dropSeeds);

  async function daily(budget: string): Promise<{ code: number; out: string[] }> {
    fx = cloneFixture({ fx: fixture() });
    cpSync(path.join(DAILY_FIXTURE, "snapshots"), path.join(fx.dataDir, "task-snapshots"), { recursive: true });
    const out: string[] = [];
    const host = fakeHost(fx, fakeBriefModels(fakeScriptModel(undefined, { usd: 0.05 })), fakeRender());
    const gather = { gh: fakeGh(), listTasks: async () => fixtureTasks(), cli: fakeCli() };
    const code = await runDailyCli(["daily", "--day", "2026-11-13", "--repo", REPO, "--transcripts", path.join(DAILY_FIXTURE, "transcripts"),
      "--initiative", "demo", "--data-dir", fx.dataDir, "--budget-usd", budget], { host, gather, out: (t) => out.push(t), err: () => undefined });
    return { code, out };
  }

  it("exits 1 and reports the run id and spend when the budget stops the run", async () => {
    const result = await daily("0.01");

    expect(result.code).toBe(1);
    expect(result.out.join("")).toMatch(/daily run \S+: (stopped|failed); \$\d/);
  });
});
