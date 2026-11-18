import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { usePreCalibrationStatuses } from "../writing-statuses-fixtures.test-helpers.js";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runRunCli } from "./run-cli.js";
import { z } from "zod";
import type { L0Check } from "../eval-l0.js";
import { DAILY_FIXTURE, DAY, fakeCli, fakeGh, fixtureTasks, REPO } from "../presets/daily/daily-fakes.test-helpers.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import type { ScriptV1 } from "../script-schema.js";
import { StageRecordSchema } from "./records.js";
import { runStageCli } from "./stage-cli.js";

const VideoReportSchema = z.object({ videoId: z.string(), runs: z.array(z.object({ runId: z.string(), usd: z.number() })), totals: z.object({ usd: z.number() }) });
const ReportRowsSchema =z.object({ rows: z.array(z.object({ stage: z.string(), outputs: z.record(z.string(), z.string()) })) });
import { cloneFixture, dropSeeds, fakeRender, fakeBriefModels, fakeHost, fakeScriptModel, fixture, l0Check, seededRun, type Fixture } from "./run-fakes.test-helpers.js";

// The rewrite stage's tests need a choppy draft the rewrite acts on, whatever the shipped status table says (TP-4662).
usePreCalibrationStatuses();

let fx: Fixture;
afterEach(() => fx.cleanup());
afterAll(dropSeeds);

/** A copy of the file's script-only run, as `fx`, and that run's draft sha. */
async function scriptDraft(): Promise<string> {
  const seed = await seededRun({ to: "script" });
  fx = cloneFixture(seed);
  return seed.result.report.rows.find((r) => r.stage === "script")!.outputs.draft!;
}

