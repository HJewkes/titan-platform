import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunConfig, AgentRunResult } from "@titan-design/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shippedBuildArgs } from "./cli-shipped.js";
import type { ShepherdSource } from "./shepherd.js";
import { buildShipped, type ShippedBuildDeps, type ThemeAnswer } from "./shipped-build.js";
import { readShipped, type ShippedDigest } from "./shipped.js";

type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const DATE = "2031-03-05";

function merged(pr: number, initiative: string): WatchRow {
  return {
    repo: "example-org/repo", pr, branch: `feat/${pr}`, runId: `run-${pr}`, task: `${initiative}/EX-${pr}`, phase: "done", headSha: "a1b2c3d",
    phaseSince: new Date("2031-03-05T12:00:00").toISOString(), nextAction: "none", pendingGate: null, held: null, stalled: null, outcome: { kind: "merged" },
  };
}

function fakeRun() {
  const prompts: string[] = [];
  const run = async (config: AgentRunConfig<ThemeAnswer>): Promise<AgentRunResult<ThemeAnswer>> => {
    prompts.push(config.prompt);
    const prs = [...config.prompt.matchAll(/^## #(\d+)/gm)].map((match) => Number(match[1]));
    return { ok: true, output: { themes: [{ title: "T", summary: "S", prs }] }, sessionId: "s", usage: { totalCostUsd: 0, modelUsage: {}, turns: 1, durationMs: 1 }, init: INIT };
  };
  return { run, prompts };
}

const INIT = { apiKeySource: undefined, model: "sonnet", tools: [], permissionMode: undefined, claudeCodeVersion: undefined };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-shipped-options-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function readWritten(): Promise<ShippedDigest> {
  const { digest } = await readShipped({ list: async () => [] }, { dir }, Date.parse("2031-03-06T07:10:00"), DATE);
  if (digest === null) throw new Error("no digest written");
  return digest;
}

function depsWith(rows: WatchRow[], run: ShippedBuildDeps["run"]): ShippedBuildDeps {
  const github: ShippedBuildDeps["github"] = { getSquashSource: async (_repo, number) => ({ title: `PR ${number}`, body: "x".repeat(5000), commits: [] }) };
  return { shepherd: { list: async () => rows }, github, run, dir, now: Date.parse("2031-03-06T07:10:00") };
}

describe("shipped build options", () => {
  it("dry run calls no model and writes nothing, but reports the prompt size", async () => {
    const { run, prompts } = fakeRun();

    const report = await buildShipped(depsWith([merged(1, "alpha")], run), { date: DATE, dryRun: true, force: false });

    expect(prompts).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    expect(report.promptBytes).toBeGreaterThan(0);
  });

  it("with a group, calls the model for that initiative only and lists the others unsummarized", async () => {
    const { run, prompts } = fakeRun();

    await buildShipped(depsWith([merged(1, "alpha"), merged(2, "beta")], run), { date: DATE, group: "beta", dryRun: false, force: false });

    const digest = await readWritten();
    expect(prompts).toHaveLength(1);
    expect(digest.groups.map((group) => [group.initiative, group.themes.length, group.unsummarized.length])).toEqual([["alpha", 0, 1], ["beta", 1, 0]]);
  });

  it("stops at 12 model calls a day and leaves later initiatives unsummarized", async () => {
    const initiatives = Array.from({ length: 13 }, (_, i) => i + 1).map((n) => `init-${String(n).padStart(2, "0")}`);
    const { run, prompts } = fakeRun();

    await buildShipped(depsWith(initiatives.map((name, i) => merged(i + 1, name)), run), { date: DATE, dryRun: false, force: false });

    expect(prompts).toHaveLength(12);
    const digest = await readWritten();
    expect(digest.groups.flatMap((group) => group.unsummarized.map((pr) => pr.number))).toEqual([13]);
  });

  it("cuts each PR body to 1 KB in the prompt", async () => {
    const { run, prompts } = fakeRun();

    await buildShipped(depsWith([merged(1, "alpha")], run), { date: DATE, dryRun: false, force: false });

    expect(prompts[0]).toContain("x".repeat(1024));
    expect(prompts[0]).not.toContain("x".repeat(1025));
  });
});

describe("shipped build arguments", () => {
  it("reads every flag in any order", () => {
    expect(shippedBuildArgs(["shipped", "build", "--force", "--group", "alpha", "--date", DATE, "--dry-run", "--json"])).toEqual({ date: DATE, group: "alpha", dryRun: true, force: true, json: true });
  });

  it("refuses a date that is not YYYY-MM-DD and a repeated flag", () => {
    expect(shippedBuildArgs(["shipped", "build", "--date", "yesterday"])).toBeNull();
    expect(shippedBuildArgs(["shipped", "build", "--force", "--force"])).toBeNull();
  });
});
