import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunConfig, AgentRunResult } from "@titan-design/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShepherdSource } from "./shepherd.js";
import { buildShipped, type ShippedBuildDeps, type ThemeAnswer } from "./shipped-build.js";
import { readShipped, type ShippedDigest } from "./shipped.js";

type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const DATE = "2031-03-05";
const NOW = Date.parse("2031-03-06T07:10:00");

function merged(pr: number, initiative = "example"): WatchRow {
  return {
    repo: "example-org/repo", pr, branch: `feat/${pr}`, runId: `run-${pr}`, task: `${initiative}/EX-${pr}`, phase: "done", headSha: "a1b2c3d",
    phaseSince: new Date("2031-03-05T12:00:00").toISOString(), nextAction: "none", pendingGate: null, held: null, stalled: null, outcome: { kind: "merged" },
  };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const numbersIn = (prompt: string): number[] => [...prompt.matchAll(/^## #(\d+)/gm)].map((match) => Number(match[1]));

/** The fake model groups every PR its prompt shows into one theme, unless told what to answer. */
function fakeRun(answer?: ThemeAnswer, failure?: { kind: "auth_misconfigured"; reason: string }) {
  const prompts: string[] = [];
  const run = async (config: AgentRunConfig<ThemeAnswer>): Promise<AgentRunResult<ThemeAnswer>> => {
    prompts.push(config.prompt);
    if (failure !== undefined) return { ok: false, failure };
    const output = answer ?? { themes: [{ title: "Everything", summary: "All of it", prs: numbersIn(config.prompt) }] };
    return { ok: true, output, sessionId: "s", usage: { totalCostUsd: 0, modelUsage: {}, turns: 1, durationMs: 1 }, init: INIT };
  };
  return { run, prompts };
}

function fakeGithub(forbiddenFrom = Number.POSITIVE_INFINITY) {
  const reads: number[] = [];
  const github: ShippedBuildDeps["github"] = {
    getSquashSource: async (_repo, number) => {
      reads.push(number);
      if (number === forbiddenFrom) throw Object.assign(new Error("HTTP 403"), { status: 403 });
      return { title: `PR ${number}`, body: "body", commits: [] };
    },
  };
  return { github, reads };
}

const INIT = { apiKeySource: undefined, model: "sonnet", tools: [], permissionMode: undefined, claudeCodeVersion: undefined };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-shipped-build-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function depsWith(rows: WatchRow[], run: ShippedBuildDeps["run"], github = fakeGithub().github): ShippedBuildDeps {
  return { shepherd: { list: async () => rows, timeline: async () => Promise.reject(new Error("no timeline")) }, github, run, dir, now: NOW };
}

const build = (deps: ShippedBuildDeps, extra: { force?: boolean; dryRun?: boolean; group?: string } = {}) =>
  buildShipped(deps, { date: DATE, dryRun: false, force: false, ...extra });
async function readWritten(): Promise<ShippedDigest> {
  const { digest } = await readShipped({ list: async () => [], timeline: async () => Promise.reject(new Error("no timeline")) }, { dir }, NOW, DATE);
  if (digest === null) throw new Error("no digest written");
  return digest;
}
const unsummarizedOf = (digest: ShippedDigest): number[] => digest.groups.flatMap((group) => group.unsummarized.map((pr) => pr.number)).sort((a, b) => a - b);

describe("shipped build", () => {
  it("drops a PR number the model invented and leaves a PR it omitted unsummarized", async () => {
    const { run } = fakeRun({ themes: [{ title: "Fixes", summary: "Fixed things", prs: [7, 8, 99] }] });

    await build(depsWith([merged(7), merged(8), merged(9)], run));

    const digest = await readWritten();
    expect(digest.groups[0]?.themes.map((theme) => theme.prs.map((pr) => pr.number))).toEqual([[7, 8]]);
    expect(unsummarizedOf(digest)).toEqual([9]);
  });

  it("makes no model call for an unchanged PR set, and rebuilds it with force", async () => {
    const rows = [merged(1), merged(2)];
    await build(depsWith(rows, fakeRun().run));
    const again = fakeRun();

    const unchanged = await build(depsWith(rows, again.run));
    const callsBeforeForce = again.prompts.length;
    await build(depsWith(rows, again.run), { force: true });

    expect(unchanged.outcome).toBe("unchanged");
    expect(callsBeforeForce).toBe(0);
    expect(again.prompts).toHaveLength(1);
  });

  it("splits 95 PRs into 3 batches and, on a 403 at PR 50, leaves 50 to 95 unsummarized and still writes", async () => {
    const { run, prompts } = fakeRun();
    const { github, reads } = fakeGithub(50);

    const report = await build(depsWith(range(1, 95).map((n) => merged(n)), run, github));

    expect(report.batches).toBe(3);
    expect(prompts.map(numbersIn)).toEqual([range(1, 40), range(41, 49)]);
    expect(reads.at(-1)).toBe(50);
    expect(unsummarizedOf(await readWritten())).toEqual(range(50, 95));
  });

  it("rejects with exit 2 and writes no file when claude is not logged in", async () => {
    const { run } = fakeRun(undefined, { kind: "auth_misconfigured", reason: "not logged in" });

    await expect(build(depsWith([merged(1)], run))).rejects.toMatchObject({ code: 2 });

    expect(await readdir(dir)).toEqual([]);
  });
});