function cli(host: ReturnType<typeof fakeHost>) {
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) => runRunCli(["run", ...argv, "--data-dir", fx.dataDir], { host, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { run, out, err };
}

describe("explainer run CLI", () => {
  it("runs a video, exits 0, and `run report` prints the stage table", async () => {
    fx = fixture();
    const { run, out } = cli(fakeHost(fx, fakeScriptModel(), fakeRender()));

    const code = await run("--spine", fx.spine, "--facts", fx.facts);
    const runId = /^run (\S+): completed/.exec(out[0] ?? "")?.[1];
    out.length = 0;
    const reportCode = await run("report", runId!);

    expect(code).toBe(0);
    expect(reportCode).toBe(0);
    expect(out.join("")).toContain("| tts | ran | in-process |");
  });

  it("`run report --video` prints the video's folded cost report as JSON and writes no report file", async () => {
    fx = fixture();
    const { run, out } = cli(fakeHost(fx, fakeScriptModel(), fakeRender()));
    await run("--spine", fx.spine, "--facts", fx.facts);
    const runId = /^run (\S+): completed/.exec(out[0] ?? "")?.[1];
    out.length = 0;
    rmSync(path.join(fx.dataDir, "runs", runId!, "run-report.json"));

    const code = await run("report", "--video", runId!, "--json");

    const report = VideoReportSchema.parse(JSON.parse(out.join("")));
    expect(code).toBe(0);
    expect(report.videoId).toBe(runId);
    expect(report.runs.map((r) => r.runId)).toEqual([runId]);
    expect(report.totals.usd).toBeCloseTo(report.runs[0]!.usd, 10);
    expect(existsSync(path.join(fx.dataDir, "runs", runId!, "run-report.json"))).toBe(false);
  });

  it("`run report --video` exits 2 on a video no run belongs to", async () => {
    fx = fixture();
    const { run, err } = cli(fakeHost(fx, fakeScriptModel(), fakeRender()));

    const code = await run("report", "--video", "no-such-video", "--json");

    expect(code).toBe(2);
    expect(err.join("")).toContain("no explainer-video run belongs to video no-such-video");
  });

  it("exits 1 on a stopped run and prints how to resume it", async () => {
    fx = fixture();
    const { run, err } = cli(fakeHost(fx, fakeScriptModel(undefined, { usd: 0.05 }), fakeRender()));

    const code = await run("--spine", fx.spine, "--facts", fx.facts, "--budget-usd", "0.05");

    expect(code).toBe(1);
    expect(err.join("")).toMatch(/continue with: explainer run resume \S+/);
  });

  it("names the failed stage and its failed gate when a red eval check fails the run", async () => {
    fx = fixture();
    const { run, err } = cli(fakeHost(fx, fakeScriptModel(), fakeRender(), { evalChecks: [l0Check(false)] }));

    const code = await run("--spine", fx.spine, "--facts", fx.facts);

    expect(code).toBe(1);
    expect(err.join("")).toMatch(/failed at stage \w+\n {2}[\w-]+: .*\nrecord: runs\/\S+\/failed\/\w+\.json\n/);
    expect(err.join("")).toContain("continue with: explainer run resume");
  });

  it("exits 2 on an unknown stage or a runaway cap", async () => {
    fx = fixture();
    const { run } = cli(fakeHost(fx, fakeScriptModel(), fakeRender()));

    expect(await run("--from", "mix")).toBe(2);
    expect(await run("--budget-usd", "2000")).toBe(2);
  });
});

describe("explainer stage and run variants CLI", () => {
  it("run --variant reruns from the varied stage, and report --compare names the cache hits", async () => {
    fx = fixture();
    const host = fakeHost(fx, fakeScriptModel(), fakeRender());
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

    expect(out.join("")).toContain("| tts | cached | in-process |");
    expect(out.join("")).toContain(`## Compare: ${second} against ${first}`);
    expect(out.join("")).toContain("Cache hits in");
  });

  it("stage runs one stage from stored shas and prints a cache hit the second time", async () => {
    const draft = await scriptDraft();
    const host = fakeHost(fx, fakeScriptModel(), fakeRender());
    const lines: string[] = [];
    const stage = (...argv: string[]) => runStageCli(["stage", ...argv, "--data-dir", fx.dataDir], { host, out: (t) => lines.push(t), err: (t) => lines.push(t) });

    expect(await stage("rewrite", "--in", `draft=${draft}`, "--sample", "3")).toBe(0);
    expect(await stage("rewrite", "--in", `draft=${draft}`, "--sample", "3")).toBe(0);
    expect(await stage("rewrite", "--in", "draft=abc")).toBe(2);

    expect(lines.filter((l) => l.startsWith("stage rewrite:")).map((l) => l.split(";")[0])).toEqual(["stage rewrite: ran", "stage rewrite: cache hit"]);
    // The reported row's verdict is the fixture's register, not the cache; the fake's split beats leave it near a band edge.
    expect(lines).toContainEqual(expect.stringMatching(/^checks: no-new-l0-error pass \(gate\), word-budget pass \(gate\), rewrite-rows (pass|FAIL) \(reported\), writing (pass|FAIL) \(reported\)\n$/));
  });

  it("stage --json prints the failed record with its gate verdict and exits 1", async () => {
    const draft = await scriptDraft();
    const drafted = choppy().beats[0]!.spoken;
    const redOnceRewritten: L0Check = (input) => l0Check(input.script.beats[0]!.spoken === drafted)(input);
    const host = fakeHost(fx, fakeScriptModel(), fakeRender(), { evalChecks: [redOnceRewritten] });
    const lines: string[] = [];

    const code = await runStageCli(["stage", "rewrite", "--in", `draft=${draft}`, "--json", "--data-dir", fx.dataDir], { host, out: (t) => lines.push(t), err: () => undefined });

    expect(code).toBe(1);
    const record = StageRecordSchema.parse(JSON.parse(lines.join("")));
    expect(record.checks.find((check) => check.name === "no-new-l0-error")).toMatchObject({ gate: true, pass: false });
  });
});

const GOAL_WALK_BLOCKS = ["bottom-line", "goals", "lanes", "ships", "side-quests", "stats", "reflection", "ask"];

/** choppy()'s beats spread in order over goal-walk's eight chapters, so each chapter has a first beat to carry its lead. */
function overGoalWalk(): ScriptV1 {
  const script = choppy();
  const chapters = GOAL_WALK_BLOCKS.map((id, i) => ({ id, label: `${id} · Lane ${i + 1}?`, question: `Lane ${i + 1}?` }));
  const beats = script.beats.map((beat, i) => ({ ...beat, chapter: chapters[Math.floor((i * chapters.length) / script.beats.length)]!.id }));
  return { ...script, chapters, beats };
}

describe("explainer run --from gather --type daily-overview", () => {
  // Mutation: dropping `spine: { from: audition-pick }` from daily-overview.yaml refuses this run for want of --spine.
  it("reaches the script stage with no --spine, on the spine the audition picked", async () => {
    fx = fixture();
    cpSync(path.join(DAILY_FIXTURE, "snapshots"), path.join(fx.dataDir, "task-snapshots"), { recursive: true });
    const out: string[] = [];
    const err: string[] = [];
    const cli = fakeCli();
    const gather = { gh: fakeGh(), listTasks: async () => fixtureTasks(), cli };
    const daily = ["--facts-from", "gatherDaily", "--day", DAY, "--repo", REPO, "--transcripts", path.join(DAILY_FIXTURE, "transcripts"), "--initiative", "demo"];

    await runRunCli(["run", ...daily, "--type", "daily-overview", "--from", "gather", "--to", "script", "--data-dir", fx.dataDir], {
      host: fakeHost(fx, fakeBriefModels(fakeScriptModel(overGoalWalk(), { followLeads: true })), fakeRender()), gather, out: (t) => out.push(t), err: (t) => err.push(t),
    });

    expect(cli.calls.map((argv) => argv.slice(0, 3).join(" "))).toContain("active-work miner cost");
    expect(err.join("")).not.toContain("--spine");
    const report = ReportRowsSchema.parse(JSON.parse(readFileSync(path.join(path.dirname(out.join("").match(/report: (\S+)/)![1]!), "run-report.json"), "utf8")));
    const row = (stage: string) => report.rows.find((r) => r.stage === stage)!;
    expect(row("audition").outputs.spine).toBeDefined();
    expect(row("script").outputs.draft).toBeDefined();
  });

  // Mutation: dropping the gather's coverage output leaves the script prompt without the lanes it must name or count.
  it("hands the script the gather's coverage manifest as a prompt section", async () => {
    fx = fixture();
    cpSync(path.join(DAILY_FIXTURE, "snapshots"), path.join(fx.dataDir, "task-snapshots"), { recursive: true });
    const cli = fakeCli();
    const gather = { gh: fakeGh(), listTasks: async () => fixtureTasks(), cli };
    const daily = ["--facts-from", "gatherDaily", "--day", DAY, "--repo", REPO, "--transcripts", path.join(DAILY_FIXTURE, "transcripts"), "--initiative", "demo"];
    const writer = fakeScriptModel(overGoalWalk(), { followLeads: true });

    await runRunCli(["run", ...daily, "--type", "daily-overview", "--from", "gather", "--to", "script", "--data-dir", fx.dataDir], {
      host: fakeHost(fx, fakeBriefModels(writer), fakeRender()), gather, out: () => undefined, err: () => undefined,
    });

    expect(cli.calls.map((argv) => argv.slice(0, 3).join(" "))).toContain("active-work miner cost");
    expect(writer.prompts[0]).toContain("## Coverage (coverage.json)");
    expect(writer.prompts[0]).toMatch(/^- .+ merged, counted by lane\/[a-z-]+\/rollup; name: /m);
  });
});

describe("explainer run --day relative to the UTC clock", () => {
  async function dryRun(day: string): Promise<{ code: number; out: string; err: string }> {
    fx = fixture();
    cpSync(path.join(DAILY_FIXTURE, "snapshots"), path.join(fx.dataDir, "task-snapshots"), { recursive: true });
    const out: string[] = [];
    const err: string[] = [];
    const gather = { gh: fakeGh(), listTasks: async () => fixtureTasks(), cli: fakeCli() };
    const argv = ["run", "--facts-from", "gatherDaily", "--day", day, "--repo", REPO, "--transcripts", path.join(DAILY_FIXTURE, "transcripts"), "--initiative", "demo",
      "--type", "daily-overview", "--dry-run", "--data-dir", fx.dataDir];
    const code = await runRunCli(argv, { host: fakeHost(fx, fakeBriefModels(fakeScriptModel(overGoalWalk())), fakeRender()), gather, out: (t) => out.push(t), err: (t) => err.push(t) });
    return { code, out: out.join(""), err: err.join("") };
  }

  const atFirstMinutes = async (body: () => Promise<void>): Promise<void> => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T00:20:00Z"));
    try { await body(); } finally { vi.useRealTimers(); }
  };

  it("gathers the previous UTC date for --day yesterday", async () => {
    await atFirstMinutes(async () => {
      const result = await dryRun("yesterday");
      expect(result.out).toContain("daily-overview 2026-11-13");
      expect(result.err).not.toContain("not closed");
    });
  });

  it("notes once that the current UTC day's window is not closed", async () => {
    await atFirstMinutes(async () => {
      const result = await dryRun("2026-11-14");
      expect(result.err.match(/not closed/g)).toHaveLength(1);
    });
  });

  it("prints no open-day note for a closed day", async () => {
    await atFirstMinutes(async () => {
      expect((await dryRun("2026-11-13")).err).not.toContain("not closed");
    });
  });

  it("exits 2 with the usage message for --day tomorrow", async () => {
    await atFirstMinutes(async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const result = await dryRun("tomorrow");
        expect(result.code).toBe(2);
        expect(stderr.mock.calls.join("")).toContain("--day takes YYYY-MM-DD or yesterday");
      } finally { stderr.mockRestore(); }
    });
  });
});
